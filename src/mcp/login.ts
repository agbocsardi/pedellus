import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  adaptOAuthProvider,
  authorizeMcp,
} from "@earendil-works/pi-mcp/oauth";
import type { McpHttpServerConfig } from "./config.js";
import { FileMcpOAuthStateStore } from "./oauth-store.js";
import { McpServerConnection, guardedFetch } from "./server.js";

/**
 * One owner-approved OAuth login for a configured Streamable HTTP MCP server.
 *
 * The authorization code flow is the native `@earendil-works/pi-mcp/oauth` implementation: protected
 * resource and authorization server discovery, dynamic client registration, PKCE, state validation
 * and RFC 9207 issuer validation. This module adds only the host policy the gateway needs:
 *
 * - the flow starts only after an explicit owner approval, never at connect time or from a model tool;
 * - the authorization URL is handed to the approving owner surface exactly once, and neither the URL,
 *   the `state` value, the code verifier nor any token is ever returned to the model or written to a
 *   conversation entry;
 * - the callback listener is loopback-only and one flow runs at a time;
 * - the grant is stored in this runtime's private token file and is verified by one real connection
 *   before the login is reported as complete.
 *
 * Limitation: the redirect URI is a loopback address on the gateway host. An owner whose browser runs
 * on another machine must forward that port over SSH to complete the flow; a provider that refuses a
 * non-public client redirect cannot be used with this slice.
 */
export const MCP_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Fixed reasons; they name no URL, body, token or provider message. */
export type McpLoginFailure =
  | "canceled"
  | "authorization-failed"
  | "callback-failed"
  | "token-exchange-failed"
  | "verify-failed";

export type McpLoginOutcome =
  | { readonly ok: true; readonly tools: number }
  | { readonly ok: false; readonly reason: McpLoginFailure };

export interface McpLoginRun {
  /** One-time authorization URL for the approving owner. Never returned to a model-facing surface. */
  readonly authorizationUrl: string;
  /** When this attempt stops waiting for the browser. */
  readonly expiresAtMs: number;
  readonly completion: Promise<McpLoginOutcome>;
}

export interface McpLoginOptions {
  readonly config: McpHttpServerConfig;
  readonly workspace: string;
  /** Private token file for this exact server URL. */
  readonly storePath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** Gateway shutdown or an owner cancellation; the flow stops and stores nothing further. */
  readonly signal?: AbortSignal;
}

function canceled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Start the flow and return once the server has told us where the owner must go. Everything after
 * that (the browser callback, the code exchange and the verification connection) settles through
 * `completion`, so the approving surface is not blocked for minutes.
 */
export async function beginMcpLogin(options: McpLoginOptions): Promise<McpLoginRun> {
  if (options.config.oauth !== true) throw new Error("An MCP login needs a server entry with \"oauth\": true");
  const timeoutMs = options.timeoutMs ?? MCP_LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const callback = await OAuthCallbackServer.listen({ timeoutMs });
  const store = new FileMcpOAuthStateStore(options.storePath, options.config.url);
  let authorizationUrl: URL | undefined;
  let client: McpClient | undefined;
  const provider = new McpOAuthProvider({
    serverUrl: options.config.url,
    redirectUrl: callback.redirectUrl,
    clientMetadata: { client_name: "durable-nanobot" },
    store,
    onRedirect(url) {
      authorizationUrl = url;
    },
  });
  try {
    // The redirect URI changes every attempt, so a dynamic registration made for an earlier one must
    // not be reused. Used tokens are deliberately kept: a failed attempt must not destroy a grant that
    // still works, and a successful exchange overwrites them.
    try {
      await store.load();
    } catch {
      // An unreadable grant is not usable and would block every read; replace it.
      await store.clear();
    }
    await provider.invalidateCredentials("client");
    const signal = options.signal === undefined
      ? AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      : AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    client = new McpClient({ name: "nanobot", version: "0.0.0", requestTimeoutMs: 60_000 });
    try {
      await client.connect(new StreamableHttpTransport({
        url: options.config.url,
        authProvider: adaptOAuthProvider(provider),
        fetch: guardedFetch,
      }));
    } catch (error) {
      // The expected first outcome: the server challenges and the native flow hands us the URL.
      if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
    }
    // A stored grant (possibly just refreshed) already worked, so no browser step was needed. That is
    // an honest outcome, not an unusable authorization endpoint.
    const redirect = authorizationUrl;
    const discoveredTools = redirect === undefined && client.serverCapabilities?.tools !== undefined
      ? (await client.listTools().catch(() => [])).length
      : 0;
    await client.close().catch(() => undefined);
    client = undefined;
    if (canceled(options.signal)) throw new CancelledLoginError();
    if (redirect === undefined) throw new McpAlreadyAuthorizedError(discoveredTools);
    const state = await provider.state();
    const run: McpLoginRun = {
      authorizationUrl: redirect.href,
      expiresAtMs: deadline,
      completion: complete(options, provider, callback, state, deadline),
    };
    return run;
  } catch (error) {
    await client?.close().catch(() => undefined);
    await callback.close().catch(() => undefined);
    throw error;
  }
}

class CancelledLoginError extends Error {
  override name = "CancelledLoginError";
}

/**
 * The configured entry already authenticated with its stored (or freshly refreshed) grant, so the
 * approved login had nothing to authorize. `tools` is the discovered tool count of that connection.
 */
export class McpAlreadyAuthorizedError extends Error {
  override name = "McpAlreadyAuthorizedError";
  constructor(readonly tools: number) {
    super("The MCP server already accepted the stored grant");
  }
}

function outcome(error: unknown, reason: McpLoginFailure): McpLoginOutcome {
  if (error instanceof CancelledLoginError) return { ok: false, reason: "canceled" };
  return { ok: false, reason };
}

async function complete(
  options: McpLoginOptions,
  provider: McpOAuthProvider,
  callback: OAuthCallbackServer,
  state: string,
  deadline: number,
): Promise<McpLoginOutcome> {
  // Cancellation must also stop the browser wait, which has its own five-minute deadline: closing the
  // listener rejects it instead of leaving the gateway shutdown blocked on a browser that will not come.
  let callbackClosed = false;
  const closeCallback = async (): Promise<void> => {
    if (callbackClosed) return;
    callbackClosed = true;
    await callback.close().catch(() => undefined);
  };
  const onAbort = (): void => { void closeCallback(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let code: string;
    let iss: string | undefined;
    try {
      const answer = await callback.waitForCallback(state);
      code = answer.code;
      iss = answer.iss;
    } catch (error) {
      if (canceled(options.signal)) return { ok: false, reason: "canceled" };
      return outcome(error, "callback-failed");
    }
    if (canceled(options.signal)) return { ok: false, reason: "canceled" };
    try {
      await authorizeMcp(provider, {
        serverUrl: options.config.url,
        authorizationCode: code,
        ...(iss === undefined ? {} : { iss }),
        signal: options.signal === undefined
          ? AbortSignal.timeout(Math.max(1, deadline - Date.now()))
          : AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      });
    } catch (error) {
      if (canceled(options.signal)) return { ok: false, reason: "canceled" };
      return outcome(error, "token-exchange-failed");
    }
    if (canceled(options.signal)) return { ok: false, reason: "canceled" };
    // Verify the grant with one real connection. A failure here is reported, and the stored grant
    // stays on disk so the owner can retry the login instead of starting from nothing.
    const connection = new McpServerConnection({
      name: "login-verify",
      config: options.config,
      workspace: options.workspace,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      oauth: { storePath: options.storePath, redirectUrl: callback.redirectUrl },
    });
    try {
      await connection.open();
      if (!connection.connected) return { ok: false, reason: "verify-failed" };
      return { ok: true, tools: connection.toolNames().length };
    } finally {
      await connection.close().catch(() => undefined);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await closeCallback();
  }
}
