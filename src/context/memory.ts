/**
 * Explicit-root topic-memory discovery and a context manifest.
 *
 * Markdown files in the workspace `memory/` directory are authoritative; this
 * module stores no runtime state and creates no second store. The caller names
 * one explicit workspace root and, optionally, the memory files it already
 * injected into context. Discovery reads file metadata only: file bodies are
 * parsed for a description and body length, never returned. Topic bodies are
 * read on demand by the native `read` tool using the returned relative path,
 * and written by the native `write`/`edit` tools, so a completed write is a
 * plain Markdown change that survives restart and is seen by the next
 * discovery pass. This module never creates, writes, renames, or deletes a
 * file.
 *
 * The result includes a Python-style `# Memory Tree` manifest and one frozen
 * document ready for `ConversationContextSnapshot.memory`. The manifest names
 * each entry as `memory/...` with its state (`loaded` or `topic`), body length,
 * and description, and carries deterministic provenance labels that never
 * contain the absolute root.
 *
 * Reads are pinned like the workspace loader (see `fs-safe.ts`): beneath the
 * explicitly named root, every directory is opened through `/proc/self/fd`
 * with `O_DIRECTORY | O_NOFOLLOW`, files with `O_NOFOLLOW`, hard-link aliases are
 * refused, and a file that changes during its read or whose name no longer
 * names the read inode is a failure. Symlinked topic entries are skipped rather
 * than followed; an explicitly named loaded file that is a symlink is rejected.
 * The root path itself may contain symlinks because the host named it. There is
 * no content-size budget and no whole-tree recheck after all reads, so a swap
 * after a file's own check is not detected. Linux-only, like the rest of the
 * workspace loaders.
 */
import type { FileHandle } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { CONTEXT_LIMITS, type ContextDocumentSnapshot } from "./index.js";
import {
  CONTROL_CHARACTERS,
  DIRECTORY_FLAGS,
  FsSafeError,
  type FileErrorFactory,
  MEMORY_DIR,
  MEMORY_SYSTEM_DIR as SYSTEM_DIR,
  PROTECTED_MEMORY_NAMES as PROTECTED_NAMES,
  clipCodePoints as codePointPrefix,
  codePointCount,
  decodeUtf8,
  errorCode,
  frontmatterField,
  isRecord,
  openPinned,
  openRootDirectory,
  ownDataField as ownDataFieldWith,
  pinnedFsSupported,
  procFdPath,
  readPinnedFile,
  safeMemorySegment,
  unquoteFrontmatter,
  validatedRoot as validatedRootWith,
} from "./fs-safe.js";

/** Deterministic provenance prefixes. */
const WORKSPACE_SOURCE_PREFIX = "workspace:";
const MANIFEST_SOURCE = "memory:manifest";

/**
 * Discovery limits. There is no entry cap: every discovered topic and every
 * explicitly loaded file is listed. The description cap matches the Python
 * memory tree, and the directory scan bound stops an unbounded walk with a
 * visible note. There is deliberately no manifest character budget and no
 * per-file or shared byte budget: the manifest lists every reached entry and a
 * topic file is read in full for its description and body length, as Python does.
 */
export const MEMORY_CONTEXT_LIMITS = Object.freeze({
  /** Description code points, matching Python's memory-tree description cap. */
  maxDescriptionChars: 240,
  maxSourceChars: CONTEXT_LIMITS.sourceChars,
  /** `workspace:` plus the path must fit the renderer's provenance bound. */
  maxPathChars: CONTEXT_LIMITS.sourceChars - WORKSPACE_SOURCE_PREFIX.length,
  maxPathSegmentChars: 64,
  maxPathSegments: 8,
  /** Directory entries inspected in one call; a tree beyond this reports a visible stop. */
  maxScannedEntries: 4_096,
  maxRootChars: 4_096,
});

/** `loaded` means the host already put the file in context; `topic` means read on demand. */
export type MemoryEntryState = "loaded" | "topic";

export interface MemoryTopicEntry {
  /** Workspace-relative `memory/...` path for the native `read`/`write` tools. */
  readonly path: string;
  /** Stable provenance label; never an absolute host path. */
  readonly source: string;
  readonly state: MemoryEntryState;
  readonly description: string;
  /** Body length after frontmatter, in Unicode code points (Python `len`). */
  readonly bodyChars: number;
}

export interface MemoryContextRequest {
  /** Explicit absolute workspace root. There is no default and no ambient home fallback. */
  readonly workspaceRoot: string;
  /**
   * Explicit workspace-relative memory files the host already injected into
   * context, for example `memory/MEMORY.md` and `memory/system/now.md`. They
   * are read for their manifest entry and marked `loaded`. Omitted means none.
   */
  readonly loadedFiles?: readonly string[];
}

export interface MemoryContextResult {
  readonly entries: readonly MemoryTopicEntry[];
  /** Python-style `# Memory Tree` text; empty when no entry exists. */
  readonly manifest: string;
  /** Ready to append to `ConversationContextSnapshot.memory`; absent when no entry exists. */
  readonly document?: ContextDocumentSnapshot;
}

export type MemoryFileFailureKind =
  | "missing"
  | "symlink"
  | "hardlink"
  | "not-regular"
  | "not-directory"
  | "unreadable"
  | "changed"
  | "encoding"
  | "io";

export class MemoryContextInputError extends TypeError {
  readonly code = "memory_context_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "MemoryContextInputError";
  }
}

export class MemoryContextFileError extends Error {
  readonly code = "memory_context_file_error";
  readonly kind: MemoryFileFailureKind;
  /** Stable workspace-relative label only; never an absolute path or file content. */
  readonly source: string;

  constructor(kind: MemoryFileFailureKind, source: string) {
    super(`Memory context file ${source}: ${kind}`);
    this.name = "MemoryContextFileError";
    this.kind = kind;
    this.source = source;
  }
}

interface ScanState {
  scanned: number;
  truncated: boolean;
  /** Entries refused by the locator-shape bounds; always reported in the manifest. */
  refused: number;
}

interface FrontmatterSplit {
  readonly meta: ReadonlyMap<string, string>;
  readonly body: string;
}

const inputError = (message: string): Error => new MemoryContextInputError(message);
const fileError: FileErrorFactory = (kind, source) => new MemoryContextFileError(kind, source);

function ownDataField(value: unknown, key: string, label: string): { found: boolean; value: unknown } {
  return ownDataFieldWith(value, key, label, inputError);
}

function validatedRoot(value: unknown): string {
  return validatedRootWith(value, "workspaceRoot", {
    maxChars: MEMORY_CONTEXT_LIMITS.maxRootChars,
    refuseNanobot: true,
  }, inputError);
}

/**
 * Validate one workspace-relative `memory/**\/*.md` path without touching the
 * filesystem. A topic path may not name an always-loaded or protected surface;
 * a loaded path is host-selected injection, so it may name those files too.
 */
function validatedMemoryPath(value: unknown, loaded: boolean): string {
  const kind = loaded ? "loadedFiles" : "topic";
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MEMORY_CONTEXT_LIMITS.maxPathChars ||
      CONTROL_CHARACTERS.test(value) || value.includes("\\") ||
      value.startsWith("/") || !value.endsWith(".md")) {
    throw new MemoryContextInputError(`${kind} must be a workspace-relative memory/**/*.md path`);
  }
  const segments = value.split("/");
  if (segments.length < 2 || segments.length > MEMORY_CONTEXT_LIMITS.maxPathSegments ||
      segments[0] !== MEMORY_DIR) {
    throw new MemoryContextInputError(`${kind} must be a workspace-relative memory/**/*.md path`);
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MEMORY_CONTEXT_LIMITS.maxPathSegmentChars ||
        !safeMemorySegment(segment)) {
      throw new MemoryContextInputError(`${kind} must be a workspace-relative memory/**/*.md path`);
    }
  }
  const name = segments[segments.length - 1]!;
  if (!loaded && PROTECTED_NAMES.has(name)) {
    throw new MemoryContextInputError(`${name} is not a writable topic memory file`);
  }
  if (!loaded && segments.includes(SYSTEM_DIR)) {
    throw new MemoryContextInputError("memory/system/ is always loaded and not a topic memory location");
  }
  return value;
}

/**
 * Validate an explicit topic path for a host preparing a native `write`/
 * `edit`. This refuses `MEMORY.md`, `HISTORY.md`, `memory/system/`, control
 * characters, dot segments, over-long segments and paths outside `memory/`; it
 * does not touch the filesystem and does not confirm expected prior content.
 */
export function validateMemoryTopicPath(value: unknown): string {
  return validatedMemoryPath(value, false);
}

/**
 * Validate an explicit list of memory files the host already injected into
 * context. Hosts can use this while parsing configuration; the loader applies
 * the same rules again before reading. These are injected files, not topics,
 * so protected names such as `HISTORY.md` and `memory/system/MEMORY.md` are
 * allowed; topic-write restrictions live in `validateMemoryTopicPath()`.
 */
export function validateMemoryLoadedFiles(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new MemoryContextInputError("loadedFiles must be an array");
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of value) {
    const path = validatedMemoryPath(entry, true);
    if (seen.has(path)) throw new MemoryContextInputError("loadedFiles must not contain duplicate paths");
    seen.add(path);
    paths.push(path);
  }
  return Object.freeze(paths);
}

/** Open the host-named root; symlinks in its own path are followed, nothing beneath it is. */
async function openWorkspaceDirectory(rootPath: string): Promise<FileHandle> {
  if (!pinnedFsSupported()) {
    throw new MemoryContextInputError("Memory context loading requires Linux /proc/self/fd and O_NOFOLLOW support");
  }
  return openRootDirectory(rootPath, (error) => {
    const code = errorCode(error);
    if (code === "ENOENT") return new MemoryContextInputError("workspaceRoot must exist");
    if (code === "EACCES" || code === "EPERM") return new MemoryContextInputError("workspaceRoot is not readable");
    if (code === "ENOTDIR") return new MemoryContextInputError("workspaceRoot must be a directory");
    return new MemoryContextInputError("workspaceRoot cannot be read");
  });
}

/** A missing `memory/` means no topics; it is never created. */
async function openMemoryDirectory(root: FileHandle): Promise<FileHandle | undefined> {
  try {
    return await openPinned(root, MEMORY_DIR, DIRECTORY_FLAGS, MEMORY_DIR, (kind, source) => new FsSafeError(kind, source));
  } catch (error) {
    const kind = (error as FsSafeError).kind;
    if (kind === "missing") return undefined;
    if (kind === "symlink") throw new MemoryContextInputError("workspace memory directory must not be a symlink");
    if (kind === "not-directory") throw new MemoryContextInputError("workspace memory must be a directory");
    throw new MemoryContextInputError("workspace memory directory cannot be read");
  }
}

function directorySource(segments: readonly string[]): string {
  return [MEMORY_DIR, ...segments].join("/");
}

async function scanTopics(
  directory: FileHandle,
  segments: readonly string[],
  state: ScanState,
  found: string[],
): Promise<void> {
  if (state.truncated) return;
  let entries;
  try {
    entries = await readdir(procFdPath(directory.fd), { withFileTypes: true });
  } catch {
    throw new MemoryContextFileError("unreadable", directorySource(segments));
  }

  for (const entry of entries) {
    if (state.scanned >= MEMORY_CONTEXT_LIMITS.maxScannedEntries) {
      // A very large tree stops discovery instead of failing the load; the
      // manifest reports that further entries were not inspected.
      state.truncated = true;
      return;
    }
    state.scanned++;
    const name = entry.name;
    // Dirent methods do not follow symlinks; a symlinked entry is skipped
    // rather than read through a link outside the workspace.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (name === SYSTEM_DIR) continue;
      if (!locatorBoundName(name)) {
        state.refused++;
        continue;
      }
      const nextSegments = [...segments, name];
      // `memory` + directories + `.md` file must fit the path segment bound.
      if (nextSegments.length > MEMORY_CONTEXT_LIMITS.maxPathSegments - 2) {
        state.refused++;
        continue;
      }
      let child: FileHandle;
      try {
        child = await openPinned(directory, name, DIRECTORY_FLAGS, directorySource(nextSegments),
          (kind, source) => new FsSafeError(kind, source));
      } catch (error) {
        // A subdirectory that disappears (or is swapped for a link) mid-scan
        // contributes nothing; the caller keeps what it already discovered.
        const kind = (error as FsSafeError).kind;
        if (kind === "missing" || kind === "symlink") continue;
        throw new MemoryContextFileError("unreadable", directorySource(nextSegments));
      }
      try {
        await scanTopics(child, nextSegments, state, found);
      } finally {
        await child.close().catch(() => undefined);
      }
      continue;
    }
    if (!entry.isFile() || !name.endsWith(".md") || PROTECTED_NAMES.has(name)) continue;
    // A refused name or path length is a locator-shape limit, never a content
    // limit: it is counted in a visible manifest line so nothing disappears
    // from the tree without a trace.
    if (!locatorBoundName(name)) {
      state.refused++;
      continue;
    }
    const path = directorySource([...segments, name]);
    // The provenance label must fit the renderer's source bound; an
    // over-long workspace path is not a usable topic locator.
    if (path.length > MEMORY_CONTEXT_LIMITS.maxPathChars) {
      state.refused++;
      continue;
    }
    found.push(path);
  }
}

/** A manifest entry needs a one-line, bounded name; anything else is counted as refused. */
function locatorBoundName(name: string): boolean {
  return name.length <= MEMORY_CONTEXT_LIMITS.maxPathSegmentChars && safeMemorySegment(name);
}

function clipDescription(value: string): string {
  // A manifest entry stays one line and carries no control characters.
  const singleLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (codePointCount(singleLine) <= MEMORY_CONTEXT_LIMITS.maxDescriptionChars) return singleLine;
  return `${codePointPrefix(singleLine, MEMORY_CONTEXT_LIMITS.maxDescriptionChars - 1)}\u2026`;
}

/** Python-compatible flat frontmatter split; YAML block syntax is not supported. */
function splitFrontmatter(content: string): FrontmatterSplit {
  const meta = new Map<string, string>();
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { meta, body: content };
  }
  const openLength = content.startsWith("---\r\n") ? 5 : 4;
  const end = content.indexOf("\n---", openLength);
  if (end === -1) return { meta, body: content };
  let closeEnd = end + 4;
  if (content[closeEnd] === "\r") closeEnd++;
  if (content[closeEnd] === "\n") closeEnd++;
  for (const line of content.slice(openLength, end).split(/\r?\n/)) {
    const field = frontmatterField(line);
    if (field === undefined) continue;
    meta.set(field.key.toLowerCase(), unquoteFrontmatter(field.value));
  }
  return { meta, body: content.slice(closeEnd) };
}

function parseEntry(content: string): { description: string; bodyChars: number } {
  const split = splitFrontmatter(content);
  const bodyChars = codePointCount(split.body.trim());
  const described = split.meta.get("description")?.trim() ?? "";
  if (described) return { description: clipDescription(described), bodyChars };
  for (const line of split.body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      return { description: clipDescription(stripped.replace(/^#+/, "").trim()), bodyChars };
    }
  }
  return { description: "(missing description)", bodyChars };
}

/**
 * Read one file only to derive its manifest entry. The body is discarded;
 * callers read topic content on demand with the native `read` tool. Every
 * ancestor below the root is opened without following a symlink, so a
 * symlinked `memory/` or `memory/system/` is refused instead of read through.
 */
async function readManifestEntry(
  root: FileHandle,
  path: string,
): Promise<{ description: string; bodyChars: number }> {
  const segments = path.split("/");
  const name = segments.pop()!;
  const opened: FileHandle[] = [];
  let parent = root;
  try {
    for (const segment of segments) {
      parent = await openPinned(parent, segment, DIRECTORY_FLAGS, path, fileError);
      opened.push(parent);
    }
    const { buffer } = await readPinnedFile(parent, name, path, fileError);
    return parseEntry(decodeUtf8(buffer, () => new MemoryContextFileError("encoding", path)));
  } finally {
    for (const handle of opened.reverse()) await handle.close().catch(() => undefined);
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function composeManifest(
  entries: readonly MemoryTopicEntry[],
  skipped: number,
  refused: number,
  scanTruncated: boolean,
): string {
  const lines = [
    "# Memory Tree",
    "Files marked loaded are already included in context. Other files are topic memories; use their descriptions to decide what may be relevant.",
    ...entries.map((entry) =>
      `- \`${entry.path}\` (${entry.state}, ${entry.bodyChars} chars): ${entry.description}`),
  ];
  if (skipped > 0) {
    lines.push(`- \u2026 ${skipped} memory files skipped (unreadable, changed, or not valid UTF-8)`);
  }
  if (refused > 0) {
    lines.push(
      `- \u2026 ${refused} refused memory ${refused === 1 ? "entry" : "entries"} ` +
      "(name, depth, or path length outside the locator bound)",
    );
  }
  if (scanTruncated) {
    lines.push("- \u2026 more memory files were not inspected (directory-entry bound reached)");
  }
  return lines.join("\n");
}

/**
 * Compose the manifest in full. Every entry is listed; only a skipped or
 * refused entry is counted in a visible line, so nothing is silently absent.
 */
function buildManifest(
  entries: readonly MemoryTopicEntry[],
  skipped: number,
  refused: number,
  scanTruncated: boolean,
): string {
  if (entries.length === 0 && skipped === 0 && refused === 0 && !scanTruncated) return "";
  return composeManifest(entries, skipped, refused, scanTruncated);
}

/**
 * Discover topic memory under one explicit workspace root and build a manifest.
 * `loadedFiles` names memory files the host already injected; every other
 * discovered `.md` file is a `topic` to read on demand. Nothing is written,
 * created, cached, or stored outside the caller's workspace.
 *
 * A missing `memory/` directory yields no entries. A missing or invalid
 * explicitly named loaded file rejects the whole load, so configured content
 * is never silently replaced. A discovered topic that is unreadable or not
 * valid UTF-8, and an entry refused by a locator-shape bound, is counted in the
 * manifest; a missing/vanished or changed topic is skipped the same way. No
 * content-size budget applies.
 */
export async function loadMemoryContext(request: MemoryContextRequest): Promise<MemoryContextResult> {
  if (!isRecord(request)) {
    throw new MemoryContextInputError("Memory context request must be an object");
  }
  const rootPath = validatedRoot(ownDataField(request, "workspaceRoot", "Memory context request").value);
  const loadedField = ownDataField(request, "loadedFiles", "Memory context request");
  const loadedFiles = validateMemoryLoadedFiles(loadedField.found ? loadedField.value : undefined);
  const loaded = new Set(loadedFiles);

  const root = await openWorkspaceDirectory(rootPath);
  const entries: MemoryTopicEntry[] = [];
  const state: ScanState = { scanned: 0, truncated: false, refused: 0 };
  let skipped = 0;
  try {
    const topics: string[] = [];
    const memory = await openMemoryDirectory(root);
    if (memory !== undefined) {
      try {
        await scanTopics(memory, [], state, topics);
      } finally {
        await memory.close().catch(() => undefined);
      }
    }

    // Every discovered topic and every explicitly loaded file is listed; there is
    // no entry cap, so nothing is hidden behind a count.
    const shown = [...new Set([...loadedFiles, ...topics])].sort(comparePaths);

    for (const path of shown) {
      const isLoaded = loaded.has(path);
      let parsed: { description: string; bodyChars: number };
      try {
        parsed = await readManifestEntry(root, path);
      } catch (error) {
        // A discovered topic may be stale, unreadable or not UTF-8; that must not
        // block Gateway reopen. Explicitly loaded files stay loud.
        if (!isLoaded && error instanceof MemoryContextFileError) {
          skipped++;
          continue;
        }
        throw error;
      }
      entries.push(Object.freeze({
        path,
        source: `${WORKSPACE_SOURCE_PREFIX}${path}`,
        state: isLoaded ? "loaded" : "topic",
        description: parsed.description,
        bodyChars: parsed.bodyChars,
      }));
    }
  } finally {
    await root.close().catch(() => undefined);
  }

  const manifest = buildManifest(entries, skipped, state.refused, state.truncated);
  const document = manifest.length === 0
    ? undefined
    : Object.freeze({ source: MANIFEST_SOURCE, content: manifest });

  return Object.freeze({
    entries: Object.freeze(entries),
    manifest,
    ...(document !== undefined ? { document } : {}),
  });
}
