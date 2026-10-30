/**
 * The model-facing `worker` tool.
 *
 * The tool is a context capability, not a coding tool: it takes no path, runs no shell and holds no
 * filesystem authority. It starts, lists, inspects and cancels this conversation's own durable worker
 * tasks. Scope is the host's mapped-chat policy, enforced by the runtime: only an authenticated,
 * scope-checked spawning conversation is offered it, never a raw, forked, channel-state or
 * task-owned conversation, so a worker can never start another worker.
 *
 * Starting is immediate: the tool returns a task ID while the worker runs in the background, and the
 * spawning agent continues its ordinary turn. Completion arrives later as one internal result event
 * in this conversation; nothing here sends anything to the user.
 */
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type Extension,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import { WORKER_LIMITS, WORKER_WORKSPACE_MODES, type WorkerWorkspaceMode } from "./limits.js";
import type { WorkerFoundation, WorkerView } from "./worker-task.js";

export const WORKER_TOOL_NAME = "worker";

export interface WorkerToolOptions {
  readonly foundation: WorkerFoundation;
  /** Host-resolved spawning conversation; `undefined` means this conversation may not spawn workers. */
  readonly spawnerFor: (conversationId: ConversationId) => boolean;
  /** The open Harness; the extension is registered before `Harness.open()`, so this is late-bound. */
  readonly harness: () => Harness;
  /** Why worktree mode cannot start here, if it cannot; read-only and cheap. */
  readonly precheckWorktree: () => Promise<string | undefined>;
}

export interface WorkerTool {
  readonly extension: Extension;
}

const ACTIONS = ["start", "list", "inspect", "cancel"] as const;

interface WorkerToolArguments {
  readonly action: (typeof ACTIONS)[number];
  readonly task?: string;
  readonly workspace_mode?: WorkerWorkspaceMode;
  readonly request_id?: string;
  readonly worker_id?: number;
}

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

const reasonText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function iso(ms: number | null): string {
  return ms === null ? "none" : new Date(ms).toISOString();
}

function oneLine(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/gu, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function describe(view: WorkerView, detailed: boolean): string {
  const lines = [
    `worker ${view.taskId}  status: ${view.status}  workspace: ${
      view.workspaceMode === "worktree"
        ? `worktree ${view.workspacePath ?? "?"} (branch ${view.branch ?? "?"}, base ${view.baseCommit ?? "?"})`
        : "shared"
    }`,
    `  task: ${oneLine(view.prompt, detailed ? 600 : 120)}`,
  ];
  if (view.finishedAtMs !== null) {
    lines.push(`  started: ${iso(view.createdAtMs)}  finished: ${iso(view.finishedAtMs)}`);
  } else {
    lines.push(`  started: ${iso(view.createdAtMs)}`);
  }
  if (detailed) {
    if (view.result !== null) lines.push(`  result (untrusted worker output):\n${view.result}`);
    if (view.error !== null) lines.push(`  reason: ${view.error}`);
    if (view.conversationId !== null) lines.push(`  conversation: ${view.conversationId} (inspect the task transcript there)`);
  } else if (view.error !== null) {
    lines.push(`  reason: ${oneLine(view.error, 200)}`);
  }
  return lines.join("\n");
}

export function createWorkerTool(options: WorkerToolOptions): WorkerTool {
  const tool = defineTool({
    name: WORKER_TOOL_NAME,
    description:
      "Start and manage bounded background workers for this conversation. A worker is an ordinary " +
      "background task with its own conversation: it keeps working while you continue, and its result " +
      "comes back to you later as one internal event in this conversation. Nothing a worker produces is " +
      "sent to the user directly; you decide what, if anything, to relay. Actions: `start` launches one " +
      "worker and returns immediately; `list` shows this conversation's workers; `inspect` shows one " +
      "worker's bounded result; `cancel` aborts one worker. A worker inherits this conversation's " +
      "currently enabled tools (never more) and has no way to start further workers or use channels.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("list"),
        Type.Literal("inspect"),
        Type.Literal("cancel"),
      ], { description: "Which operation to perform." }),
      task: Type.Optional(Type.String({
        description:
          "start: the complete, self-contained instruction for the worker. The worker has no access to " +
          "this conversation's history, so include everything it needs. Required for start.",
      })),
      workspace_mode: Type.Optional(Type.Union([
        Type.Literal("shared"),
        Type.Literal("worktree"),
      ], {
        description:
          "start: required. `shared` runs in the actual configured workspace, so concurrent work sees " +
          "each other's changes; use it for small or read-only background work. `worktree` runs in an " +
          "isolated git worktree on a generated branch of the configured repository, so it cannot touch " +
          "the owner's working state; use it for serious coding work. It needs a clean git workspace and " +
          "is never merged automatically.",
      })),
      request_id: Type.Optional(Type.String({
        description:
          "start: optional idempotency key. Starting again with the same request_id returns the existing " +
          "worker instead of launching a second one.",
      })),
      worker_id: Type.Optional(Type.Integer({
        description: "inspect/cancel: the worker ID from `start` or `list`.",
        minimum: 1,
      })),
    }),
    // Safe to rerun after an interrupted execution: `start` dedupes on the stable call ID, and the
    // other actions only read or report an already-terminal task.
    replay: "safe",
    outputLimits: { maxBytes: 64 * 1024, maxLines: 1_000, retain: "head" },
    async execute(args, api, context) {
      if (!options.spawnerFor(api.conversationId)) {
        return text(
          "Background workers are available only in a mapped chat conversation; this conversation " +
          "cannot start or inspect them.",
          true,
        );
      }
      let harness: Harness;
      try {
        harness = options.harness();
      } catch {
        return text("Background workers are not available yet: the runtime is still starting.", true);
      }
      const request = args as unknown as WorkerToolArguments;

      if (request.action === "list") {
        let views: readonly WorkerView[];
        try {
          views = await options.foundation.list(harness, api.conversationId, context);
        } catch (error) {
          return text(`Could not read this conversation's workers: ${reasonText(error)}`, true);
        }
        if (views.length === 0) return text("No background workers in this conversation.");
        return text(views.map((view) => describe(view, false)).join("\n\n"));
      }

      if (request.action === "inspect" || request.action === "cancel") {
        const workerId = request.worker_id;
        if (!Number.isSafeInteger(workerId) || (workerId as number) < 1) {
          return text(`${request.action} requires worker_id; use action \`list\` to see the IDs.`, true);
        }
        if (request.action === "inspect") {
          let view: WorkerView | undefined;
          try {
            view = await options.foundation.inspect(harness, api.conversationId, workerId as number, context);
          } catch (error) {
            return text(`Could not read worker ${workerId}: ${reasonText(error)}`, true);
          }
          if (view === undefined) return text(`No worker ${workerId} in this conversation.`, true);
          return text(describe(view, true));
        }
        let result: "marked" | "terminal" | "not_found";
        try {
          result = await options.foundation.cancel(harness, api.conversationId, workerId as number, context);
        } catch (error) {
          return text(`Could not cancel worker ${workerId}: ${reasonText(error)}`, true);
        }
        if (result === "not_found") return text(`No worker ${workerId} in this conversation.`, true);
        if (result === "terminal") return text(`Worker ${workerId} has already finished; nothing to cancel.`);
        return text(
          `Cancelled worker ${workerId}. Its result event in this conversation will report the cancellation.`,
        );
      }

      if (request.action !== "start") {
        return text(`Unknown action; use one of ${ACTIONS.join(", ")}.`, true);
      }
      const task = typeof request.task === "string" ? request.task.trim() : "";
      if (task === "") return text("start requires a non-empty task description for the worker.", true);
      if (task.length > WORKER_LIMITS.maxPromptChars) {
        return text(
          `start refuses a task description longer than ${WORKER_LIMITS.maxPromptChars} characters; ` +
          "split it into a smaller bounded task.",
          true,
        );
      }
      const mode = request.workspace_mode;
      if (!(WORKER_WORKSPACE_MODES as readonly string[]).includes(mode as string)) {
        return text(
          "start requires workspace_mode: `shared` runs in the actual configured workspace " +
          "(concurrent work interferes), `worktree` runs in an isolated git worktree of this repository.",
          true,
        );
      }
      if (mode === "worktree") {
        const problem = await options.precheckWorktree();
        if (problem !== undefined) return text(`start refused: ${problem}`, true);
      }
      if (request.request_id !== undefined && typeof request.request_id !== "string") {
        return text("request_id must be a string when provided.", true);
      }
      const requestId = typeof request.request_id === "string" && request.request_id.trim() !== ""
        ? `model:${request.request_id.trim()}`
        : `tool:${api.callId}`;
      let receipt: { readonly taskId: number; readonly deduplicated: boolean };
      try {
        receipt = await options.foundation.start({
          id: api.conversationId,
          commit: <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) => api.commit(change, ctx),
        }, {
          requestId,
          prompt: task,
          workspaceMode: mode as WorkerWorkspaceMode,
        }, context);
      } catch (error) {
        // Model-visible start errors are actionable (concurrency cap, duplicate request, bad input);
        // they carry no host paths or credentials.
        return text(`Could not start a background worker: ${reasonText(error)}`, true);
      }
      if (receipt.deduplicated) {
        return text(
          `Worker ${receipt.taskId} already exists for this request; it was not started again. ` +
          "Use action `inspect` for its result.",
        );
      }
      return text(
        `Started background worker ${receipt.taskId} in ${mode} workspace mode. It runs while you continue; ` +
        "its result will arrive later as one internal event in this conversation. Use action `inspect` or " +
        "`cancel` with that ID if needed.",
      );
    },
  });

  return { extension: defineExtension({ name: "nanobot.worker-tool", tools: [tool] }) };
}
