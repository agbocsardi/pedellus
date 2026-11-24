/**
 * Minimal private protocol between the local gateway owner and a CLI/terminal surface.
 *
 * The transport is a filesystem-protected Unix socket inside the configured data
 * directory and a newline-delimited JSON request/response/event stream. It is not a
 * public listener, a general RPC framework or a second runtime: the gateway keeps
 * every Durable handle, root/state/fork conversation and model credential.
 */

import type { Cursor } from "@earendil-works/pi-durable";
import type { CronOperatorCancelOutcome, CronOperatorCreateOutcome, CronOperatorJob, CronOperatorListing, CronOperatorRow } from "../automation/operator.js";
import { CRON_OPERATOR_LIMITS } from "../automation/operator.js";
import type { CronScheduleInput } from "../automation/cron.js";
import type { BackgroundStatus } from "../background-status.js";
import type { AppDeviceListing, AppPairingCreated, AppPairingRefusal } from "../channels/app.js";
import type { AppShortcutCreated, AppShortcutListing, AppShortcutRefusal } from "../channels/app-shortcuts.js";
import type { HistoryEpisode, HistoryEpisodePage, HistoryEpisodeQuery } from "../history/episodes.js";
import type { HistoryPage, HistoryQuery } from "../history/index.js";
import type { MemoryDigestStartResult, MemoryDigestStatusView } from "../history/memory-digest.js";
import type { McpAdminListing, McpCallbackResult } from "../mcp/index.js";
import type { ModelReloadResult } from "../model-reload.js";
import { validAskQuestionView, type AskQuestionView } from "../questions/index.js";
import type {
  GatewayModelList,
  GatewayModelSelection,
  GatewayModelSelectionRequest,
  GatewaySessionReset,
} from "../runtime.js";
import type {
  TerminalAnswerText,
  TerminalEntryPage,
  TerminalEntryQuery,
  TerminalStatus,
} from "../terminal/conversation.js";

export const LOCAL_PROTOCOL_VERSION = 4;

export const LOCAL_PROTOCOL_LIMITS = Object.freeze({
  /** One request line; inputs are capped well below this by the CLI itself. */
  maxRequestLineBytes: 256 * 1024,
  /** One response line; entry pages are already projected and bounded. */
  maxResponseLineBytes: 4 * 1024 * 1024,
  /** Outstanding client requests before the client refuses more. */
  maxPendingRequests: 64,
  /** Buffered server snapshots before the oldest is dropped. */
  maxPendingSnapshots: 64,
  /** Bytes queued on one connection socket before a slow client is disconnected. */
  maxOutboundBytes: 8 * 1024 * 1024,
  /** Admitted prompt length, matching the terminal's own line bound. */
  maxInputChars: 32_000,
  /** One operator-supplied attachment path; the CLI may send a workspace-independent absolute path. */
  maxAttachmentPathChars: 4_096,
  maxEntryPage: 200,
  maxHistoryLimit: 50,
  maxConversationTokenChars: 32,
  maxLabelChars: 200,
  maxEntryId: Number.MAX_SAFE_INTEGER,
  /** One attach carries at most this many pending host notices, delivered once each. */
  maxNoticeIds: 8,
  maxNoticeTextChars: 512,
} as const);

/** Fixed error codes; the message never carries dependency or path text. */
export type LocalErrorCode = "invalid" | "busy" | "unavailable" | "failed";

export class LocalRequestError extends Error {
  override name = "LocalRequestError";
  readonly code: LocalErrorCode;
  constructor(code: LocalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The local endpoint cannot be used: another live owner holds it, the path cannot
 * be represented, or the gateway process cannot bind it. The CLI prints fixed text.
 */
export class LocalGatewayError extends Error {
  override name = "LocalGatewayError";
  constructor(readonly reason: "address" | "unavailable", message: string) {
    super(message);
  }
}

export interface LocalRequestEnvelope {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export interface LocalErrorBody {
  readonly code: LocalErrorCode;
  readonly message: string;
}

export type LocalServerMessage =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: LocalErrorBody }
  | { readonly event: "snapshot"; readonly snapshot: unknown }
  | { readonly event: "settled"; readonly id: number; readonly settlement: unknown }
  | { readonly event: "askQuestion"; readonly question: unknown }
  | { readonly event: "mcpAuthorization"; readonly authorization: unknown }
  | { readonly event: "mcpNotice"; readonly text: string };

type LocalEmpty = Readonly<Record<string, never>>;

export interface LocalHostNotice {
  readonly id: string;
  readonly text: string;
}

/** The attach handshake: protocol version, the one scoped conversation and its capability flags. */
export interface LocalAttachResult {
  readonly protocol: number;
  readonly sessionKey: string;
  readonly conversationId: number;
  readonly tools: readonly string[];
  readonly contextRefresh: boolean;
  readonly presets: boolean;
  readonly reload: boolean;
  readonly attachments: boolean;
  readonly digest: boolean;
  readonly mcp: boolean;
  readonly restart: boolean;
  readonly notices: readonly LocalHostNotice[];
  readonly questions: readonly AskQuestionView[];
}

export type LocalRevokeResult = "revoked" | "missing";

/**
 * Every request the local socket accepts, with its wire params and wire result. The server's handler
 * tables and the client's calls are both typed from this one map, so a method added, renamed or
 * reshaped on one side is a compile error on the other. Results are still untrusted on arrival: the
 * client checks each one with `LOCAL_RESULT_CHECKS` before use.
 */
export interface LocalProtocolMethods {
  attach: { params: { readonly conversation?: string }; result: LocalAttachResult };
  // Store-wide operator controls: reachable without an attach.
  cronList: { params: { readonly offset?: number }; result: CronOperatorListing };
  cronShow: { params: { readonly id: string }; result: { readonly jobs: CronOperatorJob[] } };
  cronCreate: { params: { readonly origin: string; readonly request: CronScheduleInput }; result: CronOperatorCreateOutcome };
  cronCancel: { params: { readonly id: string }; result: CronOperatorCancelOutcome };
  appPair: {
    params: { readonly label?: string };
    result: AppPairingCreated | { readonly refused: AppPairingRefusal };
  };
  appDevices: { params: LocalEmpty; result: { readonly devices: readonly AppDeviceListing[] } };
  appRevoke: { params: { readonly label: string }; result: { readonly result: LocalRevokeResult } };
  appShortcutAdd: {
    params: { readonly label: string };
    result: AppShortcutCreated | { readonly refused: AppShortcutRefusal };
  };
  appShortcutList: { params: LocalEmpty; result: { readonly shortcuts: readonly AppShortcutListing[] } };
  appShortcutRevoke: { params: { readonly label: string }; result: { readonly result: LocalRevokeResult } };
  // Attached-conversation requests.
  watch: { params: LocalEmpty; result: LocalEmpty };
  submit: { params: { readonly content: string }; result: { readonly id: number } };
  submitAttachment: {
    params: { readonly path: string; readonly content?: string };
    result: { readonly id: number; readonly attachment: { readonly relativePath: string; readonly bytes: number } };
  };
  submissionStatus: { params: { readonly id: number }; result: { readonly status: string } };
  answer: { params: { readonly entryId: number }; result: TerminalAnswerText };
  status: { params: LocalEmpty; result: TerminalStatus & { readonly background?: BackgroundStatus } };
  ackNotices: { params: { readonly ids: readonly string[] }; result: LocalEmpty };
  entries: {
    params: { readonly query: TerminalEntryQuery; readonly limit: number; readonly cursor?: Cursor };
    result: TerminalEntryPage;
  };
  compact: { params: LocalEmpty; result: { readonly taskId: number } };
  abort: { params: LocalEmpty; result: LocalEmpty };
  reset: { params: LocalEmpty; result: GatewaySessionReset };
  restart: { params: LocalEmpty; result: LocalEmpty };
  listModels: { params: LocalEmpty; result: GatewayModelList };
  selectModel: { params: { readonly selection: GatewayModelSelectionRequest }; result: GatewayModelSelection };
  selectModelPreset: { params: { readonly name: string }; result: GatewayModelSelection };
  reloadModels: { params: LocalEmpty; result: ModelReloadResult };
  refreshContext: { params: LocalEmpty; result: { readonly skills: number } };
  mcpList: { params: LocalEmpty; result: { readonly listing: McpAdminListing } };
  mcpCallback: { params: { readonly text: string }; result: McpCallbackResult };
  digestStart: { params: LocalEmpty; result: MemoryDigestStartResult };
  digestStatus: { params: LocalEmpty; result: MemoryDigestStatusView };
  historySearch: { params: { readonly query: HistoryQuery }; result: HistoryPage };
  historyEpisodes: {
    params: { readonly session?: string; readonly query?: HistoryEpisodeQuery };
    result: HistoryEpisodePage;
  };
  /** JSON has no `undefined`: a missing episode crosses the socket as `null`. */
  historyEpisode: { params: { readonly session?: string; readonly startEntryId: number }; result: HistoryEpisode | null };
  historyEntries: {
    params: {
      readonly session?: string;
      readonly query: TerminalEntryQuery;
      readonly limit: number;
      readonly cursor?: Cursor;
    };
    result: TerminalEntryPage;
  };
}

export type LocalMethod = keyof LocalProtocolMethods;
export type LocalParams<M extends LocalMethod> = LocalProtocolMethods[M]["params"];
export type LocalResult<M extends LocalMethod> = LocalProtocolMethods[M]["result"];

/** Requests served on the private socket without an attach; everything else needs one. */
export const LOCAL_OPERATOR_METHODS = Object.freeze([
  "cronList", "cronShow", "cronCreate", "cronCancel",
  "appPair", "appDevices", "appRevoke", "appShortcutAdd", "appShortcutList", "appShortcutRevoke",
] as const satisfies readonly LocalMethod[]);

export type LocalOperatorMethod = typeof LOCAL_OPERATOR_METHODS[number];
export type LocalSessionMethod = Exclude<LocalMethod, "attach" | LocalOperatorMethod>;

export function isLocalOperatorMethod(method: string): method is LocalOperatorMethod {
  return (LOCAL_OPERATOR_METHODS as readonly string[]).includes(method);
}

function unexpected(what: string): never {
  throw new LocalGatewayError("unavailable", `local gateway sent an unexpected ${what}`);
}

function resultObject(value: unknown, what: string): Record<string, unknown> {
  return asObject(value) ?? unexpected(what);
}

function safeId(value: unknown, what: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : unexpected(what);
}

function revokeResult(what: string) {
  return (value: unknown): { readonly result: LocalRevokeResult } => {
    const result = resultObject(value, what).result;
    if (result !== "revoked" && result !== "missing") unexpected(what);
    return { result };
  };
}

/**
 * Every job-view timestamp must be renderable before a success receipt: the operator renderer
 * prints `new Date(ms).toISOString()`, which throws beyond the platform date range. The producer
 * itself refuses dates outside this range (cron-schedule's MAX_DATE_MS), so the same bound here
 * accepts every same-version reply while rejecting one the terminal could not print.
 */
const RENDERABLE_DATE_MS = 8.64e15;

/** Count text in Unicode code points: the producer's `projectedLine` truncates by code point, so
 * a legal line with astral characters can be up to twice its limit in UTF-16 units. */
function codePointCount(value: string): number {
  return [...value].length;
}

/** One bounded timestamp field; `null` is the wire spelling of "none yet" and is always legal. */
function cronTimestamp(value: unknown, what: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > RENDERABLE_DATE_MS) {
    unexpected(what);
  }
  return value;
}

/** One projected text line, bounded in code points at the producer's own limit. Projected text
 * can legitimately be empty (control characters collapse), so only the bound is enforced. */
function projectedText(value: unknown, maxCodePoints: number, what: string): string {
  if (typeof value !== "string" || codePointCount(value) > maxCodePoints) unexpected(what);
  return value;
}

/** A generated or operator-supplied identifier: bounded in code points and never empty. */
function boundedId(value: unknown, maxCodePoints: number, what: string): string {
  if (typeof value !== "string" || codePointCount(value) === 0 || codePointCount(value) > maxCodePoints) {
    unexpected(what);
  }
  return value;
}

/** Every status the producer's job state machine can report; anything else is not renderable. */
const CRON_JOB_STATUSES = new Set([
  "pending", "running", "waiting", "sleeping", "completing", "completed", "failed", "aborted",
  "faulted", "orphaned", "parked", "missing", "scheduled", "queued", "cancelled", "stopped",
] as const);

function cronStatus(value: unknown, what: string): CronOperatorJob["status"] {
  if (typeof value !== "string" || !CRON_JOB_STATUSES.has(value as never)) unexpected(what);
  return value as CronOperatorJob["status"];
}

/** Optional projected error/reason text: `null` when absent, otherwise a bounded line. */
function cronOptionalText(value: unknown, what: string): string | null {
  if (value === null) return null;
  return projectedText(value, CRON_OPERATOR_LIMITS.maxErrorLineChars, what);
}

/** Task summaries a job view may carry; `null` means the task does not exist, and a task that
 * exists may not be placed yet (`scheduledAtMs: null`). */
function cronTaskSummary(value: unknown, what: string): CronOperatorJob["timer"] {
  if (value === null) return null;
  const task = resultObject(value, what);
  const taskId = cronTimestamp(task.taskId, what);
  if (taskId === null) unexpected(what);
  const scheduledAtMs = cronTimestamp(task.scheduledAtMs, what);
  return {
    taskId,
    status: cronStatus(task.status, what) as NonNullable<CronOperatorJob["timer"]>["status"],
    scheduledAtMs,
    error: cronOptionalText(task.error, what),
    reason: cronOptionalText(task.reason, what),
  };
}

/**
 * A job view exactly as the terminal renders it: every required field is checked against the
 * producer's own limits (`CRON_OPERATOR_LIMITS`, code-point text bounds, renderable timestamps,
 * the closed status set), so a same-version reply is always accepted while a malformed view fails
 * the call and the operator command holds its outcome as unknown instead of rendering a success
 * built from garbage.
 */
function cronJobView(value: unknown, what: string): CronOperatorJob {
  const job = resultObject(value, what);
  const lastOutcome = job.lastOutcome === null ? null : (() => {
    const record = resultObject(job.lastOutcome, what);
    if (record.status !== "ok" && record.status !== "error") unexpected(what);
    const outcomeStatus: "ok" | "error" = record.status;
    return {
      status: outcomeStatus,
      finishedAtMs: cronTimestamp(record.finishedAtMs, what) ?? unexpected(what),
      error: cronOptionalText(record.error, what),
    };
  })();
  const lastSkip = job.lastSkip === null ? null : (() => {
    const record = resultObject(job.lastSkip, what);
    return {
      skippedAtMs: cronTimestamp(record.skippedAtMs, what) ?? unexpected(what),
      reason: projectedText(record.reason, CRON_OPERATOR_LIMITS.maxErrorLineChars, what),
    };
  })();
  const lastFault = job.lastFault === null ? null : (() => {
    const record = resultObject(job.lastFault, what);
    return {
      recordedAtMs: cronTimestamp(record.recordedAtMs, what) ?? unexpected(what),
      error: projectedText(record.error, CRON_OPERATOR_LIMITS.maxErrorLineChars, what),
    };
  })();
  const deliveryFault = job.deliveryFault === null ? null : (() => {
    const record = resultObject(job.deliveryFault, what);
    return {
      recordedAtMs: cronTimestamp(record.recordedAtMs, what) ?? unexpected(what),
      message: projectedText(record.message, CRON_OPERATOR_LIMITS.maxErrorLineChars, what),
    };
  })();
  const target = job.target === null ? null : (() => {
    const record = resultObject(job.target, what);
    const taskId = cronTimestamp(record.taskId, what);
    if (taskId === null) unexpected(what);
    return {
      taskId,
      status: cronStatus(record.status, what) as NonNullable<CronOperatorJob["target"]>["status"],
      error: cronOptionalText(record.error, what),
      reason: cronOptionalText(record.reason, what),
    };
  })();
  const mode = job.mode;
  if (mode !== "background" && mode !== "origin") unexpected(what);
  const intent = job.intent;
  if (intent !== "message" && intent !== "digest") unexpected(what);
  return {
    id: boundedId(job.id, CRON_OPERATOR_LIMITS.maxJobIdChars, what),
    origin: boundedId(job.origin, CRON_OPERATOR_LIMITS.maxSessionKeyChars, what),
    name: projectedText(job.name, CRON_OPERATOR_LIMITS.maxNameChars, what),
    mode,
    intent,
    schedule: projectedText(job.schedule, CRON_OPERATOR_LIMITS.maxMessageLineChars, what),
    status: cronStatus(job.status, what),
    nextAtMs: cronTimestamp(job.nextAtMs, what),
    message: projectedText(job.message, CRON_OPERATOR_LIMITS.maxMessageLineChars, what),
    lastOutcome,
    lastSkip,
    lastFault,
    deliveryFault,
    timer: cronTaskSummary(job.timer, what),
    execution: cronTaskSummary(job.execution, what),
    target,
  };
}

function cronJobOrNull(value: unknown, what: string): CronOperatorJob | null {
  return value === null ? null : cronJobView(value, what);
}

/** The create reply's required fields; a wrong shape fails the call instead of printing a success. */
function cronCreateOutcome(value: unknown, what: string): CronOperatorCreateOutcome {
  const result = resultObject(value, what);
  if (result.status === "unknown_origin") return { status: "unknown_origin" };
  if (result.status !== "scheduled") unexpected(what);
  const jobId = boundedId(result.jobId, CRON_OPERATOR_LIMITS.maxJobIdChars, what);
  const nextAtMs = cronTimestamp(result.nextAtMs, what);
  if (typeof result.deduplicated !== "boolean") unexpected(what);
  return {
    status: "scheduled",
    job: cronJobOrNull(result.job, what),
    jobId,
    nextAtMs,
    deduplicated: result.deduplicated,
  };
}

/** The cancel reply's required fields, per outcome. */
function cronCancelOutcome(value: unknown, what: string): CronOperatorCancelOutcome {
  const result = resultObject(value, what);
  switch (result.status) {
    case "not_found":
    case "ambiguous":
    case "forbidden":
      return { status: result.status };
    case "already_terminal":
      return { status: "already_terminal", job: cronJobView(result.job, what) };
    case "cancelled": {
      const withdrawn = result.withdrawn;
      if (withdrawn !== null && withdrawn !== undefined
        && withdrawn !== "aborted" && withdrawn !== "already_placed" && withdrawn !== "settled" && withdrawn !== "not_found") {
        unexpected(what);
      }
      const abortError = result.abortError;
      if (abortError !== null && abortError !== undefined
        && (typeof abortError !== "string" || codePointCount(abortError) > CRON_OPERATOR_LIMITS.maxErrorLineChars)) {
        unexpected(what);
      }
      return {
        status: "cancelled",
        job: cronJobOrNull(result.job, what),
        withdrawn: withdrawn ?? null,
        abortError: abortError ?? null,
      };
    }
    default:
      unexpected(what);
  }
}

function labelledRows<T>(key: string, what: string) {
  return (value: unknown): T[] => {
    const rows = resultObject(value, what)[key];
    if (!Array.isArray(rows) || rows.some((entry) => {
      const row = asObject(entry);
      return row === undefined || typeof row.label !== "string" || typeof row.createdAtMs !== "number";
    })) unexpected(what);
    return rows as T[];
  };
}

/**
 * A result whose detailed shape is presentation data the terminal renders defensively; the
 * transport only requires the JSON object the server always sends.
 */
function objectResult<T>(what: string) {
  return (value: unknown): T => resultObject(value, what) as T;
}

function attachResult(value: unknown): LocalAttachResult {
  const what = "attach result";
  const result = resultObject(value, what);
  if (result.protocol !== LOCAL_PROTOCOL_VERSION) {
    throw new LocalGatewayError("unavailable", "local gateway protocol mismatch");
  }
  if (typeof result.sessionKey !== "string" || result.sessionKey.length === 0
    || !Number.isSafeInteger(result.conversationId)) unexpected(what);
  const tools = result.tools;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) unexpected(what);
  const questions = result.questions ?? [];
  if (!Array.isArray(questions) || questions.some((entry) => !validAskQuestionView(entry))) unexpected(what);
  const notices = result.notices ?? [];
  if (!Array.isArray(notices) || notices.length > LOCAL_PROTOCOL_LIMITS.maxNoticeIds) unexpected(what);
  return {
    protocol: LOCAL_PROTOCOL_VERSION,
    sessionKey: result.sessionKey as string,
    conversationId: result.conversationId as number,
    tools: tools as string[],
    contextRefresh: result.contextRefresh === true,
    presets: result.presets === true,
    reload: result.reload === true,
    attachments: result.attachments === true,
    digest: result.digest === true,
    mcp: result.mcp === true,
    restart: result.restart === true,
    questions: questions as AskQuestionView[],
    notices: notices.map((entry) => {
      const notice = asObject(entry);
      if (notice === undefined || typeof notice.id !== "string" || notice.id.length === 0
        || typeof notice.text !== "string" || notice.text.trim() === ""
        || notice.text.length > LOCAL_PROTOCOL_LIMITS.maxNoticeTextChars) unexpected(what);
      return { id: notice.id as string, text: notice.text as string };
    }),
  };
}

/**
 * The client's trust boundary: one check per method, applied to every result before use. A wrong
 * shape fails the call with a fixed `unavailable` diagnostic and never reaches the terminal.
 */
export const LOCAL_RESULT_CHECKS: { readonly [M in LocalMethod]: (value: unknown) => LocalResult<M> } = Object.freeze({
  attach: attachResult,
  cronList: (value: unknown) => {
    const what = "job listing";
    const result = resultObject(value, what);
    if (!Array.isArray(result.origins)
      || result.origins.some((entry) => typeof entry !== "string"
        || codePointCount(entry) === 0 || codePointCount(entry) > CRON_OPERATOR_LIMITS.maxSessionKeyChars)) {
      unexpected(what);
    }
    // The producer pages `list` at its own row bound; `show` below is unbounded by design.
    if (!Array.isArray(result.jobs) || result.jobs.length > CRON_OPERATOR_LIMITS.maxListRows) {
      unexpected(what);
    }
    const total = result.total;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) unexpected(what);
    const nextOffset = result.nextOffset;
    if (nextOffset !== null && nextOffset !== undefined
      && (typeof nextOffset !== "number" || !Number.isSafeInteger(nextOffset) || nextOffset < 0)) unexpected(what);
    return {
      origins: result.origins as string[],
      jobs: result.jobs.map((row) => {
        const record = resultObject(row, what);
        return {
          id: boundedId(record.id, CRON_OPERATOR_LIMITS.maxJobIdChars, what),
          origin: boundedId(record.origin, CRON_OPERATOR_LIMITS.maxSessionKeyChars, what),
          name: projectedText(record.name, CRON_OPERATOR_LIMITS.maxNameChars, what),
          schedule: projectedText(record.schedule, CRON_OPERATOR_LIMITS.maxMessageLineChars, what),
          status: cronStatus(record.status, what) as CronOperatorRow["status"],
          nextAtMs: cronTimestamp(record.nextAtMs, what),
        };
      }),
      total,
      nextOffset: nextOffset ?? null,
    };
  },
  cronShow: (value: unknown) => {
    // One exact job id can be recorded under several origins, so the producer caps nothing here.
    const jobs = resultObject(value, "job listing").jobs;
    if (!Array.isArray(jobs)) unexpected("job listing");
    return { jobs: jobs.map((job) => cronJobView(job, "job listing")) };
  },
  cronCreate: (value: unknown) => cronCreateOutcome(value, "job result"),
  cronCancel: (value: unknown) => cronCancelOutcome(value, "job result"),
  appPair: (value: unknown) => {
    const what = "pairing result";
    const result = resultObject(value, what);
    if (typeof result.refused === "string") {
      if (result.refused !== "label-in-use" && result.refused !== "device-limit"
        && result.refused !== "pairing-limit" && result.refused !== "invalid-label") unexpected(what);
      return { refused: result.refused as AppPairingRefusal };
    }
    if (typeof result.code !== "string" || typeof result.expiresAtMs !== "number") unexpected(what);
    return { code: result.code, expiresAtMs: result.expiresAtMs };
  },
  appDevices: (value: unknown) => ({ devices: labelledRows<AppDeviceListing>("devices", "device listing")(value) }),
  appRevoke: revokeResult("revoke result"),
  appShortcutAdd: (value: unknown) => {
    const what = "shortcut result";
    const result = resultObject(value, what);
    if (typeof result.refused === "string") {
      if (result.refused !== "invalid-label" && result.refused !== "label-in-use"
        && result.refused !== "shortcut-limit") unexpected(what);
      return { refused: result.refused as AppShortcutRefusal };
    }
    if (typeof result.token !== "string" || typeof result.label !== "string"
      || typeof result.createdAtMs !== "number") unexpected(what);
    return { label: result.label, token: result.token, createdAtMs: result.createdAtMs };
  },
  appShortcutList: (value: unknown) => ({
    shortcuts: labelledRows<AppShortcutListing>("shortcuts", "shortcut listing")(value),
  }),
  appShortcutRevoke: revokeResult("shortcut revoke result"),
  watch: objectResult<LocalEmpty>("watch result"),
  submit: (value: unknown) => ({ id: safeId(resultObject(value, "submission").id, "submission") }),
  submitAttachment: (value: unknown) => {
    const what = "attachment submission";
    const result = resultObject(value, what);
    const id = result.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) unexpected(what);
    const attachment = asObject(result.attachment);
    const relativePath = attachment?.relativePath;
    const bytes = attachment?.bytes;
    if (typeof relativePath !== "string" || relativePath.length === 0
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) unexpected(what);
    return { id, attachment: { relativePath, bytes } };
  },
  submissionStatus: (value: unknown) => {
    const status = resultObject(value, "submission status").status;
    if (typeof status !== "string") unexpected("submission status");
    return { status };
  },
  answer: (value: unknown) => {
    const result = resultObject(value, "answer");
    if (typeof result.text !== "string") unexpected("answer");
    return result as unknown as TerminalAnswerText;
  },
  status: objectResult<LocalResult<"status">>("status"),
  ackNotices: objectResult<LocalEmpty>("acknowledgement"),
  entries: objectResult<TerminalEntryPage>("entry page"),
  compact: (value: unknown) => ({ taskId: safeId(resultObject(value, "compaction result").taskId, "compaction result") }),
  abort: objectResult<LocalEmpty>("abort result"),
  reset: (value: unknown) => {
    const result = resultObject(value, "reset result");
    if (result.status !== "reset" && result.status !== "busy") unexpected("reset result");
    return result as unknown as GatewaySessionReset;
  },
  restart: objectResult<LocalEmpty>("restart result"),
  listModels: objectResult<GatewayModelList>("model list"),
  selectModel: objectResult<GatewayModelSelection>("model selection"),
  selectModelPreset: objectResult<GatewayModelSelection>("model selection"),
  reloadModels: objectResult<ModelReloadResult>("reload result"),
  refreshContext: (value: unknown) => {
    const skills = resultObject(value, "context refresh").skills;
    if (typeof skills !== "number") unexpected("context refresh");
    return { skills };
  },
  mcpList: (value: unknown) => ({ listing: resultObject(resultObject(value, "MCP listing").listing, "MCP listing") as unknown as McpAdminListing }),
  mcpCallback: objectResult<McpCallbackResult>("MCP callback result"),
  digestStart: objectResult<MemoryDigestStartResult>("digest result"),
  digestStatus: objectResult<MemoryDigestStatusView>("digest status"),
  historySearch: objectResult<HistoryPage>("history page"),
  historyEpisodes: objectResult<HistoryEpisodePage>("episode page"),
  historyEpisode: (value: unknown) => value === null ? null : objectResult<HistoryEpisode>("episode")(value),
  historyEntries: objectResult<TerminalEntryPage>("entry page"),
});

/** Parse one request line into a bounded envelope; reject everything else. */
export function parseRequestLine(line: string): LocalRequestEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LocalRequestError("invalid", "request is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalRequestError("invalid", "request must be an object");
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new LocalRequestError("invalid", "request id must be a positive integer");
  }
  const method = record.method;
  if (typeof method !== "string" || !/^[a-z][a-zA-Z]{0,31}$/.test(method)) {
    throw new LocalRequestError("invalid", "request method is not accepted");
  }
  return { id, method, params: record.params };
}

/** Parse one server line; unknown shapes are refused by the client. */
export function parseServerLine(line: string): LocalServerMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LocalGatewayError("unavailable", "local gateway sent malformed JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalGatewayError("unavailable", "local gateway sent an unexpected message");
  }
  const record = value as Record<string, unknown>;
  if (record.event === "snapshot" && Object.hasOwn(record, "snapshot")) {
    return { event: "snapshot", snapshot: record.snapshot };
  }
  if (record.event === "settled" && typeof record.id === "number" && Number.isSafeInteger(record.id) && Object.hasOwn(record, "settlement")) {
    return { event: "settled", id: record.id, settlement: record.settlement };
  }
  if (record.event === "askQuestion" && Object.hasOwn(record, "question")) {
    return { event: "askQuestion", question: record.question };
  }
  if (record.event === "mcpAuthorization" && Object.hasOwn(record, "authorization")) {
    return { event: "mcpAuthorization", authorization: record.authorization };
  }
  if (record.event === "mcpNotice" && typeof record.text === "string") {
    return { event: "mcpNotice", text: record.text };
  }
  if (typeof record.id === "number" && Number.isSafeInteger(record.id) && record.id >= 1) {
    if (Object.hasOwn(record, "error")) {
      const error = asObject(record.error);
      const code = error?.code;
      const message = error?.message;
      if (code !== "invalid" && code !== "busy" && code !== "unavailable" && code !== "failed") {
        throw new LocalGatewayError("unavailable", "local gateway sent an unexpected error");
      }
      if (typeof message !== "string") {
        throw new LocalGatewayError("unavailable", "local gateway sent an unexpected error");
      }
      return { id: record.id, error: { code, message } };
    }
    if (Object.hasOwn(record, "result")) return { id: record.id, result: record.result };
  }
  throw new LocalGatewayError("unavailable", "local gateway sent an unexpected message");
}

/** CLI conversation name (`cli:<name>`), shared by `pedellus agent --conversation` and the attach request. */
export const CONVERSATION_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,30})[a-z0-9]$|^[a-z0-9]$/;

/** An absent name is the historical `cli:default` conversation. */
export function conversationToken(value: unknown): string {
  if (value === undefined) return "default";
  if (typeof value !== "string" || value.length > LOCAL_PROTOCOL_LIMITS.maxConversationTokenChars
    || !CONVERSATION_NAME_PATTERN.test(value)) {
    throw new LocalRequestError("invalid", "conversation name is not accepted");
  }
  return value;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function requireObject(value: unknown): Record<string, unknown> {
  const record = asObject(value);
  if (record === undefined) throw new LocalRequestError("invalid", "request parameters must be an object");
  return record;
}

export function requireString(record: Record<string, unknown>, key: string, maxChars: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new LocalRequestError("invalid", `${key} is not accepted`);
  }
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string, maxChars: number): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new LocalRequestError("invalid", `${key} is not accepted`);
  }
  return value;
}

export function requireInteger(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new LocalRequestError("invalid", `${key} is not accepted`);
  }
  return value;
}

export function optionalCursor(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const cursor = asObject(value);
  if (cursor === undefined) throw new LocalRequestError("invalid", `${key} is not accepted`);
  return cursor;
}

/** Bounded host-notice record ids acknowledged after an attach printed them. */
export function noticeIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > LOCAL_PROTOCOL_LIMITS.maxNoticeIds || value.length === 0) {
    throw new LocalRequestError("invalid", "ids is not accepted");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 200) {
      throw new LocalRequestError("invalid", "ids is not accepted");
    }
    return entry;
  });
}

export function errorBody(error: unknown): LocalErrorBody {
  if (error instanceof LocalRequestError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === "ConversationBusy") {
    return { code: "busy", message: "conversation is busy" };
  }
  return { code: "failed", message: "operation failed" };
}
