/**
 * Shared drainer of the host's durable delivery outbox (completed background cron results and
 * host interruption notices) for the owner chat channels.
 *
 * A record is sent as stored text: no submission, no preview, no model turn. The drainer owns the
 * outbox bookkeeping every channel shares: quarantining an interrupted write-ahead send as
 * `unknown` on open (never resent), validating records before use, the origin authorization hold
 * (`withheld`, released by a fresh authenticated admission) and revocation (`unauthorized`),
 * bounded concurrency and sanitized fault reports. The channel owns decoding its session keys,
 * its durable admission evidence and the external send itself.
 */

import type { Context, Draft } from "@earendil-works/chord";
import {
  CronDeliveryOutboxError,
  type CronDeliveryOutbox,
  type CronDeliveryRecord,
} from "../automation/cron-delivery.js";

const DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "pending", "sending", "unknown", "withheld", "delivered", "failed", "unauthorized",
]);

const UNUSABLE_RECORD = "delivery outbox contains an unusable record";

/**
 * Why one stored outbox record cannot be dispatched as-is, or `undefined` when it is usable. The
 * status is validated first, and a record that is not `pending` is never judged by its delivery
 * fields: an already terminal, held or unknown record must not be re-settled as malformed.
 * `extra` adds a channel's own field checks for pending records (such as a chunk plan).
 */
export function pendingRecordProblem(
  value: unknown,
  extra?: (record: Readonly<Record<string, unknown>>) => string | undefined,
): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return UNUSABLE_RECORD;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return UNUSABLE_RECORD;
  if (typeof record.status !== "string" || !DELIVERY_STATUSES.has(record.status)) {
    return "delivery record has an invalid status";
  }
  if (record.status !== "pending") return undefined;
  if (typeof record.sessionKey !== "string" || record.sessionKey === "") return "delivery record has no origin session";
  if (typeof record.text !== "string" || record.text.trim() === "") return "delivery record has no text";
  if (record.nextChunkIndex !== undefined &&
      (!Number.isSafeInteger(record.nextChunkIndex) || (record.nextChunkIndex as number) < 0)) {
    return "delivery record has an invalid chunk cursor";
  }
  return extra?.(record);
}

/**
 * The fixed operator text for an outbox read/update failure. A malformed-outbox error's own message
 * is never copied: only these two fixed reasons reach the durable fault record.
 */
export function outboxFaultMessage(error: unknown): string {
  return error instanceof CronDeliveryOutboxError
    ? "delivery outbox is malformed"
    : "delivery outbox could not be read";
}

/** What the channel's durable admission evidence says about one record's origin, right now. */
export type OriginAuthorization =
  | { readonly status: "deliver" }
  /** Missing evidence: a reversible hold, released by a fresh authenticated admission. */
  | { readonly status: "withheld"; readonly reason: string }
  /** The original owner is no longer admitted by the live configuration: terminal. */
  | { readonly status: "unauthorized" };

/** `delivered`: the drainer settles it; `kept`: the channel already committed its next state. */
export type OutboxDeliveryResult = "delivered" | "kept";

export interface OutboxDrainerOptions<Target> {
  readonly outbox: CronDeliveryOutbox | undefined;
  /** The adapter's live context, for reads and the send-intent commit. */
  readonly context: Context;
  /** A context that survives cancellation, for commits recording an outcome. */
  readonly cleanupContext: Context;
  /** The delivery target of one mapped session key this adapter owns; `undefined` skips it. */
  decodeSession(sessionKey: string): Target | undefined;
  /** One record per scope at a time (such as one chat); absent bounds only the total. */
  scopeOf?(target: Target): string | number;
  /** Re-check durable admission evidence against the live configuration for every send. */
  authorizeOrigin(target: Target, record: CronDeliveryRecord): OriginAuthorization;
  /**
   * Send one validated, authorized record. Write-ahead intents, unknown outcomes and refusals are
   * the channel's commits (see {@link OutboxDrainer.update}); return `delivered` once every part is
   * sent, or `kept` when the record was left in another state. A throw keeps it for the next scan.
   */
  deliverRecord(sessionKey: string, target: Target, record: CronDeliveryRecord): Promise<OutboxDeliveryResult>;
  /** Extra pending-record checks of this channel; see {@link pendingRecordProblem}. */
  validateRecord?(record: Readonly<Record<string, unknown>>): string | undefined;
  /** Whether to dispatch a valid pending record now; `false` skips it without using a slot. */
  admitDispatch?(sessionKey: string, target: Target, record: CronDeliveryRecord): boolean | Promise<boolean>;
  /** Telemetry wrapper around one dispatched delivery. */
  observe?<T>(sessionKey: string, target: Target, record: CronDeliveryRecord, run: () => Promise<T>): Promise<T>;
  /** Total concurrent deliveries. */
  readonly maxActive: number;
  /** False once the adapter is stopping or its context aborted. */
  active(): boolean;
  /** Channel name for operator warnings, such as `Telegram`. */
  readonly label: string;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

export interface OutboxDrainer {
  /**
   * On open: a write-ahead intent may have reached the service before a crash, so every `sending`
   * record or leftover intent is quarantined as `unknown` and never auto-resent.
   */
  recover(): Promise<void>;
  /** One pass over every owned session: quarantine malformed records, dispatch pending ones. */
  scan(): Promise<void>;
  /** Start a scan unless one is already running; never rejects. */
  requestScan(): void;
  /**
   * After a fresh authenticated admission restored the origin evidence: return this session's
   * `withheld` records to `pending` and request a scan. Never throws into admission.
   */
  releaseWithheld(sessionKey: string): Promise<void>;
  /** One in-place change of one record; `undefined` without an outbox or when it is gone. */
  update(
    sessionKey: string,
    id: string,
    change: (entry: Draft<CronDeliveryRecord>) => void,
    context?: Context,
  ): Promise<CronDeliveryRecord | undefined>;
  /** Commit an ambiguous external outcome: `unknown`, never resent. */
  markUnknown(sessionKey: string, id: string): Promise<void>;
  /** Commit a terminal failure with fixed operator text. */
  markFailed(sessionKey: string, id: string, reason: string): Promise<void>;
  /** Best-effort durable fault with fixed text; never throws. */
  reportFault(sessionKey: string, message: string): Promise<void>;
  /** Settles when the running scan and every dispatched delivery have finished. */
  idle(): Promise<void>;
}

export function createOutboxDrainer<Target>(options: OutboxDrainerOptions<Target>): OutboxDrainer {
  const outbox = options.outbox;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const activeKeys = new Set<string>();
  const activeScopes = new Set<string | number>();
  const tasks = new Set<Promise<void>>();
  const releaseEpochs = new Map<string, number>();
  let scanning: Promise<void> | undefined;
  let pendingScan: Promise<void> | undefined;

  const update: OutboxDrainer["update"] = async (sessionKey, id, change, context = options.cleanupContext) => {
    if (outbox === undefined) return undefined;
    return outbox.update(sessionKey, id, change, context);
  };

  const reportFault = async (sessionKey: string, message: string): Promise<void> => {
    if (outbox === undefined) return;
    await outbox.recordFault(sessionKey, message, options.cleanupContext).catch(() => undefined);
  };

  const markUnknown = async (sessionKey: string, id: string): Promise<void> => {
    await update(sessionKey, id, (entry) => {
      entry.status = "unknown";
      entry.unknownSince = now();
      delete entry.sendIntent;
    });
    warn(`${options.label} scheduled delivery outcome unknown for ${id}; inspect the Durable cron outbox record.`);
  };

  const markFailed = async (sessionKey: string, id: string, reason: string): Promise<void> => {
    await update(sessionKey, id, (entry) => {
      entry.status = "failed";
      entry.settledAt = now();
      delete entry.sendIntent;
      entry.error = reason;
    });
  };

  const sessions = async (): Promise<{ sessionKey: string; target: Target }[]> => {
    if (outbox === undefined) return [];
    const owned: { sessionKey: string; target: Target }[] = [];
    for (const { sessionKey } of await outbox.sessions(options.context)) {
      const target = options.decodeSession(sessionKey);
      if (target !== undefined) owned.push({ sessionKey, target });
    }
    return owned;
  };

  const list = async (sessionKey: string, context: Context): Promise<readonly unknown[] | undefined> => {
    try {
      return await outbox!.list(sessionKey, context);
    } catch (error) {
      await reportFault(sessionKey, outboxFaultMessage(error));
      return undefined;
    }
  };

  const deliver = async (sessionKey: string, target: Target, record: CronDeliveryRecord): Promise<"done" | "rescan"> => {
    if (record.sessionKey !== sessionKey) {
      await markFailed(sessionKey, record.id, "outbox session does not match its origin");
      return "done";
    }
    if (record.text.trim() === "") {
      await markFailed(sessionKey, record.id, "delivery text is empty");
      return "done";
    }
    // The session key is only a candidate locator; durable admission evidence authorizes.
    const epochBefore = releaseEpochs.get(sessionKey) ?? 0;
    const authorization = options.authorizeOrigin(target, record);
    if (authorization.status === "withheld") {
      let withheld = false;
      await update(sessionKey, record.id, (entry) => {
        if (entry.status !== "pending") return;
        // Fresh admission or a concurrent releaseWithheld() supersedes this stale hold.
        if ((releaseEpochs.get(sessionKey) ?? 0) !== epochBefore) return;
        const current = options.authorizeOrigin(target, record);
        if (current.status !== "withheld") return;
        entry.status = "withheld";
        entry.withheldSince = now();
        entry.error = current.reason;
        withheld = true;
      });
      if (!withheld) return "rescan";
      // If releaseWithheld() or fresh admission arrived while the withholding commit was in flight
      // (after the change callback ran), undo the stale hold so the record is never stranded.
      if ((releaseEpochs.get(sessionKey) ?? 0) !== epochBefore ||
          options.authorizeOrigin(target, record).status !== "withheld") {
        await update(sessionKey, record.id, (entry) => {
          if (entry.status !== "withheld") return;
          entry.status = "pending";
          delete entry.withheldSince;
          delete entry.error;
        });
        return "rescan";
      }
      warn(`${options.label} scheduled delivery withheld for ${record.id}: no durable origin admission evidence.`);
      return "done";
    }
    if (authorization.status === "unauthorized") {
      await update(sessionKey, record.id, (entry) => {
        entry.status = "unauthorized";
        entry.settledAt = now();
        entry.error = "origin sender is no longer authorized";
      });
      return "done";
    }
    if (await options.deliverRecord(sessionKey, target, record) !== "delivered") return "done";
    await update(sessionKey, record.id, (entry) => {
      entry.status = "delivered";
      entry.settledAt = now();
      delete entry.error;
    });
    return "done";
  };

  const scanOnce = async (): Promise<void> => {
    if (outbox === undefined || !options.active()) return;
    for (const { sessionKey, target } of await sessions()) {
      if (!options.active()) return;
      const records = await list(sessionKey, options.context);
      if (records === undefined) continue;
      for (const value of records) {
        if (!options.active()) return;
        const problem = pendingRecordProblem(value, options.validateRecord);
        if (problem !== undefined) {
          // A record with a usable ID is quarantined durably; one without can only be reported.
          const id = (value as { id?: unknown } | null)?.id;
          if (typeof id === "string" && id !== "") {
            await markFailed(sessionKey, id, problem).catch(async (error: unknown) => {
              await reportFault(sessionKey, outboxFaultMessage(error));
            });
          } else {
            await reportFault(sessionKey, problem);
          }
          continue;
        }
        const record = value as CronDeliveryRecord;
        if (record.status !== "pending") continue;
        const key = JSON.stringify([sessionKey, record.id]);
        const scope = options.scopeOf?.(target);
        if (activeKeys.size >= options.maxActive) return;
        if (activeKeys.has(key) || (scope !== undefined && activeScopes.has(scope))) continue;
        if (options.admitDispatch !== undefined && !(await options.admitDispatch(sessionKey, target, record))) continue;
        // Recheck liveness, capacity and reservations after awaiting `admitDispatch`.
        if (!options.active() || activeKeys.size >= options.maxActive) return;
        if (activeKeys.has(key) || (scope !== undefined && activeScopes.has(scope))) continue;
        activeKeys.add(key);
        if (scope !== undefined) activeScopes.add(scope);
        let rescan = false;
        const run = async (): Promise<void> => {
          if (await deliver(sessionKey, target, record) === "rescan") rescan = true;
        };
        let task!: Promise<void>;
        task = Promise.resolve()
          .then(() => options.observe === undefined ? run() : options.observe(sessionKey, target, record, run))
          .catch(() => {
            // Keep the durable record; the next scan retries or quarantines it.
          })
          .finally(() => {
            activeKeys.delete(key);
            if (scope !== undefined) activeScopes.delete(scope);
            if (rescan) requestScan();
            tasks.delete(task);
          });
        tasks.add(task);
      }
    }
  };

  /** Single-flight scan coordinator: at most one scan runs, with at most one coalesced follow-up. */
  const runScan = (): Promise<void> => {
    if (!options.active()) return Promise.resolve();
    if (scanning === undefined && pendingScan === undefined) {
      let current!: Promise<void>;
      current = scanOnce().finally(() => {
        if (scanning === current) scanning = undefined;
      });
      scanning = current;
      return current;
    }
    if (pendingScan === undefined) {
      const waitFor = scanning!;
      let queued!: Promise<void>;
      queued = waitFor
        .catch(() => undefined)
        .then(() => {
          if (pendingScan === queued) pendingScan = undefined;
          if (!options.active()) return undefined;
          return runScan();
        });
      pendingScan = queued;
    }
    return pendingScan;
  };

  const requestScan = (): void => {
    if (!options.active()) return;
    void runScan().catch(() => undefined);
  };

  return {
    async recover() {
      if (outbox === undefined) return;
      for (const { sessionKey } of await sessions()) {
        const records = await list(sessionKey, options.cleanupContext);
        if (records === undefined) continue;
        for (const value of records) {
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            await reportFault(sessionKey, UNUSABLE_RECORD);
            continue;
          }
          const record = value as { id?: unknown; status?: unknown; sendIntent?: unknown };
          if (record.status !== "sending" && record.sendIntent === undefined) continue;
          if (typeof record.id !== "string" || record.id === "") {
            await reportFault(sessionKey, UNUSABLE_RECORD);
            continue;
          }
          try {
            await markUnknown(sessionKey, record.id);
          } catch (error) {
            await reportFault(sessionKey, outboxFaultMessage(error));
          }
        }
      }
    },
    scan: runScan,
    requestScan,
    async releaseWithheld(sessionKey) {
      releaseEpochs.set(sessionKey, (releaseEpochs.get(sessionKey) ?? 0) + 1);
      if (outbox === undefined || !options.active()) return;
      let records: readonly unknown[];
      try {
        records = await outbox.list(sessionKey, options.context);
      } catch {
        return;
      }
      let released = false;
      for (const value of records) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as { id?: unknown; status?: unknown };
        if (record.status !== "withheld" || typeof record.id !== "string" || record.id === "") continue;
        try {
          await update(sessionKey, record.id, (entry) => {
            // Rechecked inside the commit: a concurrent scan may have settled it already.
            if (entry.status !== "withheld") return;
            entry.status = "pending";
            delete entry.withheldSince;
            delete entry.error;
          }, options.context);
          released = true;
        } catch {
          // The scan retries or quarantines it; admission itself must still succeed.
        }
      }
      if (released) requestScan();
    },
    update,
    markUnknown,
    markFailed,
    reportFault,
    async idle() {
      while (scanning !== undefined || pendingScan !== undefined || tasks.size > 0) {
        await Promise.allSettled([
          ...(scanning === undefined ? [] : [scanning]),
          ...(pendingScan === undefined ? [] : [pendingScan]),
          ...tasks,
        ]);
      }
    },
  };
}
