/**
 * The model-facing `cron` tool.
 *
 * Cron is an internal agent capability: the user asks the agent, the agent schedules work here.
 * There is no user scheduler, slash command, or UI. Every operation is owner-scoped to the calling
 * conversation's job document, and the tool never widens authority:
 *
 * - a job gets the origin conversation's enabled tools when its run is prepared, so scheduling
 *   cannot grant a tool the conversation does not already hold;
 * - a `background` run gets a fresh task-owned conversation with that authority copied and nothing
 *   else, so a scheduled turn cannot reach another conversation's state;
 * - `origin` runs answer in the conversation that scheduled them.
 *
 * The tool itself is not grant-gated and is not part of the host coding-tool ceiling: it can only
 * write owner-scoped job records in the calling conversation, and it executes no filesystem or shell
 * work. Reading, writing and shell work inside a scheduled run still needs that run's inherited
 * authority.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type Extension,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  type CronActor,
  type CronCancellation,
  type CronConversationWriter,
  type CronFoundation,
  type CronJobView,
  type CronOwner,
  type CronScheduleInput,
  type CronScheduleReceipt,
  type CronWithdrawal,
} from "./cron.js";
import { CRON_DEFAULT_TIME_ZONE } from "./cron-schedule.js";

export const CRON_TOOL_NAME = "cron";

export interface CronToolOptions {
  readonly foundation: CronFoundation;
  /**
   * Host-resolved owner of a conversation. `undefined` means the conversation is not an origin
   * session (for example a scheduled run's own background conversation), so cron is unavailable.
   */
  readonly ownerFor: (conversationId: ConversationId, context: Context) => CronOwner | undefined;
  /**
   * Optional host check for a `digest`-intent job: the calling conversation must currently be an
   * authenticated mapped chat with the curation tools. Scheduling is refused otherwise instead of
   * recording a job that can only fail. Absent means `digest` is unavailable.
   */
  readonly digestAvailable?: (conversationId: ConversationId) => boolean;
  /** The open Harness; the extension is registered before `Harness.open()`, so this is late-bound. */
  readonly harness: () => Harness;
  /** IANA zone for calendar expressions that omit `tz`. */
  readonly timeZone?: string;
}

export interface CronTool {
  readonly extension: Extension;
}

const ACTIONS = ["add", "list", "remove"] as const;
const SCHEDULE_FIELDS = ["at", "after_seconds", "every_seconds", "cron_expr"] as const;

interface CronToolArguments {
  readonly action: (typeof ACTIONS)[number];
  readonly intent?: "message" | "digest";
  readonly message?: string;
  readonly name?: string;
  readonly at?: string;
  readonly after_seconds?: number;
  readonly every_seconds?: number;
  readonly cron_expr?: string;
  readonly tz?: string;
  readonly isolated?: boolean;
  readonly job_id?: string;
}

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

const reasonText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function iso(ms: number | null): string {
  return ms === null ? "none" : new Date(ms).toISOString();
}

/**
 * A one-shot time must carry an explicit UTC offset. Interpreting a naive local time would need the
 * zone-offset arithmetic the calendar schedule avoids, and silently guessing is worse than asking
 * the caller for an unambiguous instant.
 */
function parseAt(raw: string): number {
  const value = raw.trim();
  if (value === "") {
    throw new TypeError("at must be an ISO 8601 timestamp with a UTC offset, for example 2026-11-01T09:00:00+01:00");
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new TypeError(
      `at must include an explicit UTC offset or Z (got "${value}"); use cron_expr with tz for a local wall time`,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`at is not a valid ISO 8601 timestamp: ${value}`);
  return parsed;
}

function scheduleOf(args: CronToolArguments, zone: string): CronScheduleInput["schedule"] {
  const present = SCHEDULE_FIELDS.filter((field) => args[field] !== undefined);
  if (present.length === 0) {
    throw new TypeError("add requires exactly one of at, after_seconds, every_seconds or cron_expr");
  }
  if (present.length > 1) {
    throw new TypeError(`add accepts one schedule, not ${present.join(" + ")}`);
  }
  if (args.at !== undefined) return { kind: "at", at: parseAt(args.at) };
  if (args.after_seconds !== undefined) {
    const seconds = args.after_seconds;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new TypeError("after_seconds must be a positive whole number of seconds");
    }
    const afterMs = seconds * 1000;
    if (!Number.isSafeInteger(afterMs)) throw new TypeError("after_seconds is too large");
    // The foundation resolves this once, at admission, against its own clock. The tool never
    // reads a clock, so a safe replay carries the same relative request and dedupes against the
    // original stored deadline.
    return { kind: "after", afterMs };
  }
  if (args.every_seconds !== undefined) {
    const seconds = args.every_seconds;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new TypeError("every_seconds must be a positive integer number of seconds");
    }
    const everyMs = seconds * 1000;
    if (!Number.isSafeInteger(everyMs)) throw new TypeError("every_seconds is too large");
    return { kind: "every", everyMs };
  }
  const expr = args.cron_expr;
  if (typeof expr !== "string" || expr.trim() === "") {
    throw new TypeError("cron_expr must be a non-empty cron expression");
  }
  const timeZone = args.tz === undefined ? zone : args.tz;
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new TypeError("tz must be a non-empty IANA time zone name");
  }
  return { kind: "cron", expr: expr.trim(), timeZone: timeZone.trim() };
}

function scheduleText(view: CronJobView): string {
  const { schedule } = view.job;
  if (schedule.kind === "at") return `once at ${iso(schedule.at)}`;
  if (schedule.kind === "every") return `every ${schedule.everyMs / 1000}s from ${iso(schedule.anchorMs)}`;
  return `${schedule.expr} in ${schedule.timeZone}`;
}

function describe(view: CronJobView): string {
  const parts = [
    `${view.job.id}  ${view.job.name}`,
    `  schedule: ${scheduleText(view)}`,
    `  mode: ${view.job.mode}`,
    ...(view.job.intent === "digest" ? ["  intent: digest (one bounded memory-digestion run per occurrence)"] : []),
    `  status: ${view.status}`,
    `  next: ${iso(view.nextAtMs)}`,
  ];
  if (view.job.lastOutcome !== null) {
    const outcome = view.job.lastOutcome;
    parts.push(
      `  last run: ${outcome.status} at ${iso(outcome.finishedAtMs)}${outcome.error === null ? "" : ` (${outcome.error})`}`,
    );
  }
  if (view.job.lastSkip !== null) {
    parts.push(`  last skipped: ${iso(view.job.lastSkip.skippedAtMs)} (${view.job.lastSkip.reason})`);
  }
  if (view.job.lastFault !== null) {
    parts.push(`  last failure: ${iso(view.job.lastFault.recordedAtMs)} (${view.job.lastFault.error})`);
  }
  if (view.deliveryFault !== null) {
    parts.push(`  last delivery fault: ${iso(view.deliveryFault.recordedAtMs)} (${view.deliveryFault.message})`);
  }
  return parts.join("\n");
}

function withdrawalText(withdrawn: CronWithdrawal | null): string {
  if (withdrawn === null) return "";
  if (withdrawn === "aborted") return " A queued run was withdrawn before it started.";
  if (withdrawn === "already_placed") return " A run was already placed and may still finish.";
  if (withdrawn === "settled") return " The last run had already finished.";
  return "";
}

export function createCronTool(options: CronToolOptions): CronTool {
  const zone = options.timeZone ?? CRON_DEFAULT_TIME_ZONE;
  const tool = defineTool({
    name: CRON_TOOL_NAME,
    description:
      "Schedule recurring or one-shot work for this conversation. Use it when the user asks you to " +
      "do something later, repeatedly, or on a calendar schedule (reminders, daily checks, periodic " +
      "reports). Actions: `add` creates a job whose message you will receive as a new turn when due; " +
      "`list` shows this conversation's jobs, their status and next run; `remove` cancels one job. " +
      "A job runs in an isolated background conversation by default, or in this conversation when " +
      "`isolated` is false. Scheduled runs inherit this conversation's enabled tools; they never " +
      "gain more. `intent: \"digest\"` schedules one bounded memory-digestion run instead of a model " +
      "turn; it needs read/write/edit authority in this conversation and reports through an internal " +
      "result, not a chat message.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"),
        Type.Literal("list"),
        Type.Literal("remove"),
      ], { description: "Which operation to perform." }),
      intent: Type.Optional(Type.Union([
        Type.Literal("message"),
        Type.Literal("digest"),
      ], {
        description:
          "add: `message` (default) sends `message` as a turn when due. `digest` instead runs one " +
          "bounded memory-digestion batch for this chat; message and isolated are then ignored.",
      })),
      message: Type.Optional(Type.String({
        description: "add: the instruction the agent receives when the job fires. Required unless intent is digest.",
      })),
      name: Type.Optional(Type.String({
        description: "add: short human-readable label; defaults to the first characters of the message.",
      })),
      at: Type.Optional(Type.String({
        description:
          "add: one-shot time as an ISO 8601 timestamp with an explicit UTC offset or Z, " +
          "for example 2026-11-01T09:00:00+01:00. Use after_seconds instead for a relative reminder.",
      })),
      after_seconds: Type.Optional(Type.Integer({
        description:
          "add: one-shot delay in whole seconds from now, for example 600 for ten minutes. Use this " +
          "for relative reminders instead of computing an absolute at time.",
        minimum: 1,
      })),
      every_seconds: Type.Optional(Type.Integer({
        description: "add: fixed interval in seconds, for example 3600 for hourly.",
        minimum: 1,
      })),
      cron_expr: Type.Optional(Type.String({
        description:
          "add: cron expression for calendar schedules, seconds first when six fields " +
          "(for example 0 0 9 * * 1-5 at 09:00 on weekdays).",
      })),
      tz: Type.Optional(Type.String({
        description:
          "add: IANA time zone for cron_expr, for example Europe/Budapest. Defaults to the configured " +
          "cron.timeZone, or UTC when unset.",
      })),
      isolated: Type.Optional(Type.Boolean({
        description:
          "add: true (default) runs the job in a fresh background conversation; false runs it in this " +
          "conversation once it is idle.",
      })),
      job_id: Type.Optional(Type.String({
        description: "remove: the job ID from `list`.",
      })),
    }),
    // Every action is safe to rerun after an interrupted execution: `add` dedupes a retry on the
    // tool call ID, `list` only reads, and `remove` is idempotent because a second cancel reports
    // `already_terminal`. Declaring it safe keeps the call ID stable across recovery, which is what
    // makes `tool:<callId>` dedupe a commit that succeeded without a committed result.
    replay: "safe",
    outputLimits: { maxBytes: 64 * 1024, maxLines: 1_000, retain: "head" },
    async execute(args, api, context) {
      const owner = options.ownerFor(api.conversationId, context);
      if (owner === undefined) {
        return text("Scheduling is not available in this conversation.", true);
      }
      const actor: CronActor = { owner };
      let harness: Harness;
      try {
        harness = options.harness();
      } catch {
        return text("Scheduling is not available yet: the runtime is still starting.", true);
      }
      const writer: CronConversationWriter = {
        id: api.conversationId,
        commit: <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) => harness.commit(change, ctx),
      };
      const request = args as unknown as CronToolArguments;
      if (request.action === "list") {
        let views: CronJobView[];
        try {
          views = await options.foundation.list(harness, api.conversationId, actor, context);
        } catch (error) {
          return text(`Could not read scheduled jobs: ${reasonText(error)}`, true);
        }
        if (views.length === 0) return text("No scheduled jobs in this conversation.");
        return text(views.map(describe).join("\n\n"));
      }
      if (request.action === "remove") {
        const jobId = typeof request.job_id === "string" ? request.job_id.trim() : "";
        if (jobId === "") return text("remove requires job_id; use action `list` to see the IDs.", true);
        let result: CronCancellation;
        try {
          result = await options.foundation.cancel(harness, api.conversationId, jobId, actor, context);
        } catch (error) {
          // A thrown cancel may still have committed the cancellation before a task-abort or
          // withdrawal failure. Re-read the job before claiming failure: reporting a durable
          // cancellation as failed invites a pointless retry.
          const reason = reasonText(error);
          let view: CronJobView | undefined;
          try {
            view = await options.foundation.inspect(harness, api.conversationId, jobId, actor, context);
          } catch {
            view = undefined;
          }
          if (view !== undefined && view.job.cancelledAtMs !== null) {
            return text(
              `Cancelled ${jobId} (${view.job.name}). The cancellation is recorded, but cleaning up ` +
              `its queued work failed: ${reason}`,
            );
          }
          return text(`Could not remove scheduled job ${jobId}: ${reason}`, true);
        }
        if (result.status === "not_found") return text(`No scheduled job ${jobId} in this conversation.`, true);
        if (result.status === "forbidden") return text(`Scheduled job ${jobId} belongs to another owner.`, true);
        if (result.status === "already_terminal") {
          return text(`Scheduled job ${jobId} is already finished or cancelled; nothing to remove.`);
        }
        const abortNote = result.abortError === null
          ? ""
          : ` The cancellation is recorded, but signalling its queued work failed: ${result.abortError}`;
        return text(
          `Cancelled ${jobId} (${result.job.name}).` +
          (result.job.lastOutcome === null ? "" : " Its last recorded run is kept for reference.") +
          withdrawalText(result.withdrawn) + abortNote,
        );
      }
      if (request.action !== "add") {
        return text(`Unknown action; use one of ${ACTIONS.join(", ")}.`, true);
      }
      if (request.intent !== undefined && request.intent !== "message" && request.intent !== "digest") {
        return text("intent must be \"message\" or \"digest\".", true);
      }
      const intent = request.intent ?? "message";
      if (intent === "digest" && !(options.digestAvailable?.(api.conversationId) ?? false)) {
        return text(
          "Memory digestion cannot be scheduled from this conversation: it needs an authenticated " +
          "mapped chat with read, write and edit in toolAllowlist. Nothing was scheduled.",
          true,
        );
      }
      const message = typeof request.message === "string" ? request.message.trim() : "";
      if (intent === "message" && message === "") {
        return text("add requires a non-empty message to run when the job fires.", true);
      }
      if (request.name !== undefined && typeof request.name !== "string") {
        return text("name must be a string when provided.", true);
      }
      let receipt: CronScheduleReceipt;
      try {
        // A call ID is stable across a retried call, so a replay cannot create a second job.
        receipt = await options.foundation.schedule(actor, writer, {
          message: intent === "digest" ? "Memory digestion run" : message,
          ...(request.name === undefined ? {} : { name: request.name }),
          schedule: scheduleOf(request, zone),
          mode: intent === "digest" || request.isolated === false ? "origin" : "background",
          intent,
          idempotencyKey: `tool:${api.callId}`,
        }, context);
      } catch (error) {
        // Model-visible scheduling errors are actionable (bad expression, past time). They carry no
        // credentials or host paths: the schedule parser and request validator own the message text.
        return text(`Scheduling failed: ${reasonText(error)}`, true);
      }
      // The job is durably created from here on. A failed follow-up read must not be reported as a
      // scheduling failure, because a retry would look like a new request (a new call ID).
      const when = iso(receipt.nextAtMs);
      let view: CronJobView | undefined;
      try {
        view = await options.foundation.inspect(harness, api.conversationId, receipt.jobId, actor, context);
      } catch {
        view = undefined;
      }
      if (view !== undefined) return text(`Scheduled.\n\n${describe(view)}`);
      return text(`Scheduled ${receipt.jobId}; first run at ${when}.`);
    },
  });

  return { extension: defineExtension({ name: "nanobot.cron-tool", tools: [tool] }) };
}
