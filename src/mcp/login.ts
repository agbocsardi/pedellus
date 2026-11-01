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
  adoptMcpOAuthRefresh,
  commitMcpOAuthState,
  mcpOAuthStagingPath,
  snapshotMcpOAuthGrant,
  type McpOAuthGrantSnapshot,
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
 * - the attempt works on a private staging file seeded from the stored grant, so a grant that already
 *   works is not deleted to make room for a new one and the stored grant is replaced only after one
 *   real connection and tool listing verified the staged replacement. A refresh performed during the
 *   attempt is the one exception to "the stored file is not rewritten": the authorization server has
 *   already issued that token and may have invalidated the previous refresh token, so the rotated
 *   grant is adopted immediately instead of being thrown away with a failed attempt;
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

  // The attempt starts from a staged copy of the stored grant, read together with the grant
  // generation it will commit against, so a logout cannot land between the two and hand the attempt
  // a fresh expectation for a grant it copied before the deletion.
  const serverUrl = options.config.url;
  const stagingPath = mcpOAuthStagingPath(options.storePath);
  const staging = new FileMcpOAuthStateStore(stagingPath, serverUrl);
  const snapshot = await snapshotMcpOAuthGrant(options.storePath, serverUrl);
  if (snapshot.state !== undefined) await staging.save(snapshot.state).catch(() => undefined);
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
    // A connection that refreshed the seeded grant already changed the token at the authorization
    // server, which may have invalidated the previous refresh token. Adopt the rotated grant now, so a
    // later browser failure or cancellation cannot leave a stored grant that no longer works.
    await adoptStagedRefresh(staging, snapshot, options.storePath, serverUrl);
    // A grant in the staging file already worked (the server accepted it without a browser step).
    const redirect = authorizationUrl;
    // A tool listing failure is reported as unknown instead of being counted as zero tools: the
    // connection did authenticate, but verification did not see what the server offers.
    let discovered: number | undefined;
    if (client.serverCapabilities?.tools === undefined) {
      discovered = 0;
    } else {
      discovered = await client.listTools().then((tools) => tools.length, () => undefined);
    }
    await client.close().catch(() => undefined);
    client = undefined;
    if (redirect === undefined) {
      // The stored grant (or a token it refreshed in the staged copy) already authenticated. Install
      // the verified copy as an ordinary refresh; a logout that happened meanwhile wins instead.
      const verified = await staging.load().catch(() => undefined);
      if (verified !== undefined) {
        try {
          await commitMcpOAuthState(options.storePath, serverUrl, verified, snapshot.epoch, options.signal);
        } catch {
          if (canceled(options.signal)) throw new CancelledLoginError();
          throw new McpGrantSupersededError();
        }
      }
      throw new McpAlreadyAuthorizedError(discovered);
    }
    const state = await provider.state();
    const run: McpLoginRun = {
      authorizationUrl: redirect.href,
      expiresAtMs: deadline,
      completion: complete(options, provider, callback, stagingPath, snapshot.epoch, serverUrl, state, deadline),
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
 * Persist the grant one staged connection already refreshed.
 *
 * Only a rotation of a grant the attempt read is adopted: a browser authorization that has not been
 * verified yet is never written, and `adoptMcpOAuthRefresh` refuses when the stored grant was replaced
 * or deleted meanwhile. A refusal is not an error here; the attempt keeps working from its staged copy.
 */
async function adoptStagedRefresh(
  staging: FileMcpOAuthStateStore,
  snapshot: McpOAuthGrantSnapshot,
  storePath: string,
  serverUrl: string,
): Promise<void> {
  const before = snapshot.state?.tokens;
  if (before === undefined) return;
  const staged = await staging.load().catch(() => undefined);
  if (staged?.tokens === undefined) return;
  if (JSON.stringify(before) === JSON.stringify(staged.tokens)) return;
  await adoptMcpOAuthRefresh(storePath, serverUrl, snapshot, staged).catch(() => false);
}

/**
 * The configured entry already authenticated with its stored (or freshly refreshed) grant, so the
 * approved login had nothing to authorize. `tools` is the discovered tool count of that connection,
 * or undefined when the connection authenticated but its tool listing failed.
 */
export class McpAlreadyAuthorizedError extends Error {
  override name = "McpAlreadyAuthorizedError";
  constructor(readonly tools: number | undefined) {
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
    // here is reported and the (possibly refreshed) stored grant is left in place. An owner denial or
    // a gateway shutdown closes that connection and is rechecked before anything is committed.
    const connection = new McpServerConnection({
      name: "login-verify",
      config: options.config,
      workspace: options.workspace,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      oauth: { storePath: stagingPath, redirectUrl: callback.redirectUrl },
    });
    const stopVerify = (): void => { void connection.close().catch(() => undefined); };
    options.signal?.addEventListener("abort", stopVerify, { once: true });
    let tools: number;
    try {
      await connection.open();
      if (canceled(options.signal)) return { ok: false, reason: "canceled" };
      if (!connection.connected) return { ok: false, reason: "verify-failed" };
      tools = connection.toolNames().length;
    } finally {
      options.signal?.removeEventListener("abort", stopVerify);
      await connection.close().catch(() => undefined);
    }
    // Install the verified replacement. A cancellation, logout or another completed login since this
    // attempt began retires the generation, and this commit then refuses rather than undoing it.
    try {
      const staged = await staging.load();
      if (staged?.tokens === undefined) return { ok: false, reason: "verify-failed" };
      // The cancellation is rechecked inside the commit, so a denial that lands between this call and
      // the write still installs nothing.
      await commitMcpOAuthState(options.storePath, serverUrl, staged, expectedEpoch, options.signal);
    } catch {
      if (canceled(options.signal)) return { ok: false, reason: "canceled" };
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
