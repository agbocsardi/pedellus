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
 * `O_NOFOLLOW`, additional hard-link aliases (`nlink != 1`) are rejected, and
 * observable metadata changes during a read are failures. After all reads, each
 * selected file is reopened through its pinned directory and compared, then the
 * root and every reached directory are rechecked. `nlink == 1` is not proof of
 * inode origin (link-then-unlink can leave one link), and a change after the
 * final check remains a TOCTOU window. This is not a defence against a
 * privileged/kernel adversary or coarse filesystem metadata, but it does
 * prevent ordinary symlink/hard-link escapes and detectable file/directory
 * swaps.
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

/** Deterministic provenance prefix for workspace files. */
const WORKSPACE_SOURCE_PREFIX = "workspace:";

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
  // The renderer prepends "workspace:" when it renders this provenance label.
  maxPathChars: CONTEXT_LIMITS.sourceChars - WORKSPACE_SOURCE_PREFIX.length,
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
const TRUNCATION_MARKER = "\n[context truncated at configured bounds]";

interface SelectedFile {
  readonly segments: readonly string[];
  readonly name: string;
  readonly source: string;
  readonly stat: BigIntStats;
}

interface LoadState {
  bytes: number;
  chars: number;
  readonly files: SelectedFile[];
  readonly directories: Map<string, Readonly<{ segments: readonly string[]; stat: BigIntStats }>>;
}

interface MutableWorkspaceSnapshot {
  identity?: ContextDocumentSnapshot;
  agents?: ContextDocumentSnapshot;
  soul?: ContextDocumentSnapshot;
  user?: ContextDocumentSnapshot;
  memory?: readonly ContextDocumentSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    return !Array.isArray(value);
  } catch {
    // A revoked Proxy must become a typed input error at the caller, not an
    // untyped TypeError escaping from Array.isArray.
    return false;
  }
}

interface OwnDataField {
  readonly found: boolean;
  readonly value: unknown;
}

/**
 * Capture only own data properties. Inherited and accessor-backed fields are
 * rejected rather than invoked; this mirrors the context renderer's own-data
 * reading rule but fails closed instead of silently treating them as absent.
 */
function ownDataField(value: unknown, key: string, label: string): OwnDataField {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new WorkspaceContextInputError(`${label} must be an object`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new WorkspaceContextInputError(`${label}.${key} is unreadable`);
  }
  if (descriptor === undefined) {
    let inherited = false;
    try {
      inherited = key in value;
    } catch {
      inherited = true;
    }
    if (inherited) {
      throw new WorkspaceContextInputError(`${label}.${key} must be an own data property`);
    }
    return { found: false, value: undefined };
  }
  if (!Object.hasOwn(descriptor, "value")) {
    throw new WorkspaceContextInputError(`${label}.${key} must be an own data property`);
  }
  return { found: true, value: descriptor.value };
}

/** Read an array length exactly once from its own data descriptor. */
function ownArrayLength(value: unknown, label: string): number {
  let array = false;
  try {
    array = Array.isArray(value);
  } catch {
    throw new WorkspaceContextInputError(`${label} must be an array`);
  }
  if (!array) {
    throw new WorkspaceContextInputError(`${label} must be an array`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new WorkspaceContextInputError(`${label} length is unreadable`);
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0) {
    throw new WorkspaceContextInputError(`${label} length must be an own data property`);
  }
  return descriptor.value;
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
  const length = ownArrayLength(value, "memoryFiles");
  if (length > WORKSPACE_CONTEXT_LIMITS.maxMemoryFiles) {
    throw new WorkspaceContextBoundsError("maxMemoryFiles");
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let index = 0; index < length; index++) {
    const field = ownDataField(value, String(index), "memoryFiles entry");
    if (!field.found) {
      throw new WorkspaceContextInputError("memoryFiles entries must be own data properties");
    }
    const path = validatedMemoryPath(field.value);
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
  const sourceField = ownDataField(value, "source", "identity");
  const contentField = ownDataField(value, "content", "identity");
  const source = sourceField.found && sourceField.value !== undefined ? sourceField.value : "host:identity";
  const content = contentField.value;
  if (!contentField.found) {
    throw new WorkspaceContextInputError("identity.content must be an own data property");
  }
  if (typeof source !== "string" || source.length === 0 ||
      codePointCount(source) > WORKSPACE_CONTEXT_LIMITS.maxSourceChars ||
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

function codePointPrefix(value: string, limit: number): { prefix: string; truncated: boolean } {
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count >= limit) return { prefix: value.slice(0, end), truncated: true };
    end += character.length;
    count++;
  }
  return { prefix: value, truncated: false };
}

/** Mirror the renderer's bounded-text rule so budget checks measure exact output. */
function clipToBudget(value: string, limit: number): string {
  if (limit <= 0) return "";
  const { prefix, truncated } = codePointPrefix(value, limit);
  if (!truncated) return value;
  const markerCount = codePointCount(TRUNCATION_MARKER);
  if (limit <= markerCount) return prefix;
  return `${codePointPrefix(value, limit - markerCount).prefix}${TRUNCATION_MARKER}`;
}

/** Mirror the renderer's provenance escaping for exact section-size accounting. */
function safeInlineForBudget(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.codePointAt(0)!.toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

/**
 * Reproduce `renderDocuments()` from context/index.ts closely enough to detect
 * whether it would truncate. Returns the full section text only when nothing
 * was clipped.
 */
function renderedDocumentsForBudget(
  documents: readonly (readonly [string, ContextDocumentSnapshot])[],
  limit: number,
): { text: string; truncated: boolean } {
  if (documents.length === 0 || limit <= 0) return { text: "", truncated: false };
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;
  for (const [label, document] of documents) {
    const header = `## ${label}\nSource: ${safeInlineForBudget(document.source)}\n\n`;
    const headerTaken = clipToBudget(header, limit - used);
    if (headerTaken !== header) truncated = true;
    chunks.push(headerTaken);
    used += codePointCount(headerTaken);
    if (headerTaken !== header || used >= limit) break;

    const contentTaken = clipToBudget(document.content, limit - used);
    if (contentTaken !== document.content) truncated = true;
    chunks.push(contentTaken);
    used += codePointCount(contentTaken);
    if (contentTaken !== document.content || used >= limit) break;

    const separatorTaken = clipToBudget("\n\n", limit - used);
    if (separatorTaken !== "\n\n") truncated = true;
    chunks.push(separatorTaken);
    used += codePointCount(separatorTaken);
  }
  return { text: chunks.join(""), truncated };
}

/**
 * Fail closed when the existing renderer would clip any accepted document.
 * Per-section and shared-total budgets are checked with the renderer's exact
 * headings, provenance escaping, separators, and truncation rules.
 */
function enforceRenderingBudgets(snapshot: MutableWorkspaceSnapshot): void {
  let total = 0;

  if (snapshot.identity !== undefined) {
    const rendered = renderedDocumentsForBudget([["Identity", snapshot.identity]], CONTEXT_LIMITS.sectionChars);
    if (rendered.truncated) throw new WorkspaceContextBoundsError("identitySection");
    total += codePointCount(rendered.text);
  }

  const instructions: [string, ContextDocumentSnapshot][] = [];
  if (snapshot.agents !== undefined) instructions.push(["AGENTS.md", snapshot.agents]);
  if (snapshot.soul !== undefined) instructions.push(["SOUL.md", snapshot.soul]);
  if (snapshot.user !== undefined) instructions.push(["USER.md", snapshot.user]);
  if (instructions.length > 0) {
    const rendered = renderedDocumentsForBudget(instructions, CONTEXT_LIMITS.sectionChars);
    if (rendered.truncated) throw new WorkspaceContextBoundsError("instructionsSection");
    total += codePointCount(rendered.text);
  }

  if (snapshot.memory !== undefined && snapshot.memory.length > 0) {
    const memory = snapshot.memory.map((document, index) =>
      [`Memory ${index + 1}`, document] as [string, ContextDocumentSnapshot]);
    const rendered = renderedDocumentsForBudget(memory, CONTEXT_LIMITS.sectionChars);
    if (rendered.truncated) throw new WorkspaceContextBoundsError("memorySection");
    total += codePointCount(rendered.text);
  }

  if (total > CONTEXT_LIMITS.contextChars) {
    throw new WorkspaceContextBoundsError("contextTotal");
  }
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

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

/** Directory identity only: a rename or replacement changes dev/ino/mode. */
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
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
  directorySegments: readonly string[],
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

    state.files.push(Object.freeze({
      segments: Object.freeze([...directorySegments]),
      name,
      source,
      stat: before,
    }));

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
  return readPinnedFile(root, name, name, [], state);
}

function recordDirectory(
  state: LoadState,
  segments: readonly string[],
  stat: BigIntStats,
  source: string,
): void {
  const key = segments.join("/");
  const existing = state.directories.get(key);
  if (existing !== undefined) {
    if (!sameDirectory(existing.stat, stat)) {
      throw new WorkspaceContextFileError("changed", source);
    }
    return;
  }
  state.directories.set(key, Object.freeze({ segments: Object.freeze([...segments]), stat }));
}

async function readMemoryFile(root: FileHandle, path: string, state: LoadState): Promise<string> {
  const segments = path.split("/");
  const name = segments[segments.length - 1]!;
  const directories = segments.slice(0, -1);
  const opened: FileHandle[] = [];
  const openedSegments: string[] = [];
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
      openedSegments.push(segment);
      opened.push(next);
      recordDirectory(state, openedSegments, info, path);
      parent = next;
    }
    return await readPinnedFile(parent, name, path, directories, state);
  } finally {
    for (const handle of opened.reverse()) {
      await handle.close().catch(() => undefined);
    }
  }
}

async function openRelativeDirectory(
  root: FileHandle,
  segments: readonly string[],
  source: string,
): Promise<FileHandle> {
  let current: FileHandle | null = null;
  let parent = root;
  try {
    for (const segment of segments) {
      const next = await openPinned(parent, segment, DIRECTORY_FLAGS, source);
      if (current !== null) await current.close().catch(() => undefined);
      current = next;
      parent = next;
    }
    if (current === null) throw new WorkspaceContextFileError("not-directory", source);
    return current;
  } catch (error) {
    if (current !== null) await current.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Reopen each successfully read file through its pinned directory chain and
 * compare dev/inode/size/mode/nlink/mtime/ctime. This catches a file renamed or
 * replaced after its own read but before the snapshot is returned.
 */
async function verifySelectedFiles(root: FileHandle, state: LoadState): Promise<void> {
  for (const file of state.files) {
    let directory: FileHandle | null = null;
    let parent = root;
    try {
      if (file.segments.length > 0) {
        directory = await openRelativeDirectory(root, file.segments, file.source);
        parent = directory;
      }
      const now = await lstat(join(procFdPath(parent.fd), file.name), { bigint: true });
      if (!sameFile(file.stat, now)) {
        throw new WorkspaceContextFileError("changed", file.source);
      }
    } catch {
      throw new WorkspaceContextFileError("changed", file.source);
    } finally {
      if (directory !== null) await directory.close().catch(() => undefined);
    }
  }
}

/**
 * Recheck the pinned root and every directory reached during the load. A
 * rename/replacement after the initial pins is a failure: the returned
 * provenance would otherwise describe a path that no longer names the content.
 */
async function verifyWorkspace(
  root: FileHandle,
  rootPath: string,
  rootBefore: BigIntStats,
  state: LoadState,
): Promise<void> {
  let rootNow: BigIntStats | null = null;
  let pathNow: BigIntStats | null = null;
  try {
    rootNow = await root.stat({ bigint: true });
  } catch {
    rootNow = null;
  }
  try {
    pathNow = await lstat(rootPath, { bigint: true });
  } catch {
    pathNow = null;
  }
  if (rootNow === null || pathNow === null ||
      !sameIdentity(rootNow, rootBefore) || !sameIdentity(pathNow, rootBefore)) {
    throw new WorkspaceContextFileError("changed", "workspace-root");
  }

  for (const entry of state.directories.values()) {
    const source = entry.segments.join("/");
    let handle: FileHandle | null = null;
    try {
      handle = await openRelativeDirectory(root, entry.segments, source);
      const now = await handle.stat({ bigint: true });
      if (!sameDirectory(now, entry.stat)) {
        throw new WorkspaceContextFileError("changed", source);
      }
    } catch {
      throw new WorkspaceContextFileError("changed", source);
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
    }
  }
}

/**
 * Validate an explicit memory selection without opening any file. Hosts can use
 * this while parsing their own configuration; the loader applies the same
 * rules again before reading.
 */
export function validateWorkspaceMemoryFiles(value: unknown): readonly string[] {
  return validatedMemoryFiles(value);
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
  const rootPath = validatedRoot(ownDataField(request, "workspaceRoot", "Workspace context request").value);
  const memoryField = ownDataField(request, "memoryFiles", "Workspace context request");
  const memoryFiles = validatedMemoryFiles(memoryField.found ? memoryField.value : undefined);
  const identityField = ownDataField(request, "identity", "Workspace context request");
  const identity = validatedIdentity(identityField.found ? identityField.value : undefined);
  if (WORKSPACE_CONTEXT_LIMITS.maxBootstrapFiles + memoryFiles.length > WORKSPACE_CONTEXT_LIMITS.maxFiles) {
    throw new WorkspaceContextBoundsError("maxFiles");
  }

  const root = await openAbsoluteDirectoryNoFollow(rootPath);
  let rootBefore: BigIntStats;
  try {
    rootBefore = await statHandle(root, "workspace-root");
    if (!rootBefore.isDirectory()) {
      throw new WorkspaceContextInputError("workspaceRoot must be a directory");
    }
  } catch (error) {
    await root.close().catch(() => undefined);
    throw error;
  }
  const snapshot: MutableWorkspaceSnapshot = {};
  const state: LoadState = {
    bytes: 0,
    chars: identity === undefined ? 0 : codePointCount(identity.content),
    files: [],
    directories: new Map(),
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
      snapshot[field] = frozenDocument(`${WORKSPACE_SOURCE_PREFIX}${name}`, content);
    }

    const memories: ContextDocumentSnapshot[] = [];
    for (const path of memoryFiles) {
      const content = await readMemoryFile(root, path, state);
      if (content.length === 0) continue;
      memories.push(frozenDocument(`${WORKSPACE_SOURCE_PREFIX}${path}`, content));
    }
    if (memories.length > 0) snapshot.memory = Object.freeze(memories);

    enforceRenderingBudgets(snapshot);
    await verifySelectedFiles(root, state);
    await verifyWorkspace(root, rootPath, rootBefore, state);
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
