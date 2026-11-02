import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  adaptOAuthProvider,
  authorizeMcp,
  type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import type { McpHttpServerConfig } from "./config.js";
import {
  FileMcpOAuthStateStore,
  adoptMcpOAuthRefresh,
  commitMcpOAuthState,
  commitMcpOAuthStateIfUnchanged,
  mcpOAuthStagingPath,
  snapshotMcpOAuthGrant,
  type McpOAuthGrantSnapshot,
} from "./oauth-store.js";
import { McpServerConnection, guardedFetch, headerValues } from "./server.js";

/**
 * One owner-initiated OAuth login for a configured Streamable HTTP MCP server.
 *
 * The authorization code flow is the native `@earendil-works/pi-mcp/oauth` implementation: protected
 * resource and authorization server discovery, dynamic client registration, PKCE, state validation
 * and RFC 9207 issuer validation. This module adds only the host policy the gateway needs:
 *
 * - the flow starts only from an owner's explicit request in an authenticated mapped chat, never at
 *   connect time or from an unattended scope;
 * - the authorization URL is handed to the initiating owner surface exactly once, and neither the URL,
 *   the `state` value, the code verifier nor any token is ever returned to the model or written to a
 *   conversation entry;
 * - the callback listener is loopback-only and one flow runs at a time;
 * - the attempt works on a private staging file seeded from the stored grant, so a grant that already
 *   works is not deleted to make room for a new one and the stored grant is replaced only after one
 *   real connection and tool listing verified the staged replacement. Only the grant material is seeded:
 *   the `state` value and PKCE verifier of an earlier attempt are transient flow state and are dropped, so
 *   each authorization attempt generates and uses its own. A refresh the starting connection
 *   performed on the seeded stored grant is the one exception to "the stored file is not rewritten":
 *   the authorization server has already issued that token and may have invalidated the previous
 *   refresh token, so the rotation is adopted immediately instead of being thrown away with a failed
 *   attempt;
 * - a logout that happens while the attempt runs increments the grant generation, so the late commit
 *   is refused instead of restoring a grant the owner just deleted.
 *
 * The attempt deadline and the cancellation signal cover the whole startup, not only the connection: the
 * initial connect, the startup tool listing and the adoption of a rotation are one bounded, cancellable
 * operation.
 *
 * A rotation of the stored grant is the one thing this module does not roll back: the authorization server
 * has already issued the rotated token, so it is adopted as soon as the step that performed it returns,
 * including after a failed or canceled startup connection. Provenance is what bounds adoption. A refresh
 * during verification rotates the authorization this attempt just obtained from the browser, whose client
 * registration belongs to this attempt's ephemeral loopback redirect; installing those tokens over the
 * stored grant would pair them with the wrong registration. So only a rotation that descends from the
 * stored grant is adopted, and a failed or canceled verification installs nothing: the unverified
 * authorization is discarded with the staging file.
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
  /** One-time authorization URL for the initiating owner. Never returned to a model-facing surface. */
  readonly authorizationUrl: string;
  /** The exact loopback redirect URL registered for this attempt. Never returned to a model surface. */
  readonly callbackUrl: string;
  /** The authorization response state for this attempt. Never returned to a model surface. */
  readonly state: string;
  /** When this attempt stops waiting for the browser. */
  readonly expiresAtMs: number;
  readonly completion: Promise<McpLoginOutcome>;
  /**
   * Complete this attempt from a pasted callback URL, for an owner whose browser cannot reach the
   * gateway host. The callback is validated against this attempt's exact loopback origin, path and
   * state, then replayed to the native loopback listener, which performs the same state/path checks.
   * It never fetches the pasted host and never returns a code, state, verifier or token.
   */
  submitCallback(callback: URL): Promise<"accepted" | "rejected">;
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

/**
 * Run `stop` when `signal` aborts, including when it is already aborted: a listener added after the abort
 * event has fired never runs, so a wait that relies on it alone would continue to its own deadline. Returns
 * the removal for the listener, so a step that stops caring can detach it.
 */
function onAbort(signal: AbortSignal | undefined, stop: () => void): () => void {
  if (signal === undefined) return () => undefined;
  if (signal.aborted) {
    stop();
    return () => undefined;
  }
  signal.addEventListener("abort", stop, { once: true });
  return () => signal.removeEventListener("abort", stop);
}

function environment(options: McpLoginOptions): Readonly<Record<string, string | undefined>> {
  return options.environment ?? process.env;
}

/**
 * Start the flow and return once the server has told us where the owner must go. Everything after
 * that (the browser callback, the code exchange and the verification connection) settles through
 * `completion`, so the initiating surface is not blocked for minutes.
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
  // Seed only the durable grant material. `oauthState` and `codeVerifier` are transient flow state of an
  // earlier attempt: reusing them would present a stale `state` value to the server and exchange a code
  // with a PKCE verifier that belongs to another flow, so each attempt starts without them.
  if (snapshot.state !== undefined) {
    await staging.save(grantMaterial(snapshot.state)).catch(() => undefined);
  }
  if (canceled(options.signal)) {
    await staging.clear().catch(() => undefined);
    throw new CancelledLoginError();
  }
  let callback: OAuthCallbackServer | undefined;
  let client: McpClient | undefined;
  let authorizationUrl: URL | undefined;
  let discovered: number | undefined;
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
    // The deadline and the abort stay installed through the tool listing below, not just through
    // `connect`: a listing is a separate request that can hang on its own, and it must be stopped by a
    // shutdown and bounded by the login deadline like the rest of the startup.
    const startupTimer = setTimeout(stopStartup, Math.max(1, deadline - Date.now()));
    const releaseStartup = onAbort(options.signal, stopStartup);
    let connectError: unknown;
    try {
      try {
        // A signal that was already aborted when this listener was added never fires another event: the
        // listener closed the client at once, so the connection is skipped here instead of being started
        // only to be torn down.
        if (!canceled(options.signal)) {
          await client.connect(new StreamableHttpTransport({
            url: options.config.url,
            headers: headerValues(options.config, environment(options)),
            authProvider: adaptOAuthProvider(provider),
            fetch: guardedFetch,
          }));
        }
      } catch (error) {
        connectError = error;
      }
      // A connection that refreshed the seeded grant already changed the token at the authorization
      // server, which may have invalidated the previous refresh token. Adopt the rotated grant before a
      // failed connection, a cancellation or the cleanup below can drop it, so the stored grant keeps the
      // token the server most recently issued. The rotation descends from the stored grant, which is the
      // only provenance this module adopts.
      await adoptStagedRotation(staging, snapshot.state, snapshot, options.storePath, serverUrl);
      if (canceled(options.signal)) throw new CancelledLoginError();
      // The expected first outcome: the server challenges and the native flow hands us the URL.
      if (connectError !== undefined && !(connectError instanceof McpOAuthAuthorizationRequiredError)) throw connectError;
      // A tool listing failure is reported as unknown instead of being counted as zero tools: the
      // connection did authenticate, but verification did not see what the server offers.
      if (client.serverCapabilities?.tools === undefined) {
        discovered = 0;
      } else {
        const remaining = Math.max(1, deadline - Date.now());
        const listingSignal = options.signal === undefined
          ? AbortSignal.timeout(remaining)
          : AbortSignal.any([options.signal, AbortSignal.timeout(remaining)]);
        discovered = await client.listTools({ signal: listingSignal }).then((tools) => tools.length, () => undefined);
      }
    } finally {
      clearTimeout(startupTimer);
      releaseStartup();
    }
    // A grant in the staging file already worked (the server accepted it without a browser step).
    const redirect = authorizationUrl;
    await client.close().catch(() => undefined);
    client = undefined;
    if (redirect === undefined) {
      // The stored grant (or a token it refreshed in the staged copy) already authenticated, and any
      // rotation was adopted above. A live connection can refresh the same grant without retiring its
      // generation, so the staged copy is installed only while the stored grant still holds the token
      // material this attempt read: a newer rotation is kept, and a logout that happened meanwhile wins.
      const verified = await staging.load().catch(() => undefined);
      if (verified !== undefined) {
        try {
          await commitMcpOAuthStateIfUnchanged(options.storePath, serverUrl, verified, snapshot, options.signal);
        } catch {
          if (canceled(options.signal)) throw new CancelledLoginError();
          throw new McpGrantSupersededError();
        }
      }
      throw new McpAlreadyAuthorizedError(discovered);
    }
    const state = await provider.state();
    const callbackUrl = callback.redirectUrl;
    let submitted = false;
    const run: McpLoginRun = {
      authorizationUrl: redirect.href,
      callbackUrl,
      state,
      expiresAtMs: deadline,
      completion: complete(options, provider, callback, stagingPath, snapshot, serverUrl, state, deadline),
      async submitCallback(pasted) {
        if (submitted) return "rejected";
        const target = callbackTarget(callbackUrl, state, pasted);
        if (target === undefined) return "rejected";
        submitted = true;
        const remaining = Math.max(1, deadline - Date.now());
        const signal = options.signal === undefined
          ? AbortSignal.timeout(remaining)
          : AbortSignal.any([options.signal, AbortSignal.timeout(remaining)]);
        try {
          const response = await fetch(target, { redirect: "error", signal });
          return response.ok ? "accepted" : "rejected";
        } catch {
          return "rejected";
        }
      },
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

/**
 * The native listener's own URL with only the pasted query. Exact origin, path and state must match
 * this attempt, so a foreign or stale callback is refused before any request is made.
 */
function callbackTarget(callbackUrl: string, state: string, pasted: URL): URL | undefined {
  if (pasted.protocol !== "http:") return undefined;
  const expected = new URL(callbackUrl);
  if (pasted.host !== expected.host || pasted.pathname !== expected.pathname) return undefined;
  if (pasted.searchParams.get("state") !== state) return undefined;
  if (!pasted.searchParams.has("code") && !pasted.searchParams.has("error")) return undefined;
  const target = new URL(expected.href);
  target.search = pasted.search;
  return target;
}

class CancelledLoginError extends Error {
  override name = "CancelledLoginError";
}

/**
 * The durable part of a grant: the server URL, the client registration, the tokens and the discovery
 * document. Transient flow state (`oauthState`, `codeVerifier`) is never carried into a fresh attempt.
 */
function grantMaterial(state: McpOAuthState): McpOAuthState {
  const material: McpOAuthState = { serverUrl: state.serverUrl };
  if (state.clientInformation !== undefined) material.clientInformation = state.clientInformation;
  if (state.tokens !== undefined) material.tokens = state.tokens;
  if (state.tokensExpireAt !== undefined) material.tokensExpireAt = state.tokensExpireAt;
  if (state.discovery !== undefined) material.discovery = state.discovery;
  return material;
}

/**
 * Persist a rotation the staged attempt obtained from the authorization server.
 *
 * `baseline` is the token material the staged file held before the step that may refresh, which is the
 * stored grant the staging file was seeded from. Only a difference against that baseline is a rotation, so
 * an authorization that has not been verified is never written; and `adoptMcpOAuthRefresh` refuses when the
 * stored grant was replaced or deleted meanwhile. A refusal is not an error here: the attempt keeps working
 * from its staged copy. The starting connection calls this before a failed connection, a cancellation or the
 * cleanup can drop the token, because the server may already have invalidated the refresh token it rotated.
 *
 * The verification connection's refresh is deliberately not adopted here: it rotates the authorization this
 * attempt obtained from the browser, whose client registration is this attempt's own ephemeral loopback one,
 * so its tokens are installed only as part of the whole verified replacement.
 */
async function adoptStagedRotation(
  staging: FileMcpOAuthStateStore,
  baseline: McpOAuthState | undefined,
  snapshot: McpOAuthGrantSnapshot,
  storePath: string,
  serverUrl: string,
): Promise<void> {
  const before = baseline?.tokens;
  if (before === undefined) return;
  const staged = await staging.load().catch(() => undefined);
  if (staged?.tokens === undefined) return;
  if (JSON.stringify(before) === JSON.stringify(staged.tokens)) return;
  await adoptMcpOAuthRefresh(storePath, serverUrl, snapshot, staged).catch(() => false);
}

/**
 * The configured entry already authenticated with its stored (or freshly refreshed) grant, so the
 * login had nothing to authorize. `tools` is the discovered tool count of that connection,
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
  snapshot: McpOAuthGrantSnapshot,
  serverUrl: string,
  state: string,
  deadline: number,
): Promise<McpLoginOutcome> {
  // Cancellation must also stop the browser wait, which has its own five-minute deadline: closing the
  // listener rejects it instead of leaving the gateway shutdown blocked on a browser that will not come.
  let callbackClosed: Promise<void> | undefined;
  const closeCallback = (): Promise<void> => {
    callbackClosed ??= callback.close().catch(() => undefined);
    return callbackClosed;
  };
  const releaseCallback = onAbort(options.signal, () => { void closeCallback(); });
  const staging = new FileMcpOAuthStateStore(stagingPath, serverUrl);
  try {
    // A signal that was already aborted fired its only event before this listener existed, and closing the
    // listener early would leave the wait below with nothing to end it: report the cancellation directly.
    if (canceled(options.signal)) return { ok: false, reason: "canceled" };
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
    // The staged file now holds the authorization this attempt just obtained. It is not a rotation of the
    // stored grant, so nothing installs it before verification: one real connection and tool listing verify
    // it first, and a failure here is reported while the stored grant is left in place. An owner denial or a
    // gateway shutdown closes that connection and is rechecked before anything is committed.
    const connection = new McpServerConnection({
      name: "login-verify",
      config: options.config,
      workspace: options.workspace,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      oauth: { storePath: stagingPath, redirectUrl: callback.redirectUrl },
    });
    const stopVerify = (): void => { void connection.close().catch(() => undefined); };
    const releaseVerify = onAbort(options.signal, stopVerify);
    let connected = false;
    let tools = 0;
    let verifyError: unknown;
    try {
      await connection.open();
      if (!canceled(options.signal)) {
        connected = connection.connected;
        if (connected) tools = connection.toolNames().length;
      }
    } catch (error) {
      verifyError = error;
    } finally {
      releaseVerify();
      await connection.close().catch(() => undefined);
    }
    // A refresh during verification rotated the authorization this attempt obtained, not the stored grant:
    // those tokens carry this attempt's own client registration, so they are installed only with the whole
    // verified grant below, and a failed or canceled verification discards them instead of adopting them.
    // A cancellation that landed before the connection could even open is reported as such.
    if (canceled(options.signal)) return { ok: false, reason: "canceled" };
    if (verifyError !== undefined) throw verifyError;
    if (!connected) return { ok: false, reason: "verify-failed" };
    // Install the verified replacement. A cancellation, logout or another completed login since this
    // attempt began retires the generation, and this commit then refuses rather than undoing it.
    try {
      const staged = await staging.load();
      if (staged?.tokens === undefined) return { ok: false, reason: "verify-failed" };
      // The cancellation is rechecked inside the commit, up to the replacement's irreversible step, so a
      // denial that lands during the write still installs nothing; one that lands after it is not reported
      // as a cancellation while the grant exists.
      await commitMcpOAuthState(options.storePath, serverUrl, staged, snapshot.epoch, options.signal);
    } catch {
      if (canceled(options.signal)) return { ok: false, reason: "canceled" };
      return { ok: false, reason: "grant-superseded" };
    }
    return { ok: true, tools };
  } finally {
    releaseCallback();
    await closeCallback();
    // The staging file never outlives the attempt, whether it was committed, refused or canceled.
    await staging.clear().catch(() => undefined);
  }
}
