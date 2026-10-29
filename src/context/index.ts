import {
  defineExtension,
  section,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";

/**
 * Deterministically render Nanobot's fixed identity template semantics from
 * host-provided values. This is not a Jinja engine and performs no discovery.
 */
export interface NanobotIdentityValues {
  readonly runtime: string;
  readonly workspacePath: string;
  readonly channel?: string;
}

const IDENTITY_COMPOSITION_OVERHEAD = 1_600;

export function renderNanobotIdentity(values: NanobotIdentityValues): string {
  if (Object.hasOwn(values, "platformPolicy")) {
    throw new TypeError("Platform policy is not part of the reduced identity renderer");
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(values.workspacePath)) {
    throw new TypeError("Workspace path must not contain control characters or newlines");
  }
  for (const [label, value] of [["runtime", values.runtime], ["workspacePath", values.workspacePath]] as const) {
    if (value !== undefined && codePointCount(value) > identityContentLimit()) {
      throw new RangeError(`Identity ${label} exceeds ${identityContentLimit()} code points`);
    }
  }

  const sections = [
    `## Runtime\n${values.runtime}`,
    `## Workspace\nYour workspace is at: ${values.workspacePath}`,
  ];
  if (values.channel === "telegram" || values.channel === "discord") {
    sections.push("## Format Hint\nThis conversation is on a messaging app. Use short paragraphs. Avoid large headings (#, ##). Use **bold** sparingly. No tables — use plain lists.");
  } else if (values.channel === "email") {
    sections.push("## Format Hint\nThis conversation is via email. Structure with clear sections. Markdown may not render — keep formatting simple.");
  } else if (values.channel === "cli") {
    sections.push("## Format Hint\nOutput is rendered in a terminal. Avoid markdown headings and tables. Use plain text with minimal formatting.");
  }

  const outputChars = sections.reduce((total, sectionText) => total + codePointCount(sectionText), 2 * (sections.length - 1));
  if (outputChars > identityContentLimit()) {
    throw new RangeError(`Rendered identity exceeds ${identityContentLimit()} code points`);
  }
  return sections.join("\n\n");
}

function identityContentLimit(): number {
  // renderDocuments adds a heading and source label; reserve for worst-case escaped U+2028/U+2029.
  return CONTEXT_LIMITS.sectionChars - IDENTITY_COMPOSITION_OVERHEAD;
}

export const CONTEXT_LIMITS = Object.freeze({
  totalChars: 50_000,
  contextChars: 48_000,
  maxConversations: 256,
  sectionChars: 16_000,
  toolVisibilityChars: 2_000,
  sourceChars: 256,
  maxMemorySources: 32,
  maxSkillNameCodeUnits: 128,
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

/**
 * Host-supplied skill record. The prompt renders only `skillSummary`; these
 * entries feed the gateway's on-demand skill tool, and `content` must never be
 * placed in a prompt section. No skill file is discovered or parsed here.
 */
export interface ContextSkillSnapshot {
  readonly name: string;
  readonly source: string;
  /** Raw SKILL.md body, served only by the on-demand skill tool. */
  readonly content: string;
  /** Host has approved/enabled the skill and evaluated any requirements. False or absent is fail-closed. */
  readonly enabled: boolean;
}

/**
 * All context for one Durable conversation. IDs are storage-local; snapshots must be
 * captured by an extension/registry dedicated to one Harness, never shared across Harnesses.
 */
export interface ConversationContextSnapshot {
  readonly conversationId: ConversationId;
  /** Already-rendered identity text; this module does not expand Python/Jinja placeholders. */
  readonly identity?: ContextDocumentSnapshot;
  readonly agents?: ContextDocumentSnapshot;
  readonly soul?: ContextDocumentSnapshot;
  readonly user?: ContextDocumentSnapshot;
  /** Memory content the host has explicitly selected for this conversation. */
  readonly memory?: readonly ContextDocumentSnapshot[];
  /** On-demand skill table for the gateway tool; never rendered in a prompt section. */
  readonly skills?: readonly ContextSkillSnapshot[];
  /**
   * Host-rendered progressive skill summary (name, description, locator,
   * availability). It is the only skills content placed in the prompt; bodies are
   * never included, whatever `always` or config selection says.
   */
  readonly skillSummary?: string;
}

interface PreparedContext {
  readonly sections: Readonly<Partial<Record<keyof typeof CONTEXT_SECTION_KEYS, string>>>;
}

const TRUNCATION_MARKER = "\n[context truncated at configured bounds]";
const SKILL_FRONTMATTER = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/;

/**
 * Make an opt-in Durable extension from immutable, host-supplied snapshots.
 * Direct callers must use a fresh extension and dedicated registry per
 * Harness/storage: Durable conversation IDs collide across stores, and
 * PromptInput provides no store namespace. Reconstruct same-store snapshots
 * before resume. `openGateway` enforces this using its persisted session map;
 * direct callers own that precondition. Renderers read only this private copy
 * and the request's actual `agent.tools`; no ambient discovery.
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
    const [conversationId, prepared] = prepareSnapshot(raw);
    if (contexts.has(conversationId)) {
      throw new TypeError(`Duplicate context snapshot for conversation ${conversationId}`);
    }
    contexts.set(conversationId, prepared);
  }
  return buildContextExtension(contexts);
}

/** Build replacement extensions from prepared values without retaining mutable host snapshots. */
export function createContextExtensionBuilder(): {
  add(snapshot: ConversationContextSnapshot): Extension;
  /** Replace one conversation's prepared snapshot, or add it when absent. */
  replace(snapshot: ConversationContextSnapshot): Extension;
  remove(conversationId: ConversationId): Extension;
} {
  const contexts = new Map<ConversationId, PreparedContext>();
  return {
    add(snapshot) {
      if (contexts.size >= CONTEXT_LIMITS.maxConversations) {
        throw new RangeError(`At most ${CONTEXT_LIMITS.maxConversations} conversation snapshots are accepted`);
      }
      const [conversationId, prepared] = prepareSnapshot(snapshot);
      if (contexts.has(conversationId)) {
        throw new TypeError(`Duplicate context snapshot for conversation ${conversationId}`);
      }
      const next = new Map(contexts);
      next.set(conversationId, prepared);
      const extension = buildContextExtension(next);
      contexts.set(conversationId, prepared);
      return extension;
    },
    replace(snapshot: ConversationContextSnapshot): Extension {
      // Explicit host refresh: replace or add one conversation without disturbing the others.
      const [conversationId, prepared] = prepareSnapshot(snapshot);
      if (!contexts.has(conversationId) && contexts.size >= CONTEXT_LIMITS.maxConversations) {
        throw new RangeError(`At most ${CONTEXT_LIMITS.maxConversations} conversation snapshots are accepted`);
      }
      const next = new Map(contexts);
      next.set(conversationId, prepared);
      const extension = buildContextExtension(next);
      contexts.set(conversationId, prepared);
      return extension;
    },
    remove(conversationId) {
      // A missing snapshot is a no-op, so an eviction race cannot invalidate a live extension.
      const next = new Map(contexts);
      next.delete(conversationId);
      const extension = buildContextExtension(next);
      contexts.delete(conversationId);
      return extension;
    },
  };
}

function prepareSnapshot(snapshot: unknown): [ConversationId, PreparedContext] {
  const conversationId = ownValue(snapshot, "conversationId");
  if (typeof conversationId !== "number" || !Number.isSafeInteger(conversationId) || conversationId < 1) {
    throw new TypeError("Each context snapshot needs an own Durable conversationId");
  }
  return [conversationId as ConversationId, prepareContext(snapshot)];
}

function buildContextExtension(contexts: ReadonlyMap<ConversationId, PreparedContext>): Extension {
  const captured = new Map(contexts);
  const content = (input: { readonly conversationId: ConversationId }, key: keyof typeof CONTEXT_SECTION_KEYS) =>
    captured.get(input.conversationId)?.sections[key];

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

  // Skills are names/descriptions/locators only. Bodies come from the on-demand tool, so
  // no `always`, selected name, or host-supplied body can enter the prompt stack.
  const skillSummary = ownString(snapshot, "skillSummary");
  if (skillSummary !== undefined && skillSummary.trim().length > 0) {
    add("skills", renderDocuments(
      [["Available skills", { source: "host snapshot (skill summary)", content: skillSummary }]],
      CONTEXT_LIMITS.sectionChars,
    ));
  }

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

export function stripSkillFrontmatter(content: string): string {
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
