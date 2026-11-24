/**
 * The terminal's operator console for scheduled work.
 *
 * It is a process subcommand (`pedellus cron ...`), not a chat slash command: the owner
 * runs it from a shell, and it attaches to the running gateway over the existing private socket.
 * The gateway decides every authority question — which chats exist, which actor owns a job, what
 * a cancellation did — and this module only parses flags, sends one bounded request and renders
 * the answer. A lost response is reported as an unknown outcome instead of a made-up result.
 */
import type { Context } from "@earendil-works/chord";
import type { CronScheduleInput, CronWithdrawal } from "./cron.js";
import { parseCronInstant, type CronScheduleRequest } from "./cron-schedule.js";
import {
  CRON_OPERATOR_LIMITS,
  CronOperatorInputError,
  parseCronOperatorRequest,
  type CronOperatorCancelOutcome,
  type CronOperatorCreateOutcome,
  type CronOperatorJob,
  type CronOperatorListing,
  type CronOperatorRow,
} from "./operator.js";
import { commandUsage, findCommandHelp, renderCommandHelp } from "../help/cli.js";
import { LocalRemoteError, type LocalGatewayClient } from "../local/client.js";

/** A refusal or failure to report as `pedellus cron: <message>`; exit status 1. */
export class CronCommandError extends Error {
  override name = "CronCommandError";
}

/** A malformed invocation; the command's own help page is the whole diagnostic. */
export class CronUsageError extends Error {
  override name = "CronUsageError";
}

export type CronCommand =
  | { readonly kind: "list"; readonly offset?: number }
  | { readonly kind: "show"; readonly jobId: string }
  | { readonly kind: "cancel"; readonly jobId: string }
  | {
      readonly kind: "create";
      /** Explicit mapped chat; never implicitly creates a conversation. */
      readonly origin: string;
      readonly request: CronScheduleInput;
    };

export interface CronInvocation {
  readonly command: CronCommand;
  /** Explicit `--config` path; absent means the fixed runtime-home default. */
  readonly configPath?: string;
}

const ACTIONS = new Set(["list", "show", "cancel", "create"]);
/** Printable, non-space tokens; the exact length is the host's own limit. */
const TOKEN = /^[\x21-\x7e]+$/;
const SECONDS = /^[1-9][0-9]{0,15}$/;

function usage(): CronUsageError {
  const page = findCommandHelp("cron");
  return new CronUsageError(page === undefined ? commandUsage("cron") : renderCommandHelp(page));
}

function refused(message: string): CronCommandError {
  return new CronCommandError(message);
}

/** Seconds as a positive whole number, bounded by the safe integer range in milliseconds. */
function seconds(raw: string, flag: string): number {
  const value = Number(raw);
  if (!SECONDS.test(raw) || !Number.isSafeInteger(value * 1000)) {
    throw refused(`${flag} takes a positive whole number of seconds.`);
  }
  return value * 1000;
}

/** One schedule flag into the foundation's own request vocabulary. */
function scheduleOf(flags: Map<string, string>): CronScheduleRequest {
  const selected = ["--at", "--after", "--every", "--cron"].filter((flag) => flags.has(flag));
  if (selected.length !== 1) {
    throw refused("create requires exactly one of --at, --after, --every or --cron.");
  }
  if (flags.has("--tz") && !flags.has("--cron")) throw refused("--tz only applies to --cron.");
  if (flags.has("--at")) return { kind: "at", at: instant(flags.get("--at")!) };
  if (flags.has("--after")) return { kind: "after", afterMs: seconds(flags.get("--after")!, "--after") };
  if (flags.has("--every")) return { kind: "every", everyMs: seconds(flags.get("--every")!, "--every") };
  return {
    kind: "cron",
    expr: flags.get("--cron")!,
    ...(flags.has("--tz") ? { timeZone: flags.get("--tz")! } : {}),
  };
}

function instant(raw: string): number {
  try {
    return parseCronInstant(raw);
  } catch (error) {
    throw refused(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Parse one process invocation. Flags are read the same way for every action and then checked
 * against that action's exact set, so an option is never silently ignored.
 */
export function parseCronInvocation(args: readonly string[]): CronInvocation {
  const [action, ...rest] = args;
  if (action === undefined || !ACTIONS.has(action)) throw usage();
  const allowed = action === "create"
    ? new Set(["--config", "--origin", "--key", "--message", "--name", "--mode", "--at", "--after", "--every", "--cron", "--tz"])
    : new Set(action === "list" ? ["--config", "--offset"] : ["--config"]);
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length;) {
    const flag = rest[index]!;
    if (!flag.startsWith("--")) {
      positional.push(flag);
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (!allowed.has(flag) || value === undefined || flags.has(flag)) throw usage();
    flags.set(flag, value);
    index += 2;
  }
  const configPath = flags.get("--config");
  if (configPath === "") throw usage();

  if (action === "list") {
    if (positional.length > 0) throw usage();
    const rawOffset = flags.get("--offset");
    if (rawOffset !== undefined && (!/^[0-9]+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset)))) throw usage();
    return { command: { kind: "list", ...(rawOffset === undefined ? {} : { offset: Number(rawOffset) }) },
      ...(configPath === undefined ? {} : { configPath }) };
  }
  if (action === "show" || action === "cancel") {
    const [jobId, ...extra] = positional;
    if (jobId === undefined || extra.length > 0
      || jobId.length > CRON_OPERATOR_LIMITS.maxJobIdChars || !TOKEN.test(jobId)) {
      throw usage();
    }
    return {
      command: action === "show" ? { kind: "show", jobId } : { kind: "cancel", jobId },
      ...(configPath === undefined ? {} : { configPath }),
    };
  }

  if (positional.length > 0) throw usage();
  const origin = flags.get("--origin");
  if (origin !== undefined && (origin.length > CRON_OPERATOR_LIMITS.maxSessionKeyChars || !TOKEN.test(origin))) {
    throw refused("--origin must be one mapped chat session key.");
  }
  const key = flags.get("--key");
  const message = flags.get("--message");
  if (origin === undefined || key === undefined || message === undefined) {
    throw refused("create requires --origin, --key and --message.");
  }
  const mode = flags.get("--mode");
  let request: CronScheduleInput;
  try {
    request = parseCronOperatorRequest({
      message,
      idempotencyKey: key,
      ...(flags.has("--name") ? { name: flags.get("--name") } : {}),
      ...(mode === undefined ? {} : { mode }),
      schedule: scheduleOf(flags),
    });
  } catch (error) {
    if (error instanceof CronOperatorInputError) throw refused(error.message);
    throw error;
  }
  return {
    command: { kind: "create", origin, request },
    ...(configPath === undefined ? {} : { configPath }),
  };
}

const iso = (ms: number | null): string => (ms === null ? "none" : new Date(ms).toISOString());

/** One compact line per job in the bounded page. */
function jobLine(job: CronOperatorRow): string {
  return `${job.id}  ${job.status}  next ${iso(job.nextAtMs)}  ${job.origin}  ${job.name}  (${job.schedule})`;
}

export function renderCronList(listing: CronOperatorListing): string {
  const { jobs, origins } = listing;
  const chats = new Set(jobs.map((job) => job.origin)).size;
  const heading = jobs.length === 0
    ? (listing.total === 0 ? "No scheduled jobs." : `No jobs at this offset; ${listing.total} total. Run cron list to start again.`)
    : `${jobs.length} cron ${jobs.length === 1 ? "job" : "jobs"} in ${chats} ${chats === 1 ? "chat" : "chats"}` +
      (listing.total > jobs.length ? ` on this page (${listing.total} total):` : ":");
  return [
    heading,
    ...jobs.map(jobLine),
    ...(listing.nextOffset === null ? [] : [`${listing.total} jobs total. Next page: pedellus cron list --offset ${listing.nextOffset}`]),
    `Mapped chats: ${origins.length === 0 ? "none" : origins.join(", ")}`,
  ].join("\n");
}

/** One job's fixed facts, including the bounded message line the operator scheduled. */
export function renderCronJob(job: CronOperatorJob): string {
  const lines = [
    `${job.id}  ${job.name}`,
    `  origin: ${job.origin}`,
    `  schedule: ${job.schedule}`,
    `  mode: ${job.mode}${job.intent === "digest" ? "  intent: digest" : ""}`,
    `  status: ${job.status}`,
    `  next: ${iso(job.nextAtMs)}`,
    `  message: ${job.message}`,
  ];
  if (job.lastOutcome !== null) {
    lines.push(`  last run: ${job.lastOutcome.status} at ${iso(job.lastOutcome.finishedAtMs)}` +
      (job.lastOutcome.error === null ? "" : ` (${job.lastOutcome.error})`));
  }
  if (job.lastSkip !== null) lines.push(`  last skipped: ${iso(job.lastSkip.skippedAtMs)} (${job.lastSkip.reason})`);
  if (job.lastFault !== null) lines.push(`  last failure: ${iso(job.lastFault.recordedAtMs)} (${job.lastFault.error})`);
  if (job.deliveryFault !== null) {
    lines.push(`  last delivery fault: ${iso(job.deliveryFault.recordedAtMs)} (${job.deliveryFault.message})`);
  }
  for (const [label, task] of [["timer task", job.timer], ["run task", job.execution]] as const) {
    if (task === null) continue;
    const detail = task.error ?? task.reason;
    lines.push(`  ${label} ${task.taskId}: ${task.status}` +
      (task.scheduledAtMs === null ? "" : ` for ${iso(task.scheduledAtMs)}`) +
      (detail === null ? "" : ` (${detail})`));
  }
  if (job.target !== null) {
    const detail = job.target.error ?? job.target.reason;
    lines.push(`  run target ${job.target.taskId}: ${job.target.status}` + (detail === null ? "" : ` (${detail})`));
  }
  return lines.join("\n");
}

function withdrawalText(withdrawn: CronWithdrawal | null): string {
  if (withdrawn === "aborted") return " A queued run was withdrawn before it started.";
  if (withdrawn === "already_placed") return " A run was already placed and may still finish.";
  if (withdrawn === "settled") return " The last run had already finished.";
  return "";
}

/** A gateway refusal is definitive; anything else may have changed the store before it was lost. */
function definitive(error: unknown): error is LocalRemoteError {
  return error instanceof LocalRemoteError && (error.code === "invalid" || error.code === "unavailable");
}

function unknownOutcome(command: CronCommand): CronCommandError {
  return command.kind === "create"
    ? refused(
      "the gateway did not answer, so the outcome is unknown: the job may have been created. " +
      "Re-run the identical create command with the same --key; an identical retry dedupes and changes nothing.",
    )
    : refused(
      "the gateway did not answer, so the outcome is unknown: the cancellation may already be recorded. " +
      "Run `pedellus cron show <jobId>` before retrying.",
    );
}

export interface CronCommandOptions {
  readonly client: LocalGatewayClient;
  readonly command: CronCommand;
  readonly output: { write(text: string): unknown };
  readonly context: Context;
}

/** Send one operator request and print its result; throws `CronCommandError` on any refusal. */
export async function runCronCommand(options: CronCommandOptions): Promise<void> {
  const { client, command, output, context } = options;
  if (command.kind === "list" || command.kind === "show") {
    try {
      if (command.kind === "list") {
        output.write(`${renderCronList(await client.cronList(context, command.offset))}\n`);
        return;
      }
      const jobs = await client.cronShow(command.jobId, context);
      if (jobs.length === 0) throw refused(`no scheduled job with id ${command.jobId}.`);
      output.write(`${jobs.map(renderCronJob).join("\n\n")}\n`);
      return;
    } catch (error) {
      if (error instanceof CronCommandError) throw error;
      throw refused(error instanceof LocalRemoteError
        ? error.message
        : "the gateway did not answer; nothing was read.");
    }
  }

  if (command.kind === "cancel") {
    let result: CronOperatorCancelOutcome;
    try {
      result = await client.cronCancel(command.jobId, context);
    } catch (error) {
      if (definitive(error)) throw refused(`${error.message.replace(/[.\s]+$/, "")}. Nothing was cancelled.`);
      throw unknownOutcome(command);
    }
    if (result.status === "not_found") throw refused(`no scheduled job with id ${command.jobId}.`);
    if (result.status === "ambiguous") {
      throw refused(`job ${command.jobId} is recorded under more than one chat; refusing to cancel anything.`);
    }
    if (result.status === "forbidden") {
      throw refused(`job ${command.jobId} belongs to another owner; refusing to cancel anything.`);
    }
    if (result.status === "already_terminal") {
      output.write(`Job ${command.jobId} is already finished or cancelled; nothing to cancel.\n\n` +
        `${renderCronJob(result.job)}\n`);
      return;
    }
    const cleanup = result.abortError === null
      ? ""
      : ` The cancellation is recorded, but cleaning up its queued work failed: ${result.abortError}`;
    output.write(`Cancelled ${command.jobId}.\n`);
    const notes = `${withdrawalText(result.withdrawn)}${cleanup}`.trim();
    if (notes !== "") output.write(`${notes}\n`);
    if (result.job !== null) output.write(`\n${renderCronJob(result.job)}\n`);
    return;
  }

  const origin = command.origin;
  let result: CronOperatorCreateOutcome;
  try {
    result = await client.cronCreate(origin, command.request, context);
  } catch (error) {
    if (definitive(error)) throw refused(`${error.message.replace(/[.\s]+$/, "")}. Nothing was scheduled.`);
    throw unknownOutcome(command);
  }
  if (result.status === "unknown_origin") {
    throw refused(`"${origin}" is not a mapped chat; nothing was scheduled. Run \`pedellus cron list\` to see the mapped chats.`);
  }
  if (!result.deduplicated) {
    output.write(result.job === null
      ? `Scheduled ${result.jobId}; next run ${iso(result.nextAtMs)}.\n`
      : `Scheduled on ${result.job.origin}.\n\n${renderCronJob(result.job)}\n`);
    return;
  }
  if (result.job !== null && result.job.status === "cancelled") {
    output.write(
      `Request key ${command.request.idempotencyKey} already created ${result.jobId}, which is cancelled; ` +
      `nothing was scheduled and it will not be re-armed.\n\n${renderCronJob(result.job)}\n`,
    );
    return;
  }
  output.write(result.job === null
    ? `Already created as ${result.jobId} by the same request key; this retry changed nothing.\n`
    : `Already created as ${result.jobId} by the same request key; this retry changed nothing.\n\n` +
      `${renderCronJob(result.job)}\n`);
}
