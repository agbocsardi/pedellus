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
  readonly details: readonly string[];
  readonly examples: readonly string[];
}

/** The historical bare form: a terminal attach, kept for compatibility. */
export const COMPATIBILITY_SYNOPSIS = "durable-nanobot --config <path>   (agent, compatibility)";

/** The one sentence every page repeats, because it is the only configuration default. */
export const DEFAULT_CONFIG_NOTE =
  "Without --config, gateway, agent, login, logout and recovery use ~/.durable-nanobot/config.json.";

const CONFIG_OPTION: HelpOption = {
  flags: "--config <path>",
  text:
    "Read exactly this configuration file. Omitting it reads the fixed default below; there is no discovery, " +
    "merging, search or auto-generation.",
};

/** Ordered command entries: this order is the overview and the composed usage block. */
export const COMMANDS: readonly CommandHelp[] = [
  {
    name: "gateway",
    synopsis: "durable-nanobot gateway [--config <path>]",
    summary: "Run the single owner runtime and serve attached conversation surfaces",
    options: [CONFIG_OPTION],
    details: [
      "One gateway owns the Durable store, the configured workspace, memory digestion, cron, tool authority and " +
        "every channel; no other process may own the same configuration.",
      "It serves one private Unix socket under the canonical data directory and, when configured, Telegram. " +
        "An attached CLI is a conversation surface over that socket, so restarting the gateway restarts the runtime.",
      "It writes fixed diagnostics only and never echoes configuration values, credential names, paths or " +
        "provider errors.",
    ],
    examples: ["durable-nanobot gateway", "durable-nanobot gateway --config /path/to/config.json"],
  },
  {
    name: "agent",
    synopsis: "durable-nanobot agent [--config <path>] [--conversation <name>]",
    summary: "Attach this terminal to a running gateway",
    options: [
      CONFIG_OPTION,
      {
        flags: "--conversation <name>",
        text:
          "Attach the separate `cli:<name>` conversation instead of the historical `cli:default`. The name is " +
          "lowercase letters, digits, `_` and `-`, up to 32 characters.",
      },
    ],
    details: [
      "The attachment never opens a second runtime, store or channel: it resumes the conversation's Durable " +
        "transcript, model selection and queued work over the running gateway's private socket.",
      "Without a running gateway that answers on this configuration's local endpoint it fails with one fixed " +
        "diagnostic instead of starting one implicitly.",
      "The bare historical `durable-nanobot --config <path>` form attaches exactly like `agent` and still " +
        "requires an explicit path.",
    ],
    examples: ["durable-nanobot agent", "durable-nanobot agent --conversation work"],
  },
  {
    name: "login",
    synopsis: "durable-nanobot login [--config <path>] [provider] [--auth api_key|oauth]",
    summary: "Store one provider credential in Durable's private credential store",
    options: [
      CONFIG_OPTION,
      { flags: "[provider]", text: "A native Pi AI provider ID; a documented legacy alias is resolved for convenience." },
      { flags: "--auth api_key|oauth", text: "Choose the provider's native API-key or OAuth method instead of the prompt." },
    ],
    details: [
      "Authentication is explicit and terminal-only: the gateway never logs in at startup and no model, chat or " +
        "scheduled run can start a login flow.",
      "It validates the full configuration the same way the gateway does, prepares the canonical configured " +
        "data directory, and writes only Durable's own private credential files there. It opens no gateway, " +
        "store or model turn.",
      "Failures print one fixed diagnostic naming the cause, never credentials, browser URLs, provider errors or paths.",
    ],
    examples: ["durable-nanobot login", "durable-nanobot login openai --auth oauth"],
  },
  {
    name: "logout",
    synopsis: "durable-nanobot logout [--config <path>] [provider]",
    summary: "Remove one stored provider credential",
    options: [CONFIG_OPTION, { flags: "[provider]", text: "A native Pi AI provider ID; a legacy alias is resolved." }],
    details: [
      "Like `login`, this is an explicit terminal command against Durable's private credential store; it never " +
        "runs from a chat turn or at startup.",
      "A missing stored credential is reported as its own fixed failure and nothing is written.",
    ],
    examples: ["durable-nanobot logout", "durable-nanobot logout openai"],
  },
  {
    name: "recovery",
    synopsis: "durable-nanobot recovery [--config <path>] [--cancel <taskId> --fingerprint <sha256>]",
    summary: "Inspect or cancel prepared context that blocks a conversation",
    options: [
      CONFIG_OPTION,
      { flags: "--cancel <taskId>", text: "Cancel exactly this blocked prepared-context task; requires --fingerprint." },
      { flags: "--fingerprint <sha256>", text: "The 64-character lowercase hex fingerprint printed for that task." },
    ],
    details: [
      "Without options it lists the prepared context blocks that stop a conversation from reopening, as JSON on " +
        "standard output.",
      "With both `--cancel` and its exact `--fingerprint` it cancels that one task, so a stale or mistyped pair " +
        "never touches another task.",
    ],
    examples: [
      "durable-nanobot recovery",
      "durable-nanobot recovery --cancel 12 --fingerprint <sha256>",
    ],
  },
];

export function findCommandHelp(name: string): CommandHelp | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** The exact `Usage: durable-nanobot <name> ...` line for one command. */
export function commandUsageLine(command: CommandHelp): string {
  return `Usage: ${command.synopsis}`;
}

const HELP_HINT =
  "Run `durable-nanobot --help` for the overview and `durable-nanobot <command> --help` for one command.";

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
    "durable-nanobot — local assistant gateway and conversation surfaces",
    "",
    "Usage:",
    "  durable-nanobot <command> [options]",
    `  ${COMPATIBILITY_SYNOPSIS}`,
    "",
    "Commands:",
    ...commandRows,
    "",
    "Global options:",
    `  ${CONFIG_OPTION.flags}   ${CONFIG_OPTION.text}`,
    "",
    DEFAULT_CONFIG_NOTE,
    "",
    "Slash commands in an attached CLI conversation (availability depends on the running gateway's capabilities):",
    conversationListing("cli", cliCommands),
    "",
    "Help:",
    "  durable-nanobot --help | -h",
    "  durable-nanobot help [command]",
    "  durable-nanobot <command> --help",
    "  /help [command] inside a CLI conversation or an admitted Telegram chat",
    "",
    HELP_HINT,
  ].join("\n");
}

/** One command page: synopsis, summary, options, details and examples. */
export function renderCommandHelp(command: CommandHelp): string {
  const lines = [
    `durable-nanobot ${command.name}`,
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
  lines.push("Details:", ...command.details.map((detail) => `  ${detail}`), "");
  lines.push("Examples:", ...command.examples.map((example) => `  ${example}`), "");
  lines.push(DEFAULT_CONFIG_NOTE, HELP_HINT);
  return lines.join("\n");
}
