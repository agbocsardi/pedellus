/**
 * Operator-explicit discovery and snapshot acquisition for a dedicated legacy
 * root. This module reads only the exact historical Python surfaces below the
 * caller-supplied root and returns snapshots for `prepareArchivalImport`.
 *
 * It never imports, persists, advances a cursor, resumes a session, or runs an
 * archived history record. The root is deliberately not ambient: there is no
 * `~/.nanobot` default and no content parsing here.
 */
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { existsSync } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ARCHIVAL_PREPARATION_LIMITS,
  prepareArchivalImport,
  type ArchivalImportRequest,
  type ArchivalPreparationOptions,
  type ArchivalPreparationReport,
  type ArchivalSourceSnapshot,
} from "../archival-import/index.js";

export const ARCHIVAL_SOURCE_ACQUISITION_FORMAT = "nanobot-archival-source-acquisition" as const;
export const ARCHIVAL_SOURCE_ACQUISITION_VERSION = 1 as const;

/** Source shapes are fixed by the Python writer layout, not inferred from content. */
export const ARCHIVAL_SOURCE_SURFACES = Object.freeze([
  "sessions/*.jsonl",
  "sessions/archive/*/*.jsonl",
  "memory/history.jsonl",
] as const);

/**
 * Defaults fit one preparation request: one batch has at most
 * `ARCHIVAL_PREPARATION_LIMITS.maxSources` sources and
 * `ARCHIVAL_PREPARATION_LIMITS.maxTotalBytes` bytes.
 */
export const ARCHIVAL_SOURCE_ACQUISITION_LIMITS = Object.freeze({
  maxSources: 256,
  maxSourceBytes: ARCHIVAL_PREPARATION_LIMITS.maxSourceBytes,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntriesPerDirectory: 4_096,
  maxEntriesVisited: 16_384,
  maxSourcesPerBatch: ARCHIVAL_PREPARATION_LIMITS.maxSources,
  maxBatchBytes: ARCHIVAL_PREPARATION_LIMITS.maxTotalBytes,
  maxDiagnostics: 4_096,
});

const HARD_LIMITS = Object.freeze({
  maxSources: 1_024,
  maxSourceBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntriesPerDirectory: 65_536,
  maxEntriesVisited: 1_048_576,
  maxSourcesPerBatch: 128,
  maxBatchBytes: 64 * 1024 * 1024,
  maxDiagnostics: 100_000,
});

export interface ArchivalSourceAcquisitionLimits {
  readonly maxSources: number;
  readonly maxSourceBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntriesPerDirectory: number;
  readonly maxEntriesVisited: number;
  readonly maxSourcesPerBatch: number;
  readonly maxBatchBytes: number;
  readonly maxDiagnostics: number;
}

export interface ArchivalSourceAcquisitionOptions {
  /** Absolute, operator-authorized, dedicated legacy root. Never a default. */
  readonly root: string;
  /** Caller-supplied opaque namespace forwarded unchanged to preparation. */
  readonly storeNamespace: string;
  readonly limits?: Partial<ArchivalSourceAcquisitionLimits>;
}

export type ArchivalSourceKind = "session" | "archive" | "history";
export type ArchivalSourceFormat = "session-jsonl" | "session-archive-jsonl" | "history-jsonl";
export type ArchivalSourceSurfaceName = "sessions" | "archive" | "memory" | "history";
export type ArchivalSourceSurfaceStatus = "present" | "missing" | "error" | "not-checked";
export type ArchivalSourceDiagnosticSurface =
  | "root"
  | "sessions"
  | "archive"
  | "archive-key"
  | "memory"
  | "history"
  | "source";

export interface AcquiredArchivalSource {
  readonly sourceId: string;
  readonly kind: ArchivalSourceKind;
  readonly format: ArchivalSourceFormat;
  readonly provenance: string;
  readonly sha256: string;
  readonly byteLength: number;
  /** Direct input for `prepareArchivalImport`; bytes are the exact snapshot. */
  readonly snapshot: ArchivalSourceSnapshot;
}

export interface ArchivalSourceBatch {
  readonly batch: number;
  readonly sources: readonly ArchivalSourceSnapshot[];
  readonly totalBytes: number;
}

export interface ArchivalSourceDiagnostic {
  /** Stable code only; never a path, filesystem message, or source content. */
  readonly code: string;
  readonly severity: "failure" | "notice";
  readonly surface: ArchivalSourceDiagnosticSurface;
  /** Opaque hash-derived source ID, or null for a directory/surface diagnostic. */
  readonly sourceId: string | null;
}

export interface ArchivalSourceAcquisitionReport {
  readonly format: typeof ARCHIVAL_SOURCE_ACQUISITION_FORMAT;
  readonly version: typeof ARCHIVAL_SOURCE_ACQUISITION_VERSION;
  readonly storeNamespace: string;
  /** Stable hash-derived label; never the raw root path. */
  readonly rootLabel: string;
  readonly complete: boolean;
  readonly reviewRequired: true;
  readonly explicitRootReadsPerformed: true;
  readonly ambientReadsPerformed: false;
  readonly importPerformed: false;
  readonly persistencePerformed: false;
  readonly preparationPerformed: false;
  readonly replayPerformed: false;
  readonly runtimeActionsPrepared: 0;
  /** Number of the four expected surfaces currently present. */
  readonly surfacesAvailable: number;
  /** Expected surfaces that are missing, not checked, or errored. */
  readonly expectedSurfacesMissing: readonly ArchivalSourceSurfaceName[];
  readonly discovery: Readonly<{
    readonly sessions: ArchivalSourceSurfaceStatus;
    readonly archive: ArchivalSourceSurfaceStatus;
    readonly memory: ArchivalSourceSurfaceStatus;
    readonly history: ArchivalSourceSurfaceStatus;
  }>;
  readonly bounds: Readonly<{
    readonly limits: ArchivalSourceAcquisitionLimits;
    readonly directoryEntriesVisited: number;
    readonly sourceCandidates: number;
    readonly declaredBytes: number;
    readonly bytesRead: number;
    readonly sourcesAcquired: number;
    readonly batches: number;
  }>;
  readonly counts: Readonly<{
    readonly sourcesDiscovered: number;
    readonly sourcesAcquired: number;
    readonly sourcesRejected: number;
    readonly sessionSources: number;
    readonly archiveSources: number;
    readonly historySources: number;
    readonly ignoredEntries: number;
    readonly structuralEntries: number;
    readonly directoryEntriesVisited: number;
    readonly bytesRead: number;
    readonly batches: number;
    readonly diagnostics: number;
  }>;
  readonly sources: readonly AcquiredArchivalSource[];
  /** Empty unless the acquisition is complete; no partial batch is exposed. */
  readonly batches: readonly ArchivalSourceBatch[];
  readonly diagnostics: readonly ArchivalSourceDiagnostic[];
  readonly limitations: readonly string[];
}

export class ArchivalSourceInputError extends TypeError {
  readonly code = "archival_source_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ArchivalSourceInputError";
  }
}

export class ArchivalSourceBoundsError extends RangeError {
  readonly code = "archival_source_bound_exceeded";
  readonly bound: string;

  constructor(bound: string) {
    super(`Archival source acquisition exceeds the ${bound} bound`);
    this.name = "ArchivalSourceBoundsError";
    this.bound = bound;
  }
}

export class ArchivalSourcePlatformError extends Error {
  readonly code = "archival_source_platform_unsupported";

  constructor() {
    super("Archival source acquisition requires Linux /proc/self/fd and O_NOFOLLOW support");
    this.name = "ArchivalSourcePlatformError";
  }
}

const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROC_FD = "/proc/self/fd";
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const RESTRICTED_ROOTS = Object.freeze(["/proc", "/sys", "/dev"]);
const EXPECTED_SURFACES: readonly ArchivalSourceSurfaceName[] = Object.freeze([
  "sessions",
  "archive",
  "memory",
  "history",
]);

const LIMITATIONS: readonly string[] = Object.freeze([
  "Linux only: safe traversal uses O_NOFOLLOW and /proc/self/fd directory pinning. Other platforms fail closed rather than use weaker path checks.",
  "The root must be explicit, absolute, and dedicated to synthetic or separately authorized private copies. The module refuses /, the home directory or its ancestors, ~/.nanobot or anything inside it, the temp root itself, and /proc, /sys, or /dev.",
  "Only sessions/*.jsonl, sessions/archive/*/*.jsonl, and memory/history.jsonl are discovered. Other entries are counted as ignored and are never opened; deeper nesting and archive container files are unsupported.",
  "Acquisition copies exact bytes but does not parse JSONL. Preparation may still reject or quarantine content, and preparation bounds may still throw after successful acquisition.",
  "Consistency checks compare device, inode, size, mode, mtime, and ctime across discovery, open, read, and post-read path checks. This detects observable replacement, truncation, growth, and metadata changes, but it is not a defense against a privileged or kernel-level adversary, nor against filesystems that fail to update metadata.",
  "Regular files must have one hard link. Symlinks, hard-link aliases, FIFOs, sockets, devices, and directories at candidate paths are rejected rather than followed or read.",
  "Missing expected directories/files are explicit notices, not proof that the root was wrong. Unreadable or unsafe surfaces are failures. Any failure makes the report incomplete and withholds all preparation batches.",
  "The module does not enforce source ownership, permissions, confidentiality, authorization, retention policy, redaction, or PII scanning. The caller must keep the snapshot and resulting preparation reports private.",
  "Source IDs are stable hashes of relative paths and provenance is derived from a hashed root label. No raw path is returned, logged, or placed in diagnostics.",
  "Batches are formed only for a complete acquisition and fit the default preparation source-count and byte limits. Caller-supplied preparation limits that are smaller than a batch can still throw.",
  "No persistence, search index, cursor advancement, session resume, archive replay, or runtime action is provided. Archived history is never run.",
]);

type MutableLimits = {
  -readonly [K in keyof ArchivalSourceAcquisitionLimits]: ArchivalSourceAcquisitionLimits[K];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function rethrowInputFailure(error: unknown, message: string): never {
  if (error instanceof ArchivalSourceBoundsError ||
      error instanceof ArchivalSourceInputError ||
      error instanceof ArchivalSourcePlatformError) {
    throw error;
  }
  throw new ArchivalSourceInputError(message);
}

function readInput<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error) {
    return rethrowInputFailure(error, message);
  }
}

function normalizedLimits(input: unknown): ArchivalSourceAcquisitionLimits {
  try {
    return normalizedLimitsValue(input);
  } catch (error) {
    return rethrowInputFailure(error, "Archival source acquisition limits are unreadable");
  }
}

function normalizedLimitsValue(input: unknown): ArchivalSourceAcquisitionLimits {
  const result: MutableLimits = { ...ARCHIVAL_SOURCE_ACQUISITION_LIMITS };
  if (input === undefined) {
    validateLimitRelations(result);
    return result;
  }
  if (!isRecord(input)) {
    throw new ArchivalSourceInputError("Archival source acquisition limits must be an object");
  }
  let keys: string[];
  try {
    keys = Object.keys(input);
  } catch {
    throw new ArchivalSourceInputError("Archival source acquisition limits are unreadable");
  }
  for (const key of keys) {
    if (!Object.hasOwn(ARCHIVAL_SOURCE_ACQUISITION_LIMITS, key)) {
      throw new ArchivalSourceInputError("Unknown archival source acquisition limit property");
    }
  }
  for (const key of Object.keys(ARCHIVAL_SOURCE_ACQUISITION_LIMITS) as (keyof ArchivalSourceAcquisitionLimits)[]) {
    let value: unknown;
    try {
      value = input[key];
    } catch {
      throw new ArchivalSourceInputError(`Invalid archival source acquisition bound: ${key}`);
    }
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > HARD_LIMITS[key]) {
      throw new ArchivalSourceInputError(`Invalid archival source acquisition bound: ${key}`);
    }
    result[key] = value as number;
  }
  validateLimitRelations(result);
  return result;
}

function validateLimitRelations(limits: ArchivalSourceAcquisitionLimits): void {
  if (limits.maxSourcesPerBatch > limits.maxSources) {
    throw new ArchivalSourceInputError("maxSourcesPerBatch must not exceed maxSources");
  }
  if (limits.maxSourceBytes > limits.maxBatchBytes) {
    throw new ArchivalSourceInputError("maxSourceBytes must not exceed maxBatchBytes");
  }
  if (limits.maxBatchBytes > limits.maxTotalBytes) {
    throw new ArchivalSourceInputError("maxBatchBytes must not exceed maxTotalBytes");
  }
  if (limits.maxEntriesPerDirectory > limits.maxEntriesVisited) {
    throw new ArchivalSourceInputError("maxEntriesPerDirectory must not exceed maxEntriesVisited");
  }
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
    throw new ArchivalSourcePlatformError();
  }
}

function accountHome(): string {
  let info: ReturnType<typeof userInfo>;
  try {
    info = userInfo();
  } catch {
    throw new ArchivalSourceInputError("Archival source acquisition cannot determine the account home directory");
  }
  const home = info.homedir;
  if (typeof home !== "string" || home.length === 0 || !isAbsolute(home)) {
    throw new ArchivalSourceInputError("Archival source acquisition cannot determine the account home directory");
  }
  return resolve(home);
}

function protectedHomes(): readonly string[] {
  const homes = new Set<string>([accountHome()]);
  try {
    const environmentHome = homedir();
    if (typeof environmentHome === "string" && environmentHome.length > 0 && isAbsolute(environmentHome)) {
      homes.add(resolve(environmentHome));
    }
  } catch {
    // The passwd home remains authoritative when HOME is unreadable.
  }
  return [...homes];
}

function validatedRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new ArchivalSourceInputError("Archival source root must be an explicit absolute path");
  }
  const root = resolve(value);
  if (root === sep) {
    throw new ArchivalSourceInputError("Archival source root must not be the filesystem root");
  }
  // Defence in depth: refuse any live default-location component even when HOME
  // is redirected or the passwd home does not match the path spelling.
  if (root.split(sep).some((component) => component.toLowerCase() === ".nanobot")) {
    throw new ArchivalSourceInputError("Archival source root must not overlap the default ~/.nanobot location");
  }
  for (const home of protectedHomes()) {
    const defaultLegacy = resolve(join(home, ".nanobot"));
    if (isWithin(root, home)) {
      throw new ArchivalSourceInputError("Archival source root must not be the home directory or an ancestor of it");
    }
    if (isWithin(root, defaultLegacy) || isWithin(defaultLegacy, root)) {
      throw new ArchivalSourceInputError("Archival source root must not overlap the default ~/.nanobot location");
    }
  }
  const temporary = resolve(tmpdir());
  if (root === temporary) {
    throw new ArchivalSourceInputError("Archival source root must be a dedicated directory, not the temp root");
  }
  for (const restricted of RESTRICTED_ROOTS) {
    if (isWithin(restricted, root)) {
      throw new ArchivalSourceInputError("Archival source root must not be inside a restricted system directory");
    }
  }
  return root;
}

function validatedStoreNamespace(value: unknown): string {
  if (typeof value !== "string" || !SAFE_LABEL.test(value)) {
    throw new ArchivalSourceInputError("Archival source acquisition needs one caller-supplied safe storeNamespace label");
  }
  return value;
}

type AccessKind =
  | "missing"
  | "symlink"
  | "not-directory"
  | "not-regular"
  | "hardlink"
  | "unreadable"
  | "changed"
  | "io";

/** Internal failure with no path or OS message attached. */
class AccessFailure extends Error {
  readonly kind: AccessKind;

  constructor(kind: AccessKind) {
    super(kind);
    this.name = "AccessFailure";
    this.kind = kind;
  }
}

function asAccessFailure(error: unknown): AccessFailure {
  if (error instanceof AccessFailure) return error;
  if (error instanceof ArchivalSourceBoundsError ||
      error instanceof ArchivalSourceInputError ||
      error instanceof ArchivalSourcePlatformError) {
    throw error;
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
      return new AccessFailure("missing");
    case "ELOOP":
      return new AccessFailure("symlink");
    case "EACCES":
    case "EPERM":
      return new AccessFailure("unreadable");
    case "ENOTDIR":
      return new AccessFailure("not-directory");
    default:
      return new AccessFailure("io");
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

function procFdPath(fd: number): string {
  return `${PROC_FD}/${fd}`;
}

async function openAbsoluteDirectoryNoFollow(path: string): Promise<FileHandle> {
  const components = path.slice(1).split(sep).filter(Boolean);
  if (components.length === 0) {
    throw new AccessFailure("not-directory");
  }
  let current: FileHandle;
  try {
    current = await open(sep, DIRECTORY_FLAGS);
  } catch (error) {
    throw asAccessFailure(error);
  }
  try {
    for (const component of components) {
      let next: FileHandle;
      try {
        next = await open(join(procFdPath(current.fd), component), DIRECTORY_FLAGS);
      } catch (error) {
        throw asAccessFailure(error);
      }
      try {
        const info = await next.stat({ bigint: true });
        if (!info.isDirectory()) throw new AccessFailure("not-directory");
      } catch (error) {
        await next.close().catch(() => undefined);
        throw asAccessFailure(error);
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw asAccessFailure(error);
  }
}

async function openRelativeDirectory(
  root: FileHandle,
  segments: readonly string[],
): Promise<FileHandle> {
  let current: FileHandle | null = null;
  let parent = root;
  try {
    for (const segment of segments) {
      let next: FileHandle;
      try {
        next = await open(join(procFdPath(parent.fd), segment), DIRECTORY_FLAGS);
      } catch (error) {
        throw asAccessFailure(error);
      }
      try {
        const info = await next.stat({ bigint: true });
        if (!info.isDirectory()) throw new AccessFailure("not-directory");
      } catch (error) {
        await next.close().catch(() => undefined);
        throw asAccessFailure(error);
      }
      if (current) await current.close();
      current = next;
      parent = next;
    }
  } catch (error) {
    if (current) await current.close().catch(() => undefined);
    throw asAccessFailure(error);
  }
  if (!current) throw new AccessFailure("not-directory");
  return current;
}

interface AcquisitionState {
  readonly limits: ArchivalSourceAcquisitionLimits;
  readonly provenance: string;
  readonly diagnostics: ArchivalSourceDiagnostic[];
  readonly candidates: Candidate[];
  readonly sources: AcquiredArchivalSource[];
  readonly directories: Map<string, Readonly<{ segments: readonly string[]; stat: BigIntStats }>>;
  entriesVisited: number;
  ignoredEntries: number;
  structuralEntries: number;
  candidateEntries: number;
  archiveKeyEntries: number;
  declaredBytes: number;
  bytesRead: number;
  rejectedSources: number;
  surfaces: {
    sessions: ArchivalSourceSurfaceStatus;
    archive: ArchivalSourceSurfaceStatus;
    memory: ArchivalSourceSurfaceStatus;
    history: ArchivalSourceSurfaceStatus;
  };
}

interface Candidate {
  readonly sourceId: string;
  readonly kind: ArchivalSourceKind;
  readonly format: ArchivalSourceFormat;
  readonly segments: readonly string[];
  readonly directorySegments: readonly string[];
  readonly name: string;
  readonly stat: BigIntStats;
  readonly directoryStat: BigIntStats;
}

function segmentsKey(segments: readonly string[]): string {
  return segments.join("/");
}

function sourcePrefix(kind: ArchivalSourceKind): string {
  if (kind === "session") return "legacy-session";
  if (kind === "archive") return "legacy-archive";
  return "legacy-history";
}

function sourceFormat(kind: ArchivalSourceKind): ArchivalSourceFormat {
  if (kind === "session") return "session-jsonl";
  if (kind === "archive") return "session-archive-jsonl";
  return "history-jsonl";
}

function sourceIdFor(kind: ArchivalSourceKind, segments: readonly string[]): string {
  return `${sourcePrefix(kind)}-${sha256Hex(`${kind}/${segments.join("/")}`).slice(0, 32)}`;
}

function addDiagnostic(
  state: AcquisitionState,
  code: string,
  severity: "failure" | "notice",
  surface: ArchivalSourceDiagnosticSurface,
  sourceId: string | null = null,
): void {
  if (state.diagnostics.length >= state.limits.maxDiagnostics) {
    throw new ArchivalSourceBoundsError("diagnostic-count");
  }
  state.diagnostics.push({ code, severity, surface, sourceId });
}

function surfaceForSegments(segments: readonly string[]): ArchivalSourceDiagnosticSurface {
  if (segments[0] === "memory") return "memory";
  if (segments[0] === "sessions" && segments[1] === "archive") return "archive";
  if (segments[0] === "sessions") return "sessions";
  return "root";
}

function directoryDiagnosticCode(prefix: string, kind: AccessKind): string {
  switch (kind) {
    case "missing":
      return `${prefix}-missing`;
    case "symlink":
      return `${prefix}-symlink`;
    case "not-directory":
      return `${prefix}-not-directory`;
    case "unreadable":
      return `${prefix}-unreadable`;
    case "changed":
      return `${prefix}-changed`;
    default:
      return `${prefix}-io-error`;
  }
}

function sourceDiagnosticCode(kind: AccessKind): string {
  switch (kind) {
    case "symlink":
      return "source-symlink-rejected";
    case "not-regular":
    case "not-directory":
      return "source-not-regular-file";
    case "hardlink":
      return "source-hardlink-alias";
    case "unreadable":
      return "source-unreadable";
    case "missing":
      return "source-vanished";
    case "changed":
      return "source-changed";
    default:
      return "source-io-error";
  }
}

async function withDirectory<T>(
  root: FileHandle,
  segments: readonly string[],
  state: AcquisitionState,
  action: (handle: FileHandle, names: readonly string[], stat: BigIntStats) => Promise<T>,
): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await openRelativeDirectory(root, segments);
  } catch (error) {
    throw asAccessFailure(error);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory()) throw new AccessFailure("not-directory");
    const names: string[] = [];
    const directory = await opendir(procFdPath(handle.fd));
    try {
      for await (const entry of directory) {
        const name = entry.name;
        if (name === "." || name === "..") continue;
        names.push(name);
        state.entriesVisited++;
        if (state.entriesVisited > state.limits.maxEntriesVisited) {
          throw new ArchivalSourceBoundsError("directory-entry");
        }
        if (names.length > state.limits.maxEntriesPerDirectory) {
          throw new ArchivalSourceBoundsError("directory-entry-per-directory");
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    const after = await handle.stat({ bigint: true });
    if (!sameDirectory(before, after)) throw new AccessFailure("changed");
    state.directories.set(segmentsKey(segments), { segments: [...segments], stat: after });
    names.sort();
    return await action(handle, names, after);
  } catch (error) {
    throw asAccessFailure(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function considerFileCandidate(
  parent: FileHandle,
  name: string,
  kind: ArchivalSourceKind,
  directorySegments: readonly string[],
  directoryStat: BigIntStats,
  state: AcquisitionState,
): Promise<void> {
  state.candidateEntries++;
  if (state.candidateEntries > state.limits.maxSources) {
    throw new ArchivalSourceBoundsError("source-count");
  }
  const segments = [...directorySegments, name];
  const sourceId = sourceIdFor(kind, segments);
  let info: BigIntStats;
  try {
    info = await lstat(join(procFdPath(parent.fd), name), { bigint: true });
  } catch (error) {
    const failure = asAccessFailure(error);
    state.rejectedSources++;
    addDiagnostic(state, sourceDiagnosticCode(failure.kind), "failure", "source", sourceId);
    return;
  }
  if (info.isSymbolicLink()) {
    state.rejectedSources++;
    addDiagnostic(state, "source-symlink-rejected", "failure", "source", sourceId);
    return;
  }
  if (!info.isFile()) {
    state.rejectedSources++;
    addDiagnostic(state, "source-not-regular-file", "failure", "source", sourceId);
    return;
  }
  if (info.nlink !== 1n) {
    state.rejectedSources++;
    addDiagnostic(state, "source-hardlink-alias", "failure", "source", sourceId);
    return;
  }
  if (info.size > BigInt(state.limits.maxSourceBytes)) {
    throw new ArchivalSourceBoundsError("source-byte");
  }
  const byteLength = Number(info.size);
  state.declaredBytes += byteLength;
  if (state.declaredBytes > state.limits.maxTotalBytes) {
    throw new ArchivalSourceBoundsError("total-byte");
  }
  state.candidates.push({
    sourceId,
    kind,
    format: sourceFormat(kind),
    segments,
    directorySegments: [...directorySegments],
    name,
    stat: info,
    directoryStat,
  });
}

async function discoverSessions(root: FileHandle, state: AcquisitionState): Promise<void> {
  try {
    await withDirectory(root, ["sessions"], state, async (handle, names, stat) => {
      state.surfaces.sessions = "present";
      for (const name of names) {
        if (name === "archive") {
          state.structuralEntries++;
          continue;
        }
        if (!name.endsWith(".jsonl")) {
          state.ignoredEntries++;
          continue;
        }
        await considerFileCandidate(handle, name, "session", ["sessions"], stat, state);
      }
    });
  } catch (error) {
    if (error instanceof ArchivalSourceBoundsError) throw error;
    const failure = asAccessFailure(error);
    if (failure.kind === "missing") {
      state.surfaces.sessions = "missing";
      addDiagnostic(state, "sessions-directory-missing", "notice", "sessions");
      return;
    }
    state.surfaces.sessions = "error";
    addDiagnostic(state, directoryDiagnosticCode("sessions-directory", failure.kind), "failure", "sessions");
  }
}

async function discoverArchive(root: FileHandle, state: AcquisitionState): Promise<void> {
  if (state.surfaces.sessions !== "present") {
    state.surfaces.archive = "not-checked";
    addDiagnostic(state, "archive-directory-not-checked", "notice", "archive");
    return;
  }
  try {
    await withDirectory(root, ["sessions", "archive"], state, async (handle, names) => {
      state.surfaces.archive = "present";
      for (const name of names) {
        let info: BigIntStats;
        try {
          info = await lstat(join(procFdPath(handle.fd), name), { bigint: true });
        } catch (error) {
          state.structuralEntries++;
          const failure = asAccessFailure(error);
          addDiagnostic(
            state,
            directoryDiagnosticCode("archive-key-directory", failure.kind),
            "failure",
            "archive-key",
          );
          continue;
        }
        if (info.isSymbolicLink()) {
          state.structuralEntries++;
          addDiagnostic(state, "archive-key-directory-symlink", "failure", "archive-key");
          continue;
        }
        if (!info.isDirectory()) {
          state.ignoredEntries++;
          continue;
        }
        state.structuralEntries++;
        state.archiveKeyEntries++;
        if (state.archiveKeyEntries > state.limits.maxSources) {
          throw new ArchivalSourceBoundsError("archive-key-count");
        }
        const keySegments = ["sessions", "archive", name];
        try {
          await withDirectory(root, keySegments, state, async (keyHandle, keyNames, keyStat) => {
            for (const keyName of keyNames) {
              if (!keyName.endsWith(".jsonl")) {
                state.ignoredEntries++;
                continue;
              }
              await considerFileCandidate(keyHandle, keyName, "archive", keySegments, keyStat, state);
            }
          });
        } catch (error) {
          if (error instanceof ArchivalSourceBoundsError) throw error;
          const failure = asAccessFailure(error);
          addDiagnostic(
            state,
            directoryDiagnosticCode("archive-key-directory", failure.kind),
            "failure",
            "archive-key",
          );
        }
      }
    });
  } catch (error) {
    if (error instanceof ArchivalSourceBoundsError) throw error;
    const failure = asAccessFailure(error);
    if (failure.kind === "missing") {
      state.surfaces.archive = "missing";
      addDiagnostic(state, "archive-directory-missing", "notice", "archive");
      return;
    }
    state.surfaces.archive = "error";
    addDiagnostic(state, directoryDiagnosticCode("archive-directory", failure.kind), "failure", "archive");
  }
}

async function discoverHistory(root: FileHandle, state: AcquisitionState): Promise<void> {
  try {
    await withDirectory(root, ["memory"], state, async (handle, names, stat) => {
      state.surfaces.memory = "present";
      const hasHistory = names.includes("history.jsonl");
      state.ignoredEntries += names.length - (hasHistory ? 1 : 0);
      if (!hasHistory) {
        state.surfaces.history = "missing";
        addDiagnostic(state, "history-file-missing", "notice", "history");
        return;
      }
      const sourceId = sourceIdFor("history", ["memory", "history.jsonl"]);
      state.candidateEntries++;
      if (state.candidateEntries > state.limits.maxSources) {
        throw new ArchivalSourceBoundsError("source-count");
      }
      let info: BigIntStats;
      try {
        info = await lstat(join(procFdPath(handle.fd), "history.jsonl"), { bigint: true });
      } catch (error) {
        const failure = asAccessFailure(error);
        state.surfaces.history = "error";
        state.rejectedSources++;
        addDiagnostic(state, sourceDiagnosticCode(failure.kind), "failure", "history", sourceId);
        return;
      }
      if (info.isSymbolicLink()) {
        state.surfaces.history = "error";
        state.rejectedSources++;
        addDiagnostic(state, "history-file-symlink-rejected", "failure", "history", sourceId);
        return;
      }
      if (!info.isFile()) {
        state.surfaces.history = "error";
        state.rejectedSources++;
        addDiagnostic(state, "history-file-not-regular", "failure", "history", sourceId);
        return;
      }
      if (info.nlink !== 1n) {
        state.surfaces.history = "error";
        state.rejectedSources++;
        addDiagnostic(state, "history-file-hardlink-alias", "failure", "history", sourceId);
        return;
      }
      if (info.size > BigInt(state.limits.maxSourceBytes)) {
        throw new ArchivalSourceBoundsError("source-byte");
      }
      const byteLength = Number(info.size);
      state.declaredBytes += byteLength;
      if (state.declaredBytes > state.limits.maxTotalBytes) {
        throw new ArchivalSourceBoundsError("total-byte");
      }
      state.candidates.push({
        sourceId,
        kind: "history",
        format: "history-jsonl",
        segments: ["memory", "history.jsonl"],
        directorySegments: ["memory"],
        name: "history.jsonl",
        stat: info,
        directoryStat: stat,
      });
      state.surfaces.history = "present";
    });
  } catch (error) {
    if (error instanceof ArchivalSourceBoundsError) throw error;
    const failure = asAccessFailure(error);
    state.surfaces.history = "not-checked";
    if (failure.kind === "missing") {
      state.surfaces.memory = "missing";
      addDiagnostic(state, "memory-directory-missing", "notice", "memory");
      return;
    }
    state.surfaces.memory = "error";
    addDiagnostic(state, directoryDiagnosticCode("memory-directory", failure.kind), "failure", "memory");
  }
}

async function readCandidate(
  root: FileHandle,
  candidate: Candidate,
  state: AcquisitionState,
): Promise<Buffer> {
  const directory = await openRelativeDirectory(root, candidate.directorySegments);
  try {
    const directoryNow = await directory.stat({ bigint: true });
    if (!sameDirectory(directoryNow, candidate.directoryStat)) {
      throw new AccessFailure("changed");
    }
    const path = join(procFdPath(directory.fd), candidate.name);
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink()) throw new AccessFailure("symlink");
    if (!before.isFile()) throw new AccessFailure("not-regular");
    if (before.nlink !== 1n) throw new AccessFailure("hardlink");
    if (before.size > BigInt(state.limits.maxSourceBytes)) {
      throw new ArchivalSourceBoundsError("source-byte");
    }
    if (!sameFile(before, candidate.stat)) throw new AccessFailure("changed");

    const handle = await open(path, FILE_FLAGS);
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.isSymbolicLink()) throw new AccessFailure("symlink");
      if (!opened.isFile()) throw new AccessFailure("not-regular");
      if (opened.nlink !== 1n) throw new AccessFailure("hardlink");
      if (opened.size > BigInt(state.limits.maxSourceBytes)) {
        throw new ArchivalSourceBoundsError("source-byte");
      }
      if (!sameFile(opened, before)) throw new AccessFailure("changed");

      const byteLength = Number(opened.size);
      const bytes = Buffer.alloc(byteLength);
      let offset = 0;
      while (offset < byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, byteLength - offset, offset);
        if (bytesRead === 0) throw new AccessFailure("changed");
        offset += bytesRead;
      }

      const after = await handle.stat({ bigint: true });
      if (!sameFile(after, opened)) throw new AccessFailure("changed");
      const pathAfter = await lstat(path, { bigint: true });
      if (!sameFile(pathAfter, opened)) throw new AccessFailure("changed");
      return bytes;
    } finally {
      await handle.close().catch(() => undefined);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function verifyRootAndDirectories(
  root: FileHandle,
  rootPath: string,
  rootBefore: BigIntStats,
  state: AcquisitionState,
): Promise<void> {
  let rootNow: BigIntStats | null = null;
  try {
    rootNow = await root.stat({ bigint: true });
  } catch {
    rootNow = null;
  }
  let pathNow: BigIntStats | null = null;
  try {
    pathNow = await lstat(rootPath, { bigint: true });
  } catch {
    pathNow = null;
  }
  if (rootNow === null || pathNow === null ||
      !sameDirectory(rootNow, rootBefore) || !sameDirectory(pathNow, rootBefore)) {
    addDiagnostic(state, "root-changed", "failure", "root");
  }

  const verified = new Set<string>();
  for (const entry of state.directories.values()) {
    const key = segmentsKey(entry.segments);
    if (key === "" || verified.has(key)) continue;
    verified.add(key);
    let handle: FileHandle | null = null;
    try {
      handle = await openRelativeDirectory(root, entry.segments);
      const now = await handle.stat({ bigint: true });
      if (!sameDirectory(now, entry.stat)) {
        addDiagnostic(state, "directory-changed", "failure", surfaceForSegments(entry.segments));
      }
    } catch (error) {
      const failure = asAccessFailure(error);
      addDiagnostic(
        state,
        directoryDiagnosticCode("directory", failure.kind),
        "failure",
        surfaceForSegments(entry.segments),
      );
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }
}

function batchesFor(
  sources: readonly AcquiredArchivalSource[],
  limits: ArchivalSourceAcquisitionLimits,
): readonly ArchivalSourceBatch[] {
  const batches: ArchivalSourceBatch[] = [];
  let current: ArchivalSourceSnapshot[] = [];
  let currentBytes = 0;
  for (const source of sources) {
    if (source.byteLength > limits.maxBatchBytes) {
      throw new ArchivalSourceBoundsError("batch-byte");
    }
    const wouldOverflow = current.length > 0 &&
      (current.length >= limits.maxSourcesPerBatch ||
       currentBytes + source.byteLength > limits.maxBatchBytes);
    if (wouldOverflow) {
      batches.push({ batch: batches.length, sources: current, totalBytes: currentBytes });
      current = [];
      currentBytes = 0;
    }
    if (current.length >= limits.maxSourcesPerBatch) {
      throw new ArchivalSourceBoundsError("batch-source");
    }
    current.push(source.snapshot);
    currentBytes += source.byteLength;
  }
  if (current.length > 0) {
    batches.push({ batch: batches.length, sources: current, totalBytes: currentBytes });
  }
  return batches;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Discover and snapshot the supported historical Python surfaces under exactly
 * one explicit root. No path is returned; use the `sourceId`/`provenance`
 * labels and the snapshot bytes only with the preparation API.
 */
export async function acquireLegacySourceSnapshots(
  options: ArchivalSourceAcquisitionOptions,
): Promise<ArchivalSourceAcquisitionReport> {
  assertSupportedPlatform();
  if (!readInput(() => isRecord(options), "Archival source acquisition options are unreadable")) {
    throw new ArchivalSourceInputError("Archival source acquisition options must be an object");
  }
  const optionKeys = readInput(() => Object.keys(options), "Archival source acquisition options are unreadable");
  for (const key of optionKeys) {
    if (key !== "root" && key !== "storeNamespace" && key !== "limits") {
      throw new ArchivalSourceInputError("Unknown archival source acquisition option property");
    }
  }
  const rootPath = validatedRoot(readInput(() => options.root, "Archival source acquisition options are unreadable"));
  const storeNamespace = validatedStoreNamespace(
    readInput(() => options.storeNamespace, "Archival source acquisition options are unreadable"),
  );
  const limits = normalizedLimits(readInput(() => options.limits, "Archival source acquisition options are unreadable"));
  const rootLabel = `legacy-root-${sha256Hex(rootPath).slice(0, 32)}`;
  const provenance = `${rootLabel}:snapshot-v1`;

  let root: FileHandle;
  try {
    root = await openAbsoluteDirectoryNoFollow(rootPath);
  } catch (error) {
    const failure = asAccessFailure(error);
    if (failure.kind === "symlink") {
      throw new ArchivalSourceInputError("Archival source root must not contain symbolic links");
    }
    if (failure.kind === "not-directory") {
      throw new ArchivalSourceInputError("Archival source root must be a real directory");
    }
    if (failure.kind === "unreadable") {
      throw new ArchivalSourceInputError("Archival source root is not readable");
    }
    throw new ArchivalSourceInputError("Archival source root is missing or unreadable");
  }

  let rootBefore: BigIntStats;
  try {
    rootBefore = await root.stat({ bigint: true });
    if (!rootBefore.isDirectory()) {
      throw new ArchivalSourceInputError("Archival source root must be a real directory");
    }
  } catch (error) {
    await root.close().catch(() => undefined);
    if (error instanceof ArchivalSourceInputError) throw error;
    throw new ArchivalSourceInputError("Archival source root is unreadable");
  }

  const state: AcquisitionState = {
    limits,
    provenance,
    diagnostics: [],
    candidates: [],
    sources: [],
    directories: new Map(),
    entriesVisited: 0,
    ignoredEntries: 0,
    structuralEntries: 0,
    candidateEntries: 0,
    archiveKeyEntries: 0,
    declaredBytes: 0,
    bytesRead: 0,
    rejectedSources: 0,
    surfaces: {
      sessions: "not-checked",
      archive: "not-checked",
      memory: "not-checked",
      history: "not-checked",
    },
  };

  let batches: readonly ArchivalSourceBatch[] = [];
  try {
    await discoverSessions(root, state);
    await discoverArchive(root, state);
    await discoverHistory(root, state);

    const seenSourceIds = new Set<string>();
    const uniqueCandidates: Candidate[] = [];
    for (const candidate of [...state.candidates].sort((left, right) =>
      segmentsKey(left.segments) < segmentsKey(right.segments) ? -1 : 1)) {
      if (seenSourceIds.has(candidate.sourceId)) {
        state.rejectedSources++;
        addDiagnostic(state, "source-id-collision", "failure", "source", candidate.sourceId);
        continue;
      }
      seenSourceIds.add(candidate.sourceId);
      uniqueCandidates.push(candidate);
    }

    for (const candidate of uniqueCandidates) {
      try {
        const bytes = await readCandidate(root, candidate, state);
        state.bytesRead += bytes.length;
        if (state.bytesRead > limits.maxTotalBytes) {
          throw new ArchivalSourceBoundsError("total-byte");
        }
        const digest = sha256Hex(bytes);
        const snapshot: ArchivalSourceSnapshot = {
          sourceId: candidate.sourceId,
          sha256: digest,
          format: candidate.format,
          provenance,
          bytes,
        };
        state.sources.push({
          sourceId: candidate.sourceId,
          kind: candidate.kind,
          format: candidate.format,
          provenance,
          sha256: digest,
          byteLength: bytes.length,
          snapshot,
        });
      } catch (error) {
        if (error instanceof ArchivalSourceBoundsError ||
            error instanceof ArchivalSourceInputError ||
            error instanceof ArchivalSourcePlatformError) {
          throw error;
        }
        const failure = asAccessFailure(error);
        state.rejectedSources++;
        addDiagnostic(state, sourceDiagnosticCode(failure.kind), "failure", "source", candidate.sourceId);
      }
    }

    await verifyRootAndDirectories(root, rootPath, rootBefore, state);
    if (state.candidateEntries === 0) {
      addDiagnostic(state, "no-sources-discovered", "failure", "root");
    }
  } finally {
    await root.close().catch(() => undefined);
  }

  const expectedSurfacesMissing = EXPECTED_SURFACES.filter(
    (surface) => state.surfaces[surface] !== "present",
  );
  const surfacesAvailable = EXPECTED_SURFACES.length - expectedSurfacesMissing.length;
  const complete = state.diagnostics.every((diagnostic) => diagnostic.severity !== "failure");
  if (complete) {
    batches = batchesFor(state.sources, limits);
  }

  const report: ArchivalSourceAcquisitionReport = {
    format: ARCHIVAL_SOURCE_ACQUISITION_FORMAT,
    version: ARCHIVAL_SOURCE_ACQUISITION_VERSION,
    storeNamespace,
    rootLabel,
    complete,
    reviewRequired: true,
    explicitRootReadsPerformed: true,
    ambientReadsPerformed: false,
    importPerformed: false,
    persistencePerformed: false,
    preparationPerformed: false,
    replayPerformed: false,
    runtimeActionsPrepared: 0,
    surfacesAvailable,
    expectedSurfacesMissing,
    discovery: { ...state.surfaces },
    bounds: {
      limits,
      directoryEntriesVisited: state.entriesVisited,
      sourceCandidates: state.candidateEntries,
      declaredBytes: state.declaredBytes,
      bytesRead: state.bytesRead,
      sourcesAcquired: state.sources.length,
      batches: batches.length,
    },
    counts: {
      sourcesDiscovered: state.candidateEntries,
      sourcesAcquired: state.sources.length,
      sourcesRejected: state.rejectedSources,
      sessionSources: state.sources.filter((source) => source.kind === "session").length,
      archiveSources: state.sources.filter((source) => source.kind === "archive").length,
      historySources: state.sources.filter((source) => source.kind === "history").length,
      ignoredEntries: state.ignoredEntries,
      structuralEntries: state.structuralEntries,
      directoryEntriesVisited: state.entriesVisited,
      bytesRead: state.bytesRead,
      batches: batches.length,
      diagnostics: state.diagnostics.length,
    },
    sources: [...state.sources],
    batches,
    diagnostics: [...state.diagnostics],
    limitations: LIMITATIONS,
  };
  return deepFreeze(report);
}

/**
 * Run the existing preparation API over a complete acquisition, one bounded
 * batch at a time. No persistence or import is performed. The acquisition is
 * treated as an internal trust boundary: version, labels, digests, sources, and
 * batch membership are revalidated and batches are recomputed from `sources`,
 * so a forged report cannot silently omit or duplicate work.
 */
export function prepareAcquiredArchivalImport(
  report: ArchivalSourceAcquisitionReport,
  options: ArchivalPreparationOptions = {},
): readonly ArchivalPreparationReport[] {
  const validated = validatedAcquisitionReport(report);
  return validated.batches.map((batch) => {
    const request: ArchivalImportRequest = {
      storeNamespace: validated.storeNamespace,
      sources: batch.sources,
    };
    return prepareArchivalImport(request, options);
  });
}

interface ValidatedAcquisitionReport {
  readonly storeNamespace: string;
  readonly sources: readonly AcquiredArchivalSource[];
  readonly batches: readonly ArchivalSourceBatch[];
}

function validatedAcquisitionReport(report: unknown): ValidatedAcquisitionReport {
  try {
    return validatedAcquisitionReportValue(report);
  } catch (error) {
    return rethrowInputFailure(error, "Archival source acquisition report is unreadable");
  }
}

function validatedAcquisitionReportValue(report: unknown): ValidatedAcquisitionReport {
  if (!isRecord(report) || report.format !== ARCHIVAL_SOURCE_ACQUISITION_FORMAT) {
    throw new ArchivalSourceInputError("Expected an archival source acquisition report");
  }
  if (report.version !== ARCHIVAL_SOURCE_ACQUISITION_VERSION) {
    throw new ArchivalSourceInputError("Unsupported archival source acquisition report version");
  }
  if (report.complete !== true) {
    throw new ArchivalSourceInputError("Cannot prepare an incomplete archival source acquisition");
  }
  const rawDiagnostics = report.diagnostics;
  if (!Array.isArray(rawDiagnostics)) {
    throw new ArchivalSourceInputError("Archival source acquisition report has invalid diagnostics");
  }
  for (const diagnostic of rawDiagnostics) {
    if (!isRecord(diagnostic) ||
        (diagnostic.severity !== "failure" && diagnostic.severity !== "notice")) {
      throw new ArchivalSourceInputError("Archival source acquisition report has invalid diagnostics");
    }
    if (diagnostic.severity === "failure") {
      throw new ArchivalSourceInputError("Cannot prepare an archival source acquisition with failure diagnostics");
    }
  }
  const storeNamespace = validatedStoreNamespace(report.storeNamespace);
  const rootLabel = report.rootLabel;
  if (typeof rootLabel !== "string" || !SAFE_LABEL.test(rootLabel)) {
    throw new ArchivalSourceInputError("Archival source acquisition report has an invalid root label");
  }
  const rawSources = report.sources;
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw new ArchivalSourceInputError("Archival source acquisition report must contain at least one source");
  }
  const rawBounds = report.bounds;
  if (!isRecord(rawBounds)) {
    throw new ArchivalSourceInputError("Archival source acquisition report has invalid bounds");
  }
  const limits = normalizedLimits(rawBounds.limits);

  const sources: AcquiredArchivalSource[] = [];
  const seenSourceIds = new Set<string>();
  for (const rawSource of rawSources) {
    if (!isRecord(rawSource)) {
      throw new ArchivalSourceInputError("Archival source acquisition report contains an invalid source");
    }
    const sourceId = rawSource.sourceId;
    if (typeof sourceId !== "string" || !SAFE_LABEL.test(sourceId) || seenSourceIds.has(sourceId)) {
      throw new ArchivalSourceInputError("Archival source acquisition report has an invalid or duplicate source ID");
    }
    const kind = rawSource.kind;
    if (kind !== "session" && kind !== "archive" && kind !== "history") {
      throw new ArchivalSourceInputError("Archival source acquisition report has an invalid source kind");
    }
    const format = sourceFormat(kind);
    if (rawSource.format !== format) {
      throw new ArchivalSourceInputError("Archival source acquisition report source format does not match its kind");
    }
    const provenance = rawSource.provenance;
    if (typeof provenance !== "string" || !SAFE_LABEL.test(provenance)) {
      throw new ArchivalSourceInputError("Archival source acquisition report has an invalid provenance label");
    }
    const sha256 = rawSource.sha256;
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
      throw new ArchivalSourceInputError("Archival source acquisition report has an invalid source digest");
    }
    const byteLength = rawSource.byteLength;
    if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new ArchivalSourceInputError("Archival source acquisition report has an invalid source byte length");
    }
    const rawSnapshot = rawSource.snapshot;
    if (!isRecord(rawSnapshot)) {
      throw new ArchivalSourceInputError("Archival source acquisition report has an invalid snapshot");
    }
    const bytes = rawSnapshot.bytes;
    if (!(bytes instanceof Uint8Array) || byteLength !== bytes.length) {
      throw new ArchivalSourceInputError("Archival source acquisition report snapshot bytes do not match its source");
    }
    if (rawSnapshot.sourceId !== sourceId ||
        rawSnapshot.format !== format ||
        rawSnapshot.provenance !== provenance ||
        rawSnapshot.sha256 !== sha256) {
      throw new ArchivalSourceInputError("Archival source acquisition report snapshot identity does not match its source");
    }
    let digest: string;
    try {
      digest = sha256Hex(bytes);
    } catch {
      throw new ArchivalSourceInputError("Archival source acquisition report snapshot bytes are unreadable");
    }
    if (digest !== sha256) {
      throw new ArchivalSourceInputError("Archival source acquisition report snapshot digest does not match its source");
    }
    seenSourceIds.add(sourceId);
    sources.push({
      sourceId,
      kind,
      format,
      provenance,
      sha256,
      byteLength,
      snapshot: { sourceId, sha256, format, provenance, bytes },
    });
  }

  const batches = batchesFor(sources, limits);
  const rawBatches = report.batches;
  if (!Array.isArray(rawBatches) || rawBatches.length !== batches.length) {
    throw new ArchivalSourceInputError("Archival source acquisition report batches do not match its sources");
  }
  for (let index = 0; index < batches.length; index++) {
    const expected = batches[index];
    const rawBatch = rawBatches[index];
    if (!expected || !isRecord(rawBatch) ||
        rawBatch.batch !== index ||
        rawBatch.totalBytes !== expected.totalBytes ||
        !Array.isArray(rawBatch.sources) ||
        rawBatch.sources.length !== expected.sources.length) {
      throw new ArchivalSourceInputError("Archival source acquisition report batches do not match its sources");
    }
    for (let sourceIndex = 0; sourceIndex < expected.sources.length; sourceIndex++) {
      const expectedSnapshot = expected.sources[sourceIndex];
      const rawSnapshot = rawBatch.sources[sourceIndex];
      if (!expectedSnapshot || !isRecord(rawSnapshot) ||
          rawSnapshot.sourceId !== expectedSnapshot.sourceId ||
          rawSnapshot.sha256 !== expectedSnapshot.sha256 ||
          rawSnapshot.format !== expectedSnapshot.format ||
          rawSnapshot.provenance !== expectedSnapshot.provenance ||
          !(rawSnapshot.bytes instanceof Uint8Array) ||
          rawSnapshot.bytes.length !== expectedSnapshot.bytes.length) {
        throw new ArchivalSourceInputError("Archival source acquisition report batches do not match its sources");
      }
    }
  }

  return { storeNamespace, sources, batches };
}
