/**
 * Explicit-root Markdown skill discovery for the context extension.
 *
 * The host names a workspace root and, optionally, a builtin skills root. Only
 * `<workspaceRoot>/skills/<name>/SKILL.md` and
 * `<builtinSkillsRoot>/<name>/SKILL.md` are read. No home directory, package
 * path, environment variable, or filesystem-wide search supplies a root.
 *
 * The loader returns the existing `ContextSkillSnapshot` shape plus the
 * selected-skill names the context extension expects. Markdown files remain
 * authoritative; runtime state is not stored here. Host wiring is not part of
 * this module.
 *
 * File handling is Linux-first and fails closed: roots are traversed with
 * `O_DIRECTORY | O_NOFOLLOW`, files are opened with `O_NOFOLLOW`, extra hard
 * links are rejected, reads are size-bounded and must be stable, and selected
 * paths are rechecked before a result is returned. This is not a defence
 * against a privileged/kernel adversary.
 */
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { access, lstat, open, opendir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONTEXT_LIMITS, type ContextSkillSnapshot } from "./index.js";

/** Deterministic provenance prefixes. */
const WORKSPACE_SOURCE_PREFIX = "workspace:skills/";
const BUILTIN_SOURCE_PREFIX = "builtin:skills/";
const PROC_FD = "/proc/self/fd";
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const RESTRICTED_ROOTS = Object.freeze(["/proc", "/sys", "/dev"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const FRONTMATTER_KEY = /^[A-Za-z0-9_.-]+$/;

/** Bounded discovery limits. They are enforced before content reaches the renderer. */
export const SKILLS_CONTEXT_LIMITS = Object.freeze({
  maxSkills: CONTEXT_LIMITS.maxSkillInputs,
  maxSelectedSkills: CONTEXT_LIMITS.maxSkillInputs,
  maxDisabledSkills: CONTEXT_LIMITS.maxSkillInputs,
  maxSkillNameCodeUnits: CONTEXT_LIMITS.maxSkillNameCodeUnits,
  maxSkillFileBytes: 64 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxFrontmatterChars: 16 * 1024,
  maxMetadataValueChars: 16 * 1024,
  maxRootChars: 4_096,
});

export interface SkillsContextRequest {
  /** Explicit absolute workspace root. Workspace skills are `<root>/skills`. */
  readonly workspaceRoot: string;
  /**
   * Explicit absolute builtin skills root. Omitted means no builtin skills.
   * The root must exist and be a directory when supplied.
   */
  readonly builtinSkillsRoot?: string;
  /** Configured-disabled skill names. Disabled entries stay discovered but are never enabled. */
  readonly disabledSkills?: readonly string[];
  /** Explicit names whose bodies should be included by the context extension. */
  readonly selectedSkills?: readonly string[];
  /**
   * Environment for `requires.env` and `PATH` lookups. Defaults to
   * `process.env`, matching Python's `shutil.which`/`os.environ` checks.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface SkillRequirements {
  readonly bins: readonly string[];
  readonly env: readonly string[];
  readonly missingBins: readonly string[];
  readonly missingEnv: readonly string[];
}

export interface DiscoveredSkill {
  readonly name: string;
  /** Stable provenance label; never an absolute host path. */
  readonly source: string;
  /** Workspace-relative `skills/<name>/SKILL.md`; absent for builtin skills. */
  readonly path?: string;
  readonly content: string;
  /** Parsed top-level SKILL.md frontmatter subset. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly description: string;
  readonly always: boolean;
  readonly disabled: boolean;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly requirements: SkillRequirements;
}

export interface SkillsContextResult {
  /** Ready to spread into a `ConversationContextSnapshot`. */
  readonly skills: readonly ContextSkillSnapshot[];
  /** Requested names that are discovered and enabled, in request order. */
  readonly selectedSkills: readonly string[];
  readonly discovered: readonly DiscoveredSkill[];
  /** Python-style progressive summary; unavailable skills are marked, disabled ones omitted. */
  readonly summary: string;
}

export type SkillFileFailureKind =
  | "missing"
  | "symlink"
  | "hardlink"
  | "not-regular"
  | "not-directory"
  | "unreadable"
  | "changed"
  | "encoding"
  | "io";

export class SkillsContextInputError extends TypeError {
  readonly code = "skills_context_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SkillsContextInputError";
  }
}

export class SkillsContextBoundsError extends RangeError {
  readonly code = "skills_context_bound_exceeded";
  readonly bound: string;

  constructor(bound: string) {
    super(`Skills context exceeds the ${bound} bound`);
    this.name = "SkillsContextBoundsError";
    this.bound = bound;
  }
}

export class SkillsContextFileError extends Error {
  readonly code = "skills_context_file_error";
  readonly kind: SkillFileFailureKind;
  /** Stable workspace/builtin-relative label only; never an absolute path or file content. */
  readonly source: string;

  constructor(kind: SkillFileFailureKind, source: string) {
    super(`Skills context file ${source}: ${kind}`);
    this.name = "SkillsContextFileError";
    this.kind = kind;
    this.source = source;
  }
}

interface SkillRecord {
  readonly name: string;
  readonly source: string;
  readonly path?: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly rootPath: string;
  readonly segments: readonly string[];
  readonly directoryStat: BigIntStats;
  readonly fileStat: BigIntStats;
}

interface LoadState {
  bytes: number;
  readonly records: SkillRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function ownDataField(value: unknown, key: string, label: string): { found: boolean; value: unknown } {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new SkillsContextInputError(`${label} must be an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return { found: key in value, value: undefined };
  }
  if (!Object.hasOwn(descriptor, "value")) {
    throw new SkillsContextInputError(`${label}.${key} must be an own data property`);
  }
  return { found: true, value: descriptor.value };
}

function ownArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new SkillsContextInputError(`${label} must be an array`);
  return value;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function validatedRoot(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > SKILLS_CONTEXT_LIMITS.maxRootChars ||
      !isAbsolute(value) || CONTROL_CHARACTERS.test(value)) {
    throw new SkillsContextInputError(`${label} must be an explicit absolute path`);
  }
  const root = resolve(value);
  if (root === sep) throw new SkillsContextInputError(`${label} must not be the filesystem root`);
  for (const restricted of RESTRICTED_ROOTS) {
    if (isWithin(restricted, root)) {
      throw new SkillsContextInputError(`${label} must not be inside a restricted system directory`);
    }
  }
  return root;
}

function validatedNames(value: unknown, label: string, max: number): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const entries = ownArray(value, label);
  if (entries.length > max) throw new SkillsContextBoundsError(label);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0 ||
        entry.length > SKILLS_CONTEXT_LIMITS.maxSkillNameCodeUnits || CONTROL_CHARACTERS.test(entry)) {
      throw new SkillsContextInputError(`${label} entries must be bounded skill names`);
    }
    seen.add(entry);
  }
  return Object.freeze([...seen]);
}

function validatedEnvironment(value: unknown): Readonly<Record<string, string | undefined>> {
  if (value === undefined) return Object.freeze({ ...process.env });
  if (!isRecord(value)) throw new SkillsContextInputError("environment must be an object");
  const environment: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || entry === undefined) environment[key] = entry;
  }
  return Object.freeze(environment);
}

function procFdPath(fd: number): string {
  return `${PROC_FD}/${fd}`;
}

function failureKind(code: string | undefined): SkillFileFailureKind {
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

function fileFailure(error: unknown, source: string): SkillsContextFileError {
  if (error instanceof SkillsContextFileError) return error;
  return new SkillsContextFileError(failureKind((error as NodeJS.ErrnoException | null)?.code), source);
}

function rootFailure(error: unknown, label: string): SkillsContextInputError {
  if (error instanceof SkillsContextInputError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return new SkillsContextInputError(`${label} must exist`);
  if (code === "ELOOP") return new SkillsContextInputError(`${label} must not contain symlink components`);
  if (code === "EACCES" || code === "EPERM") return new SkillsContextInputError(`${label} is not readable`);
  if (code === "ENOTDIR") return new SkillsContextInputError(`${label} must be a directory`);
  return new SkillsContextInputError(`${label} cannot be opened safely`);
}

async function openAbsoluteDirectoryNoFollow(path: string, label: string): Promise<FileHandle> {
  const components = path.slice(1).split(sep).filter(Boolean);
  if (components.length === 0) {
    throw new SkillsContextInputError(`${label} must be a directory below the filesystem root`);
  }
  let current: FileHandle;
  try {
    current = await open(sep, DIRECTORY_FLAGS);
  } catch (error) {
    throw rootFailure(error, label);
  }
  try {
    for (const component of components) {
      let next: FileHandle;
      try {
        next = await open(join(procFdPath(current.fd), component), DIRECTORY_FLAGS);
      } catch (error) {
        throw rootFailure(error, label);
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
    // O_NOFOLLOW + O_DIRECTORY can report ENOTDIR when the final component is a
    // symlink. Classify it without following the link.
    if (kind === "not-directory") {
      try {
        const info = await lstat(path, { bigint: true });
        if (info.isSymbolicLink()) throw new SkillsContextFileError("symlink", source);
      } catch (classificationError) {
        if (classificationError instanceof SkillsContextFileError) throw classificationError;
      }
    }
    throw new SkillsContextFileError(kind, source);
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

async function statHandle(handle: FileHandle, source: string): Promise<BigIntStats> {
  try {
    return await handle.stat({ bigint: true });
  } catch (error) {
    throw fileFailure(error, source);
  }
}

function decodeUtf8(buffer: Buffer, source: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SkillsContextFileError("encoding", source);
  }
}

async function readPinnedFile(
  parent: FileHandle,
  name: string,
  source: string,
  state: LoadState,
): Promise<{ content: string; stat: BigIntStats }> {
  const handle = await openPinned(parent, name, FILE_FLAGS, source);
  try {
    const before = await statHandle(handle, source);
    if (!before.isFile()) throw new SkillsContextFileError("not-regular", source);
    if (before.nlink !== 1n) throw new SkillsContextFileError("hardlink", source);
    if (before.size > BigInt(SKILLS_CONTEXT_LIMITS.maxSkillFileBytes)) {
      throw new SkillsContextBoundsError("maxSkillFileBytes");
    }
    const size = Number(before.size);
    if (state.bytes + size > SKILLS_CONTEXT_LIMITS.maxTotalBytes) {
      throw new SkillsContextBoundsError("maxTotalBytes");
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
      if (bytesRead === 0) throw new SkillsContextFileError("changed", source);
      offset += bytesRead;
    }

    const after = await statHandle(handle, source);
    if (!sameFile(before, after)) throw new SkillsContextFileError("changed", source);
    const pathInfo = await lstat(join(procFdPath(parent.fd), name), { bigint: true }).catch(() => undefined);
    if (pathInfo === undefined || !sameFile(before, pathInfo)) {
      throw new SkillsContextFileError("changed", source);
    }

    state.bytes += size;
    return { content: decodeUtf8(buffer, source), stat: before };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function clipCodePoints(value: string, limit: number): string {
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count >= limit) return value.slice(0, end);
    end += character.length;
    count++;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  if (value.length > SKILLS_CONTEXT_LIMITS.maxMetadataValueChars) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? deepFreeze(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function parseScalar(value: string): unknown {
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  return value;
}

/**
 * Parse only the flat frontmatter subset used by Nanobot skills. `metadata` is
 * a JSON object (as in the shipped skills); YAML block mappings, anchors,
 * tags, and multi-line scalars are deliberately unsupported.
 */
function parseMetadataField(raw: string): Record<string, unknown> | undefined {
  const value = parseScalar(raw);
  if (typeof value === "string") return parseJsonObject(value);
  if (isRecord(value)) return deepFreeze(value);
  return undefined;
}

function parseFrontmatter(content: string): Readonly<Record<string, unknown>> | undefined {
  if (!content.startsWith("---")) return undefined;
  const match = FRONTMATTER.exec(content.slice(0, SKILLS_CONTEXT_LIMITS.maxFrontmatterChars));
  if (!match) return undefined;
  const parsed: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#") || /^[ \t]/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!FRONTMATTER_KEY.test(key)) continue;
    const raw = line.slice(colon + 1).trim();
    if (key === "metadata") {
      const metadata = parseMetadataField(raw);
      if (metadata !== undefined) parsed[key] = metadata;
    } else if (raw.length > 0) {
      parsed[key] = parseScalar(raw);
    }
  }
  return Object.keys(parsed).length > 0 ? Object.freeze(parsed) : undefined;
}

function ownValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function parseMetadataObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length > SKILLS_CONTEXT_LIMITS.maxMetadataValueChars) {
    return undefined;
  }
  return parseJsonObject(value);
}

function nanobotPayload(metadata: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const parsed = parseMetadataObject(metadata?.metadata);
  const payload = ownValue(parsed, "nanobot") ?? ownValue(parsed, "openclaw");
  return isRecord(payload) ? payload : {};
}

function skillIsAlways(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  return metadata?.always === true || nanobotPayload(metadata).always === true;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string =>
    typeof entry === "string" && entry.length > 0 && entry.length <= 256 && !CONTROL_CHARACTERS.test(entry),
  );
}

async function commandAvailable(command: string, environment: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const candidates = command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : (environment.PATH ?? environment.Path ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function checkRequirements(
  metadata: Readonly<Record<string, unknown>> | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SkillRequirements> {
  const requires = ownValue(nanobotPayload(metadata), "requires");
  const bins = stringList(ownValue(requires, "bins"));
  const env = stringList(ownValue(requires, "env"));
  const missingBins: string[] = [];
  for (const command of bins) {
    if (!(await commandAvailable(command, environment))) missingBins.push(command);
  }
  const missingEnv = env.filter((name) => !environment[name]);
  return Object.freeze({
    bins: Object.freeze(bins),
    env: Object.freeze(env),
    missingBins: Object.freeze(missingBins),
    missingEnv: Object.freeze(missingEnv),
  });
}

async function scanSkillDirectories(
  directory: FileHandle,
  rootPath: string,
  prefixSegments: readonly string[],
  sourcePrefix: string,
  workspaceRelative: boolean,
  state: LoadState,
): Promise<void> {
  const names: string[] = [];
  for await (const entry of await opendir(procFdPath(directory.fd))) {
    if (entry.name.length > SKILLS_CONTEXT_LIMITS.maxSkillNameCodeUnits ||
        !SAFE_SKILL_NAME.test(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new SkillsContextFileError("symlink", `${sourcePrefix}${entry.name}/SKILL.md`);
    }
    if (!entry.isDirectory()) continue;
    names.push(entry.name);
    if (names.length > SKILLS_CONTEXT_LIMITS.maxSkills) {
      throw new SkillsContextBoundsError("maxSkills");
    }
  }
  names.sort();

  for (const name of names) {
    if (state.records.length >= SKILLS_CONTEXT_LIMITS.maxSkills) {
      throw new SkillsContextBoundsError("maxSkills");
    }
    const source = `${sourcePrefix}${name}/SKILL.md`;
    let skillDirectory: FileHandle;
    try {
      skillDirectory = await openPinned(directory, name, DIRECTORY_FLAGS, source);
    } catch (error) {
      throw fileFailure(error, source);
    }
    try {
      const directoryStat = await statHandle(skillDirectory, source);
      let file;
      try {
        file = await readPinnedFile(skillDirectory, "SKILL.md", source, state);
      } catch (error) {
        if (error instanceof SkillsContextFileError && error.kind === "missing") continue;
        throw error;
      }
      const metadata = parseFrontmatter(file.content);
      const record: SkillRecord = {
        name,
        source,
        ...(workspaceRelative ? { path: `skills/${name}/SKILL.md` } : {}),
        content: file.content,
        ...(metadata !== undefined ? { metadata } : {}),
        rootPath,
        segments: Object.freeze([...prefixSegments, name]),
        directoryStat,
        fileStat: file.stat,
      };
      state.records.push(record);
    } finally {
      await skillDirectory.close().catch(() => undefined);
    }
  }
}

async function scanWorkspaceSkills(
  workspaceRoot: string,
  state: LoadState,
): Promise<void> {
  const root = await openAbsoluteDirectoryNoFollow(workspaceRoot, "workspaceRoot");
  try {
    let skills: FileHandle;
    try {
      skills = await openPinned(root, "skills", DIRECTORY_FLAGS, "skills");
    } catch (error) {
      if (error instanceof SkillsContextFileError && error.kind === "missing") return;
      throw error;
    }
    try {
      await scanSkillDirectories(skills, workspaceRoot, ["skills"], WORKSPACE_SOURCE_PREFIX, true, state);
    } finally {
      await skills.close().catch(() => undefined);
    }
  } finally {
    await root.close().catch(() => undefined);
  }
}

async function scanBuiltinSkills(
  builtinRoot: string,
  state: LoadState,
): Promise<void> {
  const root = await openAbsoluteDirectoryNoFollow(builtinRoot, "builtinSkillsRoot");
  try {
    await scanSkillDirectories(root, builtinRoot, [], BUILTIN_SOURCE_PREFIX, false, state);
  } finally {
    await root.close().catch(() => undefined);
  }
}

/**
 * Re-open each accepted skill through its declared root and compare the
 * directory and file identities captured during the read. Detects renames or
 * replacements that would otherwise leave provenance pointing at new content.
 */
async function verifyRecords(state: LoadState): Promise<void> {
  for (const record of state.records) {
    let root: FileHandle | null = null;
    let parent: FileHandle | null = null;
    const opened: FileHandle[] = [];
    try {
      root = await openAbsoluteDirectoryNoFollow(record.rootPath, "skill root");
      parent = root;
      for (const segment of record.segments) {
        const next = await openPinned(parent, segment, DIRECTORY_FLAGS, record.source);
        opened.push(next);
        parent = next;
      }
      const directoryNow = await statHandle(parent, record.source);
      if (!sameDirectory(directoryNow, record.directoryStat)) {
        throw new SkillsContextFileError("changed", record.source);
      }
      const fileNow = await lstat(join(procFdPath(parent.fd), "SKILL.md"), { bigint: true });
      if (!sameFile(fileNow, record.fileStat)) {
        throw new SkillsContextFileError("changed", record.source);
      }
    } catch (error) {
      throw fileFailure(
        error instanceof SkillsContextFileError ? error : new SkillsContextFileError("changed", record.source),
        record.source,
      );
    } finally {
      for (const handle of opened.reverse()) await handle.close().catch(() => undefined);
      if (root !== null) await root.close().catch(() => undefined);
    }
  }
}

function formatSummary(discovered: readonly DiscoveredSkill[]): string {
  return discovered
    .filter((skill) => !skill.disabled)
    .map((skill) => {
      const missing = [
        ...skill.requirements.missingBins.map((name) => `CLI: ${name}`),
        ...skill.requirements.missingEnv.map((name) => `ENV: ${name}`),
      ];
      const suffix = skill.available
        ? ""
        : ` (unavailable${missing.length > 0 ? `: ${missing.join(", ")}` : ""})`;
      return `- **${skill.name}** — ${skill.description}${suffix}  \`${skill.path ?? skill.source}\``;
    })
    .join("\n");
}

/**
 * Discover skills from explicit roots and return values compatible with
 * `ConversationContextSnapshot`.
 *
 * Workspace skills take precedence over builtin skills with the same directory
 * name. Disabled and requirement-unavailable skills stay discovered with
 * `enabled: false`; the context renderer therefore never includes their bodies.
 * Selected names are filtered to discovered, enabled skills. A missing
 * `<workspaceRoot>/skills` directory means no workspace skills; a supplied
 * `builtinSkillsRoot` must exist.
 */
export async function loadSkillsContext(
  request: SkillsContextRequest,
): Promise<SkillsContextResult> {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new SkillsContextInputError("Skills discovery requires O_NOFOLLOW and O_DIRECTORY support");
  }
  if (!isRecord(request)) {
    throw new SkillsContextInputError("Skills context request must be an object");
  }
  const workspaceRoot = validatedRoot(
    ownDataField(request, "workspaceRoot", "Skills context request").value,
    "workspaceRoot",
  );
  const builtinField = ownDataField(request, "builtinSkillsRoot", "Skills context request");
  const builtinRoot = builtinField.found && builtinField.value !== undefined
    ? validatedRoot(builtinField.value, "builtinSkillsRoot")
    : undefined;
  const disabled = new Set(validatedNames(
    ownDataField(request, "disabledSkills", "Skills context request").value,
    "disabledSkills",
    SKILLS_CONTEXT_LIMITS.maxDisabledSkills,
  ));
  const selected = validatedNames(
    ownDataField(request, "selectedSkills", "Skills context request").value,
    "selectedSkills",
    SKILLS_CONTEXT_LIMITS.maxSelectedSkills,
  );
  const environment = validatedEnvironment(
    ownDataField(request, "environment", "Skills context request").value,
  );

  const state: LoadState = { bytes: 0, records: [] };
  await scanWorkspaceSkills(workspaceRoot, state);
  if (builtinRoot !== undefined) {
    const workspaceNames = new Set(state.records.map((record) => record.name));
    const builtinState: LoadState = { bytes: state.bytes, records: [] };
    await scanBuiltinSkills(builtinRoot, builtinState);
    state.bytes = builtinState.bytes;
    for (const record of builtinState.records) {
      if (workspaceNames.has(record.name)) continue;
      if (state.records.length >= SKILLS_CONTEXT_LIMITS.maxSkills) {
        throw new SkillsContextBoundsError("maxSkills");
      }
      state.records.push(record);
    }
  }
  await verifyRecords(state);

  const discovered: DiscoveredSkill[] = [];
  for (const record of state.records) {
    const requirements = await checkRequirements(record.metadata, environment);
    const isDisabled = disabled.has(record.name);
    const available = requirements.missingBins.length === 0 && requirements.missingEnv.length === 0;
    const description = typeof record.metadata?.description === "string" && record.metadata.description.length > 0
      ? clipCodePoints(record.metadata.description, CONTEXT_LIMITS.descriptionChars)
      : record.name;
    const skill: DiscoveredSkill = Object.freeze({
      name: record.name,
      source: record.source,
      ...(record.path !== undefined ? { path: record.path } : {}),
      content: record.content,
      ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
      description,
      always: skillIsAlways(record.metadata),
      disabled: isDisabled,
      available,
      enabled: available && !isDisabled,
      requirements,
    });
    discovered.push(skill);
  }

  const skills: ContextSkillSnapshot[] = discovered.map((skill) => Object.freeze({
    name: skill.name,
    source: skill.source,
    content: skill.content,
    enabled: skill.enabled,
    ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
  }));
  const enabledNames = new Set(discovered.filter((skill) => skill.enabled).map((skill) => skill.name));
  const selectedSkills = Object.freeze(selected.filter((name) => enabledNames.has(name)));

  return Object.freeze({
    skills: Object.freeze(skills),
    selectedSkills,
    discovered: Object.freeze(discovered),
    summary: formatSummary(discovered),
  });
}
