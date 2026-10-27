import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PortConfig } from "./config.js";

export function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

/**
 * Canonicalize the configured workspace/data roots and the SQLite path. Both the
 * gateway and the owner-driven recovery path use this, so neither can open a
 * database that overlaps a writable host root or a symlinked database file.
 */
export async function prepareDataDirectory(config: PortConfig): Promise<PreparedDataDirectory> {
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
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const canonicalDataDir = await realpath(dataDir);
  if (roots.some((root) => inside(canonicalDataDir, root) || inside(root, canonicalDataDir))) {
    throw new Error("dataDir resolves inside or above workspace/extraAllowedDirs");
  }
  await chmod(canonicalDataDir, 0o700);
  const dbPath = resolve(canonicalDataDir, "nanobot.sqlite");
  try {
    const pathStat = await lstat(dbPath);
    if (!pathStat.isFile()) throw new Error("SQLite database path must be a regular file, not a symlink or special file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { workspace, extraRoots, canonicalDataDir, dbPath };
}
