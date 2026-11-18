/**
 * One declarative catalogue for the slash commands a conversation surface may offer.
 *
 * The catalogue holds short text and surface membership only: which names a particular host
 * actually offers is decided by that host and passed in as an exact name set, so no
 * availability logic, capability probe or host reference lives here. Every usage line a
 * surface prints for a catalogued command comes from here, so no copy can drift.
 */

/** Where a conversation command may appear. Process-level help is not a surface. */
export type ConversationSurface = "cli" | "telegram" | "discord" | "app";

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
  /** A different true detail for one surface, when part of the general one does not apply there. */
  readonly surfaceDetail?: Partial<Record<ConversationSurface, string>>;
  /** One short fix for a host that lacks this capability; named only on that refusal path. */
  readonly remediation?: string;
  /** One short no-effect guarantee for a refused effect command, where "not offered" alone is too weak. */
  readonly refusalGuarantee?: string;
  readonly surfaces: readonly ConversationSurface[];
}

/**
 * A lowercased, bounded command-shaped token that may be echoed verbatim in any diagnostic. Each
 * parser bounds itself differently (`COMMAND_NAME_MAX` is 32 on Telegram, a CLI name is unbounded),
 * so this echo bound is deliberately tighter than both; `_` and `-` are accepted by at least one
 * surface and `-` also keeps process-level spellings working.
 */
export const SAFE_COMMAND_NAME = /^[a-z][a-z0-9_-]{0,22}$/;

/** Catalogue order is the listing and command-menu order for every surface. */
export const CONVERSATION_COMMANDS: readonly ConversationCommand[] = [
  {
    name: "new",
    summary: "Start a fresh context for this conversation",
    usage: "Usage: /new",
    detail: "A busy conversation refuses it or applies it at its next safe boundary; stored history and tool authority are unchanged.",
    surfaces: ["cli", "telegram", "discord", "app"],
  },
  {
    name: "abort",
    summary: "Stop this turn and withdraw queued messages",
    usage: "Usage: /abort",
    detail: "Other chats, cron runs and background work are unaffected.",
    surfaces: ["cli", "telegram", "discord", "app"],
  },
  {
    name: "stop",
    summary: "Alias of /abort: stop this turn here",
    usage: "Usage: /stop",
    detail: "Exactly the same effect and durable record as /abort.",
    surfaces: ["cli", "telegram", "discord", "app"],
  },
  {
    name: "status",
    summary: "Show this conversation's model and run state",
    usage: "Usage: /status",
    detail: "Read-only: no model call or transcript read; background status may report another chat's run.",
    surfaces: ["cli", "telegram", "discord", "app"],
  },
  {
    name: "notices",
    args: "[dismiss <id>]",
    summary: "Inspect or dismiss this chat's stale host notices",
    usage: "Usage: /notices | /notices dismiss <id>",
    detail: "Lists only non-answer host notices whose delivery outcome is unknown, and retires exactly one by its id. Nothing is resent and model answers are never listed or dismissed.",
    surfaces: ["telegram"],
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
    surfaceUsage: {
      telegram: "Usage: /model (list the configured presets) or /model <preset> (or /model default).",
      discord: "Usage: /model (list the configured presets) or /model <preset> (or /model default).",
      app: "Usage: /model (list the configured presets) or /model <preset> (or /model default).",
    },
    detail: "Applies to this conversation only: a preset lasts until the gateway restarts, a direct pick persists.",
    surfaceDetail: {
      telegram: "Applies to this chat only while the gateway stays open; a restart restores the configured preset.",
      discord: "Applies to this channel only while the gateway stays open; a restart restores the configured preset.",
      app: "Applies to this thread only while the gateway stays open; a restart restores the configured preset.",
    },
    surfaces: ["cli", "telegram", "discord", "app"],
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
    remediation: "Set workspaceContext in the configuration and restart.",
    surfaces: ["cli"],
  },
  {
    name: "digest",
    args: "[status]",
    summary: "Digest closed conversation episodes",
    usage: "Usage: /digest [status] — start a batch, or read its status.",
    detail: "Finishes admitted closed episodes in the shared workspace; /digest status is free.",
    refusalGuarantee: "Nothing was started.",
    surfaces: ["cli", "telegram", "discord", "app"],
  },
  {
    name: "mcp",
    summary: "Show MCP servers and pending logins",
    usage: "Usage: /mcp",
    detail: "Read-only bounded status. Ask the assistant to add, log in, log out or remove a server; no approval command is needed.",
    refusalGuarantee: "Nothing was changed.",
    surfaces: ["cli", "telegram", "discord"],
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
    remediation: "Configure media in the gateway configuration and restart.",
    surfaces: ["cli"],
  },
  {
    name: "restart",
    summary: "Replace the whole gateway process",
    usage: "Usage: /restart",
    detail: "Affects every chat and all background work; refused while live work would be interrupted (count shown in /status), and a confirmation follows once the gateway is live.",
    surfaceDetail: {
      app: "Affects every chat and all background work; refused while live work would be interrupted (count shown in /status). Devices reconnect and replay from their stored cursor.",
    },
    surfaces: ["cli", "telegram", "discord", "app"],
  },
  {
    name: "reload",
    summary: "Reload model presets and credentials from the configuration file",
    usage: "Usage: /reload",
    detail: "Host-only: validates the whole file and applies only model selection, named presets and credentials references; tools, channels, workspace, MCP, background model captures and other settings need /restart, and so does switching between direct-model and preset mode. Refused while any live work exists except an armed native cron timer, including sleeping or blocked background captures.",
    surfaces: ["cli"],
  },
  {
    name: "help",
    args: "[command]",
    summary: "Show these controls, or one command's detail",
    usage: "Usage: /help [command]",
    detail: "Lists this host's controls; /help <command> adds that command's usage and detail.",
    surfaces: ["cli", "telegram", "discord", "app"],
  },
];

const HEADINGS: Record<ConversationSurface, string> = {
  cli: "Local commands in this CLI conversation:",
  telegram: "Controls for this chat (other messages go to the assistant):",
  discord: "Controls for this channel (other messages go to the assistant):",
  app: "Controls for this thread (other messages go to the assistant):",
};

/** How a refusal names the surface a command belongs to, as a complete phrase: "in the terminal", "in Telegram". */
const SURFACE_LABEL: Record<ConversationSurface, string> = {
  cli: "the terminal",
  telegram: "Telegram",
  discord: "Discord",
  app: "the app",
};

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
  const detail = command.surfaceDetail?.[surface] ?? command.detail;
  return detail === undefined ? usage : `${usage}\n${detail}`;
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
 * A fixed refusal for a name this surface does not run: another surface's command is named as
 * such, a catalogued-but-unoffered one says so, a malformed mention of an offered one names the
 * typo instead of denying the command, and anything else is unknown. Only a safe slash-command
 * name is echoed; no other argument text ever reaches the reply.
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
  if (names.includes(name)) {
    // An offered command cannot be refused as unavailable: the name that reached here is malformed.
    return `/${name} is offered here; that mention is malformed, so use /${name} without one.`;
  }
  const elsewhere = command.surfaces.find((candidate) => candidate !== surface);
  if (elsewhere !== undefined && !command.surfaces.includes(surface)) {
    return `/${name} is only available in ${SURFACE_LABEL[elsewhere]}. Available: ${available}.`;
  }
  // This host lacks the capability: the short fix and the no-effect guarantee belong on that path.
  const fix = command.remediation === undefined ? "" : ` ${command.remediation}`;
  const noEffect = command.refusalGuarantee === undefined ? "" : ` ${command.refusalGuarantee}`;
  return `/${name} is not offered by this host.${fix}${noEffect} Available: ${available}.`;
}
