import {
  defineExtension,
  section,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";

/** Fixed bounds for host-supplied context text (Unicode code points). */
export const CONTEXT_LIMITS = Object.freeze({
  totalChars: 50_000,
  contextChars: 48_000,
  maxConversations: 256,
  sectionChars: 16_000,
  toolVisibilityChars: 2_000,
  sourceChars: 256,
  maxMemorySources: 32,
  maxSkills: 32,
  maxSkillInputs: 64,
  maxToolNames: 128,
  descriptionChars: 1_024,
});

export const CONTEXT_SECTION_KEYS = Object.freeze({
  identity: "nanobot_identity",
  instructions: "nanobot_instructions",
  memory: "nanobot_memory",
  skills: "nanobot_skills",
  tools: "nanobot_tools",
});

export interface ContextDocumentSnapshot {
  /** Host-defined provenance label; prefer a stable relative path or opaque source ID. */
  readonly source: string;
  readonly content: string;
}

/** Parsed skill frontmatter supplied by the host; no skill file is discovered or parsed here. */
export interface ContextSkillSnapshot {
  readonly name: string;
  readonly source: string;
  readonly content: string;
  /** Host has approved/enabled the skill and evaluated any requirements. False or absent is fail-closed. */
  readonly enabled: boolean;
  /** Parsed SKILL.md frontmatter. Only `description` and Python Nanobot/OpenClaw `always` are consumed. */
  readonly metadata?: unknown;
}

/** All context for one Durable conversation. The extension never falls back to another conversation's snapshot. */
export interface ConversationContextSnapshot {
  readonly conversationId: ConversationId;
  /** Already-rendered identity text; this module does not expand Python/Jinja placeholders. */
  readonly identity?: ContextDocumentSnapshot;
  readonly agents?: ContextDocumentSnapshot;
  readonly soul?: ContextDocumentSnapshot;
  readonly user?: ContextDocumentSnapshot;
  /** Memory content the host has explicitly selected for this conversation. */
  readonly memory?: readonly ContextDocumentSnapshot[];
  readonly skills?: readonly ContextSkillSnapshot[];
  /** Explicitly selected, enabled non-always skills to include in this snapshot. */
  readonly selectedSkills?: readonly string[];
}

interface PreparedContext {
  readonly sections: Readonly<Partial<Record<keyof typeof CONTEXT_SECTION_KEYS, string>>>;
}

const TRUNCATION_MARKER = "\n[context truncated at configured bounds]";
const SKILL_FRONTMATTER = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/;

/**
 * Make an opt-in Durable extension from immutable, host-supplied snapshots.
 * The returned section renderers only read this private copy and the current
 * request's actual `agent.tools`; they do no filesystem, environment, or
 * extension/resource discovery.
 */
export function createContextExtension(
  snapshots: readonly ConversationContextSnapshot[],
): Extension {
  if (!Array.isArray(snapshots)) throw new TypeError("Context snapshots must be an array");
  if (snapshots.length > CONTEXT_LIMITS.maxConversations) {
    throw new RangeError(`At most ${CONTEXT_LIMITS.maxConversations} conversation snapshots are accepted`);
  }
  const contexts = new Map<ConversationId, PreparedContext>();
  for (const raw of readArray(snapshots, CONTEXT_LIMITS.maxConversations)) {
    const conversationId = ownValue(raw, "conversationId");
    if (typeof conversationId !== "number" || !Number.isSafeInteger(conversationId) || conversationId < 1) {
      throw new TypeError("Each context snapshot needs an own Durable conversationId");
    }
    if (contexts.has(conversationId as ConversationId)) {
      throw new TypeError(`Duplicate context snapshot for conversation ${conversationId}`);
    }
    contexts.set(conversationId as ConversationId, prepareContext(raw));
  }

  const content = (input: { readonly conversationId: ConversationId }, key: keyof typeof CONTEXT_SECTION_KEYS) =>
    contexts.get(input.conversationId)?.sections[key];

  return defineExtension({
    name: "nanobot-context",
    sections: [
      section(CONTEXT_SECTION_KEYS.identity, (input) => content(input, "identity"), { tag: false }),
      section(CONTEXT_SECTION_KEYS.instructions, (input) => content(input, "instructions"), { tag: false }),
      section(CONTEXT_SECTION_KEYS.memory, (input) => content(input, "memory"), { tag: false }),
      section(CONTEXT_SECTION_KEYS.skills, (input) => content(input, "skills"), { tag: false }),
      section(CONTEXT_SECTION_KEYS.tools, (input) => renderToolVisibility(input.agent.tools), { tag: false }),
    ],
  });
}

function prepareContext(snapshot: unknown): PreparedContext {
  const rawSelected = readArray(ownValue(snapshot, "selectedSkills"), CONTEXT_LIMITS.maxSkillInputs);
  const selected = new Set(rawSelected.filter((name): name is string => typeof name === "string"));
  const rawSkills = readArray(ownValue(snapshot, "skills"), CONTEXT_LIMITS.maxSkillInputs);
  const skillNames = new Set<string>();
  const activeSkills: { name: string; source: string; description: string; content: string }[] = [];
  let omittedSkills = Math.max(0, arrayLength(ownValue(snapshot, "skills")) - rawSkills.length);

  for (const raw of rawSkills) {
    const name = ownString(raw, "name");
    if (!name || name.length > 128) continue;
    if (skillNames.has(name)) throw new TypeError(`Duplicate skill name in context snapshot: ${name}`);
    skillNames.add(name);

    // A skill is usable only when the host explicitly enabled it. Read metadata
    // only after this check so disabled metadata can never activate it.
    if (ownValue(raw, "enabled") !== true) continue;
    const metadata = ownValue(raw, "metadata");
    const always = skillIsAlways(metadata);
    if (!always && !selected.has(name)) continue;

    if (activeSkills.length >= CONTEXT_LIMITS.maxSkills) {
      omittedSkills++;
      continue;
    }
    const content = ownString(raw, "content");
    if (content === undefined) continue;
    activeSkills.push({
      name,
      source: sourceLabel(ownString(raw, "source")),
      description: boundedText(ownString(metadata, "description") ?? name, CONTEXT_LIMITS.descriptionChars),
      content: stripSkillFrontmatter(content),
    });
  }

  const sections: Partial<Record<keyof typeof CONTEXT_SECTION_KEYS, string>> = {};
  let remaining = CONTEXT_LIMITS.contextChars;
  const add = (key: keyof typeof CONTEXT_SECTION_KEYS, text: string) => {
    if (!text || remaining <= 0) return;
    const bounded = boundedText(text, Math.min(CONTEXT_LIMITS.sectionChars, remaining));
    if (!bounded) return;
    sections[key] = bounded;
    remaining -= codePointCount(bounded);
  };

  const identity = readDocument(ownValue(snapshot, "identity"));
  if (identity) add("identity", renderDocuments([["Identity", identity]], CONTEXT_LIMITS.sectionChars));

  const workspaceDocuments: [string, ContextDocumentSnapshot][] = [];
  for (const [field, label] of [["agents", "AGENTS.md"], ["soul", "SOUL.md"], ["user", "USER.md"]] as const) {
    const document = readDocument(ownValue(snapshot, field));
    if (document) workspaceDocuments.push([label, document]);
  }
  add("instructions", renderDocuments(workspaceDocuments, CONTEXT_LIMITS.sectionChars));

  const rawMemory = ownValue(snapshot, "memory");
  const memoryLength = arrayLength(rawMemory);
  const memoryValues = readArray(rawMemory, CONTEXT_LIMITS.maxMemorySources);
  const memories = memoryValues
    .map((value, index) => readDocument(value, `memory[${index}]`))
    .filter((value): value is ContextDocumentSnapshot => value !== undefined);
  if (memoryLength > CONTEXT_LIMITS.maxMemorySources) {
    memories.push({
      source: "host snapshot (omitted entries)",
      content: `${memoryLength - CONTEXT_LIMITS.maxMemorySources} additional memory snapshots omitted by source-count bounds.`,
    });
  }
  add("memory", renderDocuments(memories.map((document, index) => [`Memory ${index + 1}`, document]), CONTEXT_LIMITS.sectionChars));

  const skillRecords = activeSkills.map((skill) => [
    `Skill ${safeInline(skill.name)} — ${safeInline(skill.description)}`,
    { source: skill.source, content: skill.content },
  ] as [string, ContextDocumentSnapshot]);
  if (omittedSkills > 0) {
    skillRecords.push(["Skills omitted", {
      source: "host snapshot (omitted entries)",
      content: `${omittedSkills} additional skill entries omitted by skill-count bounds.`,
    }]);
  }
  add("skills", renderDocuments(skillRecords, CONTEXT_LIMITS.sectionChars));

  return { sections: Object.freeze(sections) };
}

function readDocument(value: unknown, fallbackSource = "host-supplied snapshot"): ContextDocumentSnapshot | undefined {
  const content = ownString(value, "content");
  if (content === undefined || content.length === 0) return undefined;
  return {
    source: sourceLabel(ownString(value, "source") ?? fallbackSource),
    content,
  };
}

function renderDocuments(
  documents: readonly (readonly [string, ContextDocumentSnapshot])[],
  limit: number,
): string {
  if (!documents.length || limit <= 0) return "";
  const chunks: string[] = [];
  let used = 0;
  for (const [label, document] of documents) {
    const header = `## ${label}\nSource: ${safeInline(document.source)}\n\n`;
    const boundedHeader = boundedText(header, limit - used);
    if (!boundedHeader) break;
    chunks.push(boundedHeader);
    used += codePointCount(boundedHeader);
    if (boundedHeader !== header || used >= limit) break;

    const boundedContent = boundedText(document.content, limit - used);
    if (boundedContent) {
      chunks.push(boundedContent);
      used += codePointCount(boundedContent);
    }
    if (boundedContent !== document.content || used >= limit) break;
    const separator = "\n\n";
    const boundedSeparator = boundedText(separator, limit - used);
    chunks.push(boundedSeparator);
    used += codePointCount(boundedSeparator);
  }
  return chunks.join("");
}

function renderToolVisibility(tools: readonly { readonly name: string }[]): string {
  const prefix = "Model-facing tools for this request (from Durable agent.tools; this section does not enable tools): ";
  const suffix = ". Tools callable only by other tools are not listed.";
  const names: string[] = [];
  for (const tool of tools.slice(0, CONTEXT_LIMITS.maxToolNames)) {
    if (typeof tool.name !== "string" || codePointPrefix(tool.name, CONTEXT_LIMITS.sourceChars).truncated) continue;
    const candidate = [...names, safeInline(tool.name)];
    const omitted = tools.length - candidate.length;
    const list = candidate.join(", ");
    const omittedNote = omitted ? `; ${omitted} model-facing tool names omitted by bounds` : "";
    if (codePointCount(`${prefix}${list}${omittedNote}${suffix}`) > CONTEXT_LIMITS.toolVisibilityChars) break;
    names.push(candidate[candidate.length - 1]!);
  }
  const omitted = tools.length - names.length;
  const list = names.length ? names.join(", ") : "none";
  const omittedNote = omitted ? `; ${omitted} model-facing tool names omitted by bounds` : "";
  return `${prefix}${list}${omittedNote}${suffix}`;
}

function skillIsAlways(metadata: unknown): boolean {
  if (ownValue(metadata, "always") === true) return true;
  const nested = ownValue(metadata, "metadata");
  const payload = parseMetadataObject(nested);
  const namespace = hasOwnData(payload, "nanobot")
    ? ownValue(payload, "nanobot")
    : ownValue(payload, "openclaw");
  return ownValue(namespace, "always") === true;
}

function parseMetadataObject(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 4_096) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stripSkillFrontmatter(content: string): string {
  const prefix = content.slice(0, CONTEXT_LIMITS.sectionChars + 1);
  const match = SKILL_FRONTMATTER.exec(prefix);
  return match ? content.slice(match[0].length) : content;
}

function sourceLabel(value: string | undefined): string {
  const clipped = boundedText(value ?? "host-supplied snapshot", CONTEXT_LIMITS.sourceChars);
  return clipped.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim() || "host-supplied snapshot";
}

function safeInline(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.codePointAt(0)!.toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

function boundedText(value: string, limit: number): string {
  if (limit <= 0) return "";
  const { prefix, truncated } = codePointPrefix(value, limit);
  if (!truncated) return value;
  const markerCount = codePointCount(TRUNCATION_MARKER);
  if (limit <= markerCount) return prefix;
  return `${codePointPrefix(value, limit - markerCount).prefix}${TRUNCATION_MARKER}`;
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

function codePointCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

function arrayLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  const length = ownValue(value, "length");
  return typeof length === "number" && Number.isSafeInteger(length) && length > 0 ? length : 0;
}

function readArray(value: unknown, limit: number): unknown[] {
  const length = Math.min(arrayLength(value), Math.max(0, limit));
  const items: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const item = ownValue(value, String(index));
    if (item !== undefined) items.push(item);
  }
  return items;
}

function ownString(value: unknown, key: string): string | undefined {
  const found = ownValue(value, key);
  return typeof found === "string" ? found : undefined;
}

function hasOwnData(value: unknown, key: string): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
  } catch {
    return false;
  }
}

/** Read only own data properties: never invoke inherited metadata or accessor getters. */
function ownValue(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
