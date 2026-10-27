/**
 * Operator-facing, offline rehearsal for a one-off archival import.
 *
 * This slice only composes existing modules:
 *
 *   acquireLegacySourceSnapshots()
 *     -> persistArchivalImport()
 *     -> searchPersistedArchivalImport() / readArchivalImportLedger()
 *
 * It adds an explicit, private destination directory, the Gateway's process
 * lock, WAL/FULL storage opening, source/destination/workspace disjointness,
 * hardlink/sidecar rejection, private file modes, a dry-run default, and
 * preflight of preparation/persistence bounds and ledger capacity. A missing
 * known surface requires explicit per-surface acknowledgement before apply. It
 * never discovers a live Python store, opens the network, creates a
 * model/provider/task/submission, resumes a session, or replays archived data.
 * The source root and destination directory are always caller-supplied;
 * nothing is inferred.
 *
 * A dry-run reads the source copy and prepares it in memory, but does not
 * open, create, migrate, or lock the destination database. `apply: true` is the
 * only mode that writes, and it writes only the supplied synthetic/quiescent
 * copy into the explicit destination database.
 *
 * Reports contain stable codes, opaque labels, counts, and digests. They never
 * contain source content or filesystem paths. Search results, when explicitly
 * requested, are bounded search hits (snippets and allowlisted metadata) and
 * are as sensitive as the archived material; raw line bytes are never returned.
 *
 * This slice is experimental and synthetic-only. It is NOT hardened against a
 * same-user process that can write the private destination and ignores the
 * Gateway lock: that process can race the post-lock check and SQLite's
 * path-based open, and can add a hard link between fstat and fchmod. The
 * post-open checks block archival writes and the fd-based fchmod never follows
 * a swapped path, but the residual is documented and no real import is
 * authorized without a further gate.
 */
import { createHash } from "node:crypto";
import { constants, realpathSync, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/node";
import { createSession, type Session, type Storage } from "@earendil-works/pi-durable";
import {
  acquireLegacySourceSnapshots,
  ArchivalSourceBoundsError,
  ArchivalSourceInputError,
  ArchivalSourcePlatformError,
  type ArchivalSourceAcquisitionLimits,
  type ArchivalSourceAcquisitionReport,
  type ArchivalSourceDiagnostic,
  type ArchivalSourceSurfaceName,
  type ArchivalSourceSurfaceStatus,
} from "../archival-source/index.js";
import {
  ArchivalPreparationBoundsError,
  ArchivalPreparationInputError,
  prepareArchivalImport,
  type ArchivalPreparationOptions,
  type ArchivalPreparationReport,
  type ArchivalSourcePreparation,
} from "../archival-import/index.js";
import {
  ArchivalPersistenceBoundsError,
  ArchivalPersistenceConflictError,
  ArchivalPersistenceCorruptionError,
  ArchivalPersistenceInputError,
  ARCHIVAL_RECORD_SCHEMA_VERSION,
  normalizeArchivalPersistenceLimits,
  persistArchivalImport,
  readArchivalImportLedger,
  type ArchivalLedgerSource,
  type ArchivalPersistenceLimits,
  type ArchivalPersistenceReport,
  type ArchivalPersistenceSourceResult,
} from "../archival-persist/index.js";
import {
  ArchivalSearchBoundsError,
  ArchivalSearchContinuationError,
  ArchivalSearchCorruptionError,
  ArchivalSearchInputError,
  searchPersistedArchivalImport,
  type ArchivalSearchLimits,
  type ArchivalSearchPage,
  type ArchivalSearchQuery,
} from "../archival-search/index.js";
import { openFullSyncNodeSqliteStorage } from "../storage/sqlite.js";

export const ARCHIVAL_REHEARSAL_FORMAT = "nanobot-archival-import-rehearsal" as const;
export const ARCHIVAL_REHEARSAL_VERSION = 1 as const;
export const ARCHIVAL_REHEARSAL_MODE = "offline-synthetic-or-quiescent-copy-only" as const;
export const ARCHIVAL_REHEARSAL_DISPOSITION = "archive-only-never-resume-or-replay" as const;
export const ARCHIVAL_REHEARSAL_OWNERSHIP = "gateway-process-lock" as const;

const DATABASE_FILE = "nanobot.sqlite";
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const RESTRICTED_ROOTS: readonly string[] = ["/proc", "/sys", "/dev"];

export interface ArchivalRehearsalSearchOptions {
  readonly query: ArchivalSearchQuery;
  /** One bounded page only; no continuation is accepted from the caller. */
  readonly limits?: Partial<ArchivalSearchLimits>;
}

/** One bounded page with the host-trusted continuation token withheld. */
export interface ArchivalRehearsalSearchResult {
  readonly query: ArchivalSearchPage["query"];
  readonly ledger: ArchivalSearchPage["ledger"];
  readonly limits: ArchivalSearchPage["limits"];
  readonly hits: ArchivalSearchPage["hits"];
  readonly coverage: ArchivalSearchPage["coverage"];
  readonly stopReason: ArchivalSearchPage["stopReason"];
  readonly scanComplete: boolean;
  readonly continuationAvailable: boolean;
  /** Hits contain snippets and allowlisted private metadata, never raw line bytes. */
  readonly privateResults: true;
}

export interface ArchivalRehearsalOptions {
  /** Absolute, dedicated, operator-supplied quiescent/synthetic copy. Never live data. */
  readonly sourceRoot: string;
  /** Absolute, existing, private destination directory holding `nanobot.sqlite`. */
  readonly destinationDir: string;
  /** Absolute workspace that must not overlap the source or destination. */
  readonly workspace: string;
  /** Opaque namespace, validated by acquisition; never inferred from a path. */
  readonly storeNamespace: string;
  /** Default false: acquire and prepare in memory only; no destination reads/writes. */
  readonly apply?: boolean;
  readonly acquisitionLimits?: Partial<ArchivalSourceAcquisitionLimits>;
  readonly persistenceLimits?: Partial<ArchivalPersistenceLimits>;
  /** Forwarded to the existing preparation step. */
  readonly preparation?: ArchivalPreparationOptions;
  /**
   * Explicit per-surface attestation required for apply when a known optional
   * surface (`sessions`, `archive`, `memory`, `history`) is missing from the
   * copy. Dry-run exposes the missing surfaces without requiring this.
   */
  readonly acknowledgeMissingSurfaces?: readonly ArchivalSourceSurfaceName[];
  /** Optional one-page search, executed in the same lock/session after apply. */
  readonly search?: ArchivalRehearsalSearchOptions;
}

export type ArchivalRehearsalStage =
  | "source"
  | "destination"
  | "ownership"
  | "preparation"
  | "persistence"
  | "ledger"
  | "search";

export interface ArchivalRehearsalBlocker {
  readonly stage: ArchivalRehearsalStage;
  /** Stable code only; never a path, OS error message, or content. */
  readonly code: string;
  /** Opaque hash-derived/source label when the blocked item is a source. */
  readonly sourceId?: string;
}

export interface ArchivalRehearsalSourceSummary {
  readonly complete: boolean;
  readonly rootLabel: string;
  readonly surfacesAvailable: number;
  readonly expectedSurfacesMissing: readonly ArchivalSourceSurfaceName[];
  readonly discovery: Readonly<Record<ArchivalSourceSurfaceName, ArchivalSourceSurfaceStatus>>;
  readonly counts: Readonly<{
    readonly sourcesAcquired: number;
    readonly sourcesRejected: number;
    readonly sessionSources: number;
    readonly archiveSources: number;
    readonly historySources: number;
    readonly bytesRead: number;
    readonly batches: number;
    readonly diagnostics: number;
  }>;
  readonly diagnostics: readonly ArchivalSourceDiagnostic[];
  readonly batches: number;
}

export interface ArchivalRehearsalPreparedSource {
  readonly sourceId: string;
  readonly format: string;
  readonly provenance: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly status: "complete" | "incomplete" | "unsupported";
  readonly lineCount: number | null;
  readonly recordsEmitted: number;
  readonly searchUnitsEmitted: number;
  readonly preparationFormat: string;
  readonly preparationVersion: number;
}

export interface ArchivalRehearsalPreparationSummary {
  readonly format: string;
  readonly version: number;
  readonly complete: boolean;
  readonly recordsPrepared: number;
  readonly quarantinedRecords: number;
  readonly diagnostics: number;
  readonly sources: readonly ArchivalRehearsalPreparedSource[];
}

export interface ArchivalRehearsalPersistenceSummary {
  readonly newSourcesPersisted: number;
  readonly alreadyPersistedSources: number;
  readonly unsupportedSourcesNotPersisted: number;
  readonly preparation: Readonly<{
    readonly format: string;
    readonly version: number;
    readonly complete: boolean;
    readonly recordsPrepared: number;
    readonly quarantinedRecords: number;
    readonly diagnostics: number;
  }>;
  readonly counts: Readonly<{
    readonly sources: number;
    readonly recordsPersisted: number;
    readonly recordsAlreadyPresent: number;
    readonly searchUnitsPersisted: number;
  }>;
  readonly sources: readonly ArchivalPersistenceSourceResult[];
}

export interface ArchivalRehearsalBatchResult {
  readonly batch: number;
  readonly sourceCount: number;
  readonly totalBytes: number;
  readonly preparation: ArchivalRehearsalPreparationSummary | null;
  readonly persistence: ArchivalRehearsalPersistenceSummary | null;
}

export interface ArchivalRehearsalLedgerSummary {
  readonly present: boolean;
  readonly storeNamespace: string | null;
  readonly sourceCount: number;
  readonly sources: readonly Readonly<{
    readonly sourceId: string;
    readonly format: string;
    readonly provenance: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly lineCount: number | null;
    readonly preparationStatus: "complete" | "incomplete" | "unsupported";
    readonly preparationFormat: string;
    readonly preparationVersion: number;
    readonly recordSchemaVersion: number;
    readonly recordCount: number;
    readonly searchUnitCount: number;
    readonly conversationId: number | null;
    readonly firstEntryId: number | null;
    readonly lastEntryId: number | null;
    readonly firstLine: number | null;
    readonly lastLine: number | null;
  }>[];
}

export type ArchivalRehearsalStatus = "dry-run" | "applied" | "already-applied" | "blocked";

export interface ArchivalRehearsalReport {
  readonly format: typeof ARCHIVAL_REHEARSAL_FORMAT;
  readonly version: typeof ARCHIVAL_REHEARSAL_VERSION;
  readonly mode: typeof ARCHIVAL_REHEARSAL_MODE;
  readonly disposition: typeof ARCHIVAL_REHEARSAL_DISPOSITION;
  readonly ownership: typeof ARCHIVAL_REHEARSAL_OWNERSHIP;
  readonly status: ArchivalRehearsalStatus;
  readonly storeNamespace: string;
  readonly source: ArchivalRehearsalSourceSummary | null;
  /** Missing surfaces the operator explicitly accepted for this apply. */
  readonly acknowledgedMissingSurfaces: readonly ArchivalSourceSurfaceName[];
  readonly destination: Readonly<{
    /** Stable hash label; never the destination path. */
    readonly label: string;
    readonly databaseOpened: boolean;
    readonly lockAcquired: boolean;
    readonly durability: "wal-full" | "not-opened" | "not-verified";
    /** Database file mode after apply; "not-verified" means no privacy guarantee. */
    readonly databaseMode: "0600" | "not-opened" | "not-verified";
    /** WAL/SHM/journal sidecar policy after apply. */
    readonly walShmMode: "private-0600" | "absent" | "not-opened" | "not-verified";
  }>;
  readonly batches: readonly ArchivalRehearsalBatchResult[];
  readonly ledger: ArchivalRehearsalLedgerSummary | null;
  /** One bounded page, only when explicitly requested by the caller. */
  readonly search: ArchivalRehearsalSearchResult | null;
  readonly blockers: readonly ArchivalRehearsalBlocker[];
  /** True only when this run committed at least one new archival source. */
  readonly writesPerformed: boolean;
  /** Non-empty when destination privacy could not be fully verified after close. */
  readonly privacyLimitations: readonly string[];
  readonly pathsExposed: false;
  readonly contentExposed: boolean;
  /** True when a successful search page echoes the caller-supplied query text. */
  readonly queryEchoed: boolean;
  readonly rawArchivalBytesExposed: false;
  readonly modelEntriesCreated: false;
  readonly tasksCreated: false;
  readonly submissionsCreated: false;
  readonly sessionMapUpdated: false;
  readonly sessionResumed: false;
  readonly cursorAdvanced: false;
  readonly replayPerformed: false;
  readonly reviewRequired: true;
  readonly experimental: true;
  readonly syntheticOnly: true;
  readonly realImportAuthorized: false;
  readonly sameUserRaceHardened: false;
  readonly limitations: readonly string[];
}

export class ArchivalRehearsalInputError extends TypeError {
  readonly code = "archival_import_rehearsal_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ArchivalRehearsalInputError";
  }
}

const LIMITATIONS: readonly string[] = Object.freeze([
  "The caller must point at an operator-supplied synthetic or quiescent copy; this module cannot prove quiescence or synthetic provenance.",
  "Apply requires explicit acknowledgement of each known surface missing from the snapshot; dry-run only reports them.",
  "The source copy is read through the existing no-follow acquisition boundary; live ~/.nanobot and home roots are refused there.",
  "The destination is an explicit private directory; the database is opened with the Gateway's process lock and WAL/FULL durability.",
  "The destination database and WAL/SHM/journal sidecars must be single-link regular files; hardlinks, symlinks, and specials are rejected.",
  "Database/sidecar mode 0600 is enforced with a no-follow descriptor, fstat/nlink/identity checks, and fchmod; a symlink or existing hardlink target is never chmodded.",
  "A same-user process with write access to the destination can still race fstat/fchmod or the post-lock check/SQLite open; this is not hardened and is synthetic-only.",
  "Dry-run performs no destination open, lock, migration, or write. Apply writes only the supplied snapshot bytes to the destination database.",
  "Imports are batched; each batch is atomic. A rerun is idempotent per source identity (storeNamespace, sourceId, sha256).",
  "Preparation, per-batch persistence bounds, ledger conflicts, and ledger capacity are preflighted before the first batch write.",
  "Changed digests, namespaces, formats, provenance, or preparation/schema versions are conflicts that require operator reconciliation; they are never overwritten.",
  "Reports contain stable codes and opaque labels, not paths or content. Search hits and their echoed query text, when requested, are private.",
  "No model/provider entry, task, submission, session-map update, cursor advance, Python resume, or replay is created.",
  "This rehearsal is experimental and synthetic-only; it does not authorize a real import, and the same-user destination race needs a further gate.",
]);

interface CanonicalDirectory {
  readonly path: string;
  readonly status: Stats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasNanobotComponent(path: string): boolean {
  return path.split(sep).includes(".nanobot");
}

function safeLabel(value: string, fallback: string): string {
  return SAFE_LABEL.test(value) ? value : fallback;
}

interface NormalizedRehearsalOptions {
  readonly sourceRoot: string;
  readonly destinationDir: string;
  readonly workspace: string;
  readonly storeNamespace: string;
  readonly apply: boolean;
  readonly acquisitionLimits: Partial<ArchivalSourceAcquisitionLimits> | undefined;
  readonly persistenceLimits: Partial<ArchivalPersistenceLimits> | undefined;
  readonly preparation: ArchivalPreparationOptions | undefined;
  readonly acknowledgeMissingSurfaces: readonly ArchivalSourceSurfaceName[] | undefined;
  readonly search: ArchivalRehearsalSearchOptions | undefined;
}

function readOptions(options: unknown): NormalizedRehearsalOptions {
  if (!isRecord(options)) {
    throw new ArchivalRehearsalInputError("Archival rehearsal options must be an object");
  }
  const allowed = new Set([
    "sourceRoot",
    "destinationDir",
    "workspace",
    "storeNamespace",
    "apply",
    "acquisitionLimits",
    "persistenceLimits",
    "preparation",
    "acknowledgeMissingSurfaces",
    "search",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new ArchivalRehearsalInputError("Unknown archival rehearsal option property");
    }
  }
  const read = <T>(value: unknown, check: (value: unknown) => value is T, message: string): T => {
    if (value === undefined) throw new ArchivalRehearsalInputError(message);
    if (!check(value)) throw new ArchivalRehearsalInputError(message);
    return value;
  };
  const string = (value: unknown): value is string => typeof value === "string";
  const sourceRoot = read(options.sourceRoot, string,
    "Archival rehearsal sourceRoot must be a string");
  const destinationDir = read(options.destinationDir, string,
    "Archival rehearsal destinationDir must be a string");
  const workspace = read(options.workspace, string,
    "Archival rehearsal workspace must be a string");
  const storeNamespace = read(options.storeNamespace, string,
    "Archival rehearsal storeNamespace must be a string");
  if (options.apply !== undefined && typeof options.apply !== "boolean") {
    throw new ArchivalRehearsalInputError("Archival rehearsal apply must be a boolean");
  }
  if (options.search !== undefined && options.apply !== true) {
    throw new ArchivalRehearsalInputError("Archival rehearsal search requires apply: true");
  }
  if (options.acquisitionLimits !== undefined && !isRecord(options.acquisitionLimits)) {
    throw new ArchivalRehearsalInputError("Archival rehearsal acquisitionLimits must be an object");
  }
  if (options.persistenceLimits !== undefined && !isRecord(options.persistenceLimits)) {
    throw new ArchivalRehearsalInputError("Archival rehearsal persistenceLimits must be an object");
  }
  if (options.preparation !== undefined && !isRecord(options.preparation)) {
    throw new ArchivalRehearsalInputError("Archival rehearsal preparation must be an object");
  }
  let acknowledgeMissingSurfaces: readonly ArchivalSourceSurfaceName[] | undefined;
  if (options.acknowledgeMissingSurfaces !== undefined) {
    if (!Array.isArray(options.acknowledgeMissingSurfaces)) {
      throw new ArchivalRehearsalInputError("Archival rehearsal acknowledgeMissingSurfaces must be an array");
    }
    const known = new Set<ArchivalSourceSurfaceName>(["sessions", "archive", "memory", "history"]);
    const acknowledged: ArchivalSourceSurfaceName[] = [];
    for (const surface of options.acknowledgeMissingSurfaces) {
      if (typeof surface !== "string" || !known.has(surface as ArchivalSourceSurfaceName)) {
        throw new ArchivalRehearsalInputError("Archival rehearsal acknowledged surface is invalid");
      }
      if (!acknowledged.includes(surface as ArchivalSourceSurfaceName)) {
        acknowledged.push(surface as ArchivalSourceSurfaceName);
      }
    }
    acknowledgeMissingSurfaces = acknowledged;
  }
  if (options.search !== undefined) {
    if (!isRecord(options.search)) {
      throw new ArchivalRehearsalInputError("Archival rehearsal search must be an object");
    }
    for (const key of Object.keys(options.search)) {
      if (key !== "query" && key !== "limits") {
        throw new ArchivalRehearsalInputError("Unknown archival rehearsal search property");
      }
    }
    if (!isRecord(options.search.query)) {
      throw new ArchivalRehearsalInputError("Archival rehearsal search query must be an object");
    }
    if (options.search.limits !== undefined && !isRecord(options.search.limits)) {
      throw new ArchivalRehearsalInputError("Archival rehearsal search limits must be an object");
    }
  }
  return {
    sourceRoot,
    destinationDir,
    workspace,
    storeNamespace,
    apply: options.apply === true,
    acquisitionLimits: options.acquisitionLimits as Partial<ArchivalSourceAcquisitionLimits> | undefined,
    persistenceLimits: options.persistenceLimits as Partial<ArchivalPersistenceLimits> | undefined,
    preparation: options.preparation as ArchivalPreparationOptions | undefined,
    acknowledgeMissingSurfaces,
    search: options.search as ArchivalRehearsalSearchOptions | undefined,
  };
}

function requireAbsolute(value: string, message: string): string {
  if (!isAbsolute(value)) throw new ArchivalRehearsalInputError(message);
  return resolve(value);
}

async function canonicalDirectory(value: string, message: string): Promise<CanonicalDirectory> {
  const target = resolve(value);
  let status: Stats;
  try {
    status = await lstat(target);
  } catch {
    throw new ArchivalRehearsalInputError(message);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new ArchivalRehearsalInputError(message);
  }
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    throw new ArchivalRehearsalInputError(message);
  }
  if (canonical !== target) {
    throw new ArchivalRehearsalInputError(message);
  }
  return { path: canonical, status };
}

function restrictedPath(path: string, homeDirectories: readonly string[]): boolean {
  if (path === "/") return true;
  if (hasNanobotComponent(path)) return true;
  for (const home of homeDirectories) {
    if (inside(home, path)) return true;
  }
  for (const restricted of RESTRICTED_ROOTS) {
    if (inside(path, restricted)) return true;
  }
  return false;
}

interface Paths {
  readonly sourceRoot: string;
  readonly destinationDir: string;
  readonly workspace: string;
  readonly databasePath: string;
}

async function validatePaths(
  options: NormalizedRehearsalOptions,
): Promise<{ paths: Paths | null; blockers: ArchivalRehearsalBlocker[] }> {
  const blockers: ArchivalRehearsalBlocker[] = [];
  let sourceRoot: string;
  let destinationDir: string;
  let workspace: string;
  try {
    sourceRoot = requireAbsolute(options.sourceRoot, "Archival rehearsal sourceRoot must be absolute");
    destinationDir = requireAbsolute(options.destinationDir, "Archival rehearsal destinationDir must be absolute");
    workspace = requireAbsolute(options.workspace, "Archival rehearsal workspace must be absolute");
  } catch {
    throw new ArchivalRehearsalInputError("Archival rehearsal paths must be absolute");
  }

  let source: CanonicalDirectory | null = null;
  let destination: CanonicalDirectory | null = null;
  let workspaceDirectory: CanonicalDirectory | null = null;
  try {
    source = await canonicalDirectory(sourceRoot, "Archival rehearsal sourceRoot must be an existing real directory");
  } catch {
    blockers.push({ stage: "source", code: "source-root-invalid" });
  }
  try {
    destination = await canonicalDirectory(destinationDir,
      "Archival rehearsal destinationDir must be an existing real directory");
  } catch {
    blockers.push({ stage: "destination", code: "destination-invalid" });
  }
  try {
    workspaceDirectory = await canonicalDirectory(workspace,
      "Archival rehearsal workspace must be an existing real directory");
  } catch {
    blockers.push({ stage: "destination", code: "workspace-invalid" });
  }
  const homeDirectories = (() => {
    const homes = new Set<string>();
    try {
      homes.add(realpathSyncHome(userInfo().homedir));
    } catch {
      // Fail closed below if the passwd home is unavailable.
    }
    try {
      homes.add(realpathSyncHome(homedir()));
    } catch {
      // The acquisition boundary re-checks this; keep the second source best-effort.
    }
    return [...homes];
  })();
  if (homeDirectories.length === 0) {
    blockers.push({ stage: "source", code: "source-home-unavailable" });
  }
  if (source !== null && restrictedPath(source.path, homeDirectories)) {
    blockers.push({ stage: "source", code: "source-root-restricted" });
  }
  if (destination !== null && restrictedPath(destination.path, homeDirectories)) {
    blockers.push({ stage: "destination", code: "destination-restricted" });
  }
  if (destination !== null && (destination.status.mode & 0o077) !== 0) {
    blockers.push({ stage: "destination", code: "destination-not-private" });
  }
  if (source === null || destination === null || workspaceDirectory === null) {
    return { paths: null, blockers };
  }
  if (inside(source.path, destination.path) || inside(destination.path, source.path)) {
    blockers.push({ stage: "destination", code: "source-destination-overlap" });
  }
  if (inside(workspaceDirectory.path, source.path) || inside(source.path, workspaceDirectory.path)) {
    blockers.push({ stage: "source", code: "source-workspace-overlap" });
  }
  if (inside(destination.path, workspaceDirectory.path) ||
      inside(workspaceDirectory.path, destination.path)) {
    blockers.push({ stage: "destination", code: "destination-workspace-overlap" });
  }
  const databasePath = resolve(destination.path, DATABASE_FILE);
  blockers.push(...await databasePathBlockers(databasePath));
  return {
    paths: blockers.length === 0
      ? { sourceRoot: source.path, destinationDir: destination.path, workspace: workspaceDirectory.path, databasePath }
      : null,
    blockers,
  };
}

function realpathSyncHome(path: string): string {
  return realpathSync(path);
}

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function pushBlocker(blockers: ArchivalRehearsalBlocker[], blocker: ArchivalRehearsalBlocker): void {
  if (!blockers.some((existing) => existing.stage === blocker.stage &&
    existing.code === blocker.code && existing.sourceId === blocker.sourceId)) {
    blockers.push(blocker);
  }
}

/** Existing database and sidecar identity checks used before and after the lock. */
async function databasePathBlockers(databasePath: string): Promise<ArchivalRehearsalBlocker[]> {
  const blockers: ArchivalRehearsalBlocker[] = [];
  try {
    const status = await lstat(databasePath);
    if (status.isSymbolicLink() || !status.isFile()) {
      blockers.push({ stage: "destination", code: "destination-database-unsafe" });
    } else if (status.nlink !== 1) {
      blockers.push({ stage: "destination", code: "destination-database-hardlink" });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      blockers.push({ stage: "destination", code: "destination-database-unreadable" });
    }
  }
  for (const suffix of SIDECAR_SUFFIXES) {
    try {
      const status = await lstat(`${databasePath}${suffix}`);
      if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
        blockers.push({ stage: "destination", code: "destination-wal-shm-unsafe" });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        blockers.push({ stage: "destination", code: "destination-wal-shm-unreadable" });
      }
    }
  }
  return blockers;
}

function privacyLimitationsFor(
  databaseMode: "0600" | "not-opened" | "not-verified",
  walShmMode: "private-0600" | "absent" | "not-opened" | "not-verified",
): string[] {
  const limitations: string[] = [];
  if (databaseMode !== "0600" && databaseMode !== "not-opened") {
    limitations.push("Destination database privacy could not be verified; treat it as exposed.");
  }
  if (walShmMode === "not-verified") {
    limitations.push("WAL/SHM/journal sidecars could not be verified private; treat the destination as exposed.");
  }
  return limitations;
}

/** Open-only identity check followed by fchmod on an already-open descriptor. */
type PrivateFileStatus =
  | "absent"
  | "private"
  | "symlink"
  | "hardlink"
  | "not-regular"
  | "identity-changed"
  | "unreadable";

const PRIVATE_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function securePrivateFile(path: string): Promise<PrivateFileStatus> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, PRIVATE_FILE_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code === "ELOOP") return "symlink";
    return "unreadable";
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return "not-regular";
    if (before.nlink !== 1n) return "hardlink";
    // fchmod the opened inode; never a path that may have been swapped.
    // A hard link added between this fstat and fchmod is a same-user residual;
    // the fstat/lstat revalidation after fchmod detects it but cannot undo it.
    await handle.chmod(0o600);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.nlink !== 1n ||
        after.dev !== before.dev || after.ino !== before.ino) {
      return "identity-changed";
    }
    // Revalidate the path still names the same single-link inode.
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(path, { bigint: true });
    } catch {
      return "identity-changed";
    }
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n ||
        current.dev !== before.dev || current.ino !== before.ino) {
      return "identity-changed";
    }
    return "private";
  } catch {
    return "unreadable";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Make the database and any existing sidecars owner-only before archival writes. */
async function ensurePrivateDatabaseFiles(databasePath: string): Promise<{
  blockers: ArchivalRehearsalBlocker[];
  databaseMode: "0600" | "not-verified";
  walShmMode: "private-0600" | "absent" | "not-verified";
}> {
  const blockers: ArchivalRehearsalBlocker[] = [];
  let databaseMode: "0600" | "not-verified" = "not-verified";
  const database = await securePrivateFile(databasePath);
  if (database === "private") {
    databaseMode = "0600";
  } else if (database === "absent") {
    blockers.push({ stage: "destination", code: "destination-database-missing" });
  } else if (database === "hardlink") {
    blockers.push({ stage: "destination", code: "destination-database-hardlink" });
  } else if (database === "symlink" || database === "not-regular" || database === "identity-changed") {
    blockers.push({ stage: "destination", code: "destination-database-unsafe" });
  } else {
    blockers.push({ stage: "destination", code: "destination-database-permissions" });
  }

  let sidecars = 0;
  let sidecarsVerified = true;
  for (const suffix of SIDECAR_SUFFIXES) {
    const status = await securePrivateFile(`${databasePath}${suffix}`);
    if (status === "absent") continue;
    sidecars += 1;
    if (status === "private") continue;
    sidecarsVerified = false;
    blockers.push({
      stage: "destination",
      code: status === "unreadable"
        ? "destination-wal-shm-permissions"
        : "destination-wal-shm-unsafe",
    });
  }
  return {
    blockers,
    databaseMode,
    walShmMode: sidecars === 0 ? "absent" : sidecarsVerified ? "private-0600" : "not-verified",
  };
}

/**
 * Recheck identity and mode after close with the same fd-based primitive. A
 * symlink/hardlink or a replaced path is never chmodded; residual exposure is a
 * limitation instead.
 */
async function finalizeDatabasePrivacy(databasePath: string): Promise<{
  databaseMode: "0600" | "not-verified";
  walShmMode: "private-0600" | "absent" | "not-verified";
  privacyLimitations: string[];
}> {
  const privacyLimitations: string[] = [];
  const databaseMode = (await securePrivateFile(databasePath)) === "private" ? "0600" : "not-verified";
  if (databaseMode !== "0600") {
    privacyLimitations.push("Destination database privacy could not be verified after close; treat it as exposed.");
  }

  let sidecars = 0;
  let sidecarsVerified = true;
  for (const suffix of SIDECAR_SUFFIXES) {
    const status = await securePrivateFile(`${databasePath}${suffix}`);
    if (status === "absent") continue;
    sidecars += 1;
    if (status !== "private") sidecarsVerified = false;
  }
  if (sidecars > 0 && !sidecarsVerified) {
    privacyLimitations.push("WAL/SHM/journal sidecars could not be verified private; treat the destination as exposed.");
  }
  return {
    databaseMode,
    walShmMode: sidecars === 0 ? "absent" : sidecarsVerified ? "private-0600" : "not-verified",
    privacyLimitations,
  };
}

function effectivePersistenceLimits(overrides: Partial<ArchivalPersistenceLimits> | undefined):
ArchivalPersistenceLimits | null {
  try {
    return normalizeArchivalPersistenceLimits(overrides);
  } catch {
    // The persistence module owns the exact valid-key/hard-cap policy.
    return null;
  }
}

interface BatchPreflight {
  readonly blockers: ArchivalRehearsalBlocker[];
  readonly summaries: readonly (ArchivalRehearsalPreparationSummary | null)[];
  readonly preparedSources: readonly ArchivalRehearsalPreparedSource[];
  readonly persistenceLimits: ArchivalPersistenceLimits | null;
}

/** Pure preflight: preparation, persistence per-batch bounds, and summaries before any lock/write. */
function preflightBatches(
  acquisition: ArchivalSourceAcquisitionReport,
  options: NormalizedRehearsalOptions,
): BatchPreflight {
  const blockers: ArchivalRehearsalBlocker[] = [];
  const summaries: (ArchivalRehearsalPreparationSummary | null)[] = [];
  const preparedSources: ArchivalRehearsalPreparedSource[] = [];
  const persistenceLimits = effectivePersistenceLimits(options.persistenceLimits);
  if (persistenceLimits === null) {
    blockers.push({ stage: "persistence", code: "persistence-input-invalid" });
  }

  for (const batch of acquisition.batches) {
    let prepared: ArchivalPreparationReport;
    try {
      prepared = prepareArchivalImport({
        storeNamespace: options.storeNamespace,
        sources: batch.sources,
      }, options.preparation ?? {});
    } catch (error) {
      pushBlocker(blockers, blockerFor(error, "preparation"));
      summaries.push(null);
      continue;
    }
    const summary = preparationSummary(prepared);
    summaries.push(summary);
    preparedSources.push(...summary.sources);
    if (persistenceLimits === null) continue;

    if (batch.sources.length > persistenceLimits.maxSources) {
      pushBlocker(blockers, { stage: "persistence", code: "persistence-preflight-max-sources" });
    }
    if (batch.totalBytes > persistenceLimits.maxRawBytes) {
      pushBlocker(blockers, { stage: "persistence", code: "persistence-preflight-max-raw-bytes" });
    }
    let records = 0;
    let searchUnits = 0;
    for (const source of summary.sources) {
      records += source.recordsEmitted;
      searchUnits += source.searchUnitsEmitted;
      if (source.byteLength > persistenceLimits.maxRawBytesPerSource) {
        pushBlocker(blockers, {
          stage: "persistence",
          code: "persistence-preflight-max-raw-bytes-per-source",
          sourceId: source.sourceId,
        });
      }
      if (source.recordsEmitted > persistenceLimits.maxRecordsPerSource) {
        pushBlocker(blockers, {
          stage: "persistence",
          code: "persistence-preflight-max-records-per-source",
          sourceId: source.sourceId,
        });
      }
      if (source.searchUnitsEmitted > persistenceLimits.maxSearchUnitsPerSource) {
        pushBlocker(blockers, {
          stage: "persistence",
          code: "persistence-preflight-max-search-units-per-source",
          sourceId: source.sourceId,
        });
      }
    }
    if (records > persistenceLimits.maxRecords) {
      pushBlocker(blockers, { stage: "persistence", code: "persistence-preflight-max-records" });
    }
    if (searchUnits > persistenceLimits.maxSearchUnits) {
      pushBlocker(blockers, { stage: "persistence", code: "persistence-preflight-max-search-units" });
    }
  }
  if (persistenceLimits !== null && preparedSources.length > persistenceLimits.maxLedgerSources) {
    // This lower bound does not need the ledger: even an empty destination
    // cannot hold this many sources.
    pushBlocker(blockers, { stage: "ledger", code: "ledger-capacity-exceeded" });
  }
  return { blockers, summaries, preparedSources, persistenceLimits };
}

/** Ledger preflight: namespace, omitted sources, conflicts, and capacity before any batch write. */
function preflightLedger(
  ledger: ArchivalRehearsalLedgerSummary,
  preparedSources: readonly ArchivalRehearsalPreparedSource[],
  storeNamespace: string,
  limits: ArchivalPersistenceLimits,
): ArchivalRehearsalBlocker[] {
  const blockers: ArchivalRehearsalBlocker[] = [];
  const acquisitionIds = new Set(preparedSources.map((source) => source.sourceId));
  if (!ledger.present) {
    if (preparedSources.length > limits.maxLedgerSources) {
      blockers.push({ stage: "ledger", code: "ledger-capacity-exceeded" });
    }
    return blockers;
  }
  if (ledger.storeNamespace !== storeNamespace) {
    blockers.push({ stage: "ledger", code: "ledger-namespace-mismatch" });
  }
  const existing = new Map(ledger.sources.map((row) => [row.sourceId, row]));
  for (const row of ledger.sources) {
    if (!acquisitionIds.has(row.sourceId)) {
      blockers.push({
        stage: "ledger",
        code: "ledger-source-not-in-snapshot",
        sourceId: row.sourceId,
      });
    }
  }
  let newSources = 0;
  for (const source of preparedSources) {
    const row = existing.get(source.sourceId);
    if (row === undefined) {
      newSources += 1;
      continue;
    }
    const conflict = (reason: string): void => {
      blockers.push({
        stage: "persistence",
        code: `persistence-conflict-${reason}`,
        sourceId: source.sourceId,
      });
    };
    if (row.sha256 !== source.sha256) conflict("digest");
    else if (row.format !== source.format) conflict("format");
    else if (row.provenance !== source.provenance) conflict("provenance");
    else if (row.byteLength !== source.byteLength || row.lineCount !== source.lineCount) conflict("metadata");
    else if (row.preparationStatus !== source.status) conflict("preparation-status");
    else if (row.preparationFormat !== source.preparationFormat ||
      row.preparationVersion !== source.preparationVersion) conflict("preparation-version");
    else if (row.recordSchemaVersion !== ARCHIVAL_RECORD_SCHEMA_VERSION) conflict("record-schema-version");
  }
  if (ledger.sources.length + newSources > limits.maxLedgerSources) {
    blockers.push({ stage: "ledger", code: "ledger-capacity-exceeded" });
  }
  return blockers;
}

function sourceSummary(report: ArchivalSourceAcquisitionReport): ArchivalRehearsalSourceSummary {
  return {
    complete: report.complete,
    rootLabel: report.rootLabel,
    surfacesAvailable: report.surfacesAvailable,
    expectedSurfacesMissing: [...report.expectedSurfacesMissing],
    discovery: { ...report.discovery },
    counts: {
      sourcesAcquired: report.counts.sourcesAcquired,
      sourcesRejected: report.counts.sourcesRejected,
      sessionSources: report.counts.sessionSources,
      archiveSources: report.counts.archiveSources,
      historySources: report.counts.historySources,
      bytesRead: report.counts.bytesRead,
      batches: report.counts.batches,
      diagnostics: report.counts.diagnostics,
    },
    diagnostics: report.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    batches: report.batches.length,
  };
}

function preparationSummary(report: ArchivalPreparationReport):
ArchivalRehearsalPreparationSummary {
  return {
    format: report.format,
    version: report.version,
    complete: report.complete,
    recordsPrepared: report.counts.recordsEmitted ?? report.records.length,
    quarantinedRecords: report.counts.quarantinedRecords ?? 0,
    diagnostics: report.diagnostics.length,
    sources: report.sources.map((source) => ({
      sourceId: source.sourceId,
      format: source.format,
      provenance: source.provenance,
      byteLength: source.byteLength,
      sha256: source.sha256,
      status: source.status,
      lineCount: source.lineCount,
      recordsEmitted: source.recordsEmitted,
      searchUnitsEmitted: source.searchUnitsEmitted,
      preparationFormat: report.format,
      preparationVersion: report.version,
    })),
  };
}

function persistenceSummary(report: ArchivalPersistenceReport): ArchivalRehearsalPersistenceSummary {
  return {
    newSourcesPersisted: report.newSourcesPersisted,
    alreadyPersistedSources: report.alreadyPersistedSources,
    unsupportedSourcesNotPersisted: report.unsupportedSourcesNotPersisted,
    preparation: {
      format: report.preparation.format,
      version: report.preparation.version,
      complete: report.preparation.complete,
      recordsPrepared: report.preparation.recordsPrepared,
      quarantinedRecords: report.preparation.quarantinedRecords,
      diagnostics: report.preparation.diagnostics,
    },
    counts: { ...report.counts },
    sources: report.sources.map((source) => ({ ...source })),
  };
}

function searchSummary(page: ArchivalSearchPage): ArchivalRehearsalSearchResult {
  return {
    query: { ...page.query },
    ledger: { ...page.ledger },
    limits: { ...page.limits },
    hits: page.hits.map((hit) => ({ ...hit })),
    coverage: { ...page.coverage },
    stopReason: page.stopReason,
    scanComplete: page.scanComplete,
    continuationAvailable: page.continuation !== null,
    privateResults: true,
  };
}

function ledgerSummary(
  ledger: Awaited<ReturnType<typeof readArchivalImportLedger>>,
): ArchivalRehearsalLedgerSummary {
  if (ledger === undefined) {
    return { present: false, storeNamespace: null, sourceCount: 0, sources: [] };
  }
  const rows: ArchivalLedgerSource[] = [...ledger.sources];
  return {
    present: true,
    storeNamespace: ledger.storeNamespace,
    sourceCount: rows.length,
    sources: rows.map((row) => ({
      sourceId: row.sourceId,
      format: row.format,
      provenance: row.provenance,
      sha256: row.sha256,
      byteLength: row.byteLength,
      lineCount: row.lineCount,
      preparationStatus: row.preparationStatus,
      preparationFormat: row.preparationFormat,
      preparationVersion: row.preparationVersion,
      recordSchemaVersion: row.recordSchemaVersion,
      recordCount: row.recordCount,
      searchUnitCount: row.searchUnitCount,
      conversationId: row.conversationId,
      firstEntryId: row.firstEntryId,
      lastEntryId: row.lastEntryId,
      firstLine: row.firstLine,
      lastLine: row.lastLine,
    })),
  };
}


function reconcileLedger(
  ledger: ArchivalRehearsalLedgerSummary,
  acquisition: ArchivalSourceAcquisitionReport,
  storeNamespace: string,
): ArchivalRehearsalBlocker[] {
  const blockers: ArchivalRehearsalBlocker[] = [];
  if (!ledger.present) return blockers;
  if (ledger.storeNamespace !== storeNamespace) {
    blockers.push({ stage: "ledger", code: "ledger-namespace-mismatch" });
  }
  const bySourceId = new Map(ledger.sources.map((row) => [row.sourceId, row]));
  for (const source of acquisition.sources) {
    const row = bySourceId.get(source.sourceId);
    if (row === undefined) {
      blockers.push({ stage: "ledger", code: "ledger-source-missing", sourceId: source.sourceId });
      continue;
    }
    if (row.sha256 !== source.sha256 || row.format !== source.format ||
        row.provenance !== source.provenance || row.byteLength !== source.byteLength) {
      blockers.push({ stage: "ledger", code: "ledger-source-mismatch", sourceId: source.sourceId });
    }
  }
  return blockers;
}

function blockerFor(error: unknown, stage: ArchivalRehearsalStage): ArchivalRehearsalBlocker {
  if (error instanceof ArchivalPersistenceConflictError) {
    return {
      stage,
      code: `persistence-conflict-${error.reason}`,
      sourceId: safeLabel(error.sourceId, "source-label-invalid"),
    };
  }
  if (error instanceof ArchivalPersistenceBoundsError) {
    return { stage, code: "persistence-bound-exceeded" };
  }
  if (error instanceof ArchivalPersistenceCorruptionError) {
    return { stage, code: "persistence-corruption" };
  }
  if (error instanceof ArchivalPersistenceInputError) {
    return { stage, code: "persistence-input-invalid" };
  }
  if (error instanceof ArchivalSearchBoundsError) {
    return { stage, code: "search-bound-exceeded" };
  }
  if (error instanceof ArchivalSearchContinuationError) {
    return { stage, code: "search-continuation-invalid" };
  }
  if (error instanceof ArchivalSearchCorruptionError) {
    return { stage, code: "search-store-corruption" };
  }
  if (error instanceof ArchivalSearchInputError) {
    return { stage, code: "search-input-invalid" };
  }
  if (error instanceof ArchivalSourceInputError) {
    return { stage, code: "source-input-invalid" };
  }
  if (error instanceof ArchivalSourceBoundsError) {
    return { stage, code: `source-bound-${safeLabel(error.bound, "unknown")}` };
  }
  if (error instanceof ArchivalSourcePlatformError) {
    return { stage, code: "source-platform-unsupported" };
  }
  if (error instanceof ArchivalPreparationBoundsError) {
    return { stage, code: "preparation-bound-exceeded" };
  }
  if (error instanceof ArchivalPreparationInputError) {
    return { stage, code: "preparation-input-invalid" };
  }
  return { stage, code: "unexpected-failure" };
}

async function closeQuietly(session: Session | undefined, storage: Storage | undefined, context: Context): Promise<void> {
  const cleanupContext = withoutAbortSignal(context);
  if (session) await session.close(cleanupContext).catch(() => undefined);
  if (storage) await storage.close(cleanupContext).catch(() => undefined);
}

/**
 * Run one offline rehearsal. The default is a dry-run that never opens the
 * destination database. `apply: true` acquires the same process lock the
 * Gateway uses for `nanobot:<dbPath>`, opens WAL/FULL storage, and persists each
 * acquisition batch through the existing persistence slice.
 */
export async function runArchivalImportRehearsal(
  optionsInput: ArchivalRehearsalOptions,
  context: Context,
): Promise<ArchivalRehearsalReport> {
  const options = readOptions(optionsInput);
  const destinationLabel = `rehearsal-destination-${
    createHash("sha256").update(resolve(options.destinationDir)).digest("hex").slice(0, 32)
  }`;
  const makeReport = (
    status: ArchivalRehearsalStatus,
    fields: Partial<Omit<ArchivalRehearsalReport, "format" | "version" | "mode" | "disposition" | "ownership">> = {},
  ): ArchivalRehearsalReport => ({
    format: ARCHIVAL_REHEARSAL_FORMAT,
    version: ARCHIVAL_REHEARSAL_VERSION,
    mode: ARCHIVAL_REHEARSAL_MODE,
    disposition: ARCHIVAL_REHEARSAL_DISPOSITION,
    ownership: ARCHIVAL_REHEARSAL_OWNERSHIP,
    status,
    storeNamespace: SAFE_LABEL.test(options.storeNamespace) ? options.storeNamespace : "invalid-namespace",
    source: null,
    acknowledgedMissingSurfaces: [],
    destination: {
      label: destinationLabel,
      databaseOpened: false,
      lockAcquired: false,
      durability: "not-opened",
      databaseMode: "not-opened",
      walShmMode: "not-opened",
    },
    batches: [],
    ledger: null,
    search: null,
    blockers: [],
    writesPerformed: false,
    privacyLimitations: [],
    pathsExposed: false,
    contentExposed: false,
    queryEchoed: false,
    rawArchivalBytesExposed: false,
    modelEntriesCreated: false,
    tasksCreated: false,
    submissionsCreated: false,
    sessionMapUpdated: false,
    sessionResumed: false,
    cursorAdvanced: false,
    replayPerformed: false,
    reviewRequired: true,
    experimental: true,
    syntheticOnly: true,
    realImportAuthorized: false,
    sameUserRaceHardened: false,
    limitations: LIMITATIONS,
    ...fields,
  });

  const pathResult = await validatePaths(options);
  if (pathResult.paths === null || pathResult.blockers.length > 0) {
    return makeReport("blocked", { blockers: pathResult.blockers });
  }
  const paths = pathResult.paths;

  let acquisition: ArchivalSourceAcquisitionReport;
  try {
    acquisition = await acquireLegacySourceSnapshots({
      root: paths.sourceRoot,
      storeNamespace: options.storeNamespace,
      ...(options.acquisitionLimits === undefined ? {} : { limits: options.acquisitionLimits }),
    });
  } catch (error) {
    return makeReport("blocked", { blockers: [blockerFor(error, "source")] });
  }
  const source = sourceSummary(acquisition);
  const sourceBlockers: ArchivalRehearsalBlocker[] = [];
  if (!acquisition.complete) {
    sourceBlockers.push({ stage: "source", code: "source-acquisition-incomplete" });
  }
  if (acquisition.sources.length === 0) {
    sourceBlockers.push({ stage: "source", code: "source-no-sources" });
  }
  if (acquisition.surfacesAvailable === 0) {
    sourceBlockers.push({ stage: "source", code: "source-no-expected-surfaces" });
  }
  if (sourceBlockers.length > 0) {
    return makeReport("blocked", { source, blockers: sourceBlockers });
  }

  const acknowledged = new Set(options.acknowledgeMissingSurfaces ?? []);
  const acknowledgedMissingSurfaces = acquisition.expectedSurfacesMissing.filter(
    (surface) => acknowledged.has(surface),
  );
  // B1: a missing known surface makes apply a qualified, explicit operation.
  if (options.apply && acknowledgedMissingSurfaces.length !== acquisition.expectedSurfacesMissing.length) {
    return makeReport("blocked", {
      source,
      acknowledgedMissingSurfaces,
      blockers: [{ stage: "source", code: "missing-surfaces-not-acknowledged" }],
    });
  }

  // Preflight preparation and every per-batch persistence bound before any lock or write.
  const preflight = preflightBatches(acquisition, options);
  const preparedBatches: ArchivalRehearsalBatchResult[] = acquisition.batches.map((batch, index) => ({
    batch: batch.batch,
    sourceCount: batch.sources.length,
    totalBytes: batch.totalBytes,
    preparation: preflight.summaries[index] ?? null,
    persistence: null,
  }));
  if (preflight.blockers.length > 0) {
    return makeReport("blocked", {
      source,
      acknowledgedMissingSurfaces,
      batches: preparedBatches,
      blockers: preflight.blockers,
    });
  }
  if (!options.apply) {
    return makeReport("dry-run", {
      source,
      acknowledgedMissingSurfaces,
      batches: preparedBatches,
    });
  }
  if (preflight.persistenceLimits === null) {
    return makeReport("blocked", {
      source,
      acknowledgedMissingSurfaces,
      batches: preparedBatches,
      blockers: [{ stage: "persistence", code: "persistence-input-invalid" }],
    });
  }
  const persistenceLimits = preflight.persistenceLimits;

  let releaseLock: (() => Promise<void>) | undefined;
  let storage: Storage | undefined;
  let session: Session | undefined;
  let databaseOpened = false;
  let lockAcquired = false;
  let durability: "wal-full" | "not-opened" | "not-verified" = "not-opened";
  let databaseMode: "0600" | "not-opened" | "not-verified" = "not-opened";
  let walShmMode: "private-0600" | "absent" | "not-opened" | "not-verified" = "not-opened";
  const batches: ArchivalRehearsalBatchResult[] = [];
  const blockers: ArchivalRehearsalBlocker[] = [];
  let ledger: ArchivalRehearsalLedgerSummary | null = null;
  let search: ArchivalRehearsalSearchResult | null = null;
  let writesPerformed = false;
  let finalized: Awaited<ReturnType<typeof finalizeDatabasePrivacy>> | null = null;

  try {
    try {
      releaseLock = await processLock(`nanobot:${paths.databasePath}`);
      lockAcquired = true;
    } catch {
      // The raw Chord error names `nanobot:<path>`; never propagate that path.
      return makeReport("blocked", {
        source,
        acknowledgedMissingSurfaces,
        batches: preparedBatches,
        blockers: [{ stage: "ownership", code: "destination-lock-unavailable" }],
      });
    }

    // Re-check the sensitive destination boundary after taking the lock.
    try {
      const destinationNow = await lstat(paths.destinationDir);
      if (destinationNow.isSymbolicLink() || !destinationNow.isDirectory() || (destinationNow.mode & 0o077) !== 0) {
        return makeReport("blocked", {
          source,
          acknowledgedMissingSurfaces,
          destination: {
            label: destinationLabel,
            databaseOpened: false,
            lockAcquired,
            durability,
            databaseMode,
            walShmMode,
          },
          batches: preparedBatches,
          blockers: [{ stage: "destination", code: "destination-changed" }],
        });
      }
    } catch {
      return makeReport("blocked", {
        source,
        acknowledgedMissingSurfaces,
        destination: {
          label: destinationLabel,
          databaseOpened: false,
          lockAcquired,
          durability,
          databaseMode,
          walShmMode,
        },
        batches: preparedBatches,
        blockers: [{ stage: "destination", code: "destination-unreadable" }],
      });
    }
    const postLockPathBlockers = await databasePathBlockers(paths.databasePath);
    if (postLockPathBlockers.length > 0) {
      return makeReport("blocked", {
        source,
        acknowledgedMissingSurfaces,
        destination: {
          label: destinationLabel,
          databaseOpened: false,
          lockAcquired,
          durability,
          databaseMode,
          walShmMode,
        },
        batches: preparedBatches,
        blockers: postLockPathBlockers,
      });
    }

    try {
      // The native opener is path-based and follows symlinks/hardlinks. The
      // post-open securePrivateFile nlink check blocks archival writes, but a
      // same-user swap after the check above can still let Durable migrations
      // write schema pages to an external inode. Documented residual.
      storage = await openFullSyncNodeSqliteStorage(paths.databasePath, context);
      databaseOpened = true;
      durability = "wal-full";
    } catch {
      return makeReport("blocked", {
        source,
        acknowledgedMissingSurfaces,
        destination: {
          label: destinationLabel,
          databaseOpened: false,
          lockAcquired,
          durability: "not-verified",
          databaseMode,
          walShmMode,
        },
        batches: preparedBatches,
        blockers: [{ stage: "destination", code: "destination-storage-open-failed" }],
      });
    }

    const permissions = await ensurePrivateDatabaseFiles(paths.databasePath);
    databaseMode = permissions.databaseMode;
    walShmMode = permissions.walShmMode;
    if (permissions.blockers.length > 0) {
      return makeReport("blocked", {
        source,
        acknowledgedMissingSurfaces,
        destination: {
          label: destinationLabel,
          databaseOpened,
          lockAcquired,
          durability,
          databaseMode,
          walShmMode,
        },
        batches: preparedBatches,
        blockers: permissions.blockers,
        privacyLimitations: privacyLimitationsFor(databaseMode, walShmMode),
      });
    }
    session = createSession(storage);

    // N3 + N1/N2: read the ledger and reject omitted sources, conflicts, and
    // ledger overflow before the first batch commit.
    let initialLedger: ArchivalRehearsalLedgerSummary;
    try {
      initialLedger = ledgerSummary(await readArchivalImportLedger(session, context));
      ledger = initialLedger;
    } catch (error) {
      return makeReport("blocked", {
        source,
        acknowledgedMissingSurfaces,
        destination: {
          label: destinationLabel,
          databaseOpened,
          lockAcquired,
          durability,
          databaseMode,
          walShmMode,
        },
        batches: preparedBatches,
        blockers: [blockerFor(error, "ledger")],
      });
    }
    const ledgerBlockers = preflightLedger(
      initialLedger,
      preflight.preparedSources,
      options.storeNamespace,
      persistenceLimits,
    );
    if (ledgerBlockers.length > 0) {
      return makeReport("blocked", {
        source,
        acknowledgedMissingSurfaces,
        destination: {
          label: destinationLabel,
          databaseOpened,
          lockAcquired,
          durability,
          databaseMode,
          walShmMode,
        },
        batches: preparedBatches,
        ledger,
        blockers: ledgerBlockers,
      });
    }

    for (const [index, batch] of acquisition.batches.entries()) {
      const request = { storeNamespace: options.storeNamespace, sources: batch.sources };
      try {
        const persistence = await persistArchivalImport(session, request, context, {
          ...(options.persistenceLimits === undefined ? {} : { limits: options.persistenceLimits }),
          ...(options.preparation === undefined ? {} : { preparation: options.preparation }),
        });
        writesPerformed = writesPerformed || persistence.newSourcesPersisted > 0;
        batches.push({
          batch: batch.batch,
          sourceCount: batch.sources.length,
          totalBytes: batch.totalBytes,
          preparation: preflight.summaries[index] ?? null,
          persistence: persistenceSummary(persistence),
        });
      } catch (error) {
        blockers.push(blockerFor(error, "persistence"));
        batches.push({
          batch: batch.batch,
          sourceCount: batch.sources.length,
          totalBytes: batch.totalBytes,
          preparation: preflight.summaries[index] ?? null,
          persistence: null,
        });
        // A persistence failure is final for this run; earlier batches remain
        // committed atomically, and a rerun can resolve them idempotently.
        break;
      }
    }

    try {
      ledger = ledgerSummary(await readArchivalImportLedger(session, context));
    } catch (error) {
      blockers.push(blockerFor(error, "ledger"));
    }
    if (blockers.length === 0) {
      if (ledger !== null) {
        blockers.push(...reconcileLedger(ledger, acquisition, options.storeNamespace));
      } else if (batches.some((batch) => (batch.persistence?.newSourcesPersisted ?? 0) > 0)) {
        blockers.push({ stage: "ledger", code: "ledger-missing-after-apply" });
      }
    }

    if (blockers.length === 0 && options.search !== undefined) {
      try {
        search = searchSummary(await searchPersistedArchivalImport(session, options.search.query, context, {
          ...(options.search.limits === undefined ? {} : { limits: options.search.limits }),
        }));
      } catch (error) {
        blockers.push(blockerFor(error, "search"));
      }
    }
  } finally {
    await closeQuietly(session, storage, context);
    // Keep the privacy recheck inside the ownership boundary: never release the
    // lock before the final database/sidecar mode check.
    if (lockAcquired) {
      try {
        finalized = await finalizeDatabasePrivacy(paths.databasePath);
      } catch {
        finalized = null;
      }
    }
    if (releaseLock) await releaseLock().catch(() => undefined);
  }

  if (finalized !== null) {
    databaseMode = finalized.databaseMode;
    walShmMode = finalized.walShmMode;
  }

  const newSources = batches.reduce((total, batch) => total + (batch.persistence?.newSourcesPersisted ?? 0), 0);
  const alreadyPersisted = batches.reduce(
    (total, batch) => total + (batch.persistence?.alreadyPersistedSources ?? 0),
    0,
  );
  const status: ArchivalRehearsalStatus = blockers.length > 0
    ? "blocked"
    : newSources === 0 && alreadyPersisted > 0
      ? "already-applied"
      : "applied";
  return makeReport(status, {
    source,
    acknowledgedMissingSurfaces,
    destination: {
      label: destinationLabel,
      databaseOpened,
      lockAcquired,
      durability,
      databaseMode,
      walShmMode,
    },
    batches,
    ledger,
    search,
    blockers,
    writesPerformed,
    privacyLimitations: finalized?.privacyLimitations ?? [],
    contentExposed: search !== null && search.hits.length > 0,
    queryEchoed: search !== null,
  });
}
