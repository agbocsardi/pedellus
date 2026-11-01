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

/**
 * Grant generation per file, for this process only.
 *
 * An owner-approved logout must not be undone by a live connection whose OAuth provider is
 * refreshing: its next `save()` would otherwise write a fresh grant over the deleted file. Every
 * state store records the generation it was created with, and a store whose generation is stale (a
 * clear or a committed replacement happened since) refuses to write. A newly created store, for
 * example in the next gateway process or a later connection, starts at the current generation. The
 * generation also makes an owner-approved login refuse to install its verified replacement if the
 * grant changed while that attempt was running.
 *
 * The state is process-local rather than a durable marker: a process that restarts has no live
 * provider left to flush.
 */
const grantEpochs = new Map<string, number>();

/** The current generation of the grant file for `path`; changes only on a clear or a commit. */
export function mcpOAuthGrantEpoch(path: string): number {
  return grantEpochs.get(path) ?? 0;
}

function bumpEpoch(path: string): number {
  const next = mcpOAuthGrantEpoch(path) + 1;
  grantEpochs.set(path, next);
  return next;
}

/** A pending, owner-approved login writes here and installs it only after verification. */
export function mcpOAuthStagingPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(8).toString("hex")}.pending`;
}

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
  /** The generation this store may write; a clear or commit since then retires it. */
  readonly #epoch: number;

  constructor(path: string, serverUrl: string) {
    this.#path = path;
    this.#serverUrl = String(new URL(serverUrl));
    this.#epoch = mcpOAuthGrantEpoch(path);
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
      if (mcpOAuthGrantEpoch(this.#path) !== this.#epoch) {
        throw new Error("the stored MCP OAuth grant was deleted or replaced; this stale writer does not restore it");
      }
      await writeState(this.#path, this.#serverUrl, state);
    });
  }

  /**
   * Remove this server's stored grant and retire every writer created before this call. A live provider
   * refresh that lands afterwards fails instead of resurrecting the deleted grant; only a verified
   * replacement committed by an owner-approved login (or a store created afterwards) may write it.
   */
  clear(): Promise<void> {
    return serialized(this.#path, async () => {
      await rm(this.#path, { force: true });
      bumpEpoch(this.#path);
    });
  }
}

/** Write one complete state file with a private directory and mode, atomically. */
async function writeState(path: string, serverUrl: string, state: McpOAuthState): Promise<void> {
  if (typeof state.serverUrl !== "string" || state.serverUrl !== serverUrl) {
    throw new Error("MCP OAuth state belongs to a different server URL");
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const body: StoreFile = { version: STORE_VERSION, state };
  try {
    await writeFile(temporary, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Install a login's staged, verified grant as this server's grant.
 *
 * `expectedEpoch` is the generation read when the login started. A logout (or another commit) that
 * happened in the meantime increments it, so the late login cannot restore a grant the owner just
 * deleted. `signal` is rechecked inside the serialized step: a denial or a gateway shutdown that lands
 * between the caller's last check and this write still installs nothing. The caller removes its
 * staging file either way.
 */
export async function commitMcpOAuthState(
  path: string,
  serverUrl: string,
  state: McpOAuthState,
  expectedEpoch: number,
  signal?: AbortSignal,
): Promise<void> {
  await serialized(path, async () => {
    if (signal?.aborted === true) throw new Error("the MCP login was canceled before its grant was installed");
    if (mcpOAuthGrantEpoch(path) !== expectedEpoch) {
      throw new Error("the stored MCP OAuth grant changed while the login was running");
    }
    await writeState(path, String(new URL(serverUrl)), state);
    bumpEpoch(path);
  });
}

/**
 * One consistent view of a stored grant: the state and the generation it was read at.
 *
 * A login seeds its staged copy from this and commits against the same generation, so a logout that
 * lands between reading the grant and capturing the generation cannot make the attempt resurrect the
 * deleted grant under a fresh expectation.
 */
export interface McpOAuthGrantSnapshot {
  readonly state: McpOAuthState | undefined;
  readonly epoch: number;
}

/** Read the stored grant and its generation as one serialized step. Never returns a foreign URL's state. */
export function snapshotMcpOAuthGrant(path: string, serverUrl: string): Promise<McpOAuthGrantSnapshot> {
  return serialized(path, async () => ({
    state: await new FileMcpOAuthStateStore(path, serverUrl).load(),
    epoch: mcpOAuthGrantEpoch(path),
  }));
}

function tokensIdentity(state: McpOAuthState | undefined): string | undefined {
  return state?.tokens === undefined ? undefined : JSON.stringify(state.tokens);
}

/**
 * Persist a refresh a staged attempt obtained from the authorization server.
 *
 * A refresh is not a local edit: the server has already issued the new token and may have invalidated
 * the previous refresh token. Discarding it on a later failure would leave a stored grant that no
 * longer works, so the rotated tokens are adopted as soon as they exist. Adoption is bounded to the
 * case where nothing else wrote the grant since the attempt's snapshot (the generation is unchanged and
 * the stored tokens are still the ones the attempt read); then a login that started from a grant the
 * owner has since replaced or deleted cannot overwrite that decision. Only the token material is taken
 * from `state`; the stored client registration and discovery stay as they were, because the attempt's
 * own may be bound to its ephemeral loopback redirect URI. It deliberately does not bump the
 * generation: a rotation is not a replacement, and retiring the generation would also strand a live
 * connection's own refresh.
 */
export async function adoptMcpOAuthRefresh(
  path: string,
  serverUrl: string,
  snapshot: McpOAuthGrantSnapshot,
  state: McpOAuthState,
): Promise<boolean> {
  const url = String(new URL(serverUrl));
  return serialized(path, async () => {
    if (state.tokens === undefined) return false;
    if (mcpOAuthGrantEpoch(path) !== snapshot.epoch) return false;
    const current = await new FileMcpOAuthStateStore(path, url).load();
    if (tokensIdentity(current) !== tokensIdentity(snapshot.state)) return false;
    if (current === undefined) return false;
    // Adopt the rotation only: the client registration and discovery the attempt used can be bound to
    // its ephemeral loopback redirect URI, so the stored grant keeps its own.
    const next: McpOAuthState = { ...current, tokens: state.tokens };
    if (state.tokensExpireAt === undefined) delete next.tokensExpireAt;
    else next.tokensExpireAt = state.tokensExpireAt;
    await writeState(path, url, next);
    return true;
  });
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
