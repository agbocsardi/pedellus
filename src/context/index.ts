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

export function renderNanobotIdentity(values: NanobotIdentityValues): string {
  if (Object.hasOwn(values, "platformPolicy")) {
    throw new TypeError("Platform policy is not part of the reduced identity renderer");
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(values.workspacePath)) {
    throw new TypeError("Workspace path must not contain control characters or newlines");
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

  return sections.join("\n\n");
}

/**
 * Bounds that remain after the port's arbitrary context-size caps were removed.
 * None of them shortens instructions, memory or skill text: the fan-out limit
 * protects the snapshot table, and the label/name bounds shape identifiers
 * (which are metadata and locators, never the content they identify).
 */
export const CONTEXT_LIMITS = Object.freeze({
  maxConversations: 256,
  sourceChars: 256,
  maxSkillNameCodeUnits: 128,
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

const LABEL_TRUNCATION_MARKER = "\u2026";
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
  for (const raw of readArray(snapshots)) {
    const [conversationId, prepared] = prepareSnapshot(raw);
    if (contexts.has(conversationId)) {
      throw new TypeError(`Duplicate context snapshot for conversation ${conversationId}`);
    }
    contexts.set(conversationId, prepared);
  }
  return buildContextExtension(contexts);
}

/** Result of replacing one conversation's prepared snapshot, with a rollback for a failed apply. */
export interface ContextExtensionReplacement {
  readonly extension: Extension;
  /** Restore the prior prepared entry and return an extension built from the restored map. */
  restore(): Extension;
}

/** Build replacement extensions from prepared values without retaining mutable host snapshots. */
export function createContextExtensionBuilder(): {
  add(snapshot: ConversationContextSnapshot): Extension;
  /** Replace one conversation's prepared snapshot, or add it when absent. */
  replace(snapshot: ConversationContextSnapshot): ContextExtensionReplacement;
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
    replace(snapshot: ConversationContextSnapshot): ContextExtensionReplacement {
      // Explicit host refresh: replace or add one conversation without disturbing the others.
      const [conversationId, prepared] = prepareSnapshot(snapshot);
      const hadPrevious = contexts.has(conversationId);
      if (!hadPrevious && contexts.size >= CONTEXT_LIMITS.maxConversations) {
        throw new RangeError(`At most ${CONTEXT_LIMITS.maxConversations} conversation snapshots are accepted`);
      }
      const previous = contexts.get(conversationId);
      const next = new Map(contexts);
      next.set(conversationId, prepared);
      const extension = buildContextExtension(next);
      contexts.set(conversationId, prepared);
      return {
        extension,
        restore() {
          if (previous === undefined) contexts.delete(conversationId);
          else contexts.set(conversationId, previous);
          return buildContextExtension(contexts);
        },
      };
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
  // Every accepted document is composed in full. Only the host names what is
  // selected; the renderer never shortens or drops instructions, memory or
  // skill text to fit a size budget.
  const add = (key: keyof typeof CONTEXT_SECTION_KEYS, text: string) => {
    if (text) sections[key] = text;
  };

  const identity = readDocument(ownValue(snapshot, "identity"));
  if (identity) add("identity", renderDocuments([["Identity", identity]]));

  const workspaceDocuments: [string, ContextDocumentSnapshot][] = [];
  for (const [field, label] of [["agents", "AGENTS.md"], ["soul", "SOUL.md"], ["user", "USER.md"]] as const) {
    const document = readDocument(ownValue(snapshot, field));
    if (document) workspaceDocuments.push([label, document]);
  }
  add("instructions", renderDocuments(workspaceDocuments));

  const memories = readArray(ownValue(snapshot, "memory"))
    .map((value, index) => readDocument(value, `memory[${index}]`))
    .filter((value): value is ContextDocumentSnapshot => value !== undefined);
  add("memory", renderDocuments(memories.map((document, index) => [`Memory ${index + 1}`, document])));

  // Skills are names/descriptions/locators only. Bodies come from the on-demand tool, so
  // no `always`, selected name, or host-supplied body can enter the prompt stack.
  const skillSummary = ownString(snapshot, "skillSummary");
  if (skillSummary !== undefined && skillSummary.trim().length > 0) {
    add("skills", renderDocuments(
      [["Available skills", { source: "host snapshot (skill summary)", content: skillSummary }]],
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
): string {
  const chunks: string[] = [];
  for (const [label, document] of documents) {
    chunks.push(`## ${label}\nSource: ${safeInline(document.source)}\n\n`);
    chunks.push(document.content);
    chunks.push("\n\n");
  }
  return chunks.join("");
}

function renderToolVisibility(tools: readonly { readonly name: string }[]): string {
  const prefix = "Model-facing tools for this request (from Durable agent.tools; this section does not enable tools): ";
  const suffix = ". Tools callable only by other tools are not listed.";
  const names = tools
    .filter((tool) => typeof tool.name === "string")
    .map((tool) => safeInline(tool.name));
  return `${prefix}${names.length ? names.join(", ") : "none"}${suffix}`;
}

export function stripSkillFrontmatter(content: string): string {
  const match = SKILL_FRONTMATTER.exec(content);
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

/** Clip a provenance label to its shape bound. Labels identify content; they never carry it. */
function boundedText(value: string, limit: number): string {
  if (limit <= 0) return "";
  const { prefix, truncated } = codePointPrefix(value, limit);
  if (!truncated) return value;
  const markerCount = codePointCount(LABEL_TRUNCATION_MARKER);
  if (limit <= markerCount) return prefix;
  return `${codePointPrefix(value, limit - markerCount).prefix}${LABEL_TRUNCATION_MARKER}`;
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

function readArray(value: unknown): unknown[] {
  const length = arrayLength(value);
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
