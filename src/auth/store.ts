import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ApiKeyCredential,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";

const STORE_VERSION = 1;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 50;

interface StoreFile {
  readonly version: typeof STORE_VERSION;
  readonly credentials: Readonly<Record<string, Credential>>;
}

/** Durable's private credential file, inside its configured data directory. */
export function authStorePath(dataDir: string): string {
  return join(dataDir, "credentials.json");
}

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stable installation ID for OAuth flows that identify the agent host. It is
 * created on the first explicit login and kept in Durable's data directory;
 * Pi's auth/device state is never read.
 */
export async function installationDeviceId(dataDir: string): Promise<string> {
  const path = join(dataDir, "credentials-device.json");
  const read = async (): Promise<string | undefined> => {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isRecord(parsed) || typeof parsed.id !== "string" || !DEVICE_ID_PATTERN.test(parsed.id)) {
        throw new Error("Credential device identity has an unsupported format");
      }
      return parsed.id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const existing = await read();
  if (existing !== undefined) return existing;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try {
    await writeFile(path, `${JSON.stringify({ id })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await read();
    if (raced === undefined) throw new Error("Credential device identity disappeared during creation");
    return raced;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error("Credential store contains an invalid provider environment");
  }
  return Object.fromEntries(Object.entries(value)) as Record<string, string>;
}

function credential(value: unknown): Credential {
  if (!isRecord(value)) throw new Error("Credential store contains an invalid entry");
  if (value.type === "api_key") {
    if (value.key !== undefined && typeof value.key !== "string") {
      throw new Error("Credential store contains an invalid API key");
    }
    const result: ApiKeyCredential = { type: "api_key" };
    if (value.key !== undefined) result.key = value.key;
    const env = stringRecord(value.env);
    if (env !== undefined) result.env = env;
    return result;
  }
  if (value.type === "oauth") {
    if (typeof value.refresh !== "string" || typeof value.access !== "string"
      || typeof value.expires !== "number" || !Number.isFinite(value.expires)) {
      throw new Error("Credential store contains an invalid OAuth credential");
    }
    return { ...value, type: "oauth" } as OAuthCredential;
  }
  throw new Error("Credential store contains an unknown credential type");
}

function parseFile(text: string): Record<string, Credential> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Credential store is not valid JSON"); }
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !isRecord(parsed.credentials)) {
    throw new Error("Credential store has an unsupported format");
  }
  const entries: Record<string, Credential> = Object.create(null) as Record<string, Credential>;
  for (const [providerId, value] of Object.entries(parsed.credentials)) {
    if (providerId.length === 0) throw new Error("Credential store contains an empty provider ID");
    entries[providerId] = credential(value);
  }
  return entries;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * File-backed `CredentialStore` for this runtime only. It uses the native
 * type-tagged credential shape, writes atomically with private permissions,
 * and serializes read-modify-write mutations in-process and through a sibling
 * lock directory. It never reads or writes Pi's credential store.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(path: string) {
    this.#path = path;
  }

  async #readAll(options?: AuthOperationOptions): Promise<Record<string, Credential>> {
    options?.signal?.throwIfAborted();
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, Credential>;
      throw error;
    }
    options?.signal?.throwIfAborted();
    return parseFile(text);
  }

  async #writeAll(entries: Record<string, Credential>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const body: StoreFile = { version: STORE_VERSION, credentials: entries };
    try {
      await writeFile(temporary, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      signal?.throwIfAborted();
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #acquire(signal?: AbortSignal): Promise<string> {
    const lock = `${this.#path}.lock`;
    const started = Date.now();
    for (;;) {
      signal?.throwIfAborted();
      try {
        await mkdir(lock, { mode: 0o700 });
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        const current = await stat(lock);
        if (Date.now() - current.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error("Credential store is busy");
      }
      await sleep(LOCK_POLL_MS, signal);
    }
  }

  async #withLock<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const lock = await this.#acquire(signal);
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  #serialized<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const tail = next.catch(() => undefined);
    this.#locks.set(providerId, tail);
    void tail.finally(() => {
      if (this.#locks.get(providerId) === tail) this.#locks.delete(providerId);
    });
    return next;
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#serialized(providerId, async () => {
      const entries = await this.#readAll(options);
      return entries[providerId];
    });
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const entries = await this.#readAll(options);
    return Object.entries(entries).map(([providerId, value]) => ({ providerId, type: value.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#serialized(providerId, () => this.#withLock(options?.signal, async () => {
      const entries = await this.#readAll(options);
      const current = entries[providerId];
      const updated = await fn(current);
      options?.signal?.throwIfAborted();
      if (updated === undefined) return current;
      entries[providerId] = credential(updated);
      await this.#writeAll(entries, options?.signal);
      return entries[providerId];
    }));
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#serialized(providerId, () => this.#withLock(options?.signal, async () => {
      const entries = await this.#readAll(options);
      if (!Object.hasOwn(entries, providerId)) return;
      delete entries[providerId];
      await this.#writeAll(entries, options?.signal);
    }));
  }
}
