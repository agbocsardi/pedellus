/**
 * One declarative catalogue for the slash commands a conversation surface may offer.
 *
 * The catalogue holds text and surface membership only: which names a particular host
 * actually offers is decided by that host and passed in as an exact name set, so no
 * availability logic, capability probe or host reference lives here.
 */

/** Where a conversation command may appear. Process-level help is not a surface. */
export type ConversationSurface = "cli" | "telegram";

export interface ConversationCommand {
  readonly name: string;
  /** Argument placeholder shown in listings after the name; omitted for a no-argument command. */
  readonly args?: string;
  readonly summary: string;
  /** Full `Usage: /name ...` line shown in the per-command detail block. */
  readonly usage: string;
  readonly detail: string;
  readonly surfaces: readonly ConversationSurface[];
}

/** A slash-command name that may be echoed back verbatim in any diagnostic. */
export const SAFE_COMMAND_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Catalogue order is the listing and command-menu order for every surface. */
export const CONVERSATION_COMMANDS: readonly ConversationCommand[] = [
  {
    name: "new",
    summary: "Reset this conversation's context",
    usage: "Usage: /new",
    detail:
      "Native context reset for this conversation: a fresh model context with no summary or handoff. " +
      "Stored history and tool authority are unchanged, and queued messages are kept. A busy conversation " +
      "either refuses the reset or lands it at its next safe boundary.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "abort",
    summary: "Stop this turn and withdraw queued messages",
    usage: "Usage: /abort",
    detail:
      "Withdraw queued messages and stop the current turn here; other chats, cron jobs and background work " +
      "are unaffected.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "stop",
    summary: "Alias of /abort: stop this turn here",
    usage: "Usage: /stop",
    detail: "Alias of /abort with exactly the same effect.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "status",
    summary: "Show this conversation's model and run state",
    usage: "Usage: /status",
    detail:
      "Bounded read-only status: the selected model, run state and queued input count. Nothing is changed, " +
      "no model call is made and no other conversation is visible.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "history",
    args: "[count]",
    summary: "Show recent committed messages",
    usage: "Usage: /history [count] — choose a number from 1 to 50.",
    detail:
      "Print this conversation's most recent committed user and assistant text. Reasoning, tool calls, tool " +
      "output and system entries are not shown, and stored entries are never modified.",
    surfaces: ["cli"],
  },
  {
    name: "search",
    args: "…",
    summary: "Search this conversation's stored messages and tools",
    usage:
      "Usage: /search [--scope messages|tools|all] [--role user|assistant] [--limit 1-50] [--next] [--] [query] " +
      "— default scope is messages; empty text browses the selected scope.",
    detail:
      "Read-only search over this conversation's stored messages and paired tool records. `--next` continues " +
      "the last successful query; cursors stay in this process and are never printed. Sessions default to " +
      "cli:default; pass --session with a key reported here to read another session.",
    surfaces: ["cli"],
  },
  {
    name: "episodes",
    args: "[options]",
    summary: "List reset-delimited episodes of a session",
    usage:
      "Usage: /episodes [--session <sessionKey>] [--limit 1-50] [--before <entryId>] — --session defaults to cli:default.",
    detail:
      "List the reset-delimited episodes of one session, newest first. Read-only; no transcript entry is written.",
    surfaces: ["cli"],
  },
  {
    name: "episode",
    args: "<startEntryId>",
    summary: "Open one episode's displayable entries",
    usage:
      "Usage: /episode [--session <sessionKey>] <startEntryId> [--limit 1-30] — --session defaults to cli:default.",
    detail:
      "Show bounded message and tool entries inside one episode, with its reset boundary. System, reset, " +
      "compaction and thinking content is not shown and stored entries are not modified.",
    surfaces: ["cli"],
  },
  {
    name: "entry",
    args: "<entryId>",
    summary: "Open a bounded window around one entry",
    usage:
      "Usage: /entry [--session <sessionKey>] <entryId> [--radius 0-5] — --session defaults to cli:default with a history host.",
    detail:
      "Print a bounded window of entries around one entry id without reading the whole transcript. The " +
      "default session always works; another --session and cross-session browsing require a host history surface.",
    surfaces: ["cli"],
  },
  {
    name: "model",
    args: "[preset]",
    summary: "List or select a configured model preset",
    usage: "Usage: /model [preset]",
    detail:
      "List the configured model presets and this conversation's selection. `/model <preset>` (or " +
      "`/model default`) selects one for this conversation only; a busy conversation is refused, and a " +
      "restart restores the configured default. A direct-model host lists its catalog instead and selects " +
      "with `/model <provider> <modelId> [thinkingLevel]`; without host model policy the command is read-only.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "tools",
    summary: "List the configured coding tools",
    usage: "Usage: /tools",
    detail:
      "Read-only diagnostics for the coding tools this gateway's configuration allows. Chat commands never " +
      "change tool authority; changing the configured list is a host configuration change.",
    surfaces: ["cli"],
  },
  {
    name: "refresh",
    summary: "Rebuild this conversation's workspace context",
    usage: "Usage: /refresh",
    detail:
      "Re-read workspace context and skills for this conversation when it is idle. A busy conversation is " +
      "refused, and the refreshed summary and skill table apply from the next model request. Requires " +
      "configured workspace context; it is retired on Telegram in favour of /new.",
    surfaces: ["cli"],
  },
  {
    name: "digest",
    args: "[status]",
    summary: "Start one bounded memory-digestion batch",
    usage: "Usage: /digest [status]",
    detail:
      "Start one bounded completed-turn memory-digestion run from the shared workspace, or with `status` " +
      "read its bounded read-only progress. The run is background work against the shared workspace and " +
      "reports only to this conversation's agent: a failure or cancellation leaves an internal issue there, " +
      "never a direct user or channel message. Neither form makes a model call by itself.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "mcp",
    args: "[show|approve|deny <id>]",
    summary: "Review and decide MCP owner-approval requests",
    usage: "Usage: /mcp | /mcp show <id> | /mcp approve <id> | /mcp deny <id>",
    detail:
      "List the MCP servers this gateway opened and the assistant's owner-approval requests. `show <id>` " +
      "prints the exact proposed entry; `approve <id>` writes it to the configuration file or starts an " +
      "owner-approved OAuth login; `deny <id>` discards it. Nothing connects or is authorized before an " +
      "approval, and a written entry connects at the next gateway start. These are owner actions, never model tools.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "compact",
    summary: "Admit native compaction of this conversation",
    usage: "Usage: /compact",
    detail:
      "Admit one native Durable compaction task; Durable decides where its summary is placed. No transcript " +
      "entry is deleted.",
    surfaces: ["cli"],
  },
  {
    name: "attach",
    args: "<path>[ -- <prompt>]",
    summary: "Store one local file and submit it as a path-only turn",
    usage:
      "Usage: /attach <path>[ -- <prompt>] — store one local file under the workspace CLI attachment directory " +
      "and submit it as an ordinary path-only turn. The path may be absolute or relative to the CLI's working " +
      "directory. The original bytes are stored unchanged; the agent decides whether to read them with the " +
      "configured tools. No native image content, vision handoff, transcription or extraction is added. " +
      "Requires the media configuration.",
    detail:
      "The original is stored unchanged under the gateway's CLI attachment directory and is never auto-deleted. " +
      "Requires configured media; without it the command is unavailable.",
    surfaces: ["cli"],
  },
  {
    name: "restart",
    summary: "Replace the whole gateway process",
    usage: "Usage: /restart",
    detail:
      "Stop this gateway and replace the process with the same program, arguments and configuration, so new " +
      "code and configuration are loaded. Every chat and all background work are affected; the acknowledgement " +
      "confirms the request, not the completed restart.",
    surfaces: ["cli", "telegram"],
  },
  {
    name: "help",
    args: "[command]",
    summary: "Show these controls, or one command's usage and detail",
    usage: "Usage: /help [command]",
    detail:
      "Print the controls this host offers. `/help <command>` prints one command's usage and detail when " +
      "this host offers it.",
    surfaces: ["cli", "telegram"],
  },
];

const HEADINGS: Record<ConversationSurface, string> = {
  cli: "Local commands in this CLI conversation:",
  telegram: "Controls for this chat (other messages go to the assistant):",
};

export function findConversationCommand(name: string): ConversationCommand | undefined {
  return CONVERSATION_COMMANDS.find((command) => command.name === name);
}

/** The exact usage line for one catalogued command, so parsers never restate it. */
export function conversationCommandUsage(name: string): string {
  return findConversationCommand(name)?.usage ?? `Usage: /${name}`;
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

/** One per-command detail block: the exact usage line, then the detail text. */
export function conversationDetailBlock(command: ConversationCommand): string {
  return `${command.usage}\n${command.detail}`;
}

/** Listing lines for the offered commands of one surface. */
export function conversationListing(surface: ConversationSurface, names: readonly string[]): string {
  return offeredConversationCommands(surface, names).map(conversationListingLine).join("\n");
}

/** The whole help document for one surface: heading, listing, then one detail block per offered command. */
export function conversationHelpDocument(surface: ConversationSurface, names: readonly string[]): string {
  const offered = offeredConversationCommands(surface, names);
  return [
    HEADINGS[surface],
    offered.map(conversationListingLine).join("\n"),
    offered.map(conversationDetailBlock).join("\n\n"),
  ].join("\n\n");
}

/**
 * A fixed refusal for a name this host does not offer. The typed name is echoed only when it is a
 * safe slash-command name; no other argument text ever reaches the reply.
 */
export function conversationCommandRefusal(name: string, names: readonly string[]): string {
  const echo = SAFE_COMMAND_NAME.test(name) ? ` /${name}` : "";
  const available = names.map((command) => `/${command}`).join(", ");
  return `No such command${echo} here. Available: ${available}.`;
}
