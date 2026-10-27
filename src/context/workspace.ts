/**
 * Opt-in workspace snapshot loading for the context extension.
 *
 * The caller names one explicit workspace root and an explicit list of
 * `memory/**\/*.md` files. This module reads only `AGENTS.md`, `SOUL.md`,
 * `USER.md`, and those selected memory files. It never discovers files, reads
 * `~/.nanobot` or environment variables, delegates to tools, or calls a model
 * provider. It does not install itself in the runtime; the host wires the
 * returned provider into `openGateway` or returns the snapshots directly.
 *
 * Path safety is Linux-only and fails closed elsewhere: directories are pinned
 * through `/proc/self/fd` with `O_DIRECTORY | O_NOFOLLOW`, files are opened with
 * `O_NOFOLLOW`, hard-link aliases (`nlink != 1`) are rejected, and observable
 * metadata changes during a read are failures. This is not a defence against a
 * privileged/kernel adversary, but it does prevent ordinary symlink and
 * hard-link escapes from the workspace.
 */
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { existsSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CONTEXT_LIMITS,
  type ContextDocumentSnapshot,
  type ConversationContextSnapshot,
} from "./index.js";
import type { GatewayContextSnapshotProvider } from "../runtime.js";

/** Bounded loader limits. They are enforced before content reaches the renderer. */
export const WORKSPACE_CONTEXT_LIMITS = Object.freeze({
  maxBootstrapFiles: 3,
  maxMemoryFiles: CONTEXT_LIMITS.maxMemorySources,
  maxFiles: 3 + CONTEXT_LIMITS.maxMemorySources,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 128 * 1024,
  maxTotalChars: CONTEXT_LIMITS.contextChars,
  maxIdentityChars: CONTEXT_LIMITS.sectionChars - 1_600,
  maxSourceChars: CONTEXT_LIMITS.sourceChars,
  maxPathChars: 256,
  maxPathSegmentChars: 64,
  maxPathSegments: 8,
  maxWorkspaceRootChars: 4_096,
});

/** The only bootstrap files read. Their order is fixed and their labels are deterministic. */
export const WORKSPACE_BOOTSTRAP_FILES = Object.freeze(["AGENTS.md", "SOUL.md", "USER.md"] as const);

export type WorkspaceContextSnapshot = Omit<ConversationContextSnapshot, "conversationId">;

export interface WorkspaceContextRequest {
  /** Explicit absolute workspace root. There is no default and no ambient home fallback. */
  readonly workspaceRoot: string;
  /**
   * Explicit workspace-relative `memory/**\/*.md` files, in output order.
   * Omitted means no memory; `memory/MEMORY.md` is not discovered implicitly.
   */
  readonly memoryFiles?: readonly string[];
  /**
   * Already-rendered identity supplied by the host. Runtime/platform/channel
   * values are never discovered here; the host must pass what it wants to show.
   */
  readonly identity?: ContextDocumentSnapshot;
}

export type WorkspaceContextSelectionResolver = (
  ...args: Parameters<GatewayContextSnapshotProvider>
) => WorkspaceContextRequest | undefined | Promise<WorkspaceContextRequest | undefined>;

export type WorkspaceFileFailureKind =
  | "missing"
  | "symlink"
  | "hardlink"
  | "not-regular"
  | "not-directory"
  | "unreadable"
  | "changed"
  | "encoding"
  | "io";

export class WorkspaceContextInputError extends TypeError {
  readonly code = "workspace_context_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceContextInputError";
  }
}

export class WorkspaceContextBoundsError extends RangeError {
  readonly code = "workspace_context_bound_exceeded";
  readonly bound: string;

  constructor(bound: string) {
    super(`Workspace context exceeds the ${bound} bound`);
    this.name = "WorkspaceContextBoundsError";
    this.bound = bound;
  }
}

export class WorkspaceContextPlatformError extends Error {
  readonly code = "workspace_context_platform_unsupported";

  constructor() {
    super("Workspace context loading requires Linux /proc/self/fd and O_NOFOLLOW support");
    this.name = "WorkspaceContextPlatformError";
  }
}

export class WorkspaceContextFileError extends Error {
  readonly code = "workspace_context_file_error";
  readonly kind: WorkspaceFileFailureKind;
  /** Stable workspace-relative label only; never an absolute path or file content. */
  readonly source: string;

  constructor(kind: WorkspaceFileFailureKind, source: string) {
    super(`Workspace context file ${source}: ${kind}`);
    this.name = "WorkspaceContextFileError";
    this.kind = kind;
    this.source = source;
  }
}

const BOOTSTRAP_FIELDS = Object.freeze([
  ["agents", "AGENTS.md"],
  ["soul", "SOUL.md"],
  ["user", "USER.md"],
] as const);
const SAFE_MEMORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PROC_FD = "/proc/self/fd";
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const RESTRICTED_ROOTS = Object.freeze(["/proc", "/sys", "/dev"]);

interface LoadState {
  bytes: number;
  chars: number;
}

interface MutableWorkspaceSnapshot {
  identity?: ContextDocumentSnapshot;
  agents?: ContextDocumentSnapshot;
  soul?: ContextDocumentSnapshot;
  user?: ContextDocumentSnapshot;
  memory?: readonly ContextDocumentSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertSupportedPlatform(): void {
  if (process.platform !== "linux" ||
      typeof constants.O_NOFOLLOW !== "number" ||
      typeof constants.O_DIRECTORY !== "number" ||
      !existsSync(PROC_FD)) {
    throw new WorkspaceContextPlatformError();
  }
}

function validatedRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > WORKSPACE_CONTEXT_LIMITS.maxWorkspaceRootChars ||
      !isAbsolute(value) || CONTROL_CHARACTERS.test(value)) {
    throw new WorkspaceContextInputError("workspaceRoot must be an explicit absolute path");
  }
  const root = resolve(value);
  if (root === sep) {
    throw new WorkspaceContextInputError("workspaceRoot must not be the filesystem root");
  }
  if (root.split(sep).some((component) => component.toLowerCase() === ".nanobot")) {
    throw new WorkspaceContextInputError("workspaceRoot must not overlap the default ~/.nanobot location");
  }
  for (const restricted of RESTRICTED_ROOTS) {
    if (isWithin(restricted, root)) {
      throw new WorkspaceContextInputError("workspaceRoot must not be inside a restricted system directory");
    }
  }
  return root;
}

function validatedMemoryFiles(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new WorkspaceContextInputError("memoryFiles must be an array of workspace-relative paths");
  }
  if (value.length > WORKSPACE_CONTEXT_LIMITS.maxMemoryFiles) {
    throw new WorkspaceContextBoundsError("maxMemoryFiles");
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const path = validatedMemoryPath(value[index]);
    if (seen.has(path)) {
      throw new WorkspaceContextInputError("memoryFiles must not contain duplicate paths");
    }
    seen.add(path);
    paths.push(path);
  }
  return Object.freeze(paths);
}

function validatedMemoryPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > WORKSPACE_CONTEXT_LIMITS.maxPathChars ||
      CONTROL_CHARACTERS.test(value) || value.includes("\\") ||
      value.startsWith("/") || !value.endsWith(".md")) {
    throw new WorkspaceContextInputError("memoryFiles entries must be explicit workspace-relative memory/**/*.md paths");
  }
  const segments = value.split("/");
  if (segments.length < 2 || segments.length > WORKSPACE_CONTEXT_LIMITS.maxPathSegments ||
      segments[0] !== "memory") {
    throw new WorkspaceContextInputError("memoryFiles entries must be explicit workspace-relative memory/**/*.md paths");
  }
  for (const segment of segments) {
    if (segment.length > WORKSPACE_CONTEXT_LIMITS.maxPathSegmentChars ||
        !SAFE_MEMORY_SEGMENT.test(segment)) {
      throw new WorkspaceContextInputError("memoryFiles entries must be explicit workspace-relative memory/**/*.md paths");
    }
  }
  return value;
}

function validatedIdentity(value: unknown): ContextDocumentSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new WorkspaceContextInputError("identity must be a host-supplied document");
  }
  const source = value.source === undefined ? "host:identity" : value.source;
  const content = value.content;
  if (typeof source !== "string" || source.length === 0 ||
      source.length > WORKSPACE_CONTEXT_LIMITS.maxSourceChars ||
      CONTROL_CHARACTERS.test(source)) {
    throw new WorkspaceContextInputError("identity.source must be a bounded single-line provenance label");
  }
  if (typeof content !== "string" || content.length === 0) {
    throw new WorkspaceContextInputError("identity.content must be a non-empty string");
  }
  if (codePointCount(content) > WORKSPACE_CONTEXT_LIMITS.maxIdentityChars) {
    throw new WorkspaceContextBoundsError("maxIdentityChars");
  }
  return frozenDocument(source, content);
}

function frozenDocument(source: string, content: string): ContextDocumentSnapshot {
  return Object.freeze({ source, content });
}

function codePointCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

function failureKind(code: string | undefined): WorkspaceFileFailureKind {
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
      return "not-regular";
    default:
      return "io";
  }
}

function fileFailure(error: unknown, source: string): WorkspaceContextFileError {
  if (error instanceof WorkspaceContextFileError) return error;
  return new WorkspaceContextFileError(failureKind((error as NodeJS.ErrnoException | null)?.code), source);
}

function rootFailure(error: unknown): WorkspaceContextInputError {
  if (error instanceof WorkspaceContextInputError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return new WorkspaceContextInputError("workspaceRoot must exist");
  if (code === "ELOOP") return new WorkspaceContextInputError("workspaceRoot must not contain symlink components");
  if (code === "EACCES" || code === "EPERM") return new WorkspaceContextInputError("workspaceRoot is not readable");
  if (code === "ENOTDIR") return new WorkspaceContextInputError("workspaceRoot must be a directory");
  return new WorkspaceContextInputError("workspaceRoot cannot be opened safely");
}

function procFdPath(fd: number): string {
  return `${PROC_FD}/${fd}`;
}

async function openAbsoluteDirectoryNoFollow(path: string): Promise<FileHandle> {
  const components = path.slice(1).split(sep).filter(Boolean);
  if (components.length === 0) {
    throw new WorkspaceContextInputError("workspaceRoot must be a directory below the filesystem root");
  }
  let current: FileHandle;
  try {
    current = await open(sep, DIRECTORY_FLAGS);
  } catch (error) {
    throw rootFailure(error);
  }
  try {
    for (const component of components) {
      let next: FileHandle;
      try {
        next = await open(join(procFdPath(current.fd), component), DIRECTORY_FLAGS);
      } catch (error) {
        throw rootFailure(error);
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function statHandle(handle: FileHandle, source: string): Promise<BigIntStats> {
  try {
    return await handle.stat({ bigint: true });
  } catch (error) {
    throw fileFailure(error, source);
  }
}

async function openPinned(
  parent: FileHandle,
  name: string,
  flags: number,
  source: string,
): Promise<FileHandle> {
  const path = join(procFdPath(parent.fd), name);
  try {
    return await open(path, flags);
  } catch (error) {
    const kind = failureKind((error as NodeJS.ErrnoException | null)?.code);
    // O_NOFOLLOW + O_DIRECTORY can report ENOTDIR on some kernels when the
    // final component is a symlink. Classify it without following the link.
    if (kind === "not-directory") {
      try {
        const info = await lstat(path, { bigint: true });
        if (info.isSymbolicLink()) throw new WorkspaceContextFileError("symlink", source);
      } catch (classificationError) {
        if (classificationError instanceof WorkspaceContextFileError) throw classificationError;
      }
    }
    throw new WorkspaceContextFileError(kind, source);
  }
}

function decodeUtf8(buffer: Buffer, source: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new WorkspaceContextFileError("encoding", source);
  }
}

/**
 * Read one regular file through an already pinned parent directory. The
 * returned string is a fresh value; empty files are returned as "" and the
 * caller decides whether that is meaningful.
 */
async function readPinnedFile(
  parent: FileHandle,
  name: string,
  source: string,
  state: LoadState,
): Promise<string> {
  const handle = await openPinned(parent, name, FILE_FLAGS, source);
  try {
    const before = await statHandle(handle, source);
    if (!before.isFile()) throw new WorkspaceContextFileError("not-regular", source);
    if (before.nlink !== 1n) throw new WorkspaceContextFileError("hardlink", source);
    if (before.size > BigInt(WORKSPACE_CONTEXT_LIMITS.maxFileBytes)) {
      throw new WorkspaceContextBoundsError("maxFileBytes");
    }
    const size = Number(before.size);
    if (state.bytes + size > WORKSPACE_CONTEXT_LIMITS.maxTotalBytes) {
      throw new WorkspaceContextBoundsError("maxTotalBytes");
    }

    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, offset, size - offset, offset));
      } catch (error) {
        throw fileFailure(error, source);
      }
      if (bytesRead === 0) throw new WorkspaceContextFileError("changed", source);
      offset += bytesRead;
    }

    const after = await statHandle(handle, source);
    if (!sameFile(before, after)) throw new WorkspaceContextFileError("changed", source);

    let pathInfo: BigIntStats;
    try {
      pathInfo = await lstat(join(procFdPath(parent.fd), name), { bigint: true });
    } catch (error) {
      const kind = failureKind((error as NodeJS.ErrnoException | null)?.code);
      throw new WorkspaceContextFileError(kind === "missing" ? "changed" : kind, source);
    }
    if (!sameFile(before, pathInfo)) throw new WorkspaceContextFileError("changed", source);

    const content = decodeUtf8(buffer, source);
    state.bytes += size;
    state.chars += codePointCount(content);
    if (state.chars > WORKSPACE_CONTEXT_LIMITS.maxTotalChars) {
      throw new WorkspaceContextBoundsError("maxTotalChars");
    }
    return content;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readRootFile(root: FileHandle, name: string, state: LoadState): Promise<string> {
  return readPinnedFile(root, name, name, state);
}

async function readMemoryFile(root: FileHandle, path: string, state: LoadState): Promise<string> {
  const segments = path.split("/");
  const name = segments[segments.length - 1]!;
  const directories = segments.slice(0, -1);
  const opened: FileHandle[] = [];
  let parent = root;
  try {
    for (const segment of directories) {
      const next = await openPinned(parent, segment, DIRECTORY_FLAGS, path);
      let info: BigIntStats;
      try {
        info = await next.stat({ bigint: true });
      } catch (error) {
        await next.close().catch(() => undefined);
        throw fileFailure(error, path);
      }
      if (!info.isDirectory()) {
        await next.close().catch(() => undefined);
        throw new WorkspaceContextFileError("not-directory", path);
      }
      opened.push(next);
      parent = next;
    }
    return await readPinnedFile(parent, name, path, state);
  } finally {
    for (const handle of opened.reverse()) {
      await handle.close().catch(() => undefined);
    }
  }
}

/**
 * Load one immutable snapshot value set from an explicit workspace root.
 *
 * Missing `AGENTS.md`/`SOUL.md`/`USER.md` are omitted (Python's bootstrap
 * behaviour), while a missing explicitly selected memory file is an error.
 * Empty files are omitted. Any other file, encoding, size, or safety failure
 * rejects the whole load; no partial snapshot is returned.
 */
export async function loadWorkspaceContextSnapshot(
  request: WorkspaceContextRequest,
): Promise<WorkspaceContextSnapshot> {
  assertSupportedPlatform();
  if (!isRecord(request)) {
    throw new WorkspaceContextInputError("Workspace context request must be an object");
  }
  const rootPath = validatedRoot(request.workspaceRoot);
  const memoryFiles = validatedMemoryFiles(request.memoryFiles);
  const identity = validatedIdentity(request.identity);
  if (WORKSPACE_CONTEXT_LIMITS.maxBootstrapFiles + memoryFiles.length > WORKSPACE_CONTEXT_LIMITS.maxFiles) {
    throw new WorkspaceContextBoundsError("maxFiles");
  }

  const root = await openAbsoluteDirectoryNoFollow(rootPath);
  const snapshot: MutableWorkspaceSnapshot = {};
  const state: LoadState = {
    bytes: 0,
    chars: identity === undefined ? 0 : codePointCount(identity.content),
  };
  try {
    if (identity !== undefined) snapshot.identity = identity;

    for (const [field, name] of BOOTSTRAP_FIELDS) {
      let content: string;
      try {
        content = await readRootFile(root, name, state);
      } catch (error) {
        if (error instanceof WorkspaceContextFileError && error.kind === "missing") continue;
        throw error;
      }
      if (content.length === 0) continue;
      snapshot[field] = frozenDocument(`workspace:${name}`, content);
    }

    const memories: ContextDocumentSnapshot[] = [];
    for (const path of memoryFiles) {
      const content = await readMemoryFile(root, path, state);
      if (content.length === 0) continue;
      memories.push(frozenDocument(`workspace:${path}`, content));
    }
    if (memories.length > 0) snapshot.memory = Object.freeze(memories);
  } finally {
    await root.close().catch(() => undefined);
  }

  return Object.freeze(snapshot);
}

/**
 * Adapt explicit per-session selections to the gateway's snapshot provider.
 * The resolver is called for every request; nothing is cached. Hosts must base
 * session-scoped values (for example identity) only on the supplied explicit
 * arguments, not on ambient state. Returning `undefined` means no snapshot.
 */
export function createWorkspaceContextSnapshotProvider(
  resolveSelection: WorkspaceContextSelectionResolver,
): GatewayContextSnapshotProvider {
  if (typeof resolveSelection !== "function") {
    throw new WorkspaceContextInputError("resolveSelection must be a function");
  }
  return async (sessionKey, conversationId, context) => {
    const selection = await resolveSelection(sessionKey, conversationId, context);
    if (selection === undefined) return undefined;
    return loadWorkspaceContextSnapshot(selection);
  };
}
