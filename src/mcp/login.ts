import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  adaptOAuthProvider,
  authorizeMcp,
} from "@earendil-works/pi-mcp/oauth";
import type { McpHttpServerConfig } from "./config.js";
import {
  FileMcpOAuthStateStore,
  commitMcpOAuthState,
  mcpOAuthGrantEpoch,
  mcpOAuthStagingPath,
} from "./oauth-store.js";
import { McpServerConnection, guardedFetch, headerValues } from "./server.js";

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
 * - the attempt works on a private staging file, so a grant that already works is never deleted to
 *   make room for a new one. The staged state replaces the stored grant only after one real
 *   connection and tool listing verified it;
 * - a logout that happens while the attempt runs increments the grant generation, so the late commit
 *   is refused instead of restoring a grant the owner just deleted.
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
  | "verify-failed"
  | "grant-superseded";

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
  /** Private grant file for this exact server URL. An attempt never writes it before verification. */
  readonly storePath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** Gateway shutdown or an owner cancellation; the flow stops and stores nothing further. */
  readonly signal?: AbortSignal;
}

function canceled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function environment(options: McpLoginOptions): Readonly<Record<string, string | undefined>> {
  return options.environment ?? process.env;
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

  // The attempt starts from a staged copy of the stored grant, so a stored grant that still works
  // makes the approved login a no-op without touching the real file, a refresh rotates the token only
  // in the copy, and a browser attempt or failure never deletes or rewrites what is already stored.
  const stagingPath = mcpOAuthStagingPath(options.storePath);
  const staging = new FileMcpOAuthStateStore(stagingPath, options.config.url);
  const real = new FileMcpOAuthStateStore(options.storePath, options.config.url);
  const stored = await real.load().catch(() => undefined);
  if (stored !== undefined) await staging.save(stored).catch(() => undefined);
  const expectedEpoch = mcpOAuthGrantEpoch(options.storePath);
  if (canceled(options.signal)) {
    await staging.clear().catch(() => undefined);
    throw new CancelledLoginError();
  }
  let callback: OAuthCallbackServer | undefined;
  let client: McpClient | undefined;
  let authorizationUrl: URL | undefined;
  try {
    callback = await OAuthCallbackServer.listen({ timeoutMs });
    const provider = new McpOAuthProvider({
      serverUrl: options.config.url,
      redirectUrl: callback.redirectUrl,
      clientMetadata: { client_name: "durable-nanobot" },
      store: staging,
      onRedirect(url) {
        authorizationUrl = url;
      },
    });
    client = new McpClient({ name: "nanobot", version: "0.0.0", requestTimeoutMs: 60_000 });
    // `McpClient.connect` takes no signal. Closing the client rejects the pending initialize request,
    // so an owner denial or a gateway shutdown also stops a connection that is still being set up.
    const stopStartup = (): void => { void client?.close().catch(() => undefined); };
    const startupTimer = setTimeout(stopStartup, Math.max(1, deadline - Date.now()));
    options.signal?.addEventListener("abort", stopStartup, { once: true });
    try {
      await client.connect(new StreamableHttpTransport({
        url: options.config.url,
        headers: headerValues(options.config, environment(options)),
        authProvider: adaptOAuthProvider(provider),
        fetch: guardedFetch,
      }));
    } catch (error) {
      if (canceled(options.signal)) throw new CancelledLoginError();
      // The expected first outcome: the server challenges and the native flow hands us the URL.
      if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
    } finally {
      clearTimeout(startupTimer);
      options.signal?.removeEventListener("abort", stopStartup);
    }
    if (canceled(options.signal)) throw new CancelledLoginError();
    // A grant in the staging file already worked (the server accepted it without a browser step).
    const redirect = authorizationUrl;
    const discoveredTools = redirect === undefined && client.serverCapabilities?.tools !== undefined
      ? (await client.listTools().catch(() => [])).length
      : 0;
    await client.close().catch(() => undefined);
    client = undefined;
    if (redirect === undefined) {
      // The stored grant (or a token it refreshed in the staged copy) already authenticated. Install
      // the verified copy as an ordinary refresh; a logout that happened meanwhile wins instead.
      const verified = await staging.load().catch(() => undefined);
      if (verified !== undefined) {
        try {
          await commitMcpOAuthState(options.storePath, options.config.url, verified, expectedEpoch);
        } catch {
          throw new McpGrantSupersededError();
        }
      }
      throw new McpAlreadyAuthorizedError(discoveredTools);
    }
    const state = await provider.state();
    const run: McpLoginRun = {
      authorizationUrl: redirect.href,
      expiresAtMs: deadline,
      completion: complete(options, provider, callback, stagingPath, expectedEpoch, options.config.url, state, deadline),
    };
    // `completion` owns the listener from here.
    callback = undefined;
    return run;
  } catch (error) {
    await client?.close().catch(() => undefined);
    await callback?.close().catch(() => undefined);
    await staging.clear().catch(() => undefined);
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

/** The grant was deleted or replaced while the attempt was checking or installing its replacement. */
export class McpGrantSupersededError extends Error {
  override name = "McpGrantSupersededError";
  constructor() {
    super("The stored MCP OAuth grant changed while the login was running");
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
  stagingPath: string,
  expectedEpoch: number,
  serverUrl: string,
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
  const staging = new FileMcpOAuthStateStore(stagingPath, serverUrl);
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
        serverUrl,
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
    // Verify the staged grant with one real connection before it replaces anything on disk. A failure
    // here is reported and the previously stored grant is left untouched.
    const connection = new McpServerConnection({
      name: "login-verify",
      config: options.config,
      workspace: options.workspace,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      oauth: { storePath: stagingPath, redirectUrl: callback.redirectUrl },
    });
    let tools: number;
    try {
      await connection.open();
      if (!connection.connected) return { ok: false, reason: "verify-failed" };
      tools = connection.toolNames().length;
    } finally {
      await connection.close().catch(() => undefined);
    }
    // Install the verified replacement. A logout or another completed login since this attempt began
    // retired the generation, and this commit then refuses rather than undoing that decision.
    try {
      const staged = await staging.load();
      if (staged?.tokens === undefined) return { ok: false, reason: "verify-failed" };
      await commitMcpOAuthState(options.storePath, serverUrl, staged, expectedEpoch);
    } catch {
      return { ok: false, reason: "grant-superseded" };
    }
    return { ok: true, tools };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await closeCallback();
    // The staging file never outlives the attempt, whether it was committed, refused or canceled.
    await staging.clear().catch(() => undefined);
  }
}
