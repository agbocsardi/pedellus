/**
 * Shared workspace filesystem-safety, input-validation and flat-frontmatter
 * primitives for the context loaders (`workspace.ts`, `memory.ts`,
 * `skills.ts`), the notes memory backend and memory digestion.
 *
 * Path safety is Linux-only: directories are pinned through `/proc/self/fd`
 * with `O_DIRECTORY | O_NOFOLLOW`, files are opened with `O_NOFOLLOW`, hard-link
 * aliases (`nlink != 1`) are refused and a file whose metadata changes during a
 * read, or whose name no longer resolves to the read inode afterwards, is a
 * failure. This is accidental-damage protection against ordinary
 * symlink/hard-link escapes and detectable swaps, not a defence against a
 * privileged adversary; a change after the final check remains a TOCTOU window.
 *
 * Every helper that can fail takes the caller's error factory, so each loader
 * keeps its own typed error classes and messages.
 */
import { constants, existsSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** C0 controls and DEL: never valid in a locator, label or root. */
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** Unicode line/paragraph separators: they would break one-entry-per-line manifests. */
export const LINE_SEPARATORS = /[\u2028\u2029]/;
/** Kernel pseudo-filesystems a workspace root may never live under. */
export const RESTRICTED_ROOTS = Object.freeze(["/proc", "/sys", "/dev"]);
/** Strict ASCII name: skill directories and memory-curation path segments. */
export const SAFE_ASCII_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Workspace memory layout shared by the context loader and memory digestion. */
export const MEMORY_DIR = "memory";
export const MEMORY_SYSTEM_DIR = "system";
/** Legacy/protected memory names: injected only, never topics and never curated. */
export const PROTECTED_MEMORY_NAMES: ReadonlySet<string> = Object.freeze(new Set(["MEMORY.md", "HISTORY.md"]));

export const PROC_FD = "/proc/self/fd";
export const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** Opens an explicitly host-named root directory, following symlinks in its own path. */
export const ROOT_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY;
export const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type FsFailureKind =
  | "missing"
  | "symlink"
  | "hardlink"
  | "not-regular"
  | "not-directory"
  | "unreadable"
  | "changed"
  | "encoding"
  | "io";

/** Builds the caller's typed file error for one stable, workspace-relative label. */
export type FileErrorFactory = (kind: FsFailureKind, source: string) => Error;

/** Neutral typed failure for callers that translate kinds into their own contract. */
export class FsSafeError extends Error {
  readonly kind: FsFailureKind;
  readonly source: string;

  constructor(kind: FsFailureKind, source: string) {
    super(`Workspace file ${source}: ${kind}`);
    this.name = "FsSafeError";
    this.kind = kind;
    this.source = source;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    return !Array.isArray(value);
  } catch {
    // A revoked Proxy must become a typed input error at the caller, not an
    // untyped TypeError escaping from Array.isArray.
    return false;
  }
}

export interface OwnDataField {
  readonly found: boolean;
  readonly value: unknown;
}

/**
 * Capture only own data properties. Inherited and accessor-backed fields are
 * rejected rather than invoked or treated as absent; an absent field is
 * `{ found: false }`.
 */
export function ownDataField(
  value: unknown,
  key: string,
  label: string,
  fail: (message: string) => Error,
): OwnDataField {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw fail(`${label} must be an object`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(`${label}.${key} is unreadable`);
  }
  if (descriptor === undefined) {
    let inherited = false;
    try {
      inherited = key in value;
    } catch {
      inherited = true;
    }
    if (inherited) throw fail(`${label}.${key} must be an own data property`);
    return { found: false, value: undefined };
  }
  if (!Object.hasOwn(descriptor, "value")) {
    throw fail(`${label}.${key} must be an own data property`);
  }
  return { found: true, value: descriptor.value };
}

export function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export interface RootRules {
  readonly maxChars: number;
  /** Refuse any `.nanobot` component (the Python bot's default home). */
  readonly refuseNanobot?: boolean;
}

/** Validate an explicit absolute root without touching the filesystem. */
export function validatedRoot(
  value: unknown,
  label: string,
  rules: RootRules,
  fail: (message: string) => Error,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > rules.maxChars ||
      !isAbsolute(value) || CONTROL_CHARACTERS.test(value)) {
    throw fail(`${label} must be an explicit absolute path`);
  }
  const root = resolve(value);
  if (root === sep) throw fail(`${label} must not be the filesystem root`);
  if (rules.refuseNanobot === true && root.split(sep).some((component) => component.toLowerCase() === ".nanobot")) {
    throw fail(`${label} must not overlap the default ~/.nanobot location`);
  }
  for (const restricted of RESTRICTED_ROOTS) {
    if (isWithin(restricted, root)) throw fail(`${label} must not be inside a restricted system directory`);
  }
  return root;
}

/**
 * Any name the filesystem may hold, except control characters, dot segments and
 * Unicode line separators. The workspace and memory loaders share this locator
 * rule, so a topic one discovers can also be named in the other.
 */
export function safeMemorySegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." &&
    !CONTROL_CHARACTERS.test(segment) && !LINE_SEPARATORS.test(segment);
}

export function codePointCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

/** At most `limit` whole code points; never splits a surrogate pair. */
export function clipCodePoints(value: string, limit: number): string {
  if (limit <= 0) return "";
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count >= limit) return value.slice(0, end);
    end += character.length;
    count++;
  }
  return value;
}

/** Strict UTF-8 decode; malformed input becomes the caller's typed error. */
export function decodeUtf8(buffer: Uint8Array, onInvalid: () => Error): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw onInvalid();
  }
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export function failureKind(code: string | undefined): FsFailureKind {
  switch (code) {
    case "ENOENT":
      return "missing";
    case "ELOOP":
      return "symlink";
    case "EACCES":
    case "EPERM":
      return "unreadable";
    case "ENOTDIR":
      return "not-directory";
    case "EISDIR":
    // `O_NONBLOCK` opens of a Unix socket fail with ENXIO: it is a special file, not a read failure.
    case "ENXIO":
      return "not-regular";
    default:
      return "io";
  }
}

/** Keep an already typed failure; classify anything else by its errno code. */
export function fileFailure<E extends Error>(
  error: unknown,
  source: string,
  ErrorClass: new (kind: FsFailureKind, source: string) => E,
): E {
  if (error instanceof ErrorClass) return error;
  return new ErrorClass(failureKind(errorCode(error)), source);
}

/* ------------------------------------------------------------------------ */
/* Flat frontmatter                                                          */
/* ------------------------------------------------------------------------ */

/**
 * One flat `key: value` frontmatter line, or undefined for comments and lines
 * without a key. Key and value are trimmed; each caller applies its own key
 * rule (case folding, allowed characters, indentation) and value parsing.
 */
export function frontmatterField(line: string): { readonly key: string; readonly value: string } | undefined {
  if (line.trimStart().startsWith("#")) return undefined;
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  const key = line.slice(0, colon).trim();
  if (!key) return undefined;
  return { key, value: line.slice(colon + 1).trim() };
}

/** Python-compatible quote stripping for flat memory frontmatter values. */
export function unquoteFrontmatter(value: string): string {
  return value.replace(/^["']+|["']+$/g, "");
}

/* ------------------------------------------------------------------------ */
/* Pinned Linux traversal                                                    */
/* ------------------------------------------------------------------------ */

export function pinnedFsSupported(): boolean {
  return process.platform === "linux" &&
    typeof constants.O_NOFOLLOW === "number" &&
    typeof constants.O_DIRECTORY === "number" &&
    existsSync(PROC_FD);
}

export function procFdPath(fd: number): string {
  return `${PROC_FD}/${fd}`;
}

/** The `/proc/self/fd` name of `name` beneath an already pinned directory. */
export function pinnedChildPath(parent: FileHandle, name: string): string {
  return join(procFdPath(parent.fd), name);
}

/**
 * Open an absolute directory one component at a time beneath pinned
 * descriptors, so no component (including the last) may be a symlink.
 * `onError` turns an open failure (or a root with no components) into the
 * caller's typed root error.
 */
export async function openAbsoluteDirectoryNoFollow(
  path: string,
  onError: (error: unknown) => Error,
): Promise<FileHandle> {
  const components = path.slice(1).split(sep).filter(Boolean);
  if (components.length === 0) throw onError(undefined);
  let current: FileHandle;
  try {
    current = await open(sep, DIRECTORY_FLAGS);
  } catch (error) {
    throw onError(error);
  }
  try {
    for (const component of components) {
      let next: FileHandle;
      try {
        next = await open(pinnedChildPath(current, component), DIRECTORY_FLAGS);
      } catch (error) {
        throw onError(error);
      }
      const previous = current;
      // Own the new descriptor first, so a failed close of the previous one cannot leak it.
      current = next;
      try {
        await previous.close();
      } catch (error) {
        throw onError(error);
      }
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

/** Open an explicitly host-named root directory; symlinks in its own path are followed. */
export async function openRootDirectory(
  path: string,
  onError: (error: unknown) => Error,
): Promise<FileHandle> {
  try {
    return await open(path, ROOT_DIRECTORY_FLAGS);
  } catch (error) {
    throw onError(error);
  }
}

export function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

export function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

/** Directory identity only: a rename or replacement changes dev/ino/mode. */
export function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** A failed `fstat` is a typed failure for `source`, never an untyped rejection. */
export async function statHandle(handle: FileHandle, source: string, fail: FileErrorFactory): Promise<BigIntStats> {
  try {
    return await handle.stat({ bigint: true });
  } catch (error) {
    throw fail(failureKind(errorCode(error)), source);
  }
}

/** Open one entry beneath a pinned directory without following a final symlink. */
export async function openPinned(
  parent: FileHandle,
  name: string,
  flags: number,
  source: string,
  fail: FileErrorFactory,
): Promise<FileHandle> {
  const path = pinnedChildPath(parent, name);
  try {
    return await open(path, flags);
  } catch (error) {
    let kind = failureKind(errorCode(error));
    // O_NOFOLLOW + O_DIRECTORY can report ENOTDIR on some kernels when the
    // final component is a symlink. Classify it without following the link.
    if (kind === "not-directory") {
      try {
        if ((await lstat(path, { bigint: true })).isSymbolicLink()) kind = "symlink";
      } catch {
        // Keep the original classification.
      }
    }
    throw fail(kind, source);
  }
}

/** Open a chain of directories beneath a pinned root; the caller closes the result. */
export async function openPinnedDirectories(
  root: FileHandle,
  segments: readonly string[],
  source: string,
  fail: FileErrorFactory,
): Promise<FileHandle> {
  let current: FileHandle | null = null;
  let parent = root;
  try {
    for (const segment of segments) {
      const next = await openPinned(parent, segment, DIRECTORY_FLAGS, source, fail);
      const previous = current;
      current = next;
      parent = next;
      if (previous !== null) await previous.close().catch(() => undefined);
    }
    if (current === null) throw fail("not-directory", source);
    return current;
  } catch (error) {
    if (current !== null) await current.close().catch(() => undefined);
    throw error;
  }
}

export interface PinnedRead {
  readonly buffer: Buffer;
  /** Metadata observed before the read and confirmed after it. */
  readonly stat: BigIntStats;
}

/**
 * Read one regular, single-link file through an already pinned parent
 * directory. The file must keep its metadata during the read, and its name must
 * still resolve to the same inode afterwards; otherwise the read is `changed`.
 */
export async function readPinnedFile(
  parent: FileHandle,
  name: string,
  source: string,
  fail: FileErrorFactory,
): Promise<PinnedRead> {
  const handle = await openPinned(parent, name, FILE_FLAGS, source, fail);
  try {
    const before = await statHandle(handle, source, fail);
    if (!before.isFile()) throw fail("not-regular", source);
    if (before.nlink !== 1n) throw fail("hardlink", source);
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) throw fail("io", source);

    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(size);
    } catch (error) {
      // A size the runtime cannot allocate is a read failure for this file; it
      // must stay a typed file error instead of escaping as an untyped crash.
      throw fail(failureKind(errorCode(error)), source);
    }
    let offset = 0;
    while (offset < size) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, offset, size - offset, offset));
      } catch (error) {
        throw fail(failureKind(errorCode(error)), source);
      }
      if (bytesRead === 0) throw fail("changed", source);
      offset += bytesRead;
    }

    const after = await statHandle(handle, source, fail);
    if (!sameFile(before, after)) throw fail("changed", source);

    let pathInfo: BigIntStats;
    try {
      pathInfo = await lstat(pinnedChildPath(parent, name), { bigint: true });
    } catch (error) {
      const kind = failureKind(errorCode(error));
      throw fail(kind === "missing" ? "changed" : kind, source);
    }
    if (!sameFile(before, pathInfo)) throw fail("changed", source);
    return { buffer, stat: before };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
