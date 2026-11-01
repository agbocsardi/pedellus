import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { parseConfig } from "../config.js";

/**
 * Owner-approved writes to the `mcp` block of the gateway's own configuration file.
 *
 * Only an explicit owner approval reaches this module; no model tool, conversation, scheduled run or
 * channel message writes configuration on its own. The edit is deliberately narrow:
 *
 * - the file is read, only `mcp.enabled` and `mcp.servers.<name>` are changed, and everything else is
 *   preserved as it is on disk (a concurrent owner edit is never silently reverted by a stale copy);
 * - the whole merged document is validated with the same parser a gateway start uses, so an approved
 *   entry can never write a configuration this runtime would refuse to open;
 * - the write is atomic (temporary file in the same directory, then rename) and keeps the file's
 *   existing mode.
 *
 * Limitations: JSON is re-serialized with two-space indentation, so hand-written formatting and key
 * order are not preserved. The rename gives the file the gateway user's ownership. A change takes
 * effect at the next gateway start; this module never reopens or hot-reloads a runtime.
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

const CONFIG_FILE_LIMIT_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readDocument(edit: McpConfigEdit): Promise<Record<string, unknown>> {
  let text: string;
  let handle: FileHandle | undefined;
  try {
    // O_NOFOLLOW: a symlinked configuration file is refused instead of replaced through its target.
    handle = await open(edit.configFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("The configuration file must be a regular file");
    if (info.size > CONFIG_FILE_LIMIT_BYTES) throw new Error("The configuration file is unexpectedly large");
    text = await handle.readFile("utf8");
  } finally {
    await handle?.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The configuration file is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("The configuration file must contain a JSON object");
  return Object.fromEntries(Object.entries(parsed));
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

async function writeDocument(edit: McpConfigEdit, document: Record<string, unknown>): Promise<void> {
  // Validate exactly what a start would parse, so an approved edit cannot brick the gateway.
  parseConfig(document, dirname(edit.configFile));
  const mode = (await stat(edit.configFile)).mode & 0o777;
  const temporary = `${edit.configFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, edit.configFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Add or replace one validated server entry and enable the block. */
export async function writeMcpServerEntry(
  edit: McpConfigEdit,
  name: string,
  entry: unknown,
): Promise<McpConfigEditResult> {
  const document = await readDocument(edit);
  const block = rawMcpBlock(document);
  const servers = rawServers(block);
  const next = { ...block, enabled: true, servers: { ...servers, [name]: entry } };
  const validated = parseConfig({ ...document, mcp: next }, dirname(edit.configFile));
  if (validated.mcp === undefined) throw new Error("The approved MCP entry did not validate");
  await writeDocument(edit, { ...document, mcp: next });
  const names = Object.keys(validated.mcp.servers).sort((left, right) => left.localeCompare(right, "en-US"));
  return { servers: names, enabled: validated.mcp.enabled };
}

/**
 * Remove one server entry. `mcp.enabled` is left exactly as it is: disabling the whole capability is
 * a separate owner decision, not a side effect of removing one server.
 */
export async function removeMcpServerEntry(edit: McpConfigEdit, name: string): Promise<McpConfigEditResult> {
  const document = await readDocument(edit);
  const block = rawMcpBlock(document);
  const servers = rawServers(block);
  if (!Object.hasOwn(servers, name)) throw new Error(`Server ${name} is not in the configuration file`);
  const remaining = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== name));
  const next = { ...block, servers: remaining };
  const validated = parseConfig({ ...document, mcp: next }, dirname(edit.configFile));
  await writeDocument(edit, { ...document, mcp: next });
  const names = Object.keys(validated.mcp?.servers ?? {}).sort((left, right) => left.localeCompare(right, "en-US"));
  return { servers: names, enabled: validated.mcp?.enabled === true };
}
