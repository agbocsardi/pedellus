/**
 * Channel-neutral durable outbox for one completed background cron run.
 *
 * The run records its terminal outcome and this delivery record in the same commit, in the
 * origin conversation. No model is called to resend: a channel adapter reads the stored final
 * text and owns the external-send state (write-ahead intent, chunk cursor and ambiguous-outcome
 * quarantine) in this record. A record is keyed by the occurrence, so a retried terminal commit
 * cannot admit the same result twice.
 *
 * The document carries no authority. A consumer must re-authenticate the origin session key
 * against its own live allowlist before sending anything.
 *
 * A corrupt outbox is never repaired by guessing or overwritten. Admission reports `invalid` or
 * `full`, and the caller records a durable fault in a separate document instead of faulting the
 * cron run's terminal commit.
 */
import { copyJson, type Context, type Draft } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import type { HistoryChatSession } from "../history/scope.js";

export const CRON_DELIVERIES_KIND = "nanobot.cron.deliveries";
export const CRON_DELIVERY_FAULTS_KIND = "nanobot.cron.delivery-faults";
/** Total records retained per origin conversation; the oldest terminal record is evicted first. */
export const CRON_DELIVERY_MAX_RECORDS = 1_000;
/** Terminal records kept for inspection and delivery-key dedupe. */
export const CRON_DELIVERY_MAX_SETTLED = 200;
/** Stored answer text bound; the Telegram adapter's chunking applies below this. */
export const CRON_DELIVERY_MAX_TEXT_CHARS = 60_000;
/** Bounded diagnostic history for results that could not be admitted or read. */
export const CRON_DELIVERY_MAX_FAULTS = 50;

export type CronDeliveryStatus =
  | "pending"
  | "sending"
  | "unknown"
  | "withheld"
  | "delivered"
  | "failed"
  | "unauthorized";

export type CronDeliverySendIntent = {
  readonly text: string;
  readonly chunkIndex: number;
  readonly startedAt: number;
};

export type CronDeliveryRecord = {
  /** `cron:<jobId>:<scheduledAtMs>`; unique per occurrence. */
  readonly id: string;
  readonly sessionKey: string;
  readonly text: string;
  readonly createdAtMs: number;
  readonly status: CronDeliveryStatus;
  readonly nextChunkIndex: number;
  readonly messageId?: number;
  readonly sendIntent?: CronDeliverySendIntent;
  readonly unknownSince?: number;
  /** Nonterminal missing-evidence hold; released by a fresh authenticated admission. */
  readonly withheldSince?: number;
  readonly settledAt?: number;
  readonly error?: string;
};

export type CronDeliveriesDocument = { readonly deliveries: CronDeliveryRecord[] };

/** One durable reason a result was not admitted or the outbox could not be read. */
export type CronDeliveryFault = {
  /** Occurrence owner when known; `null` for a document/channel-level fault. */
  readonly jobId: string | null;
  readonly scheduledAtMs: number | null;
  readonly recordedAtMs: number;
  /** Sanitized operator-facing reason; never raw provider, channel or model error text. */
  readonly message: string;
};

export type CronDeliveryFaultsDocument = { readonly faults: CronDeliveryFault[] };

export const CronDeliveriesDoc = defineDoc<CronDeliveriesDocument>({
  kind: CRON_DELIVERIES_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ deliveries: [] }),
  checkpointWhen: () => true,
});

/** Separate from the outbox so a malformed outbox cannot also damage its diagnostic record. */
export const CronDeliveryFaultsDoc = defineDoc<CronDeliveryFaultsDocument>({
  kind: CRON_DELIVERY_FAULTS_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ faults: [] }),
  checkpointWhen: () => true,
});

const TERMINAL: ReadonlySet<CronDeliveryStatus> = new Set([
  "delivered", "failed", "unauthorized",
]);
const STATUSES: ReadonlySet<string> = new Set([
  "pending", "sending", "unknown", "withheld", "delivered", "failed", "unauthorized",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type DeliveryDrafts = Record<string, unknown>[];

/**
 * Validate the document and every existing entry enough to admit without touching a record this
 * module does not understand. Invalid data is left exactly as stored.
 */
function deliveriesOf(doc: unknown): DeliveryDrafts | undefined {
  if (!isRecord(doc)) return undefined;
  const value = doc.deliveries;
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.id !== "string" || entry.id === "") return undefined;
    if (typeof entry.status !== "string" || !STATUSES.has(entry.status)) return undefined;
    if (entry.nextChunkIndex !== undefined &&
        (!Number.isSafeInteger(entry.nextChunkIndex) || (entry.nextChunkIndex as number) < 0)) {
      return undefined;
    }
  }
  return value as DeliveryDrafts;
}

export type CronDeliveryAdmission = "admitted" | "duplicate" | "full" | "invalid";

/**
 * Admit one occurrence's result unless its key is already present.
 *
 * `invalid` means the stored document or one of its entries is not understood; nothing is changed.
 * `full` means the bounded outbox has no evictable terminal record; nothing is pushed. Neither
 * outcome throws, so the run's terminal commit remains intact.
 */
export function admitCronDelivery(doc: unknown, record: CronDeliveryRecord): CronDeliveryAdmission {
  const deliveries = deliveriesOf(doc);
  if (deliveries === undefined) return "invalid";
  if (deliveries.some((entry) => entry.id === record.id)) return "duplicate";
  pruneDeliveries(deliveries);
  if (deliveries.length >= CRON_DELIVERY_MAX_RECORDS) {
    const oldestTerminal = deliveries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => TERMINAL.has(entry.status as CronDeliveryStatus))
      .sort((left, right) => numberOrZero(left.entry.createdAtMs) - numberOrZero(right.entry.createdAtMs))[0];
    if (oldestTerminal === undefined) return "full";
    deliveries.splice(oldestTerminal.index, 1);
  }
  deliveries.push(record);
  return "admitted";
}

const numberOrZero = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function pruneDeliveries(deliveries: DeliveryDrafts): void {
  const settled = deliveries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => TERMINAL.has(entry.status as CronDeliveryStatus));
  if (settled.length <= CRON_DELIVERY_MAX_SETTLED) return;
  settled.sort((left, right) => numberOrZero(left.entry.settledAt) - numberOrZero(right.entry.settledAt));
  const drop = new Set(
    settled.slice(0, settled.length - CRON_DELIVERY_MAX_SETTLED)
      .map(({ entry }) => entry.id as string),
  );
  for (let index = deliveries.length - 1; index >= 0; index--) {
    const id = deliveries[index]!.id;
    if (drop.has(id as string)) deliveries.splice(index, 1);
  }
}

/** Keep terminal records bounded without touching pending or ambiguous deliveries. */
export function pruneCronDeliveries(doc: unknown): void {
  const deliveries = deliveriesOf(doc);
  if (deliveries !== undefined) pruneDeliveries(deliveries);
}

/**
 * Append one sanitized fault unless the same occurrence already recorded the same reason.
 * Returns `false` for a malformed fault document; it is never overwritten or repaired in place.
 */
export function recordCronDeliveryFault(doc: unknown, fault: CronDeliveryFault): boolean {
  if (!isRecord(doc)) return false;
  const value = doc.faults;
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    if (typeof entry.message !== "string") return false;
  }
  const faults = value as Record<string, unknown>[];
  if (faults.some((entry) =>
    entry.jobId === fault.jobId &&
    entry.scheduledAtMs === fault.scheduledAtMs &&
    entry.message === fault.message)) {
    return false;
  }
  if (faults.length >= CRON_DELIVERY_MAX_FAULTS) {
    const oldest = faults
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => numberOrZero(left.entry.recordedAtMs) - numberOrZero(right.entry.recordedAtMs))[0];
    if (oldest !== undefined) faults.splice(oldest.index, 1);
  }
  faults.push(fault);
  return true;
}

/** Newest durable fault for one job, or `null` when the document is absent/corrupt. */
export function latestCronDeliveryFault(doc: unknown, jobId: string): CronDeliveryFault | null {
  if (!isRecord(doc) || !Array.isArray(doc.faults)) return null;
  let latest: CronDeliveryFault | null = null;
  for (const entry of doc.faults) {
    if (!isRecord(entry) || entry.jobId !== jobId) continue;
    if (typeof entry.message !== "string" || typeof entry.recordedAtMs !== "number") continue;
    const fault: CronDeliveryFault = {
      jobId,
      scheduledAtMs: typeof entry.scheduledAtMs === "number" ? entry.scheduledAtMs : null,
      recordedAtMs: entry.recordedAtMs,
      message: entry.message,
    };
    if (latest === null || fault.recordedAtMs > latest.recordedAtMs) latest = fault;
  }
  return latest;
}

/** A durable outbox that cannot be read safely. The message is fixed operator text. */
export class CronDeliveryOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronDeliveryOutboxError";
  }
}

/**
 * Channel-facing view of completed background results. It exposes only already-mapped chat
 * conversations and mutates one record at a time; it creates no conversation and starts no run.
 */
export interface CronDeliveryOutbox {
  /** Mapped chat sessions the host may authenticate for delivery. */
  sessions(context: Context): Promise<readonly HistoryChatSession[]>;
  /** Current deliveries for one mapped chat session, oldest first. */
  list(sessionKey: string, context: Context): Promise<readonly CronDeliveryRecord[]>;
  /** Apply one in-place change to a record; returns the committed copy or `undefined`. */
  update(
    sessionKey: string,
    id: string,
    change: (record: Draft<CronDeliveryRecord>) => void,
    context: Context,
  ): Promise<CronDeliveryRecord | undefined>;
  /** Best-effort durable diagnostic for an unreadable/malformed outbox or record. */
  recordFault(sessionKey: string, message: string, context: Context): Promise<void>;
}

/** Copy a committed delivery record so no transaction draft escapes. */
export function copyCronDelivery(record: Draft<CronDeliveryRecord> | CronDeliveryRecord): CronDeliveryRecord {
  return copyJson(record) as unknown as CronDeliveryRecord;
}
