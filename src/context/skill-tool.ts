/**
 * Per-conversation progressive skill loading for the gateway.
 *
 * The host already loaded every discovered skill body into the context
 * snapshot with explicit roots and requirement checks. This extension exposes
 * one read-only model-facing tool that lists those skills and returns one
 * body on demand, so a non-`always` builtin skill (whose file lives outside the
 * workspace and is therefore unreadable by the coding tools) can still be
 * loaded without a config restart.
 *
 * The tool reads only the conversation's captured snapshot table. It never
 * touches the filesystem, never widens the workspace, grants no tools, and
 * executes nothing. Effectful work still requires an explicit coding-tool
 * grant. It is not part of the host `toolAllowlist` ceiling and cannot be
 * granted or revoked; it is installed per conversation only when the host's
 * snapshot carried skills.
 */
import { Type } from "typebox";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";
import { CONTEXT_LIMITS, stripSkillFrontmatter } from "./index.js";

export interface ConversationSkill {
  readonly name: string;
  /** Stable provenance label; never an absolute host path. */
  readonly source: string;
  /** Raw SKILL.md content, including frontmatter (stripped when returned). */
  readonly content: string;
  /** Host decision: requirement gates satisfied and not disabled. */
  readonly enabled: boolean;
}

interface ConversationSkills {
  /** Host-rendered progressive summary; preferred over a generated listing. */
  readonly summary?: string;
  readonly skills: readonly ConversationSkill[];
}

/** Result of replacing one conversation's skill table, with a rollback for a failed apply. */
export interface SkillTableUpdate {
  /** Discovered skills, including unavailable ones; 0 means the table was removed. */
  readonly skills: number;
  /** Restore this conversation's prior table, including absence. */
  restore(): void;
}

export interface SkillTool {
  readonly extension: Extension;
  /**
   * Replace one conversation's table from the host snapshot. The skill count
   * includes unavailable ones; 0 removes the table.
   */
  setConversation(conversationId: ConversationId, snapshot: unknown): SkillTableUpdate;
  removeConversation(conversationId: ConversationId): void;
}

export const SKILL_TOOL_NAME = "skill";
const LISTING_PREFIX = "Available skills (call this tool with a name to load one):";

function ownValue(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownString(value: unknown, key: string): string | undefined {
  const found = ownValue(value, key);
  return typeof found === "string" ? found : undefined;
}

function ownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice() : [];
}

function readSkills(snapshot: unknown): readonly ConversationSkill[] {
  const skills: ConversationSkill[] = [];
  const seen = new Set<string>();
  for (const raw of ownArray(ownValue(snapshot, "skills"))) {
    const name = ownString(raw, "name");
    const content = ownString(raw, "content");
    if (name === undefined || content === undefined ||
        name.length === 0 || name.length > CONTEXT_LIMITS.maxSkillNameCodeUnits || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const source = ownString(raw, "source") ?? "host-supplied snapshot";
    skills.push(Object.freeze({
      name,
      source: source.slice(0, CONTEXT_LIMITS.sourceChars),
      content,
      enabled: ownValue(raw, "enabled") === true,
    }));
  }
  return Object.freeze(skills);
}

function listing(record: ConversationSkills): string {
  if (record.summary !== undefined && record.summary.trim().length > 0) return record.summary;
  return [
    LISTING_PREFIX,
    ...record.skills.map((skill) =>
      `- **${skill.name}**${skill.enabled ? "" : " (unavailable)"}  \`${skill.source}\``),
  ].join("\n");
}

/**
 * Build the skill tool extension plus its per-conversation table. The runtime
 * registers the extension once and selects it only for conversations whose
 * host snapshot included skills.
 */
export function createSkillTool(): SkillTool {
  const conversations = new Map<ConversationId, ConversationSkills>();
  const tool = defineTool({
    name: SKILL_TOOL_NAME,
    description:
      "List the skills discovered for this conversation, or load one skill's Markdown instructions. " +
      "Call without a name to list the available and unavailable skills; call with an exact name to read " +
      "a skill body before following it. This is read-only: it returns instructions only, grants no tools, " +
      "and executes nothing.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({
        description: "Exact skill name from the listing. Omit to list skills.",
      })),
    }),
    outputLimits: { maxBytes: 96 * 1024, maxLines: 2_000, retain: "head" },
    async execute(args, api) {
      const record = conversations.get(api.conversationId);
      if (record === undefined) {
        return {
          output: [{ type: "text" as const, text: "No skills are available in this conversation." }],
          isError: true,
        };
      }
      const requested = typeof args.name === "string" ? args.name.trim() : "";
      if (requested.length === 0) {
        return { output: [{ type: "text" as const, text: listing(record) }] };
      }
      if (requested.length > CONTEXT_LIMITS.maxSkillNameCodeUnits) {
        return {
          output: [{ type: "text" as const, text: "Skill name exceeds the configured limit." }],
          isError: true,
        };
      }
      const skill = record.skills.find((entry) => entry.name === requested);
      if (skill === undefined) {
        return {
          output: [{ type: "text" as const, text: `Unknown skill "${requested}".\n${listing(record)}` }],
          isError: true,
        };
      }
      if (!skill.enabled) {
        return {
          output: [{
            type: "text" as const,
            text: `Skill "${skill.name}" is not available in this conversation: it is disabled or its requirements are unmet.`,
          }],
          isError: true,
        };
      }
      const location = skill.source.startsWith("workspace:skills/")
        ? "Relative paths in this skill resolve against its workspace directory (skills/<name>/) and can be read with the read tool when granted."
        : "This is a builtin skill: its other files are outside the workspace and cannot be read with workspace tools.";
      return {
        output: [{
          type: "text" as const,
          text: `# Skill: ${skill.name}\nSource: ${skill.source}\n${location}\n\n${stripSkillFrontmatter(skill.content)}`,
        }],
        details: { name: skill.name, source: skill.source },
      };
    },
  });

  return {
    extension: defineExtension({ name: "nanobot-skill-tool", tools: [tool] }),
    setConversation(conversationId, snapshot) {
      const previous = conversations.get(conversationId);
      const skills = readSkills(snapshot);
      if (skills.length === 0) conversations.delete(conversationId);
      else {
        const summary = ownString(snapshot, "skillSummary");
        conversations.set(conversationId, Object.freeze({
          ...(summary !== undefined && summary.trim().length > 0 ? { summary } : {}),
          skills,
        }));
      }
      return {
        skills: skills.length,
        restore() {
          if (previous === undefined) conversations.delete(conversationId);
          else conversations.set(conversationId, previous);
        },
      };
    },
    removeConversation(conversationId) {
      conversations.delete(conversationId);
    },
  };
}
