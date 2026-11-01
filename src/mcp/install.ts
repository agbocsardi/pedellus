import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { parseConfig } from "../config.js";

/**
 * Owner-approved writes to the `mcp` block of the gateway's own configuration file.
 *
 * Only an explicit owner approval reaches this module; no model tool, conversation, scheduled run or
 * channel message writes configuration on its own. The edit is deliberately narrow:
 *
 * - edits are serialized per configuration path inside this process;
 * - the file is read once into a snapshot, only `mcp.enabled` and `mcp.servers.<name>` are changed, and
 *   everything else is preserved from that snapshot;
 * - immediately before the replacement the file is read again and the edit is refused if its bytes
 *   changed, so a concurrent owner editor or another writer is not silently reverted by a stale copy;
 * - when the whole `mcp` block was disabled, every other entry present in the file is pinned to
 *   `enabled: false`, so enabling the block activates only the entry the owner approved;
 * - the whole merged document is validated with the same parser a gateway start uses, so an approved
 *   entry can never write a configuration this runtime would refuse to open;
 * - the write is atomic (temporary file in the same directory, then rename) and keeps the file's
 *   existing mode.
 *
 * Limitations: JSON is re-serialized with two-space indentation, so hand-written formatting and key
 * order are not preserved. The rename gives the file the gateway user's ownership. The check before
 * the rename and the rename itself are not one atomic operation: the bytes and the file identity are
 * compared by reopening the file immediately before the replacement, which catches an atomic-save
 * editor that replaced the file and any in-place edit that landed before the comparison, but a writer
 * that lands in the few microseconds between that comparison and the rename is still overwritten.
 * POSIX has no compare-and-swap for file content and no lock an arbitrary editor honors, so the
 * window is narrowed and reported, not removed. A change takes effect at the next gateway start;
 * this module never reopens or hot-reloads a runtime.
 */
export interface McpConfigEdit {
  /** Absolute path of the configuration file this gateway loaded. */
  readonly configFile: string;
  /** Workspace used to validate a stdio server's `cwd`, exactly as at start. */
  readonly workspace: string;
}

export interface McpConfigEditResult {
  /** Server names in the new block, sorted. */
  readonly servers: readonly string[];
  /** Whether the block enables MCP after this edit. */
  readonly enabled: boolean;
}

/**
 * The `mcp` block one owner disclosure described, taken from the configuration a gateway opened with.
 *
 * A `config` approval's effects depend on the block's state on disk (whether it was already enabled, and
 * which entries a turn-on would pin), so the disclosure and the write must read the same state. The write
 * refuses when the block on disk no longer matches this expectation instead of applying effects the owner
 * never saw.
 */
export interface McpConfigBlockExpectation {
  readonly enabled: boolean;
  /** Server entry names in the block, sorted. */
  readonly servers: readonly string[];
}

const CONFIG_FILE_LIMIT_BYTES = 1024 * 1024;

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMs: number;
}

interface DocumentSnapshot {
  readonly text: string;
  readonly document: Record<string, unknown>;
  /** Identity of the file the snapshot was read from, compared again before the replacement. */
  readonly identity: FileIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identityOf(info: Awaited<ReturnType<FileHandle["stat"]>>): FileIdentity {
  return {
    device: Number(info.dev),
    inode: Number(info.ino),
    size: Number(info.size),
    modifiedMs: Number(info.mtimeMs),
  };
}

/** Identity plus bytes: an atomic-save editor replaces the inode, an in-place edit keeps it. */
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode &&
    left.size === right.size && left.modifiedMs === right.modifiedMs;
}

/** In-process serialization per configuration path. */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const tail = next.catch(() => undefined);
  queues.set(path, tail);
  void tail.finally(() => {
    if (queues.get(path) === tail) queues.delete(path);
  });
  return next;
}

async function readText(path: string): Promise<{ readonly text: string; readonly mode: number; readonly identity: FileIdentity }> {
  let handle: FileHandle | undefined;
  try {
    // O_NOFOLLOW: a symlinked configuration file is refused instead of replaced through its target.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("The configuration file must be a regular file");
    if (info.size > CONFIG_FILE_LIMIT_BYTES) throw new Error("The configuration file is unexpectedly large");
    return { text: await handle.readFile("utf8"), mode: info.mode & 0o777, identity: identityOf(info) };
  } finally {
    await handle?.close();
  }
}

async function readDocument(edit: McpConfigEdit): Promise<DocumentSnapshot> {
  const { text, identity } = await readText(edit.configFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The configuration file is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("The configuration file must contain a JSON object");
  return { text, document: Object.fromEntries(Object.entries(parsed)), identity };
}

/** Read the on-disk `mcp` block without trusting the in-memory copy the gateway opened with. */
function rawMcpBlock(document: Record<string, unknown>): Record<string, unknown> {
  const block = document.mcp;
  if (block === undefined) return {};
  if (!isRecord(block)) throw new Error("The configuration file has an invalid mcp block");
  return Object.fromEntries(Object.entries(block));
}

function rawServers(block: Record<string, unknown>): Record<string, unknown> {
  const servers = block.servers;
  if (servers === undefined) return {};
  if (!isRecord(servers)) throw new Error("The configuration file has an invalid mcp.servers block");
  return Object.fromEntries(Object.entries(servers));
}

function sortedNames(servers: Record<string, unknown>): string[] {
  return Object.keys(servers).sort((left, right) => left.localeCompare(right, "en-US"));
}

/** Whether the on-disk block is exactly the one a disclosure described. */
function blockMatches(block: Record<string, unknown>, expected: McpConfigBlockExpectation): boolean {
  if ((block.enabled === true) !== expected.enabled) return false;
  const names = sortedNames(rawServers(block));
  return names.length === expected.servers.length && names.every((name, index) => name === expected.servers[index]);
}

async function writeDocument(
  edit: McpConfigEdit,
  snapshot: DocumentSnapshot,
  document: Record<string, unknown>,
): Promise<void> {
  // Validate exactly what a start would parse, so an approved edit cannot brick the gateway.
  parseConfig(document, dirname(edit.configFile));
  // Detect an external update between this edit's read and the replacement. Bytes and the file identity
  // are compared, so an atomic-save editor (a new inode) and an in-place edit are both caught. The
  // comparison and the rename are separate syscalls; a writer that lands between them is not detected
  // (documented above).
  const current = await readText(edit.configFile);
  if (current.text !== snapshot.text || !sameIdentity(current.identity, snapshot.identity)) {
    throw new Error(
      "The configuration file changed on disk while this edit was prepared; nothing was written. " +
      "Review the request again and approve it before retrying.",
    );
  }
  const temporary = `${edit.configFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Keep the mode the file has at replacement time, so an outside chmod is not reverted.
    await chmod(temporary, current.mode);
    await rename(temporary, edit.configFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Add or replace one validated server entry and enable the block. Only the approved entry may become
 * newly active: when the block was off, every other entry is pinned to `enabled: false` first.
 *
 * `expectedBlock` is the block state the approving owner was shown. When it is given and the file no longer
 * holds it, the write is refused: the entry would otherwise land with effects the disclosure did not
 * describe, such as pinning entries the gateway never opened with. A start re-reads the file, so the owner
 * can restart and review again.
 */
export async function writeMcpServerEntry(
  edit: McpConfigEdit,
  name: string,
  entry: unknown,
  expectedBlock?: McpConfigBlockExpectation,
): Promise<McpConfigEditResult> {
  return serialized(edit.configFile, async () => {
    const snapshot = await readDocument(edit);
    const document = snapshot.document;
    const block = rawMcpBlock(document);
    if (expectedBlock !== undefined && !blockMatches(block, expectedBlock)) {
      throw new Error(
        "The mcp block in the configuration file is not the one this gateway opened with, so the approval " +
        "would not apply the effects that were disclosed; nothing was written. Restart the gateway to re-read " +
        "the file, then review and approve again.",
      );
    }
    const servers = rawServers(block);
    const blockWasEnabled = block.enabled === true;
    const nextServers: Record<string, unknown> = { ...servers };
    if (!blockWasEnabled) {
      // Turning the block on would otherwise activate every entry it already held. Pinning keeps the
      // owner's approved authority to exactly this one entry; an entry that is already disabled stays
      // as it is.
      for (const [key, value] of Object.entries(nextServers)) {
        if (key === name || !isRecord(value) || value.enabled === false) continue;
        nextServers[key] = { ...value, enabled: false };
      }
    }
    nextServers[name] = entry;
    const next = { ...block, enabled: true, servers: nextServers };
    const validated = parseConfig({ ...document, mcp: next }, dirname(edit.configFile));
    if (validated.mcp === undefined) throw new Error("The approved MCP entry did not validate");
    await writeDocument(edit, snapshot, { ...document, mcp: next });
    const names = sortedNames(validated.mcp.servers);
    return { servers: names, enabled: validated.mcp.enabled };
  });
}

/**
 * Remove one server entry. `mcp.enabled` is left exactly as it is: disabling the whole capability is
 * a separate owner decision, not a side effect of removing one server.
 */
export async function removeMcpServerEntry(edit: McpConfigEdit, name: string): Promise<McpConfigEditResult> {
  return serialized(edit.configFile, async () => {
    const snapshot = await readDocument(edit);
    const document = snapshot.document;
    const block = rawMcpBlock(document);
    const servers = rawServers(block);
    if (!Object.hasOwn(servers, name)) throw new Error(`Server ${name} is not in the configuration file`);
    const remaining = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== name));
    const next = { ...block, servers: remaining };
    const validated = parseConfig({ ...document, mcp: next }, dirname(edit.configFile));
    await writeDocument(edit, snapshot, { ...document, mcp: next });
    const names = Object.keys(validated.mcp?.servers ?? {}).sort((left, right) => left.localeCompare(right, "en-US"));
    return { servers: names, enabled: validated.mcp?.enabled === true };
  });
}
