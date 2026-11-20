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
import { generatePushKeys } from "./app-push.js";
import { validAppLabel } from "./app-protocol.js";

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
  | { readonly kind: "revoke"; readonly label: string }
  // Shortcut credentials: `app shortcut add --label <name>` prints the token exactly once.
  | { readonly kind: "shortcut-add"; readonly label: string }
  | { readonly kind: "shortcut-list" }
  | { readonly kind: "shortcut-revoke"; readonly label: string }
  // Local only: generates a VAPID pair and prints it once. No gateway, config or file is involved.
  | { readonly kind: "push-keys" };

export interface AppInvocation {
  readonly command: AppCommand;
  /** Explicit `--config` path; absent means the fixed runtime-home default. */
  readonly configPath: string | undefined;
}

const ACTIONS = new Set(["pair", "devices", "revoke", "push-keys", "shortcut"]);

/** The console's label check is the gateway's own, so any label a device can have can be revoked. */
function validLabelArg(label: string): boolean {
  return validAppLabel(label);
}

/** `app shortcut <add --label <label>|list|revoke <label>> [--config <path>]`. */
function parseShortcut(args: readonly string[]): AppInvocation {
  const [sub, ...rest] = args;
  if (sub === undefined) throw usage();
  if (sub === "list") {
    const flags = new Map<string, string>();
    for (let index = 0; index < rest.length;) {
      const token = rest[index]!;
      if (token !== "--config" || flags.has(token)) throw usage();
      const value = rest[index + 1];
      if (value === undefined) throw usage();
      flags.set(token, value);
      index += 2;
    }
    return { command: { kind: "shortcut-list" }, configPath: flags.get("--config") };
  }
  if (sub === "add" || sub === "revoke") {
    const flags = new Map<string, string>();
    const positional: string[] = [];
    for (let index = 0; index < rest.length;) {
      const token = rest[index]!;
      if (token === "--config" || (sub === "add" && token === "--label")) {
        if (flags.has(token)) throw usage();
        const value = rest[index + 1];
        if (value === undefined) throw usage();
        flags.set(token, value);
        index += 2;
        continue;
      }
      if (token.startsWith("--")) throw usage();
      positional.push(token);
      index += 1;
    }
    // `add` names its label with --label; `revoke` takes exactly one positional label.
    const label = sub === "add" ? flags.get("--label") : positional[0];
    if (label === undefined || positional.length > (sub === "add" ? 0 : 1)) throw usage();
    if (!validLabelArg(label)) {
      throw new AppCommandError(
        `shortcut ${sub} takes a printable shortcut label of 1-40 characters.`,
      );
    }
    return {
      command: sub === "add"
        ? { kind: "shortcut-add", label }
        : { kind: "shortcut-revoke", label },
      configPath: flags.get("--config"),
    };
  }
  throw usage();
}

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
  if (action === "shortcut") return parseShortcut(rest);
  if (action === "push-keys") {
    // Local key generation reads no configuration: any argument is refused, not ignored.
    if (rest.length > 0) throw usage();
    return { command: { kind: "push-keys" }, configPath: undefined };
  }
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
    if (!validLabelArg(label)) {
      throw new AppCommandError("revoke takes a printable device label of 1-40 characters.");
    }
    return { command: { kind: "revoke", label }, configPath: flags.get("--config") };
  }
  if (positional.length > 0) throw usage();
  const label = flags.get("--label");
  if (label !== undefined && !validLabelArg(label)) {
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

/** Shortcut creations share the label rules but have their own reasons. */
const SHORTCUT_REFUSAL_TEXT: Record<string, string> = {
  "invalid-label": "That label is not printable in 1-40 characters.",
  "label-in-use": "An active shortcut token already uses that label.",
  "shortcut-limit": "The shortcut limit is full; revoke one first with \"app shortcut revoke <label>\".",
};

export async function runAppPushKeys(output: NodeJS.WriteStream): Promise<void> {
  const keys = await generatePushKeys();
  output.write([
    `VAPID public key: ${keys.publicKey}`,
    `VAPID private key: ${keys.privateKey}`,
    "Put the private key in the gateway environment file (never in the repository) and reference it by name from app.push.privateKeyEnv; put the public key in app.push.publicKey and a mailto: or https: contact in app.push.subject.",
    "",
  ].join("\n"));
}

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
  if (command.kind === "push-keys") {
    await runAppPushKeys(output);
    return;
  }
  if (command.kind === "shortcut-add") {
    const result = await client.appShortcutAdd(command.label, context);
    if ("refused" in result) throw new AppCommandError(SHORTCUT_REFUSAL_TEXT[result.refused]!);
    output.write([
      `Shortcut token for "${result.label}": ${result.token}`,
      "This token is shown once; only its hash is stored. Send it as `Authorization: Bearer <token>` to `POST /v1/ask`.",
      "It cannot open the stream, upload, download, pair or run controls.",
      "",
    ].join("\n"));
    return;
  }
  if (command.kind === "shortcut-list") {
    const shortcuts = await client.appShortcutList(context);
    if (shortcuts.length === 0) {
      output.write("No shortcut tokens exist. Start one with `durable-nanobot app shortcut add --label <name>`.\n");
      return;
    }
    const rows = shortcuts.map((shortcut) => [
      shortcut.label,
      new Date(shortcut.createdAtMs).toISOString(),
      shortcut.revokedAtMs === undefined
        ? "active"
        : `revoked ${new Date(shortcut.revokedAtMs).toISOString()}`,
    ]);
    const labelWidth = Math.max(...rows.map((row) => row[0]!.length));
    for (const row of rows) {
      output.write(`  ${row[0]!.padEnd(labelWidth)}  created ${row[1]}  ${row[2]}\n`);
    }
    return;
  }
  if (command.kind === "shortcut-revoke") {
    const result = await client.appShortcutRevoke(command.label, context);
    if (result === "missing") {
      throw new AppCommandError(`No active shortcut token has the label "${command.label}".`);
    }
    output.write(`Revoked shortcut "${command.label}". The token no longer authenticates.\n`);
    return;
  }
  const result = await client.appRevoke(command.label, context);
  if (result === "missing") {
    throw new AppCommandError(`No active paired device has the label "${command.label}".`);
  }
  output.write(`Revoked "${command.label}". Its live stream was closed; the token no longer authenticates.\n`);
}
