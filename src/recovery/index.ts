import { createHash } from "node:crypto";
import { processLock } from "@earendil-works/chord/node";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness as HarnessType,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { PortConfig } from "../config.js";
import { prepareDataDirectory } from "../store.js";
import { openFullSyncNodeSqliteStorage } from "../storage/sqlite.js";
import {
  hasPersistedNanobotContext,
  preparedContextReplay,
  type PreparedContextReplay,
} from "./prepared.js";

const RECOVERY_FINGERPRINT_VERSION = "nanobot.prepared-context-recovery.v1";

/** Expected failure of owner-driven recovery, safe to show without suppressing context. */
export class PreparedContextRecoveryError extends Error {
  override name = "PreparedContextRecoveryError";
}

export interface ContextRecoveryOptions {
  /**
   * Model catalog used only to construct the paused Harness. Recovery never
   * dispatches a model request, so the default empty catalog works offline and
   * requires no credentials. Deferred-poll cancellation is therefore skipped.
   */
  readonly models?: Models;
}

/** One live provider dispatch whose pinned context still contains Nanobot sections. */
export interface PreparedContextBlock {
  readonly taskId: number;
  readonly kind: "pi.generation" | "pi.compaction";
  readonly conversationId: ConversationId;
  readonly phase: "request" | "poll" | "summarize" | "retry";
  /** Pinned cutoff (generation) or tail (compaction) entry ID. */
  readonly at: number;
  /** Binds an explicit cancellation to this exact task state. */
  readonly fingerprint: string;
}

/** Exact task identity copied from a prior `listPreparedContextBlocks` result. */
export interface PreparedContextBlockTarget {
  readonly taskId: number;
  readonly fingerprint: string;
}

export interface PreparedContextCancelResult {
  /** `abort-marked` is durable; the next gateway open runs the native abort protocol. */
  readonly status: "abort-marked" | "terminal";
  readonly taskId: number;
}

interface OpenedRecovery {
  readonly harness: HarnessType;
  readonly releaseLock: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fingerprint(replay: PreparedContextReplay): string {
  return createHash("sha256")
    .update(JSON.stringify([
      RECOVERY_FINGERPRINT_VERSION,
      replay.id,
      replay.kind,
      replay.conversationId,
      replay.phase,
      replay.at,
    ]))
    .digest("hex");
}

async function openRecoveryHarness(
  config: PortConfig,
  context: Context,
  options: ContextRecoveryOptions,
): Promise<OpenedRecovery> {
  const { dbPath } = await prepareDataDirectory(config);
  const releaseLock = await processLock(`nanobot:${dbPath}`);
  let storage: Storage | undefined;
  try {
    storage = await openFullSyncNodeSqliteStorage(dbPath, context);
    const models = options.models ?? createModels({
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
    return { harness, releaseLock };
  } catch (error) {
    try {
      const cleanup = withoutAbortSignal(context);
      if (storage) await storage.close(cleanup);
    } finally {
      await releaseLock();
    }
    throw error;
  }
}

async function closeRecoveryHarness(opened: OpenedRecovery, context: Context): Promise<void> {
  try {
    await opened.harness.close(withoutAbortSignal(context));
  } finally {
    await opened.releaseLock();
  }
}

async function collectPreparedContextBlocks(
  harness: HarnessType,
  context: Context,
): Promise<PreparedContextBlock[]> {
  const prepared: PreparedContextReplay[] = [];
  await harness.commit(async (tx) => {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({}, 1000, cursor);
      for (const task of page.items) {
        const replay = preparedContextReplay(task);
        if (replay !== undefined) prepared.push(replay);
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }, context);

  const blocks: PreparedContextBlock[] = [];
  for (const replay of prepared) {
    const conversation = await harness.conversation(replay.conversationId, context);
    if (!conversation) {
      throw new PreparedContextRecoveryError(
        `Cannot inspect prepared ${replay.kind} task ${replay.id}: its conversation is missing`,
      );
    }
    const view = await conversation.context(context, { at: replay.at as EntryId });
    if (!hasPersistedNanobotContext(view.messages)) continue;
    blocks.push({
      taskId: replay.id,
      kind: replay.kind,
      conversationId: replay.conversationId,
      phase: replay.phase,
      at: replay.at,
      fingerprint: fingerprint(replay),
    });
  }
  blocks.sort((left, right) => left.taskId - right.taskId);
  return blocks;
}

/**
 * List prepared generation/compaction dispatches that still pin historical
 * Nanobot context. Opens the store under the gateway's process lock and never
 * resumes scheduling, so no provider request, tool, policy, or transcript write
 * is performed. Native Harness open recovery may still move a crashed running
 * task to pending and increment its restart counter. The conservative guard also
 * reports an unchanged host snapshot.
 */
export async function listPreparedContextBlocks(
  config: PortConfig,
  context: Context,
  options: ContextRecoveryOptions = {},
): Promise<readonly PreparedContextBlock[]> {
  const opened = await openRecoveryHarness(config, context, options);
  try {
    return await collectPreparedContextBlocks(opened.harness, context);
  } finally {
    await closeRecoveryHarness(opened, context);
  }
}

function validateTarget(target: PreparedContextBlockTarget): void {
  if (!isRecord(target) || !Number.isSafeInteger(target.taskId) || target.taskId < 1 ||
      typeof target.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(target.fingerprint)) {
    throw new PreparedContextRecoveryError(
      "Cancellation requires a taskId and the exact fingerprint returned by listPreparedContextBlocks",
    );
  }
}

/**
 * Durably abort exactly one prepared dispatch after revalidating its current
 * fingerprint. No scheduling is resumed and no checkpoint is rewritten: the
 * native abort mark is persisted, and the next `openGateway` runs the native
 * abort protocol before any provider phase. Cancelling is the only supported
 * reconciliation; a pinned request cannot be safely re-rendered in place.
 */
export async function cancelPreparedContextBlock(
  config: PortConfig,
  target: PreparedContextBlockTarget,
  context: Context,
  options: ContextRecoveryOptions = {},
): Promise<PreparedContextCancelResult> {
  validateTarget(target);
  const opened = await openRecoveryHarness(config, context, options);
  try {
    const blocks = await collectPreparedContextBlocks(opened.harness, context);
    const match = blocks.find((block) => block.taskId === target.taskId);
    if (!match) {
      throw new PreparedContextRecoveryError(
        `Task ${target.taskId} is not a live prepared dispatch with historical Nanobot context`,
      );
    }
    if (match.fingerprint !== target.fingerprint) {
      throw new PreparedContextRecoveryError(
        `Task ${target.taskId} changed since inspection; list blocked dispatches again before cancelling`,
      );
    }
    const result = await opened.harness.abortTask(target.taskId as TaskId, context);
    return { status: result === "terminal" ? "terminal" : "abort-marked", taskId: target.taskId };
  } finally {
    await closeRecoveryHarness(opened, context);
  }
}
