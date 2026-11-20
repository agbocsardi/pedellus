/**
 * Tool steps of one app-channel turn for the protocol v2 "Activity" view.
 *
 * Steps are derived from the run's committed transcript entries: an assistant `toolCall` starts
 * a step, the `toolResult` with the same call id ends it (`failed` when the result is an error).
 * A step carries only what the wire allows — an id stable within the turn, the bounded tool name,
 * the state and the two times. Arguments, results, file paths and error text stay in the
 * transcript, so nothing a tool was handed or returned can reach app channel state or a socket.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AppActivityStep } from "./app-protocol.js";

/** Steps accumulated from one run in call order, plus the index each call id started at. */
export type ActivityTally = {
  readonly steps: AppActivityStep[];
  readonly index: Map<string, number>;
};

export function emptyActivity(): ActivityTally {
  return { steps: [], index: new Map() };
}

/** At most `maxChars` UTF-16 units, never cutting a surrogate pair. */
function boundedTool(raw: string, maxChars: number): string {
  // Tool names come from the model or an MCP server: control, format and bidi characters never
  // reach a frame (the same rule as thread titles and labels).
  const name = raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
  if (name.length <= maxChars) return name;
  const last = name.charCodeAt(maxChars - 1);
  return name.slice(0, maxChars > 1 && last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars);
}

/** The message's own timestamp as an ISO instant; a message without one starts no step. */
function instant(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  // A finite timestamp outside Date's range would throw in toISOString and fail the delivery.
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Fold one page of committed transcript entries into the run's steps; idempotent per entry order. */
export function absorbActivity(tally: ActivityTally, entries: readonly EntryRecord[], maxToolChars: number): void {
  for (const entry of entries) {
    for (const raw of entry.model ?? []) {
      if (raw === null || typeof raw !== "object") continue;
      const message = raw as {
        readonly role?: unknown; readonly content?: unknown; readonly timestamp?: unknown;
        readonly toolCallId?: unknown; readonly isError?: unknown;
      };
      if (message.role === "assistant") {
        // An interrupted attempt's partial (kept by Durable on restart) never ran its tool calls.
        if ((message as { readonly stopReason?: unknown }).stopReason === "aborted") continue;
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block === null || typeof block !== "object") continue;
          const call = block as { readonly type?: unknown; readonly id?: unknown; readonly name?: unknown };
          if (call.type !== "toolCall" || typeof call.name !== "string") continue;
          const tool = boundedTool(call.name, maxToolChars);
          if (tool === "") continue;
          if (typeof call.id !== "string" || call.id === "") continue;
          const startedAt = instant(message.timestamp);
          if (startedAt === undefined) continue;
          tally.steps.push({
            // The wire id is positional, so no provider call id and no tool input reaches it.
            id: `s${tally.steps.length + 1}`,
            tool,
            state: "running",
            startedAt,
          });
          tally.index.set(call.id, tally.steps.length - 1);
        }
        continue;
      }
      if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
      const at = tally.index.get(message.toolCallId);
      const step = at === undefined ? undefined : tally.steps[at];
      if (at === undefined || step === undefined || step.state !== "running") continue;
      const endedAt = instant(message.timestamp);
      tally.steps[at] = {
        ...step,
        state: message.isError === true ? "failed" : "done",
        ...(endedAt === undefined ? {} : { endedAt }),
      };
    }
  }
}

/**
 * The bounded wire shape: at most `maxSteps` steps, keeping the first `maxSteps - 1` and the
 * newest one; `omitted` counts the steps that did not fit (protocol v2, "Activity").
 */
export function activityForWire(
  tally: ActivityTally,
  maxSteps: number,
): { steps: AppActivityStep[]; omitted?: number } {
  const all = tally.steps;
  if (all.length <= maxSteps) return { steps: all.map((step) => ({ ...step })) };
  const kept = [...all.slice(0, Math.max(0, maxSteps - 1)), all[all.length - 1]!];
  return { steps: kept.map((step) => ({ ...step })), omitted: all.length - maxSteps };
}
