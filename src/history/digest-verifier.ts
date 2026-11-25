/**
 * Digest run accounting and the post-turn audit, both derived only from Durable's committed
 * transcript.
 *
 * Usage accounting folds a digest conversation's committed responses, tool calls and results into
 * one tally. The call-time scope hook extends a per-conversation tally incrementally; the outcome and
 * status accounting re-read the whole bounded transcript. The committed-turn audit decides whether a
 * settled turn may acknowledge its batch: a failed read is harmless, a failed write/edit needs a
 * verified same-operation repair, and a host budget/usage refusal is fatal. Nothing here trusts
 * model text or process state for acknowledgement.
 */
import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  ToolResultEntry,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type ToolDiagnostic,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createEditTool } from "@earendil-works/pi-durable/tools";
import { extractAssistantText } from "../tasks/background.js";
import type { DigestRunLimits } from "./digest-limits.js";
import { bounded, MEMORY_DIGEST_LIMITS } from "./digest-prompt.js";
// digest-scope imports this module for its call-time hook. Only functions cross back, so the cycle
// never reads an uninitialized binding while either module evaluates.
import { mutationPathOf } from "./digest-scope.js";
import { isRecord } from "./transcript.js";

/** Entry kind of the bounded task input inside the digest run's own conversation. */
export const MEMORY_DIGEST_ENTRY_KIND = "nanobot.memory-digest-task";

/** Bounded paged transcript scans: a digest conversation, or one committed turn inside it. */
const TURN_SCAN_LIMITS = Object.freeze({
  entriesPerPage: 200,
  maxEntries: 4_000,
});

/**
 * Marker the host puts on every budget/usage refusal it adds to a tool result. It is internal and
 * fixed, so final validation can fail the batch even when the refused call was a harmless read: a
 * model must never be able to repair away a host accounting failure by reading or answering later.
 */
export const MEMORY_DIGEST_BUDGET_REFUSAL_PREFIX = "Memory digestion budget refusal: ";

/**
 * One committed response's token accounting, summed from pi-ai's usage. The adapters report `input`
 * without the cache counters and derive `totalTokens` from the sum, so the input charge is
 * `input + cacheRead + cacheWrite`: "input including cached input", with no double count.
 */
export interface DigestUsage {
  /** Committed provider responses, including retried attempts; missing usage still counts. */
  readonly requests: number;
  /** Successful stop/length/toolUse responses; native failed attempts do not consume this limit. */
  readonly successfulRequests: number;
  /** Input tokens including cached input (`input + cacheRead + cacheWrite`). */
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Actual input plus a conservative charge for every response that reported no usage. */
  readonly chargedInputTokens: number;
  /** Lower bound of the next request's input: the whole previous request plus its answer. */
  readonly reserveNextTokens: number;
  readonly unaccountedResponses: number;
}

/** What this run's committed transcript already used, plus the call currently being admitted. */
export interface DigestToolUse extends DigestUsage {
  readonly calls: number;
  readonly paths: ReadonlySet<string>;
  readonly diffChars: number;
}

/**
 * Conservative inserted-plus-removed text for one mutation call: a create charges its whole content,
 * an edit charges both sides of every pair. Repeated edits of one file therefore accumulate instead
 * of being undercharged, while a call that fails or is refused never reaches this accounting.
 */
function mutationUseOf(name: string, args: unknown): { readonly path: string; readonly chars: number } | undefined {
  if (!isRecord(args) || typeof args.path !== "string") return undefined;
  if (name === "write") {
    return typeof args.content === "string" ? { path: args.path, chars: args.content.length } : undefined;
  }
  if (name !== "edit" || !Array.isArray(args.edits)) return undefined;
  let chars = 0;
  for (const edit of args.edits) {
    if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") return undefined;
    chars += edit.oldText.length + edit.newText.length;
  }
  return { path: args.path, chars };
}

/**
 * The native edit repair, reused rather than re-implemented. The committed assistant entry keeps the
 * model's raw arguments, while the tool executes repaired ones; accounting must see the same shapes
 * (JSON-string or single-object `edits`, or a top-level `oldText`/`newText` pair). The current call's
 * hook arguments are already repaired, and applying this pure repair again is a no-op for them.
 */
const NATIVE_EDIT_PREPARE = (createEditTool() as ToolRegistration).prepareArguments;

function preparedMutationArguments(name: string, args: unknown): unknown {
  if (name !== "edit" || NATIVE_EDIT_PREPARE === undefined) return args;
  return NATIVE_EDIT_PREPARE(args);
}

export interface DigestTranscriptUse {
  readonly calls: ReadonlyMap<string, { readonly name: string; readonly arguments: unknown }>;
  readonly results: ReadonlyMap<string, boolean>;
  readonly recordedCalls: number;
  readonly usage: DigestUsage;
}

/** Running totals of one committed transcript, extended entry by entry in ascending ID order. */
interface TranscriptTally {
  readonly calls: Map<string, { readonly name: string; readonly arguments: unknown }>;
  readonly results: Map<string, boolean>;
  recordedCalls: number;
  requests: number;
  successfulRequests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  unaccountedResponses: number;
  lastRequestTokens: number;
  /** Entries folded in so far; bounded by `TURN_SCAN_LIMITS.maxEntries` across every extension. */
  examined: number;
  /** Newest entry folded in. The next extension reads only entries after it. */
  lastEntryId: EntryId | undefined;
}

function emptyTally(): TranscriptTally {
  return {
    calls: new Map(),
    results: new Map(),
    recordedCalls: 0,
    requests: 0,
    successfulRequests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    unaccountedResponses: 0,
    lastRequestTokens: 0,
    examined: 0,
    lastEntryId: undefined,
  };
}

/** Fold one committed entry into the tally. Each entry is folded whole, so a tally is never torn. */
function tallyEntry(tally: TranscriptTally, entry: EntryRecord): void {
  tally.examined += 1;
  tally.lastEntryId = entry.id;
  for (const message of entry.model ?? []) {
    const candidate: unknown = message;
    if (!isRecord(candidate)) continue;
    if (candidate.role === "assistant") {
      tally.requests += 1;
      if (candidate.stopReason === "stop" || candidate.stopReason === "length" || candidate.stopReason === "toolUse") {
        tally.successfulRequests += 1;
      }
      const usage = candidate.usage;
      if (
        isRecord(usage)
        && typeof usage.input === "number" && Number.isSafeInteger(usage.input) && usage.input >= 0
        && typeof usage.output === "number" && Number.isSafeInteger(usage.output) && usage.output >= 0
      ) {
        const cacheRead = typeof usage.cacheRead === "number" && Number.isSafeInteger(usage.cacheRead)
          && usage.cacheRead >= 0 ? usage.cacheRead : 0;
        const cacheWrite = typeof usage.cacheWrite === "number" && Number.isSafeInteger(usage.cacheWrite)
          && usage.cacheWrite >= 0 ? usage.cacheWrite : 0;
        tally.inputTokens += usage.input + cacheRead + cacheWrite;
        tally.outputTokens += usage.output;
        tally.cacheReadTokens += cacheRead;
        tally.cacheWriteTokens += cacheWrite;
        tally.lastRequestTokens = usage.input + cacheRead + cacheWrite + usage.output;
      } else {
        // Missing usage is never a fresh allowance: charge the whole run bound for it.
        tally.unaccountedResponses += 1;
      }
      if (!Array.isArray(candidate.content)) continue;
      for (const part of candidate.content) {
        if (
          isRecord(part) && part.type === "toolCall"
          && typeof part.id === "string" && typeof part.name === "string"
        ) {
          tally.calls.set(part.id, { name: part.name, arguments: part.arguments });
          tally.recordedCalls += 1;
        }
      }
    } else if (candidate.role === "toolResult" && typeof candidate.toolCallId === "string") {
      tally.results.set(candidate.toolCallId, candidate.isError === true);
    }
  }
}

/**
 * Extend a tally with the committed entries after its newest one, in bounded ascending pages. Durable
 * entries are append-only and committed in ID order, so the entries already folded in cannot change.
 * More than `TURN_SCAN_LIMITS.maxEntries` in total fails closed, exactly like a full scan.
 */
async function extendTally(
  conversation: Pick<Conversation, "entries">,
  tally: TranscriptTally,
  context: Context,
): Promise<void> {
  const query = tally.lastEntryId === undefined
    ? { order: "ascending" as const }
    : { order: "ascending" as const, minEntryId: (tally.lastEntryId + 1) as EntryId };
  let cursor: Cursor | undefined;
  for (;;) {
    const remaining = TURN_SCAN_LIMITS.maxEntries - tally.examined;
    const page = await conversation.entries(
      query,
      Math.max(1, Math.min(TURN_SCAN_LIMITS.entriesPerPage, remaining)),
      cursor,
      context,
    );
    if (page.items.length === 0) return;
    if (remaining <= 0) throw new Error("the digest conversation is too long to verify its budget");
    for (const entry of page.items) tallyEntry(tally, entry);
    cursor = page.next;
    if (cursor === undefined) return;
  }
}

function tallySnapshot(tally: TranscriptTally, limits: DigestRunLimits): DigestTranscriptUse {
  return {
    calls: tally.calls,
    results: tally.results,
    recordedCalls: tally.recordedCalls,
    usage: {
      requests: tally.requests,
      successfulRequests: tally.successfulRequests,
      inputTokens: tally.inputTokens,
      cacheReadTokens: tally.cacheReadTokens,
      cacheWriteTokens: tally.cacheWriteTokens,
      outputTokens: tally.outputTokens,
      chargedInputTokens: tally.inputTokens + tally.unaccountedResponses * limits.maxInputTokens,
      reserveNextTokens: tally.lastRequestTokens,
      unaccountedResponses: tally.unaccountedResponses,
    },
  };
}

/**
 * One bounded paged scan of a digest target's committed transcript: its tool calls and results and
 * its actual provider spend. Reading the committed transcript (not process state) is what makes the
 * bound survive a retry, a reopen and an interrupted attempt; every response is already durable when
 * the next tool call reaches the hook.
 */
export async function digestTranscriptUse(
  harness: Harness,
  conversationId: ConversationId,
  limits: DigestRunLimits,
  context: Context,
): Promise<DigestTranscriptUse> {
  const conversation = await harness.conversation(conversationId, context);
  if (conversation === undefined) throw new Error("the digest conversation is not committed");
  const tally = emptyTally();
  await extendTally(conversation, tally, context);
  return tallySnapshot(tally, limits);
}

/**
 * Derive the bounded usage of one digest run from its committed calls and results, plus the call
 * being admitted. Any assistant tool-call part counts, including a call that failed or was refused;
 * only a call with a successful result, or one still in flight, reserves changed files and changed
 * text. A parallel round is fully committed before its first call reaches the hook, so every call in
 * it sees the same reservation and no round can overshoot.
 */
export function digestToolUse(
  transcript: DigestTranscriptUse,
  current: { readonly id: string; readonly name: string; readonly arguments: unknown },
): DigestToolUse {
  const recorded = transcript.calls.has(current.id);
  const paths = new Set<string>();
  let diffChars = 0;
  /** A mutation whose args cannot be normalized fail closes instead of charging nothing. */
  const account = (name: string, args: unknown): { readonly path: string; readonly chars: number } | undefined => {
    if (name !== "write" && name !== "edit") return undefined;
    const use = mutationUseOf(name, preparedMutationArguments(name, args));
    if (use === undefined) throw new Error("a digest mutation has unrecognizable arguments");
    return use;
  };
  for (const [id, call] of transcript.calls) {
    // The current call is accounted below with the arguments its hook actually received.
    if (id === current.id) continue;
    if (call.name !== "write" && call.name !== "edit") continue;
    if (transcript.results.get(id) === true) continue;
    const use = account(call.name, call.arguments)!;
    paths.add(use.path);
    diffChars += use.chars;
  }
  const currentUse = account(current.name, current.arguments);
  if (currentUse !== undefined) {
    paths.add(currentUse.path);
    diffChars += currentUse.chars;
  }
  return {
    ...transcript.usage,
    calls: transcript.recordedCalls + (recorded ? 0 : 1),
    paths,
    diffChars,
  };
}

/** Digest conversations whose running tally one scope extension keeps; older ones are rescanned. */
const TRACKED_TRANSCRIPTS = 16;

/** Incremental, per-conversation admission accounting for the call-time scope hook. */
export interface DigestTranscriptTracker {
  toolUse(
    harness: Harness,
    conversationId: ConversationId,
    current: { readonly id: string; readonly name: string; readonly arguments: unknown },
    limits: DigestRunLimits,
    context: Context,
  ): Promise<DigestToolUse>;
}

/**
 * Keep one running tally per digest conversation, so each tool call reads only the entries committed
 * since the previous call instead of the whole transcript again. The tally is process memory and
 * always derived from Durable: a reopen starts from entry one, and calls for one conversation are
 * serialized so a parallel round folds each entry exactly once. The post-turn audit and the outcome
 * accounting still re-read the committed transcript in full, so this cache never decides
 * acknowledgement on its own.
 */
export function createDigestTranscriptTracker(): DigestTranscriptTracker {
  const tracked = new Map<ConversationId, { readonly tally: TranscriptTally; tail: Promise<unknown> }>();
  return {
    toolUse(harness, conversationId, current, limits, context) {
      let slot = tracked.get(conversationId);
      if (slot === undefined) {
        slot = { tally: emptyTally(), tail: Promise.resolve() };
      } else {
        tracked.delete(conversationId);
      }
      tracked.set(conversationId, slot);
      for (const oldest of tracked.keys()) {
        if (tracked.size <= TRACKED_TRANSCRIPTS) break;
        tracked.delete(oldest);
      }
      const owned = slot;
      const run = owned.tail.then(async () => {
        const conversation = await harness.conversation(conversationId, context);
        if (conversation === undefined) throw new Error("the digest conversation is not committed");
        await extendTally(conversation, owned.tally, context);
        // Computed inside the serialized step, before another call can extend the same tally.
        return digestToolUse(tallySnapshot(owned.tally, limits), current);
      });
      owned.tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** The committed spend and writes of one digest target, for its bounded outcome and status. */
export async function digestRunUsage(
  harness: Harness,
  conversationId: ConversationId,
  limits: DigestRunLimits,
  context: Context,
): Promise<DigestUsage & { readonly changedFiles: number; readonly diffChars: number }> {
  const transcript = await digestTranscriptUse(harness, conversationId, limits, context);
  const paths = new Set<string>();
  let diffChars = 0;
  for (const [id, call] of transcript.calls) {
    if (call.name !== "write" && call.name !== "edit") continue;
    if (transcript.results.get(id) === true) continue;
    const use = mutationUseOf(call.name, preparedMutationArguments(call.name, call.arguments));
    if (use === undefined) continue;
    paths.add(use.path);
    diffChars += use.chars;
  }
  return { ...transcript.usage, changedFiles: paths.size, diffChars };
}

export function answerText(entry: { readonly model?: readonly unknown[] } | undefined): string | null {
  const body = extractAssistantText(entry).trim();
  return body === "" ? null : bounded(body, MEMORY_DIGEST_LIMITS.maxAnswerChars);
}

/** Fixed, value-free failure reasons: they never contain tool output, file content or model text. */
export const TURN_FAILURE_REASONS = Object.freeze({
  toolCallFailed: "a digest tool call failed and was not repaired; the batch was not acknowledged",
  budgetRefused:
    "a digest tool call failed on a host budget or policy refusal; the batch was not acknowledged",
  noReport: "the digest turn produced no final report; the batch was not acknowledged",
  unverifiable: "the digest turn could not be verified; the batch was not acknowledged",
});

interface DigestTurnCall {
  readonly name: string;
  readonly arguments: unknown;
}

interface DigestToolOutcome {
  readonly name: string;
  readonly arguments: unknown;
  readonly entryId: EntryId;
  readonly isError: boolean;
  readonly diagnostics: readonly ToolDiagnostic[];
}

/** Failure codes a plain tool error or a harmless path refusal may carry. */
const HARMLESS_TOOL_CODES = new Set(["tool_error", "blocked", "invalid_arguments"]);

type DigestFailureVerdict = "harmless-read" | "repairable-mutation" | "fatal";

/** A repair preserves the operation and intended replacement, not merely the file path. */
export function repairsMutation(
  failure: DigestToolOutcome,
  success: DigestToolOutcome,
  outcomes: readonly DigestToolOutcome[],
  workspaceRoot: string,
): boolean {
  if (success.entryId <= failure.entryId || success.name !== failure.name
    || mutationPathOf(success.arguments, workspaceRoot) !== mutationPathOf(failure.arguments, workspaceRoot)
    || !isRecord(failure.arguments) || !isRecord(success.arguments)) return false;
  if (failure.name === "write") {
    return typeof failure.arguments.content === "string" && success.arguments.content === failure.arguments.content;
  }
  const attempted = failure.arguments.edits;
  const retried = success.arguments.edits;
  return failure.name === "edit" && Array.isArray(attempted) && attempted.length > 0
    && Array.isArray(retried) && attempted.length === retried.length
    && attempted.every((edit, index) => {
      const retry = retried[index];
      return isRecord(edit) && isRecord(retry) && typeof edit.newText === "string"
        && typeof edit.oldText === "string" && edit.oldText.length > 0
        && typeof retry.oldText === "string" && retry.oldText.length > 0
        && retry.newText === edit.newText;
    })
    && outcomes.some((read) => !read.isError && read.name === "read"
      && read.entryId > failure.entryId && read.entryId < success.entryId
      && mutationPathOf(read.arguments, workspaceRoot) === mutationPathOf(failure.arguments, workspaceRoot));
}

function diagnosticsOf(entry: EntryRecord): readonly ToolDiagnostic[] {
  return ToolResultEntry.is(entry) ? entry.data.diagnostics : [];
}

/** True when the host refused a call for its own budget or usage accounting, never a path refusal. */
export function isDigestBudgetRefusal(diagnostics: readonly ToolDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => typeof diagnostic.message === "string"
    && diagnostic.message.includes(MEMORY_DIGEST_BUDGET_REFUSAL_PREFIX));
}

/** Harness-written terminal codes (interrupted, aborted, restart limit) are never recoverable. */
function hasNonToolFailure(diagnostics: readonly ToolDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error"
    && diagnostic.code !== undefined && !HARMLESS_TOOL_CODES.has(diagnostic.code));
}

/**
 * Classify one failed tool result without trusting model text. A failed read is exploratory and
 * harmless (its path refusal read nothing), and an in-scope write/edit failure may be repaired by a
 * later verified retry of the same operation and replacement. A host budget/usage refusal and any non-tool failure
 * are fatal; an out-of-scope mutation has no possible same-path repair, so it is fatal too.
 */
export function digestFailureVerdict(
  name: string,
  args: unknown,
  diagnostics: readonly ToolDiagnostic[],
  workspaceRoot: string,
): DigestFailureVerdict {
  if (isDigestBudgetRefusal(diagnostics) || hasNonToolFailure(diagnostics)) return "fatal";
  if (name === "read") return "harmless-read";
  if (name !== "write" && name !== "edit") return "fatal";
  const path = mutationPathOf(args, workspaceRoot);
  if (path === undefined) return "fatal";
  return "repairable-mutation";
}

export function toolCallsOf(entry: EntryRecord | undefined): Map<string, DigestTurnCall> {
  const calls = new Map<string, DigestTurnCall>();
  for (const message of entry?.model ?? []) {
    const record = message as unknown as Record<string, unknown>;
    const content = record["content"];
    if (record["role"] !== "assistant" || !Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && part["type"] === "toolCall"
        && typeof part["id"] === "string" && typeof part["name"] === "string") {
        calls.set(part["id"], { name: part["name"], arguments: part["arguments"] });
      }
    }
  }
  return calls;
}

/** Paired calls and results of one tool-result entry, in committed order. */
export function toolOutcomesOf(
  entry: EntryRecord,
  calls: ReadonlyMap<string, DigestTurnCall>,
): DigestToolOutcome[] {
  if (entry.kind !== ToolResultEntry.kind) return [];
  const diagnostics = diagnosticsOf(entry);
  const outcomes: DigestToolOutcome[] = [];
  for (const message of entry.model ?? []) {
    if (!isRecord(message) || message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const call = calls.get(message.toolCallId);
    outcomes.push({
      name: call?.name ?? "",
      arguments: call?.arguments,
      entryId: entry.id,
      isError: message.isError === true,
      diagnostics,
    });
  }
  return outcomes;
}

export type TurnCheck =
  | { readonly status: "ok"; readonly answer: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Validate the committed turn before its batch may be acknowledged.
 *
 * The range is exactly this attempt's own transcript: from the submission's placed input entry through
 * its own answer entry, never an earlier or later turn. Within it:
 * - the first entry is this task's digest input (kind and `data.taskId`), so a different attempt's
 *   turn cannot be mistaken for this one;
 * - a failed read is harmless, but a failed mutation requires a successful same-operation retry
 *   at its normalized path with unchanged replacement/content (and an intervening successful read
 *   for edits); a host budget/usage or non-tool failure is fatal even when
 *   the model read or answered later;
 * - the answer must be a committed assistant entry with a non-empty report.
 *
 * The scan is bounded and paged; failing to reach the answer within the bound fails closed. It reads
 * the committed transcript only, so the same accounting applies to a resumed attempt after a reopen.
 */
export async function validateCommittedTurn(
  conversation: Pick<Conversation, "entries">,
  turn: { readonly taskId: number; readonly entryId: EntryId; readonly answerEntryId: EntryId },
  workspaceRoot: string,
  context: Context,
): Promise<TurnCheck> {
  if (turn.entryId >= turn.answerEntryId) {
    return { status: "failed", reason: TURN_FAILURE_REASONS.unverifiable };
  }
  let cursor: Cursor | undefined;
  let examined = 0;
  let sawInput = false;
  let reachedAnswer = false;
  let answer: string | null = null;
  const calls = new Map<string, DigestTurnCall>();
  const outcomes: DigestToolOutcome[] = [];
  while (examined < TURN_SCAN_LIMITS.maxEntries) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: turn.entryId, maxEntryId: turn.answerEntryId },
      Math.min(TURN_SCAN_LIMITS.entriesPerPage, TURN_SCAN_LIMITS.maxEntries - examined),
      cursor,
      context,
    );
    if (page.items.length === 0) break;
    for (const entry of page.items) {
      examined += 1;
      if (entry.id === turn.entryId) {
        if (entry.kind !== MEMORY_DIGEST_ENTRY_KIND) return { status: "failed", reason: TURN_FAILURE_REASONS.unverifiable };
        const data = entry.data;
        if (!isRecord(data) || data.taskId !== turn.taskId) {
          return { status: "failed", reason: TURN_FAILURE_REASONS.unverifiable };
        }
        sawInput = true;
      }
      if (entry.kind === AssistantEntry.kind) {
        for (const [id, call] of toolCallsOf(entry)) calls.set(id, call);
      }
      if (entry.kind === ToolResultEntry.kind) outcomes.push(...toolOutcomesOf(entry, calls));
      if (entry.id === turn.answerEntryId) {
        if (entry.kind !== AssistantEntry.kind) return { status: "failed", reason: TURN_FAILURE_REASONS.unverifiable };
        reachedAnswer = true;
        answer = answerText(entry);
        break;
      }
    }
    if (reachedAnswer) break;
    cursor = page.next;
    if (cursor === undefined) break;
  }
  if (!sawInput || !reachedAnswer) return { status: "failed", reason: TURN_FAILURE_REASONS.unverifiable };
  const successes = outcomes.filter((outcome) => !outcome.isError);
  for (const failure of outcomes) {
    if (!failure.isError) continue;
    const verdict = digestFailureVerdict(failure.name, failure.arguments, failure.diagnostics, workspaceRoot);
    if (verdict === "fatal") {
      return {
        status: "failed",
        reason: isDigestBudgetRefusal(failure.diagnostics)
          ? TURN_FAILURE_REASONS.budgetRefused
          : TURN_FAILURE_REASONS.toolCallFailed,
      };
    }
    if (verdict === "harmless-read") continue;
    const repaired = successes.some((success) => repairsMutation(failure, success, outcomes, workspaceRoot));
    if (!repaired) return { status: "failed", reason: TURN_FAILURE_REASONS.toolCallFailed };
  }
  if (answer === null) return { status: "failed", reason: TURN_FAILURE_REASONS.noReport };
  return { status: "ok", answer };
}
