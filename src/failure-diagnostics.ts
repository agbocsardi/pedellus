import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "@earendil-works/pi-durable";
import { STARTUP_DIAGNOSTICS } from "./startup-diagnostics.js";

export type FailureStage = "command" | "gateway.open" | "gateway.local" | "gateway.telegram"
  | "gateway.discord" | "gateway.app" | "gateway.wait" | "gateway.close.local"
  | "gateway.close.runtime" | "gateway.lock" | "gateway.restart" | "gateway.observe"
  | "gateway.idleRollover"
  | `durable.${Report["kind"]}`;

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError",
  "AbortError", "TimeoutError", "ChordError", "StartupDiagnosticError", "LocalGatewayError",
  "TelegramApiError", "GrammyError", "HttpError", "DiscordTransportError", "SqliteError",
  "ReadAfterWrite", "StorageRequestError",
  "SessionFailed", "ReadOnlySession", "ConversationBusy", "ConversationIdle"]);
const CODES = new Set([...Object.keys(STARTUP_DIAGNOSTICS), "EACCES", "EPERM", "ENOENT", "ENOSPC", "EIO",
  "EMFILE", "ENFILE", "EADDRINUSE", "EADDRNOTAVAIL", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE",
  "ETIMEDOUT", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "ERR_SQLITE_ERROR", "SQLITE_BUSY",
  "SQLITE_LOCKED", "SQLITE_CORRUPT", "SQLITE_FULL", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_STATE",
  "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
const REASONS = new Set(["locked", "closed", "aborted", "cancelled", "unavailable", "interrupted", "timeout"]);
const METHODS = new Set(["getMe", "getUpdates", "setMyCommands", "getFile", "sendMessage", "sendRichMessage",
  "sendDocument", "sendPhoto", "sendAudio", "sendVoice", "sendVideo", "sendAnimation", "sendSticker",
  "sendMediaGroup", "editMessageText", "deleteMessage", "setMessageReaction", "sendChatAction"]);
const REPORT_REASONS = new Set(["threw", "restart_limit", "interrupted", "missing_task", "task_too_old", "migration_failed"]);

export interface FailureReportDetails {
  readonly reason?: unknown;
  readonly restarts?: unknown;
}
const REPORTED = new WeakSet<object>();

/** Only actual code locations in this checkout, never exception headers, function names or external paths. */
function codeLocations(stack: unknown): string[] {
  if (typeof stack !== "string") return [];
  const locations: string[] = [];
  for (const line of stack.slice(0, 16_384).split("\n").slice(1, 65)) {
    const match = line.match(/((?:file:\/\/\/|\/)[^()\n]+):(\d+):(\d+)\)?$/);
    if (match === null) continue;
    const absolute = match[1]!.startsWith("file:") ? fileURLToPath(match[1]!) : match[1]!;
    const file = relative(ROOT, absolute);
    if (isAbsolute(file) || !/^(?:src|dist|bin|node_modules)\/[A-Za-z0-9@_./-]+\.(?:[cm]?js|tsx?)$/.test(file)
      || file.split("/").includes("..") || file.length > 220) continue;
    // tsx/source maps can name unshipped SDK source files. Accept only the corresponding
    // installed compiled module, not arbitrary invented source paths in an exception header.
    const mappedSdk = /^node_modules\/@earendil-works\/(?:pi-durable|pi-ai|chord)\/src\/.+\.ts$/.test(file)
      && existsSync(resolve(ROOT, file.replace('/src/', '/dist/').replace(/\.ts$/, '.js')));
    if (!existsSync(absolute) && !mappedSdk) continue;
    locations.push(`${file}:${Number(match[2])}:${Number(match[3])}`);
    if (locations.length === 6) break;
  }
  return locations;
}

/** Durable's value-free invariants may be shown verbatim. Other messages can contain arbitrary tool/provider data. */
function durableMessage(message: unknown, locations: readonly string[]): string | undefined {
  if (typeof message !== "string" || !locations[0]?.startsWith("node_modules/@earendil-works/pi-durable/")) return undefined;
  if (/^(?:Session is closed|Transaction has settled|Session commit callback settled before its pending Tx operations|Not a Harness|The transaction belongs to another Session|Session failed after a storage error; close and reopen it|Invalid storage cursor|Storage\.entry\(\) requires an entry ID)$/.test(message)) return message;
  if (/^(?:Tx\.(?:conversation|entry|task|scanConversations|scanEntries|latestHeadMarker|latestEntryId|scanTasks|submission|submissionByRequest)\(\)|submit\(tx, draft\)) cannot read tables after the first table write$/.test(message)) return message;
  if (/^(?:Task|Conversation|Submission|Conversation owner task|Task owner) [0-9]{1,16} (?:does not exist|is terminal|is already terminal|cannot change conversations|already has a terminal candidate|is not queued|is not a placed input or continue|is not terminal|has a durable abort mark|is abort-marked|is busy|is idle)$/.test(message)) return message;
  if (/^Entry [0-9]{1,16} is not visible from conversation [0-9]{1,16}$/.test(message)) return message;
  if (/^(?:Unknown conversation: [0-9]{1,16}|Document [0-9]{1,16} does not retain historical content)$/.test(message)) return message;
  return undefined;
}

/** Bounded journal record. No arbitrary messages, request objects, credentials, URLs or transcript text. */
export function failureDiagnostic(error: unknown, stage: FailureStage, taskId?: number, report?: FailureReportDetails): string {
  const errors: Record<string, unknown>[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  try {
    while (queue.length > 0 && errors.length < 4) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      if (!(current instanceof Error)) { errors.push({ name: "NonError" }); continue; }
      const fields = current as Error & { code?: unknown; reason?: unknown; error?: unknown; errors?: unknown;
        status?: unknown; method?: unknown; errcode?: unknown };
      const locations = codeLocations(current.stack);
      const message = durableMessage(current.message, locations);
      // Read accessors once: a second getter value must not bypass the allowlist during serialization.
      const { name, code, reason, status, errcode, method, cause, error: transportError, errors: aggregate } = fields;
      errors.push({ name: NAMES.has(name) ? name : "Error",
        ...(typeof code === "string" && CODES.has(code) ? { code } : {}),
        ...(typeof reason === "string" && REASONS.has(reason) ? { reason } : {}),
        ...(typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 599 ? { status } : {}),
        ...(typeof errcode === "number" && Number.isInteger(errcode) && errcode >= 0 && errcode <= 255 ? { sqliteCode: errcode } : {}),
        ...(typeof method === "string" && METHODS.has(method) ? { method } : {}),
        ...(message === undefined ? {} : { message }), locations });
      if (cause !== undefined) queue.push(cause);
      // grammY's transport wrapper uses `error`, not the standard Error.cause.
      if (transportError instanceof Error) queue.push(transportError);
      if (current instanceof AggregateError && Array.isArray(aggregate)) queue.push(...aggregate.slice(0, 3));
    }
  } catch {
    if (errors.length < 4) errors.push({ name: "UninspectableError" });
  }
  const reason = report?.reason;
  const restarts = report?.restarts;
  const details = {
    ...(typeof reason === "string" && REPORT_REASONS.has(reason) ? { reason } : {}),
    ...(typeof restarts === "number" && Number.isSafeInteger(restarts) && restarts >= 0 && restarts <= 1_000_000 ? { restarts } : {}),
  };
  const fingerprint = createHash("sha256").update(JSON.stringify({ stage, reason: details.reason, errors })).digest("hex").slice(0, 16);
  return `pedellus diagnostic: ${JSON.stringify({ stage, fingerprint, ...details,
    ...(Number.isSafeInteger(taskId) && taskId! > 0 ? { taskId } : {}), errors })}`;
}

/** Log before cleanup can replace the primary failure; skip the same error when the CLI catches it again. */
export function reportFailure(error: unknown, stage: FailureStage, taskId?: number, report?: FailureReportDetails): void {
  try {
    const object = typeof error === "object" && error !== null ? error : undefined;
    if (object !== undefined && REPORTED.has(object) && !stage.startsWith("durable.")) return;
    console.error(failureDiagnostic(error, stage, taskId, report));
    // A failed formatter/sink must not suppress a later reporting attempt or replace the error.
    if (object !== undefined) REPORTED.add(object);
  } catch {
    // Best effort only: reporting must never prevent cleanup or change the primary exception.
  }
}
