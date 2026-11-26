/**
 * The model-facing `cron` tool.
 *
 * Cron is an internal agent capability: the user asks the agent, the agent schedules work here.
 * There is no user scheduler, slash command, or UI. Every operation is owner-scoped to its origin
 * conversation's job document, and the tool never widens authority:
 *
 * - a job gets the origin conversation's enabled tools when each of its runs is prepared, so
 *   scheduling cannot grant a tool the conversation does not already hold;
 * - a `background` run executes in that job's own automation conversation — one per recurring job,
 *   one shared catch-all conversation per origin for one-off jobs — which holds only the authority
 *   captured for that run and nothing from another conversation's state;
 * - `origin` runs answer in the conversation that scheduled them.
 *
 * The host may place the calling conversation's jobs in another conversation of the same channel:
 * an app side thread schedules into the app's Main chat. Every action then reads and writes Main's
 * job document with Main's owner, so `list` and `remove` from a side thread address Main's jobs.
 *
 * The tool itself is not grant-gated and is not part of the host coding-tool ceiling: it can only
 * write owner-scoped job records in its origin conversation, and it executes no filesystem or shell
 * work. Reading, writing and shell work inside a scheduled run still needs that run's inherited
 * authority.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
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
  cronJobMatchesRequest,
} from "./cron.js";
import { CRON_DEFAULT_TIME_ZONE, CronScheduleError, cronScheduleText, parseCronInstant } from "./cron-schedule.js";

export const CRON_TOOL_NAME = "cron";

/**
 * The one answer for a redirected call that could not be verified or completed. It never claims that
 * nothing was scheduled: a replay after a crash may already have committed this very call's job, so
 * the only honest instruction is to look before retrying. Nothing host-supplied reaches the model.
 */
const UNVERIFIED = "Could not verify or schedule this job. Check Main's cron list before retrying.";

/**
 * Where one tool call's jobs live. It is usually the calling conversation and its owner, but the host
 * may name a different conversation of the same channel: an app side thread's jobs belong to the
 * app's Main chat, which outlives every short-lived side thread.
 */
export interface CronToolOrigin {
  readonly conversationId: ConversationId;
  readonly owner: CronOwner;
  /** Model-facing name of a host-redirected target (for example "Main"); absent for the caller. */
  readonly label?: string;
  /**
   * The calling conversation's own owner when the host redirected its jobs elsewhere. It is used for
   * one thing only: recognising a job a build before the redirect committed in the caller's own job
   * document, so a replay of that call reports it instead of scheduling a duplicate.
   */
  readonly callerOwner?: CronOwner;
}

export interface CronToolOptions {
  readonly foundation: CronFoundation;
  /**
   * Host-resolved scheduling origin of a conversation. `undefined` means the conversation is not an
   * origin session (for example a scheduled run's automation conversation), so cron is unavailable.
   * A host that re-homes a conversation's jobs throws instead, and nothing is scheduled.
   */
  readonly originFor: (
    conversationId: ConversationId, context: Context,
  ) => CronToolOrigin | undefined | Promise<CronToolOrigin | undefined>;
  /**
   * Optional host check for a `digest`-intent job: the scheduling origin must currently be an
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
  readonly silent?: boolean;
  readonly job_id?: string;
}

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

const reasonText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Whether a scheduling failure is an explicit request validation the model can act on (a malformed
 * or past schedule, a bad field): the foundation re-throws those as `TypeError`, and the schedule
 * parser as `CronScheduleError`. Anything else is an unexpected failure whose text stays internal.
 */
const isRequestValidationError = (error: unknown): boolean =>
  error instanceof TypeError || error instanceof CronScheduleError;

function iso(ms: number | null): string {
  return ms === null ? "none" : new Date(ms).toISOString();
}

function scheduleOf(args: CronToolArguments, zone: string): CronScheduleInput["schedule"] {
  const present = SCHEDULE_FIELDS.filter((field) => args[field] !== undefined);
  if (present.length === 0) {
    throw new TypeError("add requires exactly one of at, after_seconds, every_seconds or cron_expr");
  }
  if (present.length > 1) {
    throw new TypeError(`add accepts one schedule, not ${present.join(" + ")}`);
  }
  if (args.at !== undefined) return { kind: "at", at: parseCronInstant(args.at) };
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
  return cronScheduleText(view.job.schedule);
}

function describe(view: CronJobView): string {
  const parts = [
    `${view.job.id}  ${view.job.name}`,
    `  schedule: ${scheduleText(view)}`,
    `  mode: ${view.job.mode}`,
    ...(view.job.intent === "digest" ? ["  intent: digest (one bounded memory-digestion run per occurrence)"] : []),
    ...(view.job.silent === true
      ? ["  delivery: silent (a successful run is not sent to this chat; a failure is still reported)"]
      : []),
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
      "A job runs in its own background conversation by default: each recurring job keeps one " +
      "conversation across its runs, one-off jobs share a per-conversation background conversation " +
      "and queue there, and every run starts a fresh episode that does not carry the previous run's " +
      "context. `isolated: false` instead runs the job in this conversation once it is idle. " +
      "Set `silent: true` when a successful run should not be sent to this chat: successes, " +
      "including an empty answer, stay in the run's conversation only, while a failed run still " +
      "posts a short sanitized notice. A job that is not silent always sends its committed final " +
      "answer, so write the message with the reminder or report you expect back, and answer with " +
      "that text when it fires. " +
      "In an app side thread, the job is added to that app's Main chat: it runs and delivers there, " +
      "and `list`/`remove` address Main's jobs. " +
      "Scheduled runs inherit this conversation's enabled tools; they never " +
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
          "bounded memory-digestion batch for this chat; message, isolated and silent are then ignored.",
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
          "add: true (default) runs the job in its background automation conversation, which " +
          "accumulates one episode per run; false runs it in this conversation once it is idle.",
      })),
      silent: Type.Optional(Type.Boolean({
        description:
          "add: true suppresses this job's successful automatic delivery to the chat, including an " +
          "empty answer; a failed run still posts a sanitized notice. Default false, which always " +
          "delivers the run's committed answer (or a fixed notice when it produced none).",
      })),
      job_id: Type.Optional(Type.String({
        description: "remove: the job ID from `list`.",
      })),
    }),
    // Every action is safe to rerun after an interrupted execution: `add` dedupes a retry on the
    // host's own tool-task identity, `list` only reads, and `remove` is idempotent because a second
    // cancel reports `already_terminal`. Declaring it safe keeps the call ID stable across recovery,
    // which is what makes that identity stable for a commit that succeeded without a committed result.
    replay: "safe",
    outputLimits: { maxBytes: 64 * 1024, maxLines: 1_000, retain: "head" },
    async execute(args, api, context) {
      let origin: CronToolOrigin | undefined;
      try {
        origin = await options.originFor(api.conversationId, context);
      } catch {
        // The host is an ordinary chat whose jobs cannot be placed where they belong right now. A
        // redirect that failed may follow a replay whose job is already committed, so this answer
        // never claims that nothing was scheduled and never carries the host's error text.
        return text(UNVERIFIED, true);
      }
      if (origin === undefined) {
        return text("Scheduling is not available in this conversation.", true);
      }
      const owner = origin.owner;
      const originId = origin.conversationId;
      // A redirected origin names itself in every receipt, so the model can tell the owner where the
      // job went instead of implying it lives in this conversation.
      const here = origin.label ?? "this conversation";
      const herePossessive = origin.label === undefined ? "this conversation's" : `${origin.label}'s`;
      const scheduled = origin.label === undefined ? "Scheduled." : `Scheduled in ${origin.label}.`;
      // A redirect reads and writes another conversation's job document. Its failures are reported as
      // fixed text instead of the exception's, which may carry host paths or a damaged record; only
      // an explicit request-validation error is actionable enough to quote back.
      const redirected = origin.label !== undefined;
      const actor: CronActor = { owner };
      let harness: Harness;
      try {
        harness = options.harness();
      } catch {
        return text("Scheduling is not available yet: the runtime is still starting.", true);
      }
      const writer: CronConversationWriter = {
        id: originId,
        commit: <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context) => harness.commit(change, ctx),
      };
      const request = args as unknown as CronToolArguments;
      if (request.action === "list") {
        let views: CronJobView[];
        try {
          views = await options.foundation.list(harness, originId, actor, context);
        } catch (error) {
          return text(redirected
            ? `Could not read scheduled jobs in ${here}. Nothing was changed.`
            : `Could not read scheduled jobs: ${reasonText(error)}`, true);
        }
        if (views.length === 0) return text(`No scheduled jobs in ${here}.`);
        return text(views.map(describe).join("\n\n"));
      }
      if (request.action === "remove") {
        const jobId = typeof request.job_id === "string" ? request.job_id.trim() : "";
        if (jobId === "") return text("remove requires job_id; use action `list` to see the IDs.", true);
        let result: CronCancellation;
        try {
          result = await options.foundation.cancel(harness, originId, jobId, actor, context);
        } catch (error) {
          // A thrown cancel may still have committed the cancellation before a task-abort or
          // withdrawal failure. Re-read the job before claiming failure: reporting a durable
          // cancellation as failed invites a pointless retry.
          const reason = reasonText(error);
          let view: CronJobView | undefined;
          try {
            view = await options.foundation.inspect(harness, originId, jobId, actor, context);
          } catch {
            view = undefined;
          }
          if (view !== undefined && view.job.cancelledAtMs !== null) {
            return text(
              `Cancelled ${jobId} (${view.job.name}). The cancellation is recorded, but cleaning up ` +
              `its queued work failed` + (redirected ? "." : `: ${reason}`),
            );
          }
          return text(redirected
            ? `Could not remove scheduled job ${jobId}. Check ${herePossessive} cron list before retrying.`
            : `Could not remove scheduled job ${jobId}: ${reason}`, true);
        }
        if (result.status === "not_found") return text(`No scheduled job ${jobId} in ${here}.`, true);
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
      if (intent === "digest" && !(options.digestAvailable?.(originId) ?? false)) {
        return text(
          "Memory digestion cannot be scheduled from this conversation: it needs an authenticated " +
          "mapped chat with read, write and edit in toolAllowlist and the configured background " +
          "model from digest.preset or digest.model. Nothing was scheduled.",
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
      if (request.silent !== undefined && typeof request.silent !== "boolean") {
        return text("silent must be true or false.", true);
      }
      // The request this call would store, built once so the pre-redirect replay check compares the
      // real payload. Its own validation errors are the only actionable failure text below.
      let add: CronScheduleInput;
      try {
        add = {
          message: intent === "digest" ? "Memory digestion run" : message,
          ...(request.name === undefined ? {} : { name: request.name }),
          schedule: scheduleOf(request, zone),
          mode: intent === "digest" || request.isolated === false ? "origin" : "background",
          intent,
          silent: request.silent === true,
          // A provider may reuse one tool-call ID in two threads. A non-redirected add stays keyed by
          // it, exactly as before, but a redirected add puts two threads' jobs in one document, so it
          // uses the host's own tool-task identity, in a namespace that can never collide with a
          // historical `tool:` key. A replay of the same execution keeps that task ID and still
          // dedupes.
          idempotencyKey: redirected ? `side:${api.taskId}` : `tool:${api.callId}`,
        };
      } catch (error) {
        return text(`Scheduling failed: ${reasonText(error)}`, true);
      }
      // A build before the redirect committed a job in this very conversation, keyed by the
      // provider's tool-call ID, and did not commit its result. A replay now resolves another
      // conversation's job document, so that commit is recognised here. It is not migrated: the job
      // stays in the caller's conversation.
      if (origin.callerOwner !== undefined) {
        const callerOwner = origin.callerOwner;
        let legacy: CronJobView | undefined;
        try {
          const views = await options.foundation.list(
            harness, api.conversationId, { owner: callerOwner }, context,
          );
          legacy = views.find((view) => view.job.idempotencyKey === `tool:${api.callId}`);
        } catch {
          // The caller's own jobs could not be read, so a replay cannot be told from a new add and a
          // previous commit cannot be ruled out. Refuse instead of risking a second job beside it.
          return text(UNVERIFIED, true);
        }
        if (legacy !== undefined) {
          // The key alone does not name the requested job: the old build also keyed a cancelled or
          // different request of the same call. Only an exact match may be reported as this job.
          if (cronJobMatchesRequest(legacy.job, add)) {
            return text(
              "This call already scheduled a job before this conversation's jobs moved to " +
              `${origin.label ?? "another conversation"}; it stays in this conversation.` +
              `\n\n${describe(legacy)}`,
            );
          }
          return text(
            "An earlier job with this call already exists in this conversation, so nothing new was " +
            `scheduled. It was not added to ${here}.`,
          );
        }
      }
      let receipt: CronScheduleReceipt;
      try {
        receipt = await options.foundation.schedule(actor, writer, add, context);
      } catch (error) {
        // Model-visible scheduling errors are actionable (bad expression, past time). They carry no
        // credentials or host paths: the schedule parser and request validator own the message text.
        if (redirected && !isRequestValidationError(error)) return text(UNVERIFIED, true);
        return text(`Scheduling failed: ${reasonText(error)}`, true);
      }
      // The job is durably created from here on. A failed follow-up read must not be reported as a
      // scheduling failure, because a retry would look like a new request (a new call ID).
      const when = iso(receipt.nextAtMs);
      let view: CronJobView | undefined;
      try {
        view = await options.foundation.inspect(harness, originId, receipt.jobId, actor, context);
      } catch {
        view = undefined;
      }
      if (view !== undefined) return text(`${scheduled}\n\n${describe(view)}`);
      return text(origin.label === undefined
        ? `Scheduled ${receipt.jobId}; first run at ${when}.`
        : `${scheduled} First run at ${when}.`);
    },
  });

  return { extension: defineExtension({ name: "nanobot.cron-tool", tools: [tool] }) };
}
