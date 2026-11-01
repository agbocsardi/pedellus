import { randomBytes } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  defineTool,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";
import { parseMcpConfig, mcpServerEnabled, type McpConfig, type McpHttpServerConfig, type McpServerConfig } from "./config.js";
import { removeMcpServerEntry, writeMcpServerEntry, type McpConfigEdit } from "./install.js";
import {
  beginMcpLogin,
  McpAlreadyAuthorizedError,
  McpGrantSupersededError,
  type McpLoginFailure,
  type McpLoginOutcome,
  type McpLoginRun,
} from "./login.js";
import { FileMcpOAuthStateStore, mcpOAuthStatePath } from "./oauth-store.js";
import { MissingEnvironmentError, type McpServerStatus } from "./server.js";
import { looksLikeOAuthCallback, type McpSurfaceRegistry } from "./surface.js";

/**
 * Direct, explicitly owner-authorized MCP management.
 *
 * An authenticated mapped ordinary chat can ask the assistant to add or update a server entry,
 * start an OAuth login, delete a stored grant, or remove an entry. The model tool performs the
 * operation; there is no proposal record and no separate `/mcp approve` gate. The same config
 * validation, serialized atomic write, stale-file refusal and exact-entry binding are retained.
 *
 * A login's one-time authorization URL is delivered directly to the live surface that owns the
 * initiating session and never appears in a tool result, transcript or durable channel record.
 * The owner can finish consent in a same-host browser, or paste the callback URL back into that
 * same chat; that ingress completes the native PKCE flow before any model dispatch.
 */
export const MCP_ADMIN_TOOL_NAME = "mcp";

export const MCP_ADMIN_LIMITS = Object.freeze({
  /** One server entry, serialized. */
  maxEntryBytes: 8 * 1024,
  maxTextChars: 4_000,
  maxOutcomeChars: 300,
  maxNameChars: 64,
} as const);

export interface McpAdminServer {
  readonly name: string;
  readonly kind: "stdio" | "http";
  readonly enabled: boolean;
  readonly oauth: boolean;
  readonly state?: "connected" | "failed" | "closed";
  readonly failure?: string;
  readonly tools?: number;
}

export interface McpAdminStatus {
  readonly name: string;
  readonly requestId: string;
  readonly expiresAtMs: number;
}

export interface McpAdminListing {
  readonly configured: boolean;
  readonly servers: readonly McpAdminServer[];
  readonly logins: readonly McpAdminStatus[];
}

/** The result of one callback-looking ingress message. Never contains a code, state or token. */
export interface McpCallbackResult {
  /** True when the text was a callback and was consumed instead of becoming model input. */
  readonly handled: boolean;
  /** True when the native flow accepted it. */
  readonly accepted: boolean;
  /** Fixed, credential-free text for the authenticated surface. */
  readonly text: string;
}

export interface McpAdminOptions {
  /** Gateway-lifetime context for flows that outlive one tool call. */
  readonly context: Context;
  /** The configuration file this gateway loaded; direct management writes it. */
  readonly edit: McpConfigEdit;
  /** Canonical data directory; OAuth grants live under it and never in the workspace. */
  readonly dataDir: string;
  /** The configuration this gateway currently reflects. */
  readonly config: () => McpConfig | undefined;
  /**
   * Apply a validated configuration to the live gateway: connect new or changed servers, close
   * removed ones, reinstall registrations and refresh tool policy. The write already happened.
   */
  readonly applyConfig: (config: McpConfig) => Promise<void>;
  /** Close and reconnect one configured server, for example after a login or logout. */
  readonly reconnect: (name: string) => Promise<void>;
  /** Live connection status of the configured servers, read at call time. */
  readonly servers: () => readonly McpServerStatus[];
  /** The authenticated session key that owns the initiating conversation, if it has one. */
  readonly sessionKeyFor: (conversationId: ConversationId) => string | undefined;
  /** Live owner surfaces, keyed by exact authenticated session. */
  readonly surfaces: McpSurfaceRegistry;
  /** True only for authenticated ordinary mapped chats: never workers, forks or task-owned scopes. */
  readonly isAuthorizedChat: (conversationId: ConversationId) => boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}

export interface McpAdmin {
  readonly extension: Extension;
  list(context: Context): Promise<McpAdminListing>;
  /**
   * Consume one callback-looking ingress message. The caller must invoke this before admitting the
   * text as model input. Malformed, stale, replay, and cross-session callbacks are consumed and
   * refused with fixed text; their values are never persisted or returned to the model.
   */
  submitCallback(sessionKey: string, text: string, context: Context): Promise<McpCallbackResult>;
  /** Stop a running login; a completed one keeps its stored grant. */
  close(): Promise<void>;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ActiveLogin {
  readonly requestId: string;
  readonly name: string;
  readonly sessionKey: string;
  readonly run: McpLoginRun;
  readonly abort: AbortController;
  submitted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function failureText(reason: McpLoginFailure): string {
  switch (reason) {
    case "canceled":
      return "the login was canceled and no grant was completed";
    case "authorization-failed":
      return "the server's authorization endpoint could not be used";
    case "callback-failed":
      return "the browser callback did not arrive with a valid state";
    case "token-exchange-failed":
      return "the authorization code was not accepted";
    case "verify-failed":
      return "the stored grant was refused by the server";
    case "grant-superseded":
      return "the stored grant was deleted or replaced while the login was running";
  }
}

function loginOutcomeText(name: string, outcome: McpLoginOutcome, refreshFailed: boolean): string {
  if (outcome.ok) {
    return refreshFailed
      ? `MCP login for "${name}" completed and the grant is stored, but the live refresh did not complete. ` +
        "The server's fixed status shows the connection result."
      : `MCP login for "${name}" completed: ${outcome.tools} tool(s) discovered and available now.`;
  }
  return `MCP login for "${name}" did not complete: ${failureText(outcome.reason)}.`;
}

function loginStartText(name: string): string {
  return `OAuth login started for "${name}". The one-time authorization URL was sent directly to this ` +
    "authenticated owner surface; it is not part of this tool result. Open it as the owner, then either let " +
    "the browser reach this host or paste the callback URL back into this same chat. Tools become available " +
    "when the callback completes; no restart or slash approval is needed.";
}

/** Validate one entry exactly as a gateway start would, accepting no other config field. */
function validateEntry(workspace: string, name: string, entry: unknown): McpServerConfig {
  if (!NAME_PATTERN.test(name) || name.length > MCP_ADMIN_LIMITS.maxNameChars) {
    throw new Error("server name must use only letters, digits, _ and - (at most 64 characters)");
  }
  if (!isRecord(entry)) throw new Error("server must be an object with a command (stdio) or url (HTTP) entry");
  if (Buffer.byteLength(JSON.stringify(entry), "utf8") > MCP_ADMIN_LIMITS.maxEntryBytes) {
    throw new Error(`server entry must be at most ${MCP_ADMIN_LIMITS.maxEntryBytes} bytes`);
  }
  const parsed = parseMcpConfig({ enabled: true, servers: { [name]: entry } }, workspace);
  const config = parsed.servers[name];
  if (config === undefined) throw new Error("server entry did not validate");
  return config;
}

export function renderMcpListing(listing: McpAdminListing, maxChars: number = MCP_ADMIN_LIMITS.maxTextChars): string {
  const lines: string[] = [];
  lines.push(listing.configured
    ? `MCP servers in this gateway's live configuration: ${listing.servers.length}`
    : "MCP is not configured in this gateway (no enabled server entry).");
  for (const server of listing.servers) {
    const state = server.state === undefined
      ? server.enabled ? "configured, not connected" : "disabled"
      : server.state === "connected"
        ? `connected, ${server.tools ?? 0} tools`
        : server.state === "closed" ? "closed" : `failed: ${server.failure ?? "unknown"}`;
    lines.push(`- ${server.name} (${server.kind}${server.oauth ? ", oauth" : ""}): ${state}`);
  }
  if (listing.logins.length === 0) {
    lines.push("OAuth logins waiting for a callback: none.");
  } else {
    for (const login of listing.logins) {
      lines.push(
        `- OAuth login for ${login.name} waiting for its callback until ` +
        `${new Date(login.expiresAtMs).toISOString()}.`,
      );
    }
  }
  return bounded(lines.join("\n"), maxChars);
}

/** Whether a pasted callback is this exact active attempt: same loopback origin, path and state. */
function callbackMatches(run: McpLoginRun, pasted: URL): boolean {
  if (pasted.protocol !== "http:") return false;
  let expected: URL;
  try {
    expected = new URL(run.callbackUrl);
  } catch {
    return false;
  }
  return pasted.host === expected.host
    && pasted.pathname === expected.pathname
    && pasted.searchParams.get("state") === run.state
    && (pasted.searchParams.has("code") || pasted.searchParams.has("error"));
}

function callbackUrl(text: string): URL | undefined {
  try {
    return new URL(text.trim());
  } catch {
    return undefined;
  }
}

const CALLBACK_STALE =
  "No MCP login is waiting for a callback in this chat. The authorization response was not sent to " +
  "the assistant and was not stored; start a new login if one is still needed.";
const CALLBACK_REJECTED =
  "This OAuth callback did not match the active login for this chat, or it was already used. Nothing " +
  "was sent to the assistant and nothing was stored; start a new login if one is still needed.";
const CALLBACK_ACCEPTED =
  "Authorization callback received for this chat's active MCP login. The gateway is completing the " +
  "token exchange and verification now; the callback values were not sent to the assistant or stored.";

export function createMcpAdmin(options: McpAdminOptions): McpAdmin {
  const now = options.now ?? Date.now;
  let active: ActiveLogin | undefined;
  let closed = false;
  const silent = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(operation);
    queue = next.catch(() => undefined);
    return next;
  };

  const currentConfig = (): McpConfig | undefined => options.config();

  const configuredEntry = (name: string): McpServerConfig | undefined =>
    currentConfig()?.servers[name];

  const listingOf = async (): Promise<McpAdminListing> => {
    const config = currentConfig();
    const live = new Map(options.servers().map((status) => [status.name, status]));
    const servers: McpAdminServer[] = Object.entries(config?.servers ?? {})
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([name, entry]) => {
        const status = live.get(name);
        return Object.freeze({
          name,
          kind: "url" in entry ? "http" as const : "stdio" as const,
          enabled: mcpServerEnabled(entry),
          oauth: "url" in entry && entry.oauth === true,
          ...(status === undefined ? {} : {
            state: status.state,
            tools: status.tools,
            ...(status.failure === undefined ? {} : { failure: status.failure }),
          }),
        });
      });
    return Object.freeze({
      configured: servers.some((server) => server.enabled),
      servers,
      logins: active === undefined
        ? []
        : [Object.freeze({ name: active.name, requestId: active.requestId, expiresAtMs: active.run.expiresAtMs })],
    });
  };

  /** A direct change to the same server supersedes a login still waiting for its callback. */
  const cancelLoginFor = (name: string): boolean => {
    if (active === undefined || active.name !== name) return false;
    silent.add(active.requestId);
    active.abort.abort();
    active = undefined;
    return true;
  };

  const startLogin = async (
    sessionKey: string,
    name: string,
    config: McpHttpServerConfig,
  ): Promise<{ readonly ok: boolean; readonly text: string }> => {
    if (closed) return { ok: false, text: "MCP management is shutting down; no login was started." };
    if (active !== undefined) {
      return {
        ok: false,
        text: `An MCP login for "${active.name}" is already waiting for its callback; finish or cancel it before starting another.`,
      };
    }
    if (config.oauth !== true) {
      return { ok: false, text: `Server "${name}" does not use OAuth (its entry needs "oauth": true first).` };
    }
    const surface = options.surfaces.surfaceFor(sessionKey);
    if (surface === undefined) {
      return {
        ok: false,
        text: `No authenticated owner surface is attached to this chat, so the one-time authorization URL ` +
          `for "${name}" could not be delivered. No login was started.`,
      };
    }
    const abort = new AbortController();
    let run: McpLoginRun;
    try {
      run = await beginMcpLogin({
        config,
        workspace: options.edit.workspace,
        storePath: mcpOAuthStatePath(options.dataDir, config.url),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        signal: abort.signal,
      });
    } catch (error) {
      if (error instanceof McpAlreadyAuthorizedError) {
        try {
          await options.reconnect(name);
        } catch {
          // The fixed status reports the failed connection; the grant itself is valid.
        }
        const tools = error.tools;
        return {
          ok: true,
          text: tools === undefined
            ? `Server "${name}" already accepted the stored grant: one connection authenticated, but its tool ` +
              "listing failed, so the tool count is unknown. No browser authorization was needed."
            : `Server "${name}" already accepted the stored grant and was verified with one connection ` +
              `(${tools} tool(s)). No browser authorization was needed; its tools are available now.`,
        };
      }
      if (error instanceof McpGrantSupersededError) {
        return {
          ok: false,
          text: `MCP login for "${name}" was not applied: its stored grant was deleted or replaced while the ` +
            "login was checking it. A logout always wins; start a new login if one is still needed.",
        };
      }
      if (error instanceof MissingEnvironmentError) {
        return {
          ok: false,
          text: `MCP login for "${name}" could not start: environment variable ${error.variable} (a configured ` +
            "header or child variable) is not set on this host. No grant was stored and nothing was connected.",
        };
      }
      return {
        ok: false,
        text: `MCP login for "${name}" could not start: the server's authorization endpoint was not usable. ` +
          "No grant was stored and nothing was connected.",
      };
    }
    const requestId = randomBytes(8).toString("hex");
    const attempt: ActiveLogin = { requestId, name, sessionKey, run, abort, submitted: false };
    active = attempt;
    try {
      await surface.deliverAuthorization(sessionKey, {
        requestId,
        name,
        url: run.authorizationUrl,
        expiresAtMs: run.expiresAtMs,
      }, options.context);
    } catch {
      silent.add(requestId);
      abort.abort();
      if (active === attempt) active = undefined;
      return {
        ok: false,
        text: `The one-time authorization URL for "${name}" could not be confirmed as delivered to this chat, so ` +
          "the login was canceled. Start a new login to get a fresh URL.",
      };
    }
    void run.completion.then(async (outcome) => {
      if (active === attempt) active = undefined;
      if (silent.delete(requestId)) return;
      let reconnectFailed = false;
      if (outcome.ok) {
        try {
          await options.reconnect(name);
        } catch {
          reconnectFailed = true;
        }
      }
      const current = options.surfaces.surfaceFor(sessionKey);
      await current?.deliverNotice(sessionKey, loginOutcomeText(name, outcome, reconnectFailed), options.context)
        .catch(() => undefined);
    }).catch(() => undefined);
    return { ok: true, text: loginStartText(name) };
  };

  const add = async (
    sessionKey: string,
    name: string,
    entry: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly text: string }> => {
    let parsed: McpServerConfig;
    try {
      parsed = validateEntry(options.edit.workspace, name, entry);
    } catch (error) {
      return {
        ok: false,
        text: `Configuration not written: ${error instanceof Error ? error.message : "invalid entry"}.`,
      };
    }
    const canceledLogin = cancelLoginFor(name);
    let written;
    try {
      const before = currentConfig();
      const expected = {
        enabled: before?.enabled === true,
        servers: before === undefined
          ? []
          : Object.keys(before.servers).sort((left, right) => left.localeCompare(right, "en-US")),
      };
      written = await writeMcpServerEntry(options.edit, name, entry, expected);
    } catch (error) {
      return {
        ok: false,
        text: `Configuration not written: ${error instanceof Error ? error.message : "the write failed"}.`,
      };
    }
    try {
      await options.applyConfig(written.config);
    } catch {
      return {
        ok: true,
        text: `Server "${name}" was written to the configuration file, but live activation failed. ` +
          "Its status reports a fixed connection failure; a later management action can retry it.",
      };
    }
    const live = options.servers().find((server) => server.name === name);
    if (mcpServerEnabled(parsed) && "url" in parsed && parsed.oauth === true && live?.state !== "connected") {
      const login = await startLogin(sessionKey, name, parsed);
      return {
        ok: login.ok,
        text: `Server "${name}" was written to the configuration file and the gateway now reflects it. ${login.text}`,
      };
    }
    if (!mcpServerEnabled(parsed)) {
      return {
        ok: true,
        text: `Server "${name}" was written to the configuration file with enabled: false, so it is not ` +
          "connected now. Ask to add or configure it as enabled when it should become active.",
      };
    }
    const state = live === undefined
      ? "no live connection state"
      : live.state === "connected"
        ? `connected with ${live.tools} tool(s)`
        : `connection failed: ${live.failure ?? "unknown"}`;
    return {
      ok: true,
      text: `Server "${name}" was written to the configuration file and activated now: ${state}. ` +
        (canceledLogin ? "Its earlier waiting login was canceled by this change. " : "") +
        "Authenticated mapped chats receive its tools on their next request; existing worker captures are unchanged.",
    };
  };

  const remove = async (name: string): Promise<{ readonly ok: boolean; readonly text: string }> => {
    const canceledLogin = cancelLoginFor(name);
    const config = currentConfig();
    const entry = config?.servers[name];
    if (config === undefined || !config.enabled || entry === undefined) {
      return { ok: false, text: `Server "${name}" is not configured in this gateway.` };
    }
    let written;
    try {
      written = await removeMcpServerEntry(options.edit, name, entry);
    } catch (error) {
      return {
        ok: false,
        text: `Configuration not changed: ${error instanceof Error ? error.message : "the write failed"}.`,
      };
    }
    try {
      await options.applyConfig(written.config);
    } catch {
      return {
        ok: true,
        text: `Server "${name}" was removed from the configuration file, but the live registration refresh ` +
          "failed. Its tools fail closed until the next management action.",
      };
    }
    return {
      ok: true,
      text: `Server "${name}" was removed from the configuration and its live tools were retired now. ` +
        (canceledLogin ? "Its waiting login was canceled. " : "") +
        "A stored OAuth grant is kept; ask for a logout to delete it.",
    };
  };

  const logout = async (name: string): Promise<{ readonly ok: boolean; readonly text: string }> => {
    const canceledLogin = cancelLoginFor(name);
    const config = currentConfig();
    const entry = config?.servers[name];
    if (config === undefined || !config.enabled || entry === undefined || !("url" in entry) || entry.oauth !== true) {
      return {
        ok: false,
        text: `Server "${name}" is not a configured OAuth Streamable HTTP server in this gateway.`,
      };
    }
    try {
      await new FileMcpOAuthStateStore(mcpOAuthStatePath(options.dataDir, entry.url), entry.url).clear();
    } catch {
      return { ok: false, text: `The stored grant for "${name}" could not be deleted.` };
    }
    try {
      await options.reconnect(name);
    } catch {
      // The grant is gone; the reopened connection reports its own fixed failure.
    }
    return {
      ok: true,
      text: `Deleted the stored OAuth grant for "${name}" and retired its live tools now. ` +
        (canceledLogin ? "Its waiting login was canceled. " : "") +
        "A refresh that completes afterwards cannot restore the deleted grant; the entry reports " +
        "`auth-required` until a new login.",
    };
  };

  const statusText = async (): Promise<string> => renderMcpListing(await listingOf());

  return {
    extension: defineExtension({
      name: "nanobot-mcp-admin",
      tools: [
        defineTool({
          name: MCP_ADMIN_TOOL_NAME,
          // A configuration write or login is an external effect; an interrupted call is never rerun.
          replay: "unsafe",
          description:
            "MCP server management, directly executed for this authenticated owner chat. `status` reports " +
            "configured servers and any login waiting for a callback. `add` (alias `configure`) writes or " +
            "updates one server entry and activates it now; `login` starts an OAuth login and sends its " +
            "one-time URL directly to this owner surface; `logout` deletes a stored grant; `remove` deletes " +
            "an entry. A stdio command runs as a local process on this host. No separate approval command is " +
            "needed, and this tool never returns a credential or authorization URL.",
          parameters: Type.Object({
            action: Type.Unsafe<string>({
              type: "string",
              enum: ["status", "add", "configure", "login", "logout", "remove"],
            }),
            name: Type.Optional(Type.String({
              description: "Server name: letters, digits, _ and - only.",
            })),
            server: Type.Optional(Type.Unsafe<Record<string, unknown>>({
              type: "object",
              additionalProperties: true,
              description:
                "MCP config entry for `add`: exactly one of `command` (stdio) or `url` (HTTP), plus " +
                "optional `args`, `cwd`, `env`, `headers`, `oauth`, `description`, `timeoutSeconds`, `enabled`. " +
                "`env` and `headers` values are host environment variable NAMES, never secrets.",
            })),
          }),
          outputLimits: { maxBytes: 32 * 1024, maxLines: 500, retain: "head" },
          async execute(args, api, context) {
            return serialize(async () => {
              const action = typeof args.action === "string" ? args.action : "";
              if (action === "status") {
                return { output: [{ type: "text" as const, text: await statusText() }] };
              }
              if (action !== "add" && action !== "configure" && action !== "login" && action !== "logout" && action !== "remove") {
                return {
                  output: [{
                    type: "text" as const,
                    text: "action must be \"status\", \"add\", \"configure\", \"login\", \"logout\" or \"remove\".",
                  }],
                  isError: true,
                };
              }
              const name = typeof args.name === "string" ? args.name.trim() : "";
              if (name === "" || !NAME_PATTERN.test(name) || name.length > MCP_ADMIN_LIMITS.maxNameChars) {
                return {
                  output: [{ type: "text" as const, text: "A server name is required: letters, digits, _ and - only." }],
                  isError: true,
                };
              }
              if (action === "add" || action === "configure") {
                if (!isRecord(args.server)) {
                  return {
                    output: [{ type: "text" as const, text: "`server` is required for add/configure." }],
                    isError: true,
                  };
                }
                const result = await add(requireSessionKey(api.conversationId), name, args.server);
                return result.ok
                  ? { output: [{ type: "text" as const, text: result.text }] }
                  : { output: [{ type: "text" as const, text: result.text }], isError: true };
              }
              const configured = configuredEntry(name);
              if (action === "login" || action === "logout") {
                if (configured === undefined || !("url" in configured)) {
                  return {
                    output: [{
                      type: "text" as const,
                      text: `Server "${name}" is not a configured Streamable HTTP server in this gateway.`,
                    }],
                    isError: true,
                  };
                }
                if (action === "login" && !mcpServerEnabled(configured)) {
                  return {
                    output: [{
                      type: "text" as const,
                      text: `Server "${name}" is configured with enabled: false, so a login could not activate it. ` +
                        "Add or configure it as enabled first.",
                    }],
                    isError: true,
                  };
                }
              }
              if (action === "login") {
                const result = await startLogin(
                  requireSessionKey(api.conversationId),
                  name,
                  configured as McpHttpServerConfig,
                );
                return result.ok
                  ? { output: [{ type: "text" as const, text: result.text }] }
                  : { output: [{ type: "text" as const, text: result.text }], isError: true };
              }
              const result = action === "logout" ? await logout(name) : await remove(name);
              return result.ok
                ? { output: [{ type: "text" as const, text: result.text }] }
                : { output: [{ type: "text" as const, text: result.text }], isError: true };
            });
          },
        }),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool(call, api) {
            if (call.name !== MCP_ADMIN_TOOL_NAME) return undefined;
            if (!options.isAuthorizedChat(api.conversationId)) {
              return { block: "MCP management is not enabled for this conversation" };
            }
            if (options.sessionKeyFor(api.conversationId) === undefined) {
              return { block: "MCP management requires an authenticated foreground chat with an owner surface" };
            }
            return undefined;
          },
        }),
      ],
    }),
    list: listingOf,
    async submitCallback(sessionKey, text, context) {
      if (!looksLikeOAuthCallback(text)) {
        return { handled: false, accepted: false, text: "" };
      }
      return serialize(async () => {
        if (active === undefined) return { handled: true, accepted: false, text: CALLBACK_STALE };
        if (active.sessionKey !== sessionKey) {
          return { handled: true, accepted: false, text: CALLBACK_REJECTED };
        }
        const pasted = callbackUrl(text);
        if (pasted === undefined || !callbackMatches(active.run, pasted) || active.submitted) {
          return { handled: true, accepted: false, text: CALLBACK_REJECTED };
        }
        active.submitted = true;
        const accepted = await active.run.submitCallback(pasted).catch(() => "rejected" as const);
        return accepted === "accepted"
          ? { handled: true, accepted: true, text: CALLBACK_ACCEPTED }
          : { handled: true, accepted: false, text: CALLBACK_REJECTED };
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const attempt = active;
      if (attempt === undefined) return;
      silent.add(attempt.requestId);
      attempt.abort.abort();
      active = undefined;
      // The flow observes the abort and closes its callback listener; the store is already open and
      // no grant is installed by a canceled attempt.
      await attempt.run.completion.catch(() => undefined);
      silent.delete(attempt.requestId);
    },
  };

  function requireSessionKey(conversationId: ConversationId): string {
    const sessionKey = options.sessionKeyFor(conversationId);
    if (sessionKey === undefined) throw new Error("MCP management requires an authenticated foreground chat");
    return sessionKey;
  }
}
