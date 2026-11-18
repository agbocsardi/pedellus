/**
 * The terminal's owner console for the app channel.
 *
 * It is a process subcommand (`durable-nanobot app ...`), not a chat slash command: the owner runs
 * it from a shell, and it attaches to the running gateway over the existing private socket. The
 * running app adapter decides every authority question — whether a label is free, how many devices
 * exist, which stream a revocation closes — and this module only parses flags, sends one bounded
 * request and renders the answer. No code, token or device hash is ever printed besides the
 * one-time pairing code itself.
 */
import type { Context } from "@earendil-works/chord";
import type { LocalGatewayClient } from "../local/client.js";
import { commandUsage, findCommandHelp, renderCommandHelp } from "../help/cli.js";

/** A refusal or failure to report as `durable-nanobot app: <message>`; exit status 1. */
export class AppCommandError extends Error {
  override name = "AppCommandError";
}

/** A malformed invocation; the command's own help page is the whole diagnostic. */
export class AppUsageError extends Error {
  override name = "AppUsageError";
}

export type AppCommand =
  | { readonly kind: "pair"; readonly label?: string }
  | { readonly kind: "devices" }
  | { readonly kind: "revoke"; readonly label: string };

export interface AppInvocation {
  readonly command: AppCommand;
  /** Explicit `--config` path; absent means the fixed runtime-home default. */
  readonly configPath: string | undefined;
}

const ACTIONS = new Set(["pair", "devices", "revoke"]);

function usage(): AppUsageError {
  const page = findCommandHelp("app");
  return new AppUsageError(page === undefined ? commandUsage("app") : renderCommandHelp(page));
}

/**
 * Parse one process invocation. `pair` takes an optional `--label`, `revoke` takes one positional
 * label, and any other flag is refused rather than silently ignored.
 */
export function parseAppInvocation(args: readonly string[]): AppInvocation {
  const [action, ...rest] = args;
  if (action === undefined || !ACTIONS.has(action)) throw usage();
  const allowed = action === "pair" ? new Set(["--config", "--label"]) : new Set(["--config"]);
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length;) {
    const token = rest[index]!;
    if (token.startsWith("--")) {
      if (!allowed.has(token)) throw usage();
      if (flags.has(token)) throw usage();
      const value = rest[index + 1];
      if (value === undefined) throw usage();
      flags.set(token, value);
      index += 2;
      continue;
    }
    positional.push(token);
    index += 1;
  }
  if (positional.length > 0 && action !== "revoke") throw usage();
  if (action === "revoke" && (positional.length !== 1 || flags.size > 0)) throw usage();
  if (action === "revoke") {
    const label = positional[0]!;
    if (label.length === 0 || label.length > 40 || !/^[\x21-\x7e]+$/.test(label)) {
      throw new AppCommandError("revoke takes a printable device label of 1-40 characters.");
    }
    return { command: { kind: "revoke", label }, configPath: flags.get("--config") };
  }
  if (positional.length > 0) throw usage();
  const label = flags.get("--label");
  if (label !== undefined && (label.length === 0 || label.length > 40 || !/^[\x21-\x7e]+$/.test(label))) {
    throw new AppCommandError("--label takes a printable device label of 1-40 characters.");
  }
  return {
    command: { kind: action as "pair" | "devices", ...(label === undefined ? {} : { label }) },
    configPath: flags.get("--config"),
  };
}

const REFUSAL_TEXT: Record<string, string> = {
  "label-in-use": "That label is already in use by a paired device or an outstanding pairing code.",
  "device-limit": `The device limit is full; revoke a device first with "app revoke <label>".`,
  "pairing-limit": "Too many pairing codes are already outstanding; wait for one to expire or be used.",
  "invalid-label": "That label is not printable in 1-40 characters.",
};

/** Render one command's bounded answer; the caller owns the connection's lifecycle. */
export async function runAppCommand(options: {
  readonly client: LocalGatewayClient;
  readonly command: AppCommand;
  readonly output: NodeJS.WriteStream;
  readonly context: Context;
}): Promise<void> {
  const { client, command, output, context } = options;
  if (command.kind === "pair") {
    const result = await client.appPair(command.label, context);
    if ("refused" in result) throw new AppCommandError(REFUSAL_TEXT[result.refused]);
    output.write([
      `Pairing code: ${result.code}`,
      `Valid until ${new Date(result.expiresAtMs).toISOString()} (single use).`,
      "Enter it in the app's pairing screen; the code works only while the gateway is running.",
      "",
    ].join("\n"));
    return;
  }
  if (command.kind === "devices") {
    const devices = await client.appDevices(context);
    if (devices.length === 0) {
      output.write("No devices are paired. Start one with `durable-nanobot app pair`.\n");
      return;
    }
    const rows = devices.map((device) => [
      device.label,
      new Date(device.createdAtMs).toISOString(),
      device.revokedAtMs === undefined ? "active" : `revoked ${new Date(device.revokedAtMs).toISOString()}`,
    ]);
    const labelWidth = Math.max(...rows.map((row) => row[0]!.length));
    for (const row of rows) {
      output.write(`  ${row[0]!.padEnd(labelWidth)}  created ${row[1]}  ${row[2]}\n`);
    }
    return;
  }
  const result = await client.appRevoke(command.label, context);
  if (result === "missing") {
    throw new AppCommandError(`No active paired device has the label "${command.label}".`);
  }
  output.write(`Revoked "${command.label}". Its live stream was closed; the token no longer authenticates.\n`);
}
