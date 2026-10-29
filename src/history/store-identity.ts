import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Session, type SessionDocToken } from "@earendil-works/pi-durable";

export const STORE_IDENTITY_FORMAT = "nanobot.store" as const;
export const STORE_IDENTITY_VERSION = 1 as const;

/**
 * Immutable identity of one Durable store.
 *
 * A derived index (full-text search, an external cache) persists `storeId` and rejects
 * its own rows when the value changes, so pointing an index at a different or rebuilt
 * SQLite file cannot mix two stores' data or silently keep stale cursors. It is not a
 * secret: it identifies a store, and grants no access.
 */
export interface StoreIdentity {
  readonly format: typeof STORE_IDENTITY_FORMAT;
  readonly version: typeof STORE_IDENTITY_VERSION;
  /** Unique per store, minted once when the identity document is first written. */
  readonly storeId: string;
  /** Epoch milliseconds of that first write. */
  readonly createdAt: number;
}

type StoreIdentityDocument = {
  readonly format: string;
  readonly version: number;
  readonly storeId: string;
  readonly createdAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a stored or injected identity. A document from another format or a later
 * version is refused instead of guessed at, and a store with no document mints one.
 */
export function parseStoreIdentity(value: unknown): StoreIdentity {
  if (!isRecord(value)) throw new Error("Store identity document is malformed");
  const { format, version, storeId, createdAt } = value;
  if (format !== STORE_IDENTITY_FORMAT) throw new Error("Store identity document has an unknown format");
  if (version !== STORE_IDENTITY_VERSION) {
    throw new Error(`Store identity document has unsupported version ${String(version)}`);
  }
  if (typeof storeId !== "string" || storeId.length === 0 || storeId.length > 64) {
    throw new Error("Store identity document has an invalid store ID");
  }
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error("Store identity document has an invalid creation time");
  }
  return { format: STORE_IDENTITY_FORMAT, version: STORE_IDENTITY_VERSION, storeId, createdAt };
}

/**
 * Session-scoped singleton. `initial()` is read only when the document is absent, so a
 * candidate value is discarded on every later open: the first committed identity wins,
 * and an existing store is never given a second one. The document is three small fields
 * and is never updated, so it cannot grow.
 */
function storeIdentityDoc(candidate: StoreIdentity): SessionDocToken<StoreIdentityDocument> {
  return defineDoc<StoreIdentityDocument>({
    kind: "nanobot.store-identity",
    version: STORE_IDENTITY_VERSION,
    scope: "session",
    initial: () => ({
      format: candidate.format,
      version: candidate.version,
      storeId: candidate.storeId,
      createdAt: candidate.createdAt,
    }),
    checkpointWhen: () => true,
  });
}

/**
 * Return this store's durable identity, writing it in one commit if it is absent.
 *
 * Idempotent: an existing document is read, never rewritten, so repeated opens and
 * concurrent callers converge on the first committed value. It needs no scan and no
 * network, and the caller supplies the store clock so tests can pin `createdAt`.
 */
export async function ensureStoreIdentity(
  session: Pick<Session, "commit" | "snapshot">,
  context: Context,
  options: { readonly now?: () => number } = {},
): Promise<StoreIdentity> {
  const now = options.now ?? Date.now;
  const candidate: StoreIdentity = {
    format: STORE_IDENTITY_FORMAT,
    version: STORE_IDENTITY_VERSION,
    storeId: randomUUID(),
    createdAt: now(),
  };
  const doc = storeIdentityDoc(candidate);
  // A read-only acquisition stages no storage write once the document exists.
  await session.commit(async (tx) => {
    await tx.doc(doc);
  }, context);
  const stored = await session.snapshot(doc, context);
  return parseStoreIdentity(stored);
}
