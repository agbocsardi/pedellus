/**
 * One declarative catalogue for the slash commands a conversation surface may offer.
 *
 * The catalogue holds short text and surface membership only: which names a particular host
 * actually offers is decided by that host and passed in as an exact name set, so no
 * availability logic, capability probe or host reference lives here. Every usage line a
 * surface prints for a catalogued command comes from here, so no copy can drift.
 */

/** Where a conversation command may appear. Process-level help is not a surface. */
export type ConversationSurface = "cli" | "telegram";

export interface ConversationCommand {
  readonly name: string;
  /** Argument placeholder shown in listings after the name; omitted for a no-argument command. */
  readonly args?: string;
  /** One short line for every listing and for the Telegram command menu. */
  readonly summary: string;
  /** The exact `Usage: /name ...` line a surface may print for this command. */
  readonly usage: string;
  /** A different true usage line for one surface whose accepted grammar genuinely differs there. */
  readonly surfaceUsage?: Partial<Record<ConversationSurface, string>>;
  /** At most one short sentence, shown only by `/help <command>`. */
  readonly detail?: string;
  readonly surfaces: readonly ConversationSurface[];
}

/** A slash-command name that may be echoed back verbatim in any diagnostic. */
export const SAFE_COMMAND_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Catalogue order is the listing and command-menu order for every surface. */
export const CONVERSATION_COMMANDS: readonly ConversationCommand[] = [
  {
    name: "new",
    summary: "Start a fresh context for this conversation",
    usage: "Usage: /new",
    detail: "A busy conversation refuses it or applies it at its next safe boundary; stored history and tool authority are unchanged.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "abort",
    summary: "Stop this turn and withdraw queued messages",
    usage: "Usage: /abort",
    detail: "Other chats, cron runs and background work are unaffected.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "stop",
    summary: "Alias of /abort: stop this turn here",
    usage: "Usage: /stop",
    detail: "Exactly the same effect and durable record as /abort.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "status",
    summary: "Show this conversation's model and run state",
    usage: "Usage: /status",
    detail: "Read-only: no model call and no other conversation is visible.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "history",
    args: "[count]",
    summary: "Show recent committed messages",
    usage: "Usage: /history [count] — 1 to 50, default 10.",
    detail: "User and assistant text only; tool and thinking entries are hidden.",
    surfaces: ["cli"],
  },
  {
    name: "search",
    args: "[options]",
    summary: "Search this conversation's stored messages and tools",
    usage: "Usage: /search [--scope messages|tools|all] [--role user|assistant] [--limit 1-50] [--next] [--] [query]",
    detail: "Read-only; empty text browses and --next continues the last query.",
    surfaces: ["cli"],
  },
  {
    name: "episodes",
    args: "[options]",
    summary: "List a session's reset-delimited episodes",
    usage: "Usage: /episodes [--session <sessionKey>] [--limit 1-50] [--before <entryId>]",
    detail: "Newest first; --session defaults to cli:default.",
    surfaces: ["cli"],
  },
  {
    name: "episode",
    args: "<startEntryId>",
    summary: "Open one episode's displayable entries",
    usage: "Usage: /episode [--session <sessionKey>] <startEntryId> [--limit 1-30]",
    detail: "Read-only; --session defaults to cli:default.",
    surfaces: ["cli"],
  },
  {
    name: "entry",
    args: "<entryId>",
    summary: "Open a bounded window around one entry",
    usage: "Usage: /entry [--session <sessionKey>] <entryId> [--radius 0-5]",
    detail: "Read-only; --session needs a host history surface.",
    surfaces: ["cli"],
  },
  {
    name: "model",
    args: "[preset]",
    summary: "List or select a model for this conversation",
    usage: "Usage: /model [preset] | /model <provider> <modelId> [thinkingLevel]",
    surfaceUsage: { telegram: "Usage: /model (list the configured presets) or /model <preset> (or /model default)." },
    detail: "/model alone lists this host's choices; a selection applies to this conversation only, while the gateway stays open.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "tools",
    summary: "List the configured coding tools",
    usage: "Usage: /tools",
    detail: "Read-only; chat commands never change tool authority.",
    surfaces: ["cli"],
  },
  {
    name: "refresh",
    summary: "Rebuild this conversation's workspace context",
    usage: "Usage: /refresh",
    detail: "Requires configured workspace context; a busy conversation is refused.",
    surfaces: ["cli"],
  },
  {
    name: "digest",
    args: "[status]",
    summary: "Start one bounded memory-digestion batch",
    usage: "Usage: /digest [status] — start a batch, or read its status.",
    detail: "Runs one bounded background model batch on the shared workspace; /digest status is free.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "mcp",
    args: "[show|approve|deny <id>]",
    summary: "Review and decide MCP owner-approval requests",
    usage: "Usage: /mcp | /mcp show <id> | /mcp approve <id> | /mcp deny <id>.",
    detail: "Owner actions; nothing connects before an approval, and a written entry connects at the next gateway start.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "compact",
    summary: "Admit native compaction of this conversation",
    usage: "Usage: /compact",
    detail: "No transcript entry is deleted.",
    surfaces: ["cli"],
  },
  {
    name: "attach",
    args: "<path>[ -- <prompt>]",
    summary: "Store one local file and submit it as a turn",
    usage: "Usage: /attach <path>[ -- <prompt>] — stored unchanged, submitted path-only.",
    detail: "Requires the media configuration; originals are never auto-deleted.",
    surfaces: ["cli"],
  },
  {
    name: "restart",
    summary: "Replace the whole gateway process",
    usage: "Usage: /restart",
    detail: "Affects every chat and all background work; the acknowledgement confirms the request, not a completed restart.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "help",
    args: "[command]",
    summary: "Show these controls, or one command's detail",
    usage: "Usage: /help [command]",
    detail: "Lists this host's controls; /help <command> adds that command's usage and detail.",
    surfaces: ["cli", "telegram"],
  },
];

const HEADINGS: Record<ConversationSurface, string> = {
  cli: "Local commands in this CLI conversation:",
  telegram: "Controls for this chat (other messages go to the assistant):",
};

/** How a refusal names the surface a command belongs to. */
const SURFACE_LABEL: Record<ConversationSurface, string> = { cli: "terminal", telegram: "Telegram" };

export function findConversationCommand(name: string): ConversationCommand | undefined {
  return CONVERSATION_COMMANDS.find((command) => command.name === name);
}

/** The exact usage line for one catalogued command on one surface, so parsers never restate it. */
export function conversationCommandUsage(name: string, surface: ConversationSurface = "cli"): string {
  const command = findConversationCommand(name);
  return command?.surfaceUsage?.[surface] ?? command?.usage ?? `Usage: /${name}`;
}

/** Every catalogued name for one surface, in catalogue order. */
export function conversationCommandNames(surface: ConversationSurface): readonly string[] {
  return CONVERSATION_COMMANDS.filter((command) => command.surfaces.includes(surface))
    .map((command) => command.name);
}

/** The catalogued names for one surface intersected with the host's exact offer, in catalogue order. */
export function offeredConversationCommands(
  surface: ConversationSurface,
  names: readonly string[],
): readonly ConversationCommand[] {
  const offered = new Set(names);
  return CONVERSATION_COMMANDS.filter((command) => command.surfaces.includes(surface) && offered.has(command.name));
}

/** One listing line: `/name args — summary`. */
export function conversationListingLine(command: ConversationCommand): string {
  const invocation = command.args === undefined ? `/${command.name}` : `/${command.name} ${command.args}`;
  return `${invocation} — ${command.summary}`;
}

/** One per-command detail block: the exact usage line, then the one-sentence detail when there is one. */
export function conversationDetailBlock(
  command: ConversationCommand,
  surface: ConversationSurface = "cli",
): string {
  const usage = conversationCommandUsage(command.name, surface);
  return command.detail === undefined ? usage : `${usage}\n${command.detail}`;
}

/** Listing lines for the offered commands of one surface. */
export function conversationListing(surface: ConversationSurface, names: readonly string[]): string {
  return offeredConversationCommands(surface, names).map(conversationListingLine).join("\n");
}

/** The heading and listing lines for one surface: what a bounded notice can carry on its own. */
export function conversationHelpListing(surface: ConversationSurface, names: readonly string[]): string {
  return `${HEADINGS[surface]}\n\n${conversationListing(surface, names)}`;
}

/**
 * A fixed refusal for a name this surface does not offer: another surface's command is named as
 * such, a catalogued-but-unoffered one says so, and anything else is unknown. Only a safe
 * slash-command name is echoed; no other argument text ever reaches the reply.
 */
export function conversationCommandRefusal(
  surface: ConversationSurface,
  name: string,
  names: readonly string[],
): string {
  const available = names.map((command) => `/${command}`).join(", ");
  const command = findConversationCommand(name);
  if (command === undefined) {
    const echo = SAFE_COMMAND_NAME.test(name) ? ` /${name}` : "";
    return `No such command${echo} here. Available: ${available}.`;
  }
  const elsewhere = command.surfaces.find((candidate) => candidate !== surface);
  const reason = elsewhere !== undefined && !command.surfaces.includes(surface)
    ? `only available in the ${SURFACE_LABEL[elsewhere]}`
    : "not offered by this host";
  return `/${name} is ${reason}. Available: ${available}.`;
}
