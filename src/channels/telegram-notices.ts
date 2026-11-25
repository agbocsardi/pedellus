/**
 * `/notices`: the owner's read-only listing of this chat's stale host notices and the exact-id
 * dismissal of one of them.
 *
 * Only non-answer host notices whose delivery outcome is unknown are projected: a host
 * interruption notice in the delivery outbox, or one of this adapter's own pending notices. A model
 * answer or a scheduled result is never listed, dismissed or resent, and a dismissal never claims
 * external delivery: the record keeps its text and unknown provenance and only its status (or its
 * queue slot) settles as a fixed, owner-initiated dismissal.
 */
import type { Context, Draft } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import type { CronDeliveryOutbox, CronDeliveryRecord } from "../automation/cron-delivery.js";
import { boundedLabel } from "../media/outbound.js";
import { isTurnInterruptionNotice } from "../recovery/interruption.js";

export type TelegramNoticeDismissal = {
  id: string;
  sessionKey: string;
  text: string;
  unknownSince?: number;
  dismissedAt: number;
};

/** Archive of dismissed adapter-pending notices; it keeps their unknown provenance. */
export const TelegramNoticeDismissals = defineDoc<{ records: TelegramNoticeDismissal[] }>({
  kind: "nanobot.telegram-notice-dismissals", version: 1, scope: "conversation",
  history: "latest", fork: "initial", initial: () => ({ records: [] }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export const NOTICES_UNAVAILABLE_HOST =
  "Host notices are unavailable in this host: it exposes no delivery outbox. Nothing was changed and " +
  "nothing was resent.";
/** Bound of stale host notice rows in one listing; the count is still stated above the cut. */
const STALE_HOST_NOTICE_ROWS = 4;
/** Dismissal archive bound: refuse rather than silently evict provenance. */
const MAX_NOTICE_DISMISSALS = 100;
const STALE_HOST_NOTICE_DISMISSED =
  "stale host notice dismissed by the owner; the outcome stays unknown and it was not resent";
const NO_SUCH_NOTICE =
  "No stale host notice with that exact id exists in this chat. Nothing was changed and nothing was resent.";
const ONLY_HOST_NOTICES =
  "Only host notices can be dismissed here. Model answers and scheduled results are never dismissed or resent.";
const NOT_UNKNOWN =
  "That host notice is not in an unknown state, so it was not dismissed. Nothing was changed and nothing was resent.";

/** The parts of an adapter pending record this module reads. */
export type TelegramNoticeRecord = {
  readonly updateId: number;
  readonly sessionKey: string;
  readonly text: string;
  readonly notice?: boolean;
  readonly deliveryStatus?: string;
  readonly unknownSince?: number;
};

export type PendingDismissal = "dismissed" | "full" | "missing";

export interface TelegramNoticesHost {
  readonly outbox: CronDeliveryOutbox | undefined;
  readonly context: Context;
  /** The adapter's current committed pending records. */
  pending(): readonly TelegramNoticeRecord[];
  /** One state commit that archives and drops one unknown pending notice (see {@link archiveUnknownNotice}). */
  dismissPending(sessionKey: string, updateId: number, id: string): Promise<PendingDismissal>;
  /** Fixed usage notice for a malformed argument. */
  readonly usage: string;
  /** Notice length bound. */
  readonly maxChars: number;
}

/** Answer one `/notices [dismiss <id>]` of this chat with fixed, bounded text. */
export async function telegramNoticesCommand(
  host: TelegramNoticesHost,
  sessionKey: string,
  args: string,
): Promise<string> {
  const argument = args.trim();
  if (argument === "") return staleHostNoticesNotice(host, sessionKey);
  const dismiss = /^dismiss\s+(\S+)$/u.exec(argument);
  if (dismiss === null || dismiss[1]!.length > 200) return host.usage;
  return dismissStaleHostNotice(host, sessionKey, dismiss[1]!);
}

/**
 * Inside the caller's state commit: archive this chat's one adapter pending notice whose outcome is
 * unknown. On `dismissed` the caller drops that record from its delivery queue in the same commit;
 * a full archive refuses instead of evicting provenance.
 */
export function archiveUnknownNotice(
  pending: readonly TelegramNoticeRecord[],
  archive: Draft<{ records: TelegramNoticeDismissal[] }>,
  input: { readonly sessionKey: string; readonly updateId: number; readonly id: string; readonly now: number },
): PendingDismissal {
  const notice = pending.find((entry) => entry.updateId === input.updateId && entry.sessionKey === input.sessionKey);
  if (notice?.notice !== true || notice.deliveryStatus !== "unknown") return "missing";
  if (archive.records.length >= MAX_NOTICE_DISMISSALS) return "full";
  archive.records.push({
    id: input.id,
    sessionKey: input.sessionKey,
    text: notice.text,
    ...(notice.unknownSince === undefined ? {} : { unknownSince: notice.unknownSince }),
    dismissedAt: input.now,
  });
  return "dismissed";
}

/** Unknown-outcome provenance; a record without one falls back to its creation time. */
function unknownSinceMs(record: CronDeliveryRecord): number {
  const since = record.unknownSince;
  return typeof since === "number" && Number.isSafeInteger(since) && since >= 0 ? since : record.createdAtMs;
}

function unknownSinceText(record: CronDeliveryRecord): string {
  const at = unknownSinceMs(record);
  return Number.isSafeInteger(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : "an unrecorded time";
}

/**
 * This chat's own non-answer host notices whose delivery outcome is unknown. Only exact host notice
 * ids are projected and their text is never copied. Read only; nothing is retried or changed.
 */
async function staleHostNoticesNotice(host: TelegramNoticesHost, sessionKey: string): Promise<string> {
  if (host.outbox === undefined) return NOTICES_UNAVAILABLE_HOST;
  let records: readonly CronDeliveryRecord[];
  try {
    records = await host.outbox.list(sessionKey, host.context);
  } catch {
    return "Stale host notices are unavailable right now: this chat's delivery outbox could not be read. " +
      "Nothing was changed and nothing was resent.";
  }
  const stale = records
    .filter((record) => record.status === "unknown" && isTurnInterruptionNotice(record))
    .sort((left, right) => unknownSinceMs(left) - unknownSinceMs(right));
  const pending = host.pending().filter((entry) => entry.sessionKey === sessionKey
    && entry.notice === true && entry.deliveryStatus === "unknown");
  const all = [
    ...stale.map((record) => ({ id: record.id, since: unknownSinceText(record) })),
    ...pending.map((entry) => ({ id: `telegram:${entry.updateId}`,
      since: entry.unknownSince === undefined ? "unrecorded time" : new Date(entry.unknownSince).toISOString() })),
  ];
  if (all.length === 0) {
    return "No stale host notices in this chat. Model answers and scheduled results are never listed here.";
  }
  all.sort((left, right) => (Date.parse(left.since) || 0) - (Date.parse(right.since) || 0));
  const rows = all.slice(0, STALE_HOST_NOTICE_ROWS).map((record) =>
    `  ${boundedLabel(record.id, 80)} — outcome unknown since ${record.since}`);
  return [
    `Stale host notices in this chat: ${all.length}. Their delivery outcome is unknown, so none was resent.`,
    ...rows,
    ...(all.length > rows.length ? [`  … ${all.length - rows.length} more not shown`] : []),
    "Use /notices dismiss <id> for exactly one whose unknown outcome you accept.",
  ].join("\n").slice(0, host.maxChars);
}

/**
 * Retire exactly one stale host notice of this chat. An ambiguous send is never retried and a model
 * answer or scheduled result is never touched.
 */
async function dismissStaleHostNotice(host: TelegramNoticesHost, sessionKey: string, id: string): Promise<string> {
  const outbox = host.outbox;
  if (outbox === undefined) return NOTICES_UNAVAILABLE_HOST;
  if (/^telegram:-?\d+$/.test(id)) {
    const updateId = Number(id.slice("telegram:".length));
    if (!Number.isSafeInteger(updateId) || id !== `telegram:${updateId}`) return NO_SUCH_NOTICE;
    const outcome = await host.dismissPending(sessionKey, updateId, id);
    if (outcome === "dismissed") return `Dismissed stale host notice ${id}. Its original outcome stays unknown; it was not resent.`;
    if (outcome === "full") return "Notice dismissal archive is full. Nothing was changed or resent.";
    return NO_SUCH_NOTICE;
  }
  if (!isTurnInterruptionNotice({ id })) return ONLY_HOST_NOTICES;
  let records: readonly CronDeliveryRecord[];
  try {
    records = await outbox.list(sessionKey, host.context);
  } catch {
    return "That stale notice could not be read right now. Nothing was changed and nothing was resent.";
  }
  const current = records.find((record) => record.id === id);
  if (current === undefined) return NO_SUCH_NOTICE;
  if (!isTurnInterruptionNotice(current)) return ONLY_HOST_NOTICES;
  if (current.status !== "unknown") return NOT_UNKNOWN;
  let dismissed = false;
  try {
    const updated = await outbox.update(sessionKey, id, (entry) => {
      // Rechecked inside the commit: a concurrent scan or reopen may have settled it already.
      if (!isTurnInterruptionNotice(entry) || entry.status !== "unknown") return;
      dismissed = true;
      entry.status = "failed";
      entry.settledAt = Date.now();
      entry.error = STALE_HOST_NOTICE_DISMISSED;
    }, host.context);
    if (updated === undefined) return NO_SUCH_NOTICE;
  } catch {
    return "That stale notice could not be changed right now. Nothing was resent; try again later.";
  }
  if (!dismissed) return NOT_UNKNOWN;
  return `Dismissed stale host notice ${boundedLabel(id, 80)}. Its original outcome stays unknown; it was not resent.`;
}
