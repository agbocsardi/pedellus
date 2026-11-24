/**
 * Declarative process-level help for the `durable-nanobot` command line.
 *
 * Everything here is plain text: rendering a page reads no configuration, opens no
 * socket and starts no runtime, so `--help` works in a checkout with no setup.
 */
import { conversationCommandNames, conversationListing } from "./commands.js";

export interface HelpOption {
  /** Flags as typed, for example `--config <path>`. */
  readonly flags: string;
  readonly text: string;
}

export interface CommandHelp {
  readonly name: string;
  /** The exact `durable-nanobot <name> ...` invocation line, without the `Usage: ` prefix. */
  readonly synopsis: string;
  readonly summary: string;
  readonly options: readonly HelpOption[];
  /** At most two short notes; the rest belongs in documentation. */
  readonly details: readonly string[];
  readonly examples: readonly string[];
}

/** The historical bare form: a terminal attach, kept for compatibility. */
export const COMPATIBILITY_SYNOPSIS = "pedellus --config <path>   (agent, compatibility)";

/** The fixed primary configuration file, named by the shared --config option line and the usage note. */
const DEFAULT_CONFIG_FILE = "~/.pedellus/config.json";

/** The one sentence the usage block adds after its synopses, because it is the only configuration default. */
const DEFAULT_CONFIG_NOTE = `Without --config, gateway, agent, login, logout, models, recovery, cron and app use ${DEFAULT_CONFIG_FILE}.`;

const CONFIG_OPTION: HelpOption = {
  flags: "--config <path>",
  text: `Read exactly this file; without it, ${DEFAULT_CONFIG_FILE} is used.`,
};

/** Ordered command entries: this order is the overview and the composed usage block. */
export const COMMANDS: readonly CommandHelp[] = [
  {
    name: "gateway",
    synopsis: "pedellus gateway [--config <path>]",
    summary: "Run the single owner runtime and serve conversation surfaces",
    options: [CONFIG_OPTION],
    details: [
      "One gateway owns the store, workspace, cron, tools and every channel.",
      "It serves one private Unix socket; an attached CLI is a conversation surface.",
    ],
    examples: ["pedellus gateway", "pedellus gateway --config /path/to/config.json"],
  },
  {
    name: "agent",
    synopsis: "pedellus agent [--config <path>] [--conversation <name>]",
    summary: "Attach this terminal to a running gateway",
    options: [
      CONFIG_OPTION,
      {
        flags: "--conversation <name>",
        text: "The `cli:<name>` conversation: lowercase/digits/`_`/`-`, 1-32, alphanumeric ends.",
      },
    ],
    details: [
      "Never opens a second runtime, store or channel.",
      "Without a running gateway it fails with one fixed diagnostic.",
    ],
    examples: ["pedellus agent", "pedellus agent --conversation work"],
  },
  {
    name: "login",
    synopsis: "pedellus login [--config <path>] [provider] [--auth api_key|oauth]",
    summary: "Store one provider credential in Pedellus's private store",
    options: [
      CONFIG_OPTION,
      { flags: "[provider]", text: "A native Pi AI provider ID; a documented legacy alias is resolved." },
      { flags: "--auth api_key|oauth", text: "Choose the provider's method instead of the prompt." },
    ],
    details: ["Terminal-only: the gateway never logs in at startup or from a chat turn."],
    examples: ["pedellus login", "pedellus login openai --auth oauth"],
  },
  {
    name: "logout",
    synopsis: "pedellus logout [--config <path>] [provider]",
    summary: "Remove one stored provider credential",
    options: [CONFIG_OPTION, { flags: "[provider]", text: "A native Pi AI provider ID; a legacy alias is resolved." }],
    details: ["The same explicit terminal-only path as login."],
    examples: ["pedellus logout", "pedellus logout openai"],
  },
  {
    name: "models",
    synopsis: "pedellus models <refresh|list> [--config <path>] [provider...]",
    summary: "Refresh or list the native model catalog from pi.dev",
    options: [
      CONFIG_OPTION,
      { flags: "[provider...]", text: "Native provider IDs; default: the native providers this configuration names." },
    ],
    details: [
      "refresh is the only catalog network path; list is offline. Neither grants a model: edit allowedModels.",
      "A refreshed catalog applies at gateway restart or the next /reload that changes model config.",
    ],
    examples: ["pedellus models refresh", "pedellus models list openai-codex"],
  },
  {
    name: "recovery",
    synopsis: "pedellus recovery [--config <path>] [--cancel <taskId> --fingerprint <sha256>]",
    summary: "Inspect or cancel prepared context that blocks a conversation",
    options: [
      CONFIG_OPTION,
      { flags: "--cancel <taskId>", text: "Cancel exactly this blocked task; requires --fingerprint." },
      { flags: "--fingerprint <sha256>", text: "The 64-character lowercase hex fingerprint printed for that task." },
    ],
    details: ["Without options it prints the blocking tasks as JSON; a stale id and fingerprint cancel nothing."],
    examples: [
      "pedellus recovery",
      "pedellus recovery --cancel 12 --fingerprint <sha256>",
    ],
  },
  {
    name: "cron",
    synopsis: "pedellus cron <list|show <jobId>|cancel <jobId>|create> [options] [--config <path>]",
    summary: "Inspect and manage scheduled work on this store's mapped chats",
    options: [
      CONFIG_OPTION,
      { flags: "--offset <n>", text: "list: read the next bounded page at the printed offset." },
      {
        flags: "--origin <sessionKey>",
        text: "create: required mapped chat to schedule on; list prints available keys.",
      },
      { flags: "--key <requestKey>", text: "create: required durable request key; an identical retry dedupes." },
      { flags: "--message <text> [--name <label>]", text: "create: the instruction the agent receives when the job fires." },
      { flags: "--at <iso>|--after <s>|--every <s>|--cron <expr> [--tz <zone>]", text: "create: exactly one schedule." },
      { flags: "--mode background|origin", text: "create: background (default) or in the origin chat." },
    ],
    details: [
      "list and show are read-only; create and cancel act on one exact job through a running gateway.",
      "Nothing is scheduled if the origin is not a mapped chat; nothing is re-armed or edited.",
    ],
    examples: [
      "pedellus cron list",
      "pedellus cron show <jobId>",
      "pedellus cron cancel <jobId>",
      "pedellus cron create --origin <sessionKey> --key wake-1 --after 600 --message \"Stretch\"",
    ],
  },
  {
    name: "app",
    synopsis: "pedellus app <pair|devices|revoke <label>|shortcut> [--config <path>] | app push-keys",
    summary: "Pair or revoke app devices and shortcut tokens, or generate Web Push keys",
    options: [
      CONFIG_OPTION,
      { flags: "--label <label>", text: "pair or shortcut add: optional printable device label (1-40); required for shortcut add." },
      { flags: "<label>", text: "revoke and shortcut revoke: one exact label; a revoked device stream is closed at once." },
    ],
    details: [
      "Needs the app channel configured and the gateway running; every decision is the running adapter's.",
      "A pairing code is single-use and expires after ten minutes; only its hash is stored.",
      "A shortcut token is printed once by `app shortcut add --label <name>` and stored only as a hash; it authenticates exactly POST /v1/ask and never the stream, upload, download, pair or a control. Revocation is immediate.",
      "push-keys needs no gateway and reads no config: it prints one fresh VAPID key pair once and writes nothing.",
    ],
    examples: [
      "pedellus app pair",
      "pedellus app pair --label iphone",
      "pedellus app devices",
      "pedellus app revoke iphone",
      "pedellus app shortcut add --label morning",
      "pedellus app shortcut list",
      "pedellus app shortcut revoke morning",
      "pedellus app push-keys",
    ],
  },
];

export function findCommandHelp(name: string): CommandHelp | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** The exact `Usage: pedellus <name> ...` line for one command. */
export function commandUsageLine(command: CommandHelp): string {
  return `Usage: ${command.synopsis}`;
}

/** The `Usage: ...` line for a catalogued command, resolved per use so a gap fails loudly, not at import. */
export function commandUsage(name: string): string {
  const command = findCommandHelp(name);
  if (command === undefined) throw new Error(`no help entry for the ${name} command`);
  return commandUsageLine(command);
}

const HELP_HINT = "Run `pedellus <command> --help` (or `help <command>`) for one command's page.";

/**
 * The complete usage block for a malformed known form: every synopsis, the only configuration
 * default, and the help hint. It never includes supplied arguments.
 */
export function renderUsage(): string {
  const [first, ...rest] = COMMANDS.map(commandUsageLine);
  const aligned = rest.map((line) => `       ${line.slice("Usage: ".length)}`);
  return [
    ...(first === undefined ? [] : [first]),
    ...aligned,
    `       ${COMPATIBILITY_SYNOPSIS}`,
    DEFAULT_CONFIG_NOTE,
    HELP_HINT,
  ].join("\n");
}

/** The README-sized overview page. It reads no configuration and no runtime state. */
export function renderOverview(): string {
  const widths = Math.max(...COMMANDS.map((command) => command.name.length));
  const commandRows = COMMANDS.flatMap((command) => [
    `  ${command.name.padEnd(widths)}  ${command.synopsis}`,
    `${" ".repeat(widths + 4)}${command.summary}`,
  ]);
  // Availability is a runtime property of the gateway this process would attach to.
  const cliCommands = conversationCommandNames("cli");
  return [
    "pedellus — local assistant gateway and conversation surfaces",
    "",
    "Usage:",
    "  pedellus <command> [options]",
    `  ${COMPATIBILITY_SYNOPSIS}`,
    "",
    "Commands:",
    ...commandRows,
    "",
    "Options:",
    `  ${CONFIG_OPTION.flags}   ${CONFIG_OPTION.text}`,
    "",
    "Slash commands in an attached CLI conversation (availability depends on the gateway):",
    conversationListing("cli", cliCommands),
    "",
    HELP_HINT,
  ].join("\n");
}

/** One command page: synopsis, summary, options, at most two short notes and examples. */
export function renderCommandHelp(command: CommandHelp): string {
  const lines = [
    `pedellus ${command.name}`,
    "",
    commandUsageLine(command),
    "",
    command.summary,
    "",
  ];
  if (command.options.length > 0) {
    const width = Math.max(...command.options.map((option) => option.flags.length));
    lines.push("Options:", ...command.options.map((option) => `  ${option.flags.padEnd(width)}  ${option.text}`), "");
  }
  lines.push("Notes:", ...command.details.map((detail) => `  ${detail}`), "");
  lines.push("Examples:", ...command.examples.map((example) => `  ${example}`), "");
  return lines.join("\n");
}
