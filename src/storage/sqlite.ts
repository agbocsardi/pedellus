import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

async function assertDurability(
  database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
  stage: string,
): Promise<void> {
  const journal = await database.get<{ journal_mode: string }>("PRAGMA journal_mode");
  const synchronous = await database.get<{ synchronous: number }>("PRAGMA synchronous");
  if (journal?.journal_mode?.toLowerCase() !== "wal" || synchronous?.synchronous !== 2) {
    throw new Error(
      `SQLite durability check failed ${stage}: expected journal_mode=wal and synchronous=FULL (2), ` +
        `received journal_mode=${journal?.journal_mode ?? "unavailable"}, synchronous=${synchronous?.synchronous ?? "unavailable"}`,
    );
  }
}

/** Open Durable's native SQLite storage with WAL/FULL verified on its owned connection. */
export async function openFullSyncNodeSqliteStorage(path: string, context: Context): Promise<SqliteStorage> {
  const database = await openNodeSqliteDatabase(path);
  let storage: SqliteStorage | undefined;
  try {
    // The upstream opener configures WAL and NORMAL. Upgrade this same connection before
    // constructing storage, and verify the effective setting before any product operation.
    await database.exec("PRAGMA synchronous = FULL");
    await assertDurability(database, "before Durable initialization");

    storage = await SqliteStorage.open(database);
    // Durable's migrations must not weaken the connection policy before Harness receives it.
    await assertDurability(database, "after Durable initialization");
    return storage;
  } catch (error) {
    try {
      if (storage) await storage.close(withoutAbortSignal(context));
      else await database.close();
    } catch {
      // Preserve the initialization error; both native close paths close their owned connection.
    }
    throw error;
  }
}
