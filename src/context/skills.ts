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
 * Scope is accidental damage, not adversarial confinement: reads are bounded,
 * UTF-8 failures are rejected, and symlinked skill entries are skipped. There
 * is no `/proc/self/fd` pinning or post-read race verification.
 */
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONTEXT_LIMITS, type ContextSkillSnapshot } from "./index.js";

/** Deterministic provenance prefixes. */
const WORKSPACE_SOURCE_PREFIX = "workspace:skills/";
const BUILTIN_SOURCE_PREFIX = "builtin:skills/";
const RESTRICTED_ROOTS = Object.freeze(["/proc", "/sys", "/dev"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const FRONTMATTER_KEY = /^[A-Za-z0-9_.-]+$/;

/** Bounded discovery limits. They are enforced before content reaches the renderer. */
export const SKILLS_CONTEXT_LIMITS = Object.freeze({
  /** Actual `SKILL.md` records; candidate directories without one do not count. */
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

export type SkillFileFailureKind = "unreadable" | "encoding" | "io";

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

function failureKind(code: string | undefined): SkillFileFailureKind {
  if (code === "EACCES" || code === "EPERM") return "unreadable";
  return "io";
}

function fileFailure(error: unknown, source: string): SkillsContextFileError {
  if (error instanceof SkillsContextFileError) return error;
  return new SkillsContextFileError(failureKind((error as NodeJS.ErrnoException | null)?.code), source);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") throw new SkillsContextInputError(`${label} must exist`);
    if (code === "EACCES" || code === "EPERM") throw new SkillsContextInputError(`${label} is not readable`);
    if (code === "ENOTDIR") throw new SkillsContextInputError(`${label} must be a directory`);
    throw new SkillsContextInputError(`${label} cannot be read`);
  }
  if (!info.isDirectory()) throw new SkillsContextInputError(`${label} must be a directory`);
}

function decodeUtf8(buffer: Buffer, source: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SkillsContextFileError("encoding", source);
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

function parseMetadataField(raw: string): Record<string, unknown> | undefined {
  const value = parseScalar(raw);
  if (typeof value === "string") return parseJsonObject(value);
  if (isRecord(value)) return deepFreeze(value);
  return undefined;
}

/**
 * Parse only the flat frontmatter subset used by Nanobot skills. `metadata` is
 * a JSON object (as in the shipped skills); YAML block mappings, anchors,
 * tags, and multi-line scalars are deliberately unsupported.
 */
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

async function scanSkillRoot(
  rootPath: string,
  sourcePrefix: string,
  workspaceRelative: boolean,
  state: LoadState,
  skipNames: ReadonlySet<string> = new Set(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    throw new SkillsContextFileError("unreadable", sourcePrefix);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    // A symlinked or non-directory candidate is ignored rather than failing the
    // whole discovery pass.
    if (!entry.isDirectory()) continue;
    if (entry.name.length > SKILLS_CONTEXT_LIMITS.maxSkillNameCodeUnits ||
        !SAFE_SKILL_NAME.test(entry.name) || skipNames.has(entry.name)) {
      continue;
    }

    const source = `${sourcePrefix}${entry.name}/SKILL.md`;
    const skillFile = join(rootPath, entry.name, "SKILL.md");
    let info;
    try {
      info = await lstat(skillFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") continue;
      throw fileFailure(error, source);
    }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > SKILLS_CONTEXT_LIMITS.maxSkillFileBytes) {
      throw new SkillsContextBoundsError("maxSkillFileBytes");
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(skillFile);
    } catch (error) {
      throw fileFailure(error, source);
    }
    if (buffer.length > SKILLS_CONTEXT_LIMITS.maxSkillFileBytes) {
      throw new SkillsContextBoundsError("maxSkillFileBytes");
    }
    if (state.bytes + buffer.length > SKILLS_CONTEXT_LIMITS.maxTotalBytes) {
      throw new SkillsContextBoundsError("maxTotalBytes");
    }

    const content = decodeUtf8(buffer, source);
    const metadata = parseFrontmatter(content);
    state.bytes += buffer.length;
    state.records.push({
      name: entry.name,
      source,
      ...(workspaceRelative ? { path: `skills/${entry.name}/SKILL.md` } : {}),
      content,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    if (state.records.length > SKILLS_CONTEXT_LIMITS.maxSkills) {
      throw new SkillsContextBoundsError("maxSkills");
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

  await assertDirectory(workspaceRoot, "workspaceRoot");
  const state: LoadState = { bytes: 0, records: [] };
  await scanSkillRoot(join(workspaceRoot, "skills"), WORKSPACE_SOURCE_PREFIX, true, state);
  if (builtinRoot !== undefined) {
    await assertDirectory(builtinRoot, "builtinSkillsRoot");
    const workspaceNames = new Set(state.records.map((record) => record.name));
    await scanSkillRoot(builtinRoot, BUILTIN_SOURCE_PREFIX, false, state, workspaceNames);
  }

  const discovered: DiscoveredSkill[] = [];
  for (const record of state.records) {
    const requirements = await checkRequirements(record.metadata, environment);
    const isDisabled = disabled.has(record.name);
    const available = requirements.missingBins.length === 0 && requirements.missingEnv.length === 0;
    const description = typeof record.metadata?.description === "string" && record.metadata.description.length > 0
      ? clipCodePoints(record.metadata.description, CONTEXT_LIMITS.descriptionChars)
      : record.name;
    discovered.push(Object.freeze({
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
    }));
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
