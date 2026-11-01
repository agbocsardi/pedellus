import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { parseConfig } from "../config.js";
import { parseMcpConfig, type McpServerConfig } from "./config.js";

/**
 * Owner-authorized writes to the `mcp` block of the gateway's own configuration file.
 *
 * Only an explicit owner request in an authenticated mapped chat reaches this module; no scheduled
 * run, worker, unattended scope or channel message writes configuration on its own. The edit is
 * deliberately narrow:
 *
 * - edits are serialized per configuration path inside this process;
 * - the file is read once into a snapshot, only `mcp.enabled` and `mcp.servers.<name>` are changed, and
 *   everything else is preserved from that snapshot;
 * - the file is read again after the complete replacement has been written to a temporary file and
 *   immediately before the rename, and the edit is refused if its bytes changed, so a concurrent owner
 *   editor or another writer is not silently reverted by a stale copy;
 * - when the whole `mcp` block was disabled, every other entry present in the file is pinned to
 *   `enabled: false`, so enabling the block activates only the entry the owner requested;
 * - the whole merged document is validated with the same parser a gateway start uses, so a requested
 *   entry can never write a configuration this runtime would refuse to open;
 * - the write is atomic (temporary file in the same directory, then rename) and keeps the file's
 *   existing mode.
 *
 * Limitations: JSON is re-serialized with two-space indentation, so hand-written formatting and key
 * order are not preserved. The rename gives the file the gateway user's ownership. The check before
 * the rename and the rename itself are not one atomic operation: the bytes and the file identity are
 * compared by reopening the file once the temporary document is complete, immediately before the
 * replacement, which catches an atomic-save editor that replaced the file and any in-place edit that
 * landed before that comparison, but a writer that lands in the few microseconds between the comparison,
 * the mode change and the rename is still overwritten. POSIX has no compare-and-swap for file content
 * and no lock an arbitrary editor honors, so the window is narrowed and reported, not removed. A removal
 * is bound to the entry this gateway currently holds: an entry on disk that no longer parses to that
 * entry is refused instead of deleted. A change takes effect at the next gateway start; this module never
 * reopens or hot-reloads a runtime.
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
  /** The validated configuration a running gateway applies after this write. */
  readonly config: import("./config.js").McpConfig;
}

/**
 * The `mcp` block one owner disclosure described, taken from the configuration a gateway opened with.
 *
 * A write's effects depend on the block's state on disk (whether it was already enabled, and
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
  // Validate what a start would parse, so an approved edit cannot brick the gateway.
  parseConfig(document, dirname(edit.configFile));
  const temporary = `${edit.configFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Detect an external update once the complete replacement exists, immediately before the rename that
    // installs it. Bytes and the file identity are compared, so an atomic-save editor (a new inode) and an
    // in-place edit are both caught, including one that landed while the temporary file was written. The
    // comparison and the rename are separate syscalls; a writer that lands between them is not detected
    // (documented above).
    const current = await readText(edit.configFile);
    if (current.text !== snapshot.text || !sameIdentity(current.identity, snapshot.identity)) {
      throw new Error(
        "The configuration file changed on disk while this edit was prepared; nothing was written. " +
        "Review the change and retry it before the file changes again.",
      );
    }
    // Keep the mode the file has at replacement time, so an outside chmod is not reverted.
    await chmod(temporary, current.mode);
    await rename(temporary, edit.configFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Add or replace one validated server entry and enable the block. Only the requested entry may
 * become newly active: when the block was off, every other entry is pinned to `enabled: false` first.
 *
 * `expectedBlock` is the block state this gateway reflects. When it is given and the file no longer
 * holds it, the write is refused: the entry would otherwise land with pinning effects the owner did
 * not request. A restart re-reads the file, so the request can be reviewed again.
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
        "The mcp block in the configuration file is not the one this gateway reflects, so the write " +
        "would not apply the effects that were requested; nothing was written. Restart the gateway to re-read " +
        "the file, then request the change again.",
      );
    }
    const servers = rawServers(block);
    const blockWasEnabled = block.enabled === true;
    const nextServers: Record<string, unknown> = { ...servers };
    if (!blockWasEnabled) {
      // Turning the block on would otherwise activate every entry it already held. Pinning keeps the
      // owner's requested authority to exactly this one entry; an entry that is already disabled stays
      // as it is.
      for (const [key, value] of Object.entries(nextServers)) {
        if (key === name || !isRecord(value) || value.enabled === false) continue;
        nextServers[key] = { ...value, enabled: false };
      }
    }
    nextServers[name] = entry;
    const next = { ...block, enabled: true, servers: nextServers };
    const validated = parseConfig({ ...document, mcp: next }, dirname(edit.configFile));
    if (validated.mcp === undefined) throw new Error("The requested MCP entry did not validate");
    await writeDocument(edit, snapshot, { ...document, mcp: next });
    const names = sortedNames(validated.mcp.servers);
    return { servers: names, enabled: validated.mcp.enabled, config: validated.mcp };
  });
}

/**
 * Remove one server entry. `mcp.enabled` is left exactly as it is: disabling the whole capability is
 * a separate owner decision, not a side effect of removing one server.
 *
 * `expectedEntry` is the entry this gateway currently holds. When it is given and the entry on disk no
 * longer parses to that entry, nothing is removed: a bare name would otherwise delete whatever replaced
 * it, including an entry with different authority. An on-disk entry that no longer validates cannot be
 * compared to the disclosed one, so it is refused as well.
 */
export async function removeMcpServerEntry(
  edit: McpConfigEdit,
  name: string,
  expectedEntry?: unknown,
): Promise<McpConfigEditResult> {
  return serialized(edit.configFile, async () => {
    const snapshot = await readDocument(edit);
    const document = snapshot.document;
    const block = rawMcpBlock(document);
    const servers = rawServers(block);
    if (!Object.hasOwn(servers, name)) throw new Error(`Server ${name} is not in the configuration file`);
    if (expectedEntry !== undefined && !sameEntry(edit.workspace, name, servers[name], expectedEntry)) {
      throw new Error(
        `Server ${name} in the configuration file is not the entry this gateway holds; nothing was removed. ` +
        "Review the change on disk, then request the removal again.",
      );
    }
    const remaining = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== name));
    const next = { ...block, servers: remaining };
    const validated = parseConfig({ ...document, mcp: next }, dirname(edit.configFile));
    await writeDocument(edit, snapshot, { ...document, mcp: next });
    const names = Object.keys(validated.mcp?.servers ?? {}).sort((left, right) => left.localeCompare(right, "en-US"));
    const mcp = validated.mcp;
    if (mcp === undefined) throw new Error("The MCP configuration did not validate after the removal");
    return { servers: names, enabled: mcp.enabled, config: mcp };
  });
}

/**
 * Whether one on-disk entry is the disclosed entry, compared as the parsed entry a start would use: an
 * ignored formatting or key-order difference is not a mismatch, any effective difference is.
 */
function sameEntry(workspace: string, name: string, stored: unknown, expected: unknown): boolean {
  let parsed: McpServerConfig;
  let wanted: McpServerConfig;
  try {
    parsed = parseMcpConfig({ enabled: true, servers: { [name]: stored } }, workspace).servers[name]!;
    wanted = parseMcpConfig({ enabled: true, servers: { [name]: expected } }, workspace).servers[name]!;
  } catch {
    return false;
  }
  return JSON.stringify(parsed) === JSON.stringify(wanted);
}
