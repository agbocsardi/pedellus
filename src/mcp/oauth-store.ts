import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";

/**
 * Private durable OAuth state for one configured HTTP MCP server.
 *
 * It lives in the runtime's canonical data directory, never in the workspace, the transcript, a
 * conversation document or a channel message: an access or refresh token is credential material and
 * must not be readable by the model, a coding tool or any conversation reader. One file per exact
 * server URL means renaming a server keeps its grant while pointing it at a different URL cannot
 * reuse the old one.
 */
const STORE_VERSION = 1;

/** Directory holding the token files, inside the canonical data directory. */
export function mcpOAuthStoreDirectory(dataDir: string): string {
  return join(dataDir, "mcp", "oauth");
}

/** One file per server URL. The digest binds the filename to the exact URL, never to a server name. */
export function mcpOAuthStatePath(dataDir: string, serverUrl: string): string {
  const digest = createHash("sha256").update(serverUrl, "utf8").digest("hex").slice(0, 32);
  return join(mcpOAuthStoreDirectory(dataDir), `${digest}.json`);
}

interface StoreFile {
  readonly version: typeof STORE_VERSION;
  readonly state: McpOAuthState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("MCP OAuth state contains an invalid nested object");
  return Object.fromEntries(Object.entries(value));
}

/**
 * Copy only the state fields this runtime persists. Unknown keys are dropped so a crafted or
 * corrupted file cannot smuggle arbitrary content into the credential store.
 */
function oauthState(value: unknown): McpOAuthState {
  if (!isRecord(value) || typeof value.serverUrl !== "string") {
    throw new Error("MCP OAuth state is invalid");
  }
  const state: Record<string, unknown> = { serverUrl: value.serverUrl };
  for (const key of ["clientInformation", "tokens", "discovery"]) {
    const nested = optionalRecord(value[key]);
    if (nested !== undefined) state[key] = nested;
  }
  for (const key of ["tokensExpireAt"]) {
    const number = value[key];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`MCP OAuth state has an invalid ${key}`);
    state[key] = number;
  }
  for (const key of ["codeVerifier", "oauthState"]) {
    const text = value[key];
    if (text === undefined) continue;
    if (typeof text !== "string") throw new Error(`MCP OAuth state has an invalid ${key}`);
    state[key] = text;
  }
  return state as unknown as McpOAuthState;
}

/** In-process serialization per file; cross-process use of one data directory is already refused. */
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

async function readFileText(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    // O_NOFOLLOW keeps the read on the resolved regular file rather than a swapped-in symlink.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw new Error("MCP OAuth state path must be a regular file");
    return await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export class FileMcpOAuthStateStore implements McpOAuthStateStore {
  readonly #path: string;
  readonly #serverUrl: string;

  constructor(path: string, serverUrl: string) {
    this.#path = path;
    this.#serverUrl = String(new URL(serverUrl));
  }

  /** The state for this exact URL, or undefined. Another server's file content is never returned. */
  async load(): Promise<McpOAuthState | undefined> {
    const text = await readFileText(this.#path);
    if (text === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("MCP OAuth state is not valid JSON");
    }
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION) {
      throw new Error("MCP OAuth state has an unsupported format");
    }
    const state = oauthState(parsed.state);
    return state.serverUrl === this.#serverUrl ? state : undefined;
  }

  save(state: McpOAuthState): Promise<void> {
    return serialized(this.#path, async () => {
      if (typeof state.serverUrl !== "string" || state.serverUrl !== this.#serverUrl) {
        throw new Error("MCP OAuth state belongs to a different server URL");
      }
      const directory = dirname(this.#path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = `${this.#path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      const body: StoreFile = { version: STORE_VERSION, state };
      try {
        await writeFile(temporary, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  /** Remove this server's stored grant. A later login starts from no client and no token. */
  clear(): Promise<void> {
    return serialized(this.#path, async () => {
      await rm(this.#path, { force: true });
    });
  }
}

/** Read-only presence check for diagnostics; it never returns a token. */
export async function hasMcpOAuthTokens(path: string, serverUrl: string): Promise<boolean> {
  try {
    return (await new FileMcpOAuthStateStore(path, serverUrl).load())?.tokens !== undefined;
  } catch {
    // An unreadable or malformed file is not a usable grant, and its content is never reported.
    return false;
  }
}
