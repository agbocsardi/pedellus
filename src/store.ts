import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { PortConfig } from "./config.js";
import { isPathWithin } from "./execution/policy.js";

/** `path` is `root` or lexically below it; the one shared containment check. */
export function inside(path: string, root: string): boolean {
  return isPathWithin(root, path);
}

export async function canonicalFuturePath(path: string): Promise<string> {
  const target = resolve(path);
  let existing = target;
  const tail: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(existing);
      return resolve(canonical, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = resolve(existing, "..");
      if (parent === existing) throw error;
      tail.push(relative(parent, existing));
      existing = parent;
    }
  }
}

export interface PreparedDataDirectory {
  readonly workspace: string;
  readonly extraRoots: readonly string[];
  readonly canonicalDataDir: string;
  readonly dbPath: string;
}

export interface PrepareDataDirectoryOptions {
  /**
   * Recovery must not initialize or recreate a store after a typo or a moved
   * dataDir. Require the data directory and `nanobot.sqlite` to already exist.
   */
  readonly requireExistingDatabase?: boolean;
}

async function assertExistingDatabaseFile(dbPath: string): Promise<void> {
  let pathStat;
  try {
    pathStat = await lstat(dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("SQLite database does not exist; refusing to create a new recovery store");
    }
    throw error;
  }
  if (!pathStat.isFile()) throw new Error("SQLite database path must be a regular file, not a symlink or special file");
}

/** Recheck after acquiring the owner lock, before handing the path to SQLite. */
export async function assertExistingDatabaseFileForRecovery(dbPath: string): Promise<void> {
  await assertExistingDatabaseFile(dbPath);
}

/**
 * The private-owner contract the gateway installs at dataDir creation: a directory owned by the
 * current user with no group or other access. The gateway, the CLI's read-only socket lookup and
 * `doctor` all require it before using a path inside the directory, because a shared or
 * foreign-owned directory could carry anyone's socket or file. The reason strings are fixed and
 * path-free so any caller can report them directly.
 */
export function ownerPrivateDirectoryReason(
  identity: { isDirectory(): boolean; readonly mode: number; readonly uid: number },
): string | undefined {
  if ((identity.mode & 0o077) !== 0) {
    return "is not owner-private (mode must be 0700: no group or other access)";
  }
  const owner = process.getuid?.();
  if (owner !== undefined && identity.uid !== owner) return "is owned by another user";
  return undefined;
}

/**
 * Validate configured roots and dataDir disjointness without creating or modifying anything.
 * Missing roots are still resolved via `canonicalFuturePath` so read-only commands like
 * `models list` work before workspace creation while still failing closed on overlapping roots.
 *
 * An existing data directory must already meet the same private-owner contract the gateway
 * enforces when it creates it (`ownerPrivateDirectoryReason`). The check is read-only — nothing
 * is created, chmodded or repaired — so a client command either connects to an owner-private
 * directory or fails closed; a shared or foreign-owned directory could carry anyone's socket and
 * is never used.
 */
export async function validateDataDirectoryReadOnly(config: PortConfig): Promise<string> {
  const roots = await Promise.all([config.workspace, ...(config.extraAllowedDirs ?? [])].map(async (path) => {
    const canonical = await canonicalFuturePath(path);
    try {
      if (!(await stat(canonical)).isDirectory()) throw new Error("configured root is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return canonical;
  }));
  const dataDir = await canonicalFuturePath(config.dataDir);
  if (roots.some((root) => inside(dataDir, root) || inside(root, dataDir))) {
    throw new Error("dataDir must be disjoint from workspace and extraAllowedDirs");
  }
  try {
    const dataDirStat = await stat(dataDir);
    if (!dataDirStat.isDirectory()) throw new Error("dataDir must be a directory");
    const privateReason = ownerPrivateDirectoryReason(dataDirStat);
    if (privateReason !== undefined) throw new Error(`dataDir ${privateReason}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return dataDir;
}

/**
 * Canonicalize the configured workspace/data roots and the SQLite path. Both the
 * gateway and the owner-driven recovery path use this, so neither can open a
 * database that overlaps a writable host root or a symlinked database file.
 */
export async function prepareDataDirectory(
  config: PortConfig,
  options: PrepareDataDirectoryOptions = {},
): Promise<PreparedDataDirectory> {
  const workspace = await realpath(config.workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error("workspace must be a directory");
  const extraRoots = await Promise.all((config.extraAllowedDirs ?? []).map(async (path) => {
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw new Error(`extraAllowedDirs entry is not a directory: ${path}`);
    return root;
  }));
  const roots = [workspace, ...extraRoots];
  const dataDir = await canonicalFuturePath(config.dataDir);
  if (roots.some((root) => inside(dataDir, root) || inside(root, dataDir))) {
    throw new Error("dataDir must be disjoint from workspace and extraAllowedDirs");
  }
  if (options.requireExistingDatabase === true) {
    let dataDirStat;
    try {
      dataDirStat = await stat(dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("SQLite data directory does not exist; refusing to create a new recovery store");
      }
      throw error;
    }
    if (!dataDirStat.isDirectory()) throw new Error("SQLite data directory must be a directory");
  } else {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  }
  const canonicalDataDir = await realpath(dataDir);
  if (roots.some((root) => inside(canonicalDataDir, root) || inside(root, canonicalDataDir))) {
    throw new Error("dataDir resolves inside or above workspace/extraAllowedDirs");
  }
  await chmod(canonicalDataDir, 0o700);
  const dbPath = resolve(canonicalDataDir, "nanobot.sqlite");
  if (options.requireExistingDatabase === true) {
    await assertExistingDatabaseFile(dbPath);
  } else {
    try {
      const pathStat = await lstat(dbPath);
      if (!pathStat.isFile()) throw new Error("SQLite database path must be a regular file, not a symlink or special file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { workspace, extraRoots, canonicalDataDir, dbPath };
}
