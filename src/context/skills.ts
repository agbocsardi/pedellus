/**
 * Explicit-root Markdown skill discovery for the context extension.
 *
 * The host names a workspace root and, optionally, a builtin skills root. Only
 * `<workspaceRoot>/skills/<name>/SKILL.md` and
 * `<builtinSkillsRoot>/<name>/SKILL.md` are read. No home directory, package
 * path, environment variable, or filesystem-wide search supplies a root.
 *
 * The loader returns the existing `ContextSkillSnapshot` shape plus a
 * name/description/locator summary. Markdown files remain authoritative; bodies
 * are served on demand by the gateway's read-only skill tool and are never
 * rendered into the system prompt. Runtime state is not stored here.
 *
 * Metadata is parsed as a bounded subset of YAML. When a requirement-bearing
 * form cannot be read (an indented `metadata:` mapping, malformed metadata, or
 * an unusable `requires.bins`/`requires.env` list), the skill is reported as
 * unavailable with a stable reason instead of silently losing its gate. Skills
 * whose directory name is unsafe or whose files are symlinks are reported in
 * `skipped` rather than dropped without trace.
 *
 * Reads are pinned like the workspace loader (see `fs-safe.ts`): beneath each
 * explicitly named root, skill directories and `SKILL.md` files are opened
 * through `/proc/self/fd` without following symlinks, hard-link aliases are
 * refused (reported in `skipped`), and a file that changes during its read is
 * a failure. The root path itself may contain symlinks because the host named
 * it; `<workspaceRoot>/skills` may not be a symlink. No content-size budget
 * applies and UTF-8 failures are rejected. There is no whole-tree recheck after
 * all reads. Linux-only, like the rest of the workspace loaders.
 */
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { CONTEXT_LIMITS, type ContextSkillSnapshot } from "./index.js";
import {
  CONTROL_CHARACTERS,
  DIRECTORY_FLAGS,
  FsSafeError,
  SAFE_ASCII_NAME as SAFE_SKILL_NAME,
  clipCodePoints,
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
  validatedRoot as validatedRootWith,
} from "./fs-safe.js";

/** Deterministic provenance prefixes. */
const WORKSPACE_SOURCE_PREFIX = "workspace:skills/";
const BUILTIN_SOURCE_PREFIX = "builtin:skills/";
const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const FRONTMATTER_KEY = /^[A-Za-z0-9_.-]+$/;

/**
 * Per-name safety limits. There is deliberately no inventory count cap, no
 * skill-file byte cap, no frontmatter or metadata value cap, and no aggregate
 * byte cap: every discovered `SKILL.md` is reported with its full description
 * and body, as in the Python reference. Prompt size is not clipped by a size
 * budget either; the renderer composes the summary in full.
 */
export const SKILLS_CONTEXT_LIMITS = Object.freeze({
  maxSkillNameCodeUnits: CONTEXT_LIMITS.maxSkillNameCodeUnits,
  maxRequirementEntryChars: 256,
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
  /**
   * Environment for `requires.env` and `PATH` lookups. Defaults to
   * `process.env`, matching Python's `shutil.which`/`os.environ` checks.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Metadata parse outcome for one skill record. */
export type SkillMetadataStatus = "absent" | "parsed" | "unsupported";

/** Stable reason codes for metadata that this bounded parser cannot represent. */
export type SkillMetadataReason =
  | "frontmatter-unterminated"
  | "metadata-block-form"
  | "metadata-unparseable"
  | "metadata-not-object";

export interface SkillMetadataReport {
  readonly status: SkillMetadataStatus;
  readonly reason?: SkillMetadataReason;
}

/** Stable reason codes for requirement gates that could not be evaluated. */
export type SkillRequirementReason =
  | "metadata-unsupported"
  | "metadata-payload-unparseable"
  | "nanobot-metadata-not-object"
  | "requires-not-object"
  | "requires-bins-not-list"
  | "requires-env-not-list"
  | "requires-bins-entry-unsupported"
  | "requires-env-entry-unsupported";

export interface SkillRequirements {
  /** Declared entries that were readable; an unusable list is reported in `unsupported`. */
  readonly bins: readonly string[];
  readonly env: readonly string[];
  readonly missingBins: readonly string[];
  readonly missingEnv: readonly string[];
  /**
   * `none` when no gate is declared, `evaluated` when every declared gate was
   * usable, and `unsupported` when a gate could not be read. Only `evaluated`
   * and `none` can leave a skill available.
   */
  readonly status: "none" | "evaluated" | "unsupported";
  readonly unsupported: readonly SkillRequirementReason[];
}

/** A directory entry that looks like a skill but is refused before its body is read. */
export type SkippedSkillReason =
  | "unsafe-name"
  | "name-too-long"
  | "symlinked-skill"
  | "symlinked-file"
  | "hardlinked-file";

export interface SkippedSkill {
  /** Bounded, control-character-free directory name only; never an absolute path. */
  readonly name: string;
  readonly reason: SkippedSkillReason;
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
  /** Whether the frontmatter metadata could be represented at all. */
  readonly metadataStatus: SkillMetadataReport;
  readonly description: string;
  /** False when frontmatter sets `disable-model-invocation: true`; such a skill is never shown or loaded. */
  readonly modelInvocable: boolean;
  readonly disabled: boolean;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly requirements: SkillRequirements;
}

export interface SkillsContextResult {
  /** Ready to spread into a `ConversationContextSnapshot`; bodies are served on demand, never rendered. */
  readonly skills: readonly ContextSkillSnapshot[];
  readonly discovered: readonly DiscoveredSkill[];
  /** Directory entries refused before reading; empty when nothing was skipped. */
  readonly skipped: readonly SkippedSkill[];
  /** Python-style progressive summary; unavailable skills are marked, disabled ones omitted. */
  readonly summary: string;
}

export type SkillFileFailureKind = "unreadable" | "encoding" | "io";

export class SkillsContextInputError extends TypeError {
  readonly code = "skills_context_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SkillsContextInputError";
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
  readonly metadataStatus: SkillMetadataReport;
}

interface LoadState {
  readonly records: SkillRecord[];
  readonly skipped: SkippedSkill[];
}

const inputError = (message: string): Error => new SkillsContextInputError(message);
const pinnedError = (kind: FsSafeError["kind"], source: string): Error => new FsSafeError(kind, source);

/** Own data properties only: an inherited or accessor-backed field is refused, never read. */
function ownDataField(value: unknown, key: string, label: string): { found: boolean; value: unknown } {
  return ownDataFieldWith(value, key, label, inputError);
}

function ownArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new SkillsContextInputError(`${label} must be an array`);
  return value;
}

function validatedRoot(value: unknown, label: string): string {
  return validatedRootWith(value, label, { maxChars: SKILLS_CONTEXT_LIMITS.maxRootChars }, inputError);
}

function validatedNames(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const entries = ownArray(value, label);
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

/** Validate an explicit disabled skill-name list without touching the filesystem. */
export function validateSkillNames(value: unknown, label: string): readonly string[] {
  return validatedNames(value, label);
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

/** Map a pinned-read failure onto this module's stable file-error kinds. */
function skillFileError(error: unknown, source: string): SkillsContextFileError {
  if (error instanceof SkillsContextFileError) return error;
  const kind = error instanceof FsSafeError ? error.kind : undefined;
  if (kind === "unreadable" || kind === "encoding") return new SkillsContextFileError(kind, source);
  return new SkillsContextFileError("io", source);
}

/** Open a host-named root; symlinks in its own path are followed, nothing beneath it is. */
async function openDirectory(path: string, label: string): Promise<FileHandle> {
  if (!pinnedFsSupported()) {
    throw new SkillsContextInputError("Skills context loading requires Linux /proc/self/fd and O_NOFOLLOW support");
  }
  return openRootDirectory(path, (error) => {
    const code = errorCode(error);
    if (code === "ENOENT") return new SkillsContextInputError(`${label} must exist`);
    if (code === "EACCES" || code === "EPERM") return new SkillsContextInputError(`${label} is not readable`);
    if (code === "ENOTDIR") return new SkillsContextInputError(`${label} must be a directory`);
    return new SkillsContextInputError(`${label} cannot be read`);
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
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

interface FrontmatterParse {
  readonly values?: Readonly<Record<string, unknown>>;
  readonly status: SkillMetadataStatus;
  readonly reason?: SkillMetadataReason;
}

interface MetadataValueParse {
  readonly value?: Readonly<Record<string, unknown>>;
  readonly reason?: SkillMetadataReason;
}

function parseMetadataValue(raw: string): MetadataValueParse {
  const scalar = parseScalar(raw);
  // YAML null carries no gates; any other non-object scalar is an unrepresentable form.
  if (scalar === null) return { value: Object.freeze({}) };
  if (typeof scalar !== "string") return { reason: "metadata-not-object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(scalar) as unknown;
  } catch {
    return { reason: "metadata-unparseable" };
  }
  return isRecord(parsed) ? { value: deepFreeze(parsed) } : { reason: "metadata-not-object" };
}

/** A block mapping under `metadata:` may carry requirement gates this parser cannot read. */
function hasIndentedContinuation(lines: readonly string[], start: number): boolean {
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    return /^[ \t]/.test(line);
  }
  return false;
}

/**
 * Parse only the flat frontmatter subset used by Nanobot skills. `metadata` is a
 * JSON object (as in the shipped skills); YAML block mappings, anchors, tags,
 * and multi-line scalars are deliberately unsupported. An unrepresentable
 * `metadata` value is reported so a requirement gate cannot silently vanish.
 */
function parseFrontmatter(content: string): FrontmatterParse {
  if (!content.startsWith("---")) return { status: "absent" };
  const match = FRONTMATTER.exec(content);
  if (!match) return { status: "unsupported", reason: "frontmatter-unterminated" };
  const parsed: Record<string, unknown> = {};
  const lines = match[1]!.split(/\r?\n/);
  let reason: SkillMetadataReason | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim() || /^[ \t]/.test(line)) continue;
    const field = frontmatterField(line);
    if (field === undefined || !FRONTMATTER_KEY.test(field.key)) continue;
    const { key, value: raw } = field;
    if (key !== "metadata") {
      if (raw.length > 0) parsed[key] = parseScalar(raw);
      continue;
    }
    if (raw.length === 0) {
      if (hasIndentedContinuation(lines, index + 1)) reason = "metadata-block-form";
      else parsed.metadata = Object.freeze({});
      continue;
    }
    const metadata = parseMetadataValue(raw);
    if (metadata.reason !== undefined) reason = metadata.reason;
    else parsed.metadata = metadata.value!;
  }
  if (reason !== undefined) return { status: "unsupported", reason };
  return {
    ...(Object.keys(parsed).length > 0 ? { values: Object.freeze(parsed) } : {}),
    status: parsed.metadata === undefined ? "absent" : "parsed",
  };
}

function ownValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function parseMetadataObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  return parseJsonObject(value);
}

function hasOwnDataField(value: unknown, key: string): boolean {
  return isRecord(value) && Object.hasOwn(value, key);
}

interface NanobotPayload {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly reason?: SkillRequirementReason;
}

function nanobotPayload(metadata: Readonly<Record<string, unknown>> | undefined): NanobotPayload {
  const nested = metadata?.metadata;
  const parsed = parseMetadataObject(nested);
  if (nested !== undefined && parsed === undefined) {
    return { payload: Object.freeze({}), reason: "metadata-payload-unparseable" };
  }
  // Python's loader prefers `nanobot` over `openclaw`; a non-object payload cannot scope gates.
  const namespace = hasOwnDataField(parsed, "nanobot")
    ? ownValue(parsed, "nanobot")
    : ownValue(parsed, "openclaw");
  if (namespace === undefined) return { payload: Object.freeze({}) };
  if (!isRecord(namespace)) return { payload: Object.freeze({}), reason: "nanobot-metadata-not-object" };
  return { payload: namespace };
}

/** Pi/Agent Skills `disable-model-invocation`: hide from the model entirely (no command path exists here). */
function disableModelInvocation(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  return metadata?.["disable-model-invocation"] === true;
}

interface RequirementNames {
  readonly names: readonly string[];
  /** True when an entry could not be represented, so the declared gate list is incomplete. */
  readonly invalid: boolean;
}

function requirementNames(value: readonly unknown[]): RequirementNames {
  const names: string[] = [];
  let invalid = false;
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0 &&
        entry.length <= SKILLS_CONTEXT_LIMITS.maxRequirementEntryChars &&
        !CONTROL_CHARACTERS.test(entry)) {
      names.push(entry);
    } else {
      invalid = true;
    }
  }
  return { names: Object.freeze(names), invalid };
}

function requiredNames(
  requires: Record<string, unknown>,
  field: "bins" | "env",
): { names: readonly string[]; reason?: SkillRequirementReason } {
  const value = ownValue(requires, field);
  if (value === undefined) return { names: Object.freeze([]) };
  if (!Array.isArray(value)) {
    return {
      names: Object.freeze([]),
      reason: field === "bins" ? "requires-bins-not-list" : "requires-env-not-list",
    };
  }
  const parsed = requirementNames(value);
  return parsed.invalid
    ? {
        names: parsed.names,
        reason: field === "bins" ? "requires-bins-entry-unsupported" : "requires-env-entry-unsupported",
      }
    : { names: parsed.names };
}

async function commandAvailable(
  command: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const candidates = command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : (environment.PATH ?? environment.Path ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      // Python's `shutil.which` rejects directories: an execute bit on a directory
      // is not evidence of a program, so `access(X_OK)` alone would be a false gate.
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Missing, unreadable, not a regular file, or not executable: try the next PATH entry.
    }
  }
  return false;
}

async function checkRequirements(
  metadata: Readonly<Record<string, unknown>> | undefined,
  metadataStatus: SkillMetadataReport,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SkillRequirements> {
  const unsupported: SkillRequirementReason[] = [];
  if (metadataStatus.status === "unsupported") unsupported.push("metadata-unsupported");
  const payload = nanobotPayload(metadata);
  if (payload.reason !== undefined) unsupported.push(payload.reason);

  let bins: readonly string[] = Object.freeze([]);
  let env: readonly string[] = Object.freeze([]);
  const requires = ownValue(payload.payload, "requires");
  if (requires !== undefined) {
    if (!isRecord(requires)) {
      unsupported.push("requires-not-object");
    } else {
      const parsedBins = requiredNames(requires, "bins");
      if (parsedBins.reason !== undefined) unsupported.push(parsedBins.reason);
      const parsedEnv = requiredNames(requires, "env");
      if (parsedEnv.reason !== undefined) unsupported.push(parsedEnv.reason);
      bins = parsedBins.names;
      env = parsedEnv.names;
    }
  }

  const missingBins: string[] = [];
  for (const command of bins) {
    if (!(await commandAvailable(command, environment))) missingBins.push(command);
  }
  const missingEnv = env.filter((name) => !environment[name]);
  return Object.freeze({
    bins,
    env,
    missingBins: Object.freeze(missingBins),
    missingEnv: Object.freeze(missingEnv),
    status: unsupported.length > 0
      ? "unsupported" as const
      : bins.length > 0 || env.length > 0 ? "evaluated" as const : "none" as const,
    unsupported: Object.freeze(unsupported),
  });
}

function recordSkipped(state: LoadState, name: string, reason: SkippedSkillReason): void {
  // Control characters cannot be represented in a host-facing label; such a name is ignored.
  if (CONTROL_CHARACTERS.test(name)) return;
  state.skipped.push(Object.freeze({
    name: clipCodePoints(name, SKILLS_CONTEXT_LIMITS.maxSkillNameCodeUnits),
    reason,
  }));
}

/**
 * Scan one pinned skills directory. `skills/` beneath the workspace root is
 * opened without following a symlink; a builtin root is the host-named root.
 */
async function scanSkillRoot(
  root: FileHandle,
  sourcePrefix: string,
  workspaceRelative: boolean,
  state: LoadState,
  skipNames: ReadonlySet<string> = new Set(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(procFdPath(root.fd), { withFileTypes: true });
  } catch {
    throw new SkillsContextFileError("unreadable", sourcePrefix);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name.length > SKILLS_CONTEXT_LIMITS.maxSkillNameCodeUnits) {
      recordSkipped(state, entry.name, "name-too-long");
      continue;
    }
    if (!SAFE_SKILL_NAME.test(entry.name)) {
      recordSkipped(state, entry.name, "unsafe-name");
      continue;
    }
    // A workspace skill shadows a builtin with the same name; that is precedence, not a skip.
    if (skipNames.has(entry.name)) continue;
    // A symlinked or non-directory candidate is refused rather than followed.
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) recordSkipped(state, entry.name, "symlinked-skill");
      continue;
    }

    const source = `${sourcePrefix}${entry.name}/SKILL.md`;
    let directory: FileHandle;
    try {
      directory = await openPinned(root, entry.name, DIRECTORY_FLAGS, source, pinnedError);
    } catch (error) {
      const kind = (error as FsSafeError).kind;
      if (kind === "missing") continue;
      if (kind === "symlink") {
        recordSkipped(state, entry.name, "symlinked-skill");
        continue;
      }
      throw skillFileError(error, source);
    }
    let buffer: Buffer;
    try {
      ({ buffer } = await readPinnedFile(directory, "SKILL.md", source, pinnedError));
    } catch (error) {
      const kind = (error as FsSafeError).kind;
      if (kind === "missing" || kind === "not-regular") continue;
      if (kind === "symlink") {
        recordSkipped(state, entry.name, "symlinked-file");
        continue;
      }
      if (kind === "hardlink") {
        recordSkipped(state, entry.name, "hardlinked-file");
        continue;
      }
      throw skillFileError(error, source);
    } finally {
      await directory.close().catch(() => undefined);
    }

    const content = decodeUtf8(buffer, () => new SkillsContextFileError("encoding", source));
    const frontmatter = parseFrontmatter(content);
    state.records.push({
      name: entry.name,
      source,
      ...(workspaceRelative ? { path: `skills/${entry.name}/SKILL.md` } : {}),
      content,
      ...(frontmatter.values !== undefined ? { metadata: frontmatter.values } : {}),
      metadataStatus: Object.freeze({
        status: frontmatter.status,
        ...(frontmatter.reason !== undefined ? { reason: frontmatter.reason } : {}),
      }),
    });
  }
}

/** `<workspaceRoot>/skills`; absent means no workspace skills and is never created. */
async function scanWorkspaceSkills(workspace: FileHandle, state: LoadState): Promise<void> {
  let skills: FileHandle;
  try {
    skills = await openPinned(workspace, "skills", DIRECTORY_FLAGS, WORKSPACE_SOURCE_PREFIX, pinnedError);
  } catch (error) {
    if ((error as FsSafeError).kind === "missing") return;
    throw new SkillsContextFileError("unreadable", WORKSPACE_SOURCE_PREFIX);
  }
  try {
    await scanSkillRoot(skills, WORKSPACE_SOURCE_PREFIX, true, state);
  } finally {
    await skills.close().catch(() => undefined);
  }
}

/**
 * Progressive summary: names, descriptions and a minimal locator only. Bodies are
 * never included here; the model loads one on demand through the `skill` tool.
 * Disabled and model-hidden skills are omitted; requirement-unavailable ones are
 * marked. Refused directory entries are listed once so a host (and a model that
 * saw the name referenced) can tell that they were skipped rather than missing.
 */
function formatSummary(
  discovered: readonly DiscoveredSkill[],
  skipped: readonly SkippedSkill[],
): string {
  const lines = discovered
    .filter((skill) => !skill.disabled && skill.modelInvocable)
    .map((skill) => {
      const missing = [
        ...skill.requirements.missingBins.map((name) => `CLI: ${name}`),
        ...skill.requirements.missingEnv.map((name) => `ENV: ${name}`),
        ...skill.requirements.unsupported.map((reason) => `unsupported metadata: ${reason}`),
      ];
      const suffix = skill.available
        ? ""
        : ` (unavailable${missing.length > 0 ? `: ${missing.join(", ")}` : ""})`;
      return `- **${skill.name}** — ${skill.description}${suffix}  \`${skill.path ?? skill.source}\``;
    });
  if (lines.length > 0) {
    lines.unshift(
      "Load a skill with the `skill` tool by name; bodies are not included here. " +
      "Relative paths in a workspace skill resolve against its directory (`skills/<name>/`) " +
      "and can be read with the read tool when granted. A builtin skill's other files are outside the workspace " +
      "and are not readable with workspace tools.",
    );
  }
  if (skipped.length > 0) {
    lines.push(
      `Skipped skill entries: ${skipped.map((entry) => `${entry.name} (${entry.reason})`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Discover skills from explicit roots and return values compatible with
 * `ConversationContextSnapshot`.
 *
 * Workspace skills take precedence over builtin skills with the same directory
 * name. Disabled and requirement-unavailable skills stay discovered with
 * `enabled: false`; the context renderer therefore never includes their bodies.
 * A missing
 * `<workspaceRoot>/skills` directory means no workspace skills; a supplied
 * `builtinSkillsRoot` must exist.
 */
export async function loadSkillsContext(
  request: SkillsContextRequest,
): Promise<SkillsContextResult> {
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
  ));
  const environment = validatedEnvironment(
    ownDataField(request, "environment", "Skills context request").value,
  );

  const state: LoadState = { records: [], skipped: [] };
  const workspace = await openDirectory(workspaceRoot, "workspaceRoot");
  try {
    await scanWorkspaceSkills(workspace, state);
  } finally {
    await workspace.close().catch(() => undefined);
  }
  if (builtinRoot !== undefined) {
    const builtin = await openDirectory(builtinRoot, "builtinSkillsRoot");
    try {
      const workspaceNames = new Set(state.records.map((record) => record.name));
      await scanSkillRoot(builtin, BUILTIN_SOURCE_PREFIX, false, state, workspaceNames);
    } finally {
      await builtin.close().catch(() => undefined);
    }
  }

  const discovered: DiscoveredSkill[] = [];
  for (const record of state.records) {
    const requirements = await checkRequirements(record.metadata, record.metadataStatus, environment);
    const isDisabled = disabled.has(record.name);
    const available = requirements.status !== "unsupported" &&
      requirements.missingBins.length === 0 && requirements.missingEnv.length === 0;
    const description = typeof record.metadata?.description === "string" && record.metadata.description.length > 0
      ? record.metadata.description
      : record.name;
    discovered.push(Object.freeze({
      name: record.name,
      source: record.source,
      ...(record.path !== undefined ? { path: record.path } : {}),
      content: record.content,
      ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
      metadataStatus: record.metadataStatus,
      description,
      modelInvocable: !disableModelInvocation(record.metadata),
      disabled: isDisabled,
      available,
      enabled: available && !isDisabled,
      requirements,
    }));
  }

  const skills: ContextSkillSnapshot[] = discovered
    .filter((skill) => skill.modelInvocable)
    .map((skill) => Object.freeze({
      name: skill.name,
      source: skill.source,
      content: skill.content,
      enabled: skill.enabled,
    }));

  return Object.freeze({
    skills: Object.freeze(skills),
    discovered: Object.freeze(discovered),
    skipped: Object.freeze([...state.skipped]),
    summary: formatSummary(discovered, state.skipped),
  });
}
