import { randomBytes } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  defineExtension,
  defineTool,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";
import { parseMcpConfig, mcpServerEnabled, type McpConfig, type McpHttpServerConfig, type McpServerConfig } from "./config.js";
import { removeMcpServerEntry, writeMcpServerEntry, type McpConfigBlockExpectation, type McpConfigEdit } from "./install.js";
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

/**
 * Agent-driven MCP management.
 *
 * The assistant can propose a server entry, ask for an OAuth login, or ask for a logout or removal,
 * and the owner decides. A model tool only *records a request*; nothing connects, no configuration is
 * written and no browser flow starts until the owner approves that exact request from a surface the
 * model does not control: the local terminal (`/mcp approve <id>`) or the authenticated Telegram
 * owner chat. The request record is written once, is never rewritten, and is consumed by the
 * approval, so the owner approves exactly what was listed.
 *
 * This is a separate authority from `mcp.servers`: naming an entry there is already owner
 * authorization, whereas here the agent only proposes. A configuration write or an OAuth grant stays
 * an owner action, and the resulting authority is the same as if the owner had written the entry or
 * completed the login by hand.
 */
export const MCP_ADMIN_TOOL_NAME = "mcp";

export const MCP_ADMIN_LIMITS = Object.freeze({
  /** Pending/running requests kept; further proposals are refused until the owner decides. */
  maxPending: 8,
  /** Terminal requests kept for the owner-facing recent list. */
  maxTerminal: 8,
  /** One proposed server entry, serialized. */
  maxEntryBytes: 8 * 1024,
  /**
   * One full `show` disclosure. The exact entry is at most `maxEntryBytes` of JSON, so this budget
   * leaves room for the normalized description and the authority explanation without ever hiding part
   * of the entry the owner would approve.
   */
  maxShowChars: 12 * 1024,
  maxTextChars: 4_000,
  maxOutcomeChars: 300,
  maxNameChars: 64,
} as const);

export type McpRequestKind = "config" | "login" | "logout" | "remove";

/**
 * One agent proposal. `server` is the exact JSON entry the owner approves, kept verbatim so the
 * approval writes what was listed rather than a re-serialized derivation of it.
 */
export interface McpRequest {
  [key: string]: JsonValue;
  readonly id: string;
  readonly kind: McpRequestKind;
  readonly name: string;
  readonly server: Record<string, JsonValue> | null;
  readonly originConversationId: number;
  readonly createdAtMs: number;
  status: "pending" | "running" | "done" | "failed";
  outcome: string | null;
}

/** Root-scoped document. It holds proposals only: no credential, no token, no connection. */
export interface McpRequestsDocument {
  [key: string]: JsonValue;
  requests: McpRequest[];
}

export const McpRequestsDoc = defineDoc<McpRequestsDocument>({
  kind: "nanobot.mcp-requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: [] }),
  checkpointWhen: () => true,
});

/** Durable bounded request list. The runtime implements it over the root conversation document. */
export interface McpRequestStore {
  read(context: Context): Promise<readonly McpRequest[]>;
  write<T>(context: Context, change: (requests: McpRequest[]) => T): Promise<T>;
}

export interface McpAdminServer {
  readonly name: string;
  readonly kind: "stdio" | "http";
  readonly enabled: boolean;
  readonly oauth: boolean;
  readonly state?: "connected" | "failed" | "closed";
  readonly failure?: string;
  readonly tools?: number;
}

export interface McpAdminRequestView {
  readonly id: string;
  readonly kind: McpRequestKind;
  readonly name: string;
  readonly status: McpRequest["status"];
  /** One-line summary for a listing; the full entry is only rendered by `show`. */
  readonly summary: string;
}

export interface McpAdminListing {
  readonly configured: boolean;
  readonly servers: readonly McpAdminServer[];
  readonly requests: readonly McpAdminRequestView[];
}

export interface McpApproveResult {
  readonly status: "applied" | "refused" | "login-started";
  /** Fixed owner-facing text. It never contains an authorization URL or a token. */
  readonly text: string;
  /** Present only for `login-started`, for the approving owner surface. Never returned by a tool. */
  readonly authorization?: { readonly url: string; readonly expiresAtMs: number };
}

export interface McpLoginNotice {
  readonly requestId: string;
  readonly name: string;
  readonly originConversationId: ConversationId;
  readonly outcome: McpLoginOutcome;
}

export interface McpAdminOptions {
  /** The configuration file this gateway loaded; absent means managed writes are unavailable. */
  readonly edit: McpConfigEdit;
  /** Canonical data directory; OAuth grants live under it and never in the workspace. */
  readonly dataDir: string;
  /** The configuration this gateway opened with. */
  readonly config: McpConfig | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly requests: McpRequestStore;
  /** Gateway-lifetime context for the login flow that outlives one approval call. */
  readonly context: Context;
  /** True only for authenticated ordinary mapped chats: never workers, forks or task-owned scopes. */
  readonly isAuthorizedChat: (conversationId: ConversationId) => boolean;
  /** Live connection status of the configured servers, read at call time. */
  readonly servers: () => readonly McpServerStatus[];
  /** Deliver one settled login to its origin conversation's agent; never a user or channel. */
  readonly notify: (notice: McpLoginNotice) => Promise<void>;
  readonly now?: () => number;
}

export interface McpAdmin {
  readonly extension: Extension;
  list(context: Context): Promise<McpAdminListing>;
  /** The exact entry an approval would apply. Read-only. */
  show(id: string, context: Context): Promise<{ readonly found: boolean; readonly text: string }>;
  approve(id: string, context: Context): Promise<McpApproveResult>;
  deny(id: string, context: Context): Promise<McpApproveResult>;
  /** Stop a running login; a completed one keeps its stored grant. */
  close(): Promise<void>;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ID_PATTERN = /^[0-9a-f]{16}$/;
const KINDS: readonly McpRequestKind[] = ["config", "login", "logout", "remove"];

/** Fixed outcome text for a request no live flow can settle any more. */
const INTERRUPTED_OUTCOME = "interrupted before it settled: the gateway stopped while it was running";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * The owner-facing description of one proposed entry. It is rendered from the validated shape, so a
 * header or environment mapping is always shown as a variable *name* and never as a value.
 */
function describeEntry(name: string, entry: Record<string, unknown>, workspace: string): string {
  let config: McpServerConfig;
  try {
    const parsed = parseMcpConfig({ enabled: true, servers: { [name]: entry } }, workspace);
    config = parsed.servers[name]!;
  } catch {
    return `Server "${name}" (invalid now, approval would refuse it)\n${JSON.stringify(entry, null, 2)}`;
  }
  const lines = [`Server "${name}"`];
  if ("url" in config) {
    lines.push("  kind: Streamable HTTP");
    lines.push(`  url: ${config.url}`);
    lines.push(`  oauth: ${config.oauth === true ? "yes (owner-approved browser login)" : "no"}`);
    for (const [header, variable] of Object.entries(config.headers ?? {})) {
      lines.push(`  header ${header} <- host environment variable ${variable}`);
    }
  } else {
    lines.push("  kind: stdio (a local process the gateway would launch on this host)");
    lines.push(`  command: ${config.command}`);
    if (config.args !== undefined) lines.push(`  args: ${JSON.stringify(config.args)}`);
    if (config.cwd !== undefined) lines.push(`  cwd: ${config.cwd}`);
    for (const [variable, source] of Object.entries(config.env ?? {})) {
      lines.push(`  env ${variable} <- host environment variable ${source}`);
    }
  }
  if (config.description !== undefined) lines.push(`  description: ${config.description}`);
  if (config.timeoutSeconds !== undefined) lines.push(`  timeoutSeconds: ${config.timeoutSeconds}`);
  if (config.enabled === false) lines.push("  enabled: false (configured but never connected)");
  return lines.join("\n");
}

function entrySummary(entry: Record<string, unknown>): string {
  if (typeof entry.url === "string") {
    return bounded(`http ${entry.url}${entry.oauth === true ? " (oauth)" : ""}`, 200);
  }
  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
    return bounded(`stdio ${[entry.command, ...args].join(" ")}`, 200);
  }
  return "entry";
}

/**
 * Full owner disclosure for one request. A config request shows the normalized shape, the exact entry
 * that would be written, and every effect an approval has on the `mcp` block. The exact entry is
 * never truncated.
 */
function renderShow(
  request: McpRequest,
  options: Pick<McpAdminOptions, "edit" | "config">,
): string {
  const header = `Request ${request.id} (${request.kind}) for server "${request.name}"`;
  if (request.kind !== "config" || request.server === null) {
    if (request.kind === "login") {
      return `${header}\nStarts an owner-approved OAuth login and verifies the stored grant with one connection.\n` +
        "The grant is kept in this runtime's private token file; model-facing surfaces never show it.";
    }
    if (request.kind === "logout") {
      return `${header}\nDeletes the stored OAuth grant for this server. A live connection is unaffected; ` +
        "a refresh that completes afterwards cannot restore the deleted grant.";
    }
    return `${header}\nDeletes this server entry from the configuration file.`;
  }
  const blockEnabled = options.config?.enabled === true;
  const others = options.config === undefined
    ? []
    : Object.keys(options.config.servers).filter((name) => name !== request.name).sort((left, right) => left.localeCompare(right, "en-US"));
  const normalized = describeEntry(request.name, request.server, options.edit.workspace);
  const exact = JSON.stringify(request.server);
  const pretty = JSON.stringify(request.server, null, 2);
  const entry = pretty.length <= MCP_ADMIN_LIMITS.maxEntryBytes ? pretty : exact;
  const authority = [
    "Effective authority of an approval:",
    blockEnabled
      ? "  mcp.enabled is already true in this gateway's open configuration, and the write leaves it true. " +
        "Every other entry there keeps its current state."
      : "  the approval turns the block on. Every other entry present when it was off is pinned to enabled: false, " +
        "so only this entry may become newly active; an entry already disabled stays as it is.",
    ...(others.length === 0
      ? []
      : [`  other entries in this gateway's open configuration, whose state is unchanged: ${others.join(", ")}`]),
    "  The approval re-reads the file, refuses without changing it when the block there is no longer the one " +
      "described here (its enabled flag or its entry names differ from this gateway's open configuration), and " +
      "validates the whole merged document with the parser a gateway start uses. It takes effect at the next start " +
      "(`/restart`).",
    ...(request.server.oauth === true
      ? ["  Approval also starts the owner-approved OAuth login for this entry and returns its one-time URL."]
      : []),
  ].join("\n");
  const head = bounded(`${header}\n${normalized}`, Math.max(
    0,
    MCP_ADMIN_LIMITS.maxShowChars - entry.length - authority.length - 64,
  ));
  return `${head}\n\nExact entry that would be written:\n${entry}\n\n${authority}`;
}

/**
 * One approval/denial rendered for the local terminal. The authorization URL is appended here and
 * nowhere else, so it reaches the owner who approved the login and never a model, a tool result or a
 * conversation record. Telegram delivers the URL separately and directly, outside durable state.
 */
export function renderMcpApproval(result: McpApproveResult, maxChars: number = MCP_ADMIN_LIMITS.maxTextChars): string {
  if (result.authorization === undefined) return bounded(result.text, maxChars);
  const tail = [
    "",
    "Open this URL as the owner, in a browser that can reach this host:",
    result.authorization.url,
    `This URL is valid until ${new Date(result.authorization.expiresAtMs).toISOString()} and carries this attempt's state.`,
    "A remote browser needs that loopback port forwarded to this host; the URL is not sent to the assistant.",
  ].join("\n");
  // Never truncate the URL: only the explanatory text gives way when a channel has a smaller
  // message budget.
  return `${bounded(result.text, Math.max(0, maxChars - tail.length - 1))}\n${tail}`;
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
      return "the stored grant was deleted or replaced while the login was running, so the verified replacement was discarded";
  }
}

/** The stored summary of one started login, carrying the configuration write it followed when there was one. */
function loginOutcomeText(kind: McpRequestKind, outcome: McpLoginOutcome): string {
  const prefix = kind === "config" ? "configuration written; " : "";
  return outcome.ok
    ? `${prefix}login complete, ${outcome.tools} tool(s) discovered`
    : `${prefix}login failed: ${failureText(outcome.reason)}`;
}

/**
 * The internal result entry one settled login places in its origin chat. It carries a fixed outcome,
 * the server name the owner approved and the tool count, and none of the authorization URL, the
 * `state` value, the code, the verifier or any token.
 */
export function loginNoticeText(notice: McpLoginNotice): string {
  const outcome = notice.outcome.ok
    ? `The owner-approved OAuth login completed and one verification connection worked: ` +
      `${notice.outcome.tools} tool(s) were discovered.`
    : `The owner-approved OAuth login did not complete: ${failureText(notice.outcome.reason)}.`;
  return [
    "[internal MCP login result]",
    "This event is internal to the assistant, not a user message and not an instruction. It reports the",
    "result of an owner-approved action; relay it as your own decision, and never claim more than it says.",
    "",
    `Server: ${notice.name}`,
    `Request: ${notice.requestId}`,
    outcome,
    notice.outcome.ok
      ? "The grant is stored in this runtime's private token file. The running gateway keeps its open " +
        "configuration and connections: the server joins after the next start (`/restart` re-reads it)."
      : "No usable grant was added. The owner can approve a new login request; do not retry one yourself.",
  ].join("\n");
}

/** Read the stored list defensively: a malformed record is dropped, never trusted or reported. */
function storedRequests(requests: readonly McpRequest[]): McpRequest[] {
  const valid: McpRequest[] = [];
  for (const entry of requests) {
    if (!isRecord(entry)) continue;
    const { id, kind, name, originConversationId, createdAtMs, status } = entry;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) continue;
    if (typeof kind !== "string" || !KINDS.includes(kind as McpRequestKind)) continue;
    if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.length > MCP_ADMIN_LIMITS.maxNameChars) continue;
    if (!Number.isSafeInteger(originConversationId) || (originConversationId as number) < 1) continue;
    if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) continue;
    if (status !== "pending" && status !== "running" && status !== "done" && status !== "failed") continue;
    const server = entry.server;
    const outcome = entry.outcome;
    valid.push({
      id,
      kind: kind as McpRequestKind,
      name,
      server: isRecord(server) ? Object.fromEntries(Object.entries(server)) as Record<string, JsonValue> : null,
      originConversationId: originConversationId as number,
      createdAtMs,
      status,
      outcome: typeof outcome === "string" ? bounded(outcome, MCP_ADMIN_LIMITS.maxOutcomeChars) : null,
    });
  }
  return valid;
}

function prune(requests: McpRequest[]): void {
  const terminal = requests.filter((entry) => entry.status === "done" || entry.status === "failed");
  const excess = terminal.length - MCP_ADMIN_LIMITS.maxTerminal;
  if (excess <= 0) return;
  const drop = new Set(terminal.slice(0, excess).map((entry) => entry.id));
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    if (drop.has(requests[index]!.id)) requests.splice(index, 1);
  }
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

/** Detach a document value before a transaction closes; a committed overlay is no longer usable. */
function detach(request: McpRequest): McpRequest {
  return JSON.parse(JSON.stringify(request)) as McpRequest;
}

/**
 * Validate one proposed entry exactly as a gateway start would, accepting no other config field.
 * Returns the parsed entry; the caller keeps the verbatim JSON for the owner and for the write.
 */
function proposeEntry(workspace: string, name: string, entry: unknown): McpServerConfig {
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
    ? `MCP servers in this gateway's open configuration: ${listing.servers.length}`
    : "MCP is not configured in this gateway's open configuration (no enabled server entry).");
  for (const server of listing.servers) {
    const state = server.state === undefined
      ? server.enabled ? "configured, not connected in this open" : "disabled"
      : server.state === "connected"
        ? `connected, ${server.tools ?? 0} tools`
        : server.state === "closed" ? "closed" : `failed: ${server.failure ?? "unknown"}`;
    lines.push(`- ${server.name} (${server.kind}${server.oauth ? ", oauth" : ""}): ${state}`);
  }
  const waiting = listing.requests.filter((request) => request.status === "pending" || request.status === "running");
  if (waiting.length === 0) {
    lines.push("Owner approval requests: none waiting.");
  } else {
    lines.push(`Owner approval requests waiting (${waiting.length}):`);
    for (const request of waiting) lines.push(`- ${request.id} ${request.kind} ${request.name}: ${request.summary}`);
    lines.push(
      "Nothing is configured, connected or authorized until the owner approves one: in a terminal " +
      "`/mcp approve <id>` or `/mcp deny <id>`, or the same in the authenticated Telegram owner chat. " +
      "`/mcp show <id>` prints the exact entry.",
    );
  }
  const settled = listing.requests.filter((request) => request.status === "done" || request.status === "failed");
  for (const request of settled.slice(-3)) {
    lines.push(`- ${request.id} ${request.kind} ${request.name} ${request.status}: ${request.summary}`);
  }
  return bounded(lines.join("\n"), maxChars);
}

interface ActiveRequest {
  readonly abort: AbortController;
  phase: "applying" | "login";
  run?: McpLoginRun;
  /** Resolves when the approving call returns, so shutdown can wait for a start it canceled. */
  readonly done: Promise<void>;
  finish(): void;
}

export function createMcpAdmin(options: McpAdminOptions): McpAdmin {
  const now = options.now ?? Date.now;
  /**
   * Requests whose approval is applying or whose login is live. The reservation is taken before any
   * asynchronous work: it makes a second decision on the same request impossible in this process, and
   * it keeps a startup-time request from looking like a restart-interrupted one.
   */
  const inFlight = new Map<string, ActiveRequest>();
  /**
   * Requests whose result must not reach the origin chat's agent: an owner denial, or a gateway shutdown.
   * Both already answered the owner, and neither should start a model turn.
   */
  const silent = new Set<string>();

  const reserve = (id: string): ActiveRequest => {
    const abort = new AbortController();
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const flow: ActiveRequest = { abort, phase: "applying", done, finish };
    inFlight.set(id, flow);
    return flow;
  };

  /**
   * The `mcp` block this gateway opened with: the same state `renderShow` discloses and the same state an
   * approval requires on disk. Comparing against the live file would let the owner approve effects that
   * were never described, so the write refuses on a difference instead.
   */
  const openBlock = (): McpConfigBlockExpectation => ({
    enabled: options.config?.enabled === true,
    servers: options.config === undefined
      ? []
      : Object.keys(options.config.servers).sort((left, right) => left.localeCompare(right, "en-US")),
  });

  /**
   * Stored requests, durably repairing one case: a `running` request with no live reservation was
   * interrupted by a restart or a shutdown that could not settle it. It is committed as failed instead of
   * only being reported that way, because a `running` entry in the document counts against the waiting
   * limit and can be neither approved nor denied, so a handful of interruptions would block every later
   * proposal. A reservation is taken before any request is committed as `running`, so a live approval or
   * login is never demoted here; the write re-checks the reservation inside the transaction.
   */
  const read = async (context: Context): Promise<McpRequest[]> => {
    const stored = storedRequests(await options.requests.read(context));
    const orphans = new Set(stored
      .filter((request) => request.status === "running" && !inFlight.has(request.id))
      .map((request) => request.id));
    if (orphans.size > 0) {
      await options.requests.write(context, (requests) => {
        for (const entry of requests) {
          if (!orphans.has(entry.id) || entry.status !== "running" || inFlight.has(entry.id)) continue;
          entry.status = "failed";
          entry.outcome = bounded(entry.outcome ?? INTERRUPTED_OUTCOME, MCP_ADMIN_LIMITS.maxOutcomeChars);
        }
        return undefined;
      });
    }
    return stored.map((request): McpRequest => orphans.has(request.id) && !inFlight.has(request.id)
      ? { ...request, status: "failed", outcome: request.outcome ?? INTERRUPTED_OUTCOME }
      : request);
  };

  const listingOf = async (context: Context): Promise<McpAdminListing> => {
    const configured = options.config?.enabled === true ? options.config.servers : {};
    const live = new Map(options.servers().map((status) => [status.name, status]));
    const servers: McpAdminServer[] = Object.entries(configured)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([name, config]) => {
        const status = live.get(name);
        return Object.freeze({
          name,
          kind: "url" in config ? "http" as const : "stdio" as const,
          enabled: mcpServerEnabled(config),
          oauth: "url" in config && config.oauth === true,
          ...(status === undefined ? {} : {
            state: status.state,
            tools: status.tools,
            ...(status.failure === undefined ? {} : { failure: status.failure }),
          }),
        });
      });
    const requests = (await read(context))
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map((request): McpAdminRequestView => Object.freeze({
        id: request.id,
        kind: request.kind,
        name: request.name,
        status: request.status,
        // A settled request reports its outcome, so the owner sees the login result and not only the
        // entry they approved.
        summary: request.kind === "config" && request.server !== null
          ? `${entrySummary(request.server)}${request.outcome === null ? "" : ` — ${request.outcome}`}`
          : request.outcome ?? request.kind,
      }));
    return Object.freeze({ configured: Object.keys(configured).length > 0, servers, requests });
  };

  /** Record one proposal. It is written once and never rewritten; approval consumes it. */
  const propose = async (
    context: Context,
    originConversationId: ConversationId,
    kind: McpRequestKind,
    name: string,
    server?: Record<string, JsonValue>,
  ): Promise<string> => {
    // Repair interrupted requests first: a `running` entry left by a restart must not count against the
    // waiting bound and refuse a proposal the owner could otherwise accept.
    await read(context);
    return options.requests.write(context, (requests) => {
      const waiting = requests.filter((entry) => entry.status === "pending" || entry.status === "running");
      if (waiting.length >= MCP_ADMIN_LIMITS.maxPending) {
        throw new Error(
          `there are already ${waiting.length} waiting owner approval requests; ` +
          "wait for the owner to decide on them before proposing more",
        );
      }
      const id = newId();
      requests.push({
        id,
        kind,
        name,
        server: server ?? null,
        originConversationId,
        createdAtMs: now(),
        status: "pending",
        outcome: null,
      });
      prune(requests);
      return id;
    });
  };

  const findRequest = async (context: Context, id: string): Promise<McpRequest | undefined> => {
    if (!ID_PATTERN.test(id)) return undefined;
    return (await read(context)).find((request) => request.id === id);
  };

  const configuredEntry = (name: string): McpServerConfig | undefined =>
    options.config?.enabled === true ? options.config.servers[name] : undefined;

  const settle = async (context: Context, id: string, status: "done" | "failed", outcome: string): Promise<void> => {
    await options.requests.write(context, (requests) => {
      const stored = requests.find((entry) => entry.id === id);
      if (stored !== undefined) {
        stored.status = status;
        stored.outcome = bounded(outcome, MCP_ADMIN_LIMITS.maxOutcomeChars);
      }
      prune(requests);
      return undefined;
    });
  };

  /**
   * Record one started login's own result exactly as its live completion would, so a shutdown reports the
   * login's real outcome instead of replacing a verified grant's success with a cancellation. A request the
   * flow already settled keeps that value, and one that never started a login settled itself.
   */
  const settleLogin = (id: string, outcome: McpLoginOutcome): Promise<void> =>
    options.requests.write(options.context, (requests) => {
      const stored = requests.find((entry) => entry.id === id);
      if (stored === undefined || stored.status !== "running") return undefined;
      stored.status = outcome.ok ? "done" : "failed";
      stored.outcome = bounded(loginOutcomeText(stored.kind, outcome), MCP_ADMIN_LIMITS.maxOutcomeChars);
      prune(requests);
      return undefined;
    });

  /** Return a claimed request to pending when the decision proved to have no effect. */
  const releaseClaim = async (context: Context, id: string): Promise<void> => {
    await options.requests.write(context, (requests) => {
      const stored = requests.find((entry) => entry.id === id);
      if (stored !== undefined && stored.status === "running") {
        stored.status = "pending";
        stored.outcome = null;
      }
      return undefined;
    });
  };

  /**
   * Atomically move one request from `pending` to `running`. The store write is the claim: a
   * concurrent approval or denial sees the committed status and cannot apply the same request twice.
   */
  const claim = (context: Context, id: string): Promise<
    | { readonly kind: "missing" }
    | { readonly kind: "taken"; readonly request: McpRequest }
    | { readonly kind: "claimed"; readonly request: McpRequest }
  > => options.requests.write(context, (requests) => {
    const stored = requests.find((entry) => entry.id === id);
    if (stored === undefined) return { kind: "missing" as const };
    if (stored.status !== "pending") return { kind: "taken" as const, request: detach(stored) };
    stored.status = "running";
    return { kind: "claimed" as const, request: detach(stored) };
  });

  /** Start one approved login. At most one flow runs; a second is refused, never queued. */
  const startLogin = async (
    context: Context,
    request: McpRequest,
    config: McpHttpServerConfig,
    flow: ActiveRequest,
  ): Promise<McpApproveResult> => {
    if (config.oauth !== true) {
      return {
        status: "refused",
        text: `Server "${request.name}" does not use OAuth (its entry needs "oauth": true first).`,
      };
    }
    for (const [otherId, other] of inFlight) {
      if (otherId !== request.id && other.phase === "login") {
        return {
          status: "refused",
          text: "An MCP login is already waiting for its browser callback; finish or cancel it before starting another.",
        };
      }
    }
    // Reserve the one flow slot before the asynchronous start, so a second approval cannot begin.
    flow.phase = "login";
    let run: McpLoginRun;
    try {
      run = await beginMcpLogin({
        config,
        workspace: options.edit.workspace,
        storePath: mcpOAuthStatePath(options.dataDir, config.url),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        signal: flow.abort.signal,
      });
    } catch (error) {
      flow.phase = "applying";
      if (error instanceof McpAlreadyAuthorizedError) {
        const tools = error.tools;
        await settle(context, request.id, "done", tools === undefined
          ? "already authorized; the tool listing failed"
          : `already authorized, ${tools} tool(s)`);
        return {
          status: "applied",
          text: tools === undefined
            ? `Server "${request.name}" already accepted the stored grant: one connection authenticated, but its ` +
              "tool listing failed, so the tool count is unknown. No browser authorization was needed and nothing changed."
            : `Server "${request.name}" already accepted the stored grant and was verified with one ` +
              `connection (${tools} tool(s)), so no browser authorization was needed. Nothing changed.`,
        };
      }
      if (error instanceof McpGrantSupersededError) {
        await settle(context, request.id, "failed", "the stored grant changed while the login was checking it");
        return {
          status: "refused",
          text: `MCP login for "${request.name}" was not applied: its stored grant was deleted or replaced while ` +
            "the login was checking it. A logout always wins; request a new login if one is still needed.",
        };
      }
      if (error instanceof MissingEnvironmentError) {
        await settle(context, request.id, "failed", "a configured environment variable is not set");
        return {
          status: "refused",
          text: `MCP login for "${request.name}" could not start: environment variable ${error.variable} (a configured ` +
            "header or child variable) is not set on this host. No grant was stored and nothing was connected.",
        };
      }
      const canceledStart = error instanceof Error && error.name === "CancelledLoginError";
      if (canceledStart) {
        await settle(context, request.id, "failed", "login canceled before authorization");
        return {
          status: "refused",
          text: `MCP login for "${request.name}" was canceled before it started. ` +
            "A grant stored by an earlier successful login is untouched.",
        };
      }
      await settle(context, request.id, "failed", "login could not start: the authorization endpoint was not usable");
      return {
        status: "refused",
        text: `MCP login for "${request.name}" could not start: the server's authorization endpoint was not usable. ` +
          "No grant was stored and nothing was connected.",
      };
    }
    flow.run = run;
    await options.requests.write(context, (requests) => {
      const stored = requests.find((entry) => entry.id === request.id);
      if (stored !== undefined) stored.status = "running";
      return undefined;
    });
    void run.completion.then(async (outcome) => {
      if (silent.delete(request.id)) return;
      await settleLogin(request.id, outcome).catch(() => undefined);
      await options.notify({
        requestId: request.id,
        name: request.name,
        originConversationId: request.originConversationId as ConversationId,
        outcome,
      }).catch(() => undefined);
    }).catch(() => undefined).finally(() => {
      if (inFlight.get(request.id) === flow) inFlight.delete(request.id);
    });
    return {
      status: "login-started",
      text: `OAuth login started for "${request.name}". Open the authorization URL below as the owner in a browser ` +
        "that can reach this host and finish the consent screen. The URL carries this attempt's state and is valid " +
        "for a few minutes; it is not sent to the assistant and not written to any transcript. " +
        "After consent the grant is stored privately and verified with one connection.",
      authorization: { url: run.authorizationUrl, expiresAtMs: run.expiresAtMs },
    };
  };

  const applyRequest = async (
    context: Context,
    request: McpRequest,
    flow: ActiveRequest,
  ): Promise<McpApproveResult> => {
    if (request.kind === "config") {
      if (request.server === null) {
        return { status: "refused", text: `Request ${request.id} has no server entry to write.` };
      }
      let parsed: McpServerConfig;
      try {
        parsed = proposeEntry(options.edit.workspace, request.name, request.server);
      } catch (error) {
        return {
          status: "refused",
          text: `Request ${request.id} is no longer a valid entry (${error instanceof Error ? error.message : "invalid"}); nothing was written.`,
        };
      }
      let written;
      try {
        written = await writeMcpServerEntry(options.edit, request.name, request.server, openBlock());
      } catch (error) {
        return {
          status: "refused",
          text: `The configuration file was not changed: ${error instanceof Error ? error.message : "the write failed"}. ` +
            `Request ${request.id} stays available.`,
        };
      }
      const base = `Wrote server "${request.name}" to the configuration file. Configured servers now: ` +
        `${written.servers.length === 0 ? "none" : written.servers.join(", ")}. MCP is ` +
        `${written.enabled ? "enabled" : "disabled"} in that block. This gateway keeps its open configuration: ` +
        "the entry connects at the next start, and `/restart` replaces this process and re-reads the file.";
      if (!("url" in parsed) || parsed.oauth !== true) {
        await settle(context, request.id, "done", "configuration written");
        return { status: "applied", text: base };
      }
      // A config entry that also starts a login stays `running` through the start, so a concurrent
      // denial cannot report it settled while its login is about to begin.
      const login = await startLogin(context, request, parsed, flow);
      if (login.status !== "login-started") {
        // The configuration write is a completed effect even when its login could not start; only a
        // started login keeps the request running until its own completion settles it.
        await settle(context, request.id, "done", "configuration written; login not started");
      }
      return login.status === "login-started"
        ? { ...login, text: `${base} ${login.text}` }
        : { status: "applied", text: `${base} ${login.text}` };
    }
    if (request.kind === "remove") {
      try {
        const result = await removeMcpServerEntry(options.edit, request.name);
        await settle(context, request.id, "done", "configuration entry removed");
        return {
          status: "applied",
          text: `Removed server "${request.name}" from the configuration file. Configured servers now: ` +
            `${result.servers.length === 0 ? "none" : result.servers.join(", ")}. This gateway keeps its open ` +
            "configuration until the next start. A stored OAuth grant is kept; ask for a logout to delete it.",
        };
      } catch (error) {
        return {
          status: "refused",
          text: `The configuration file was not changed: ${error instanceof Error ? error.message : "the write failed"}.`,
        };
      }
    }
    const config = configuredEntry(request.name);
    if (config === undefined || !("url" in config)) {
      return {
        status: "refused",
        text: `Server "${request.name}" is not a configured Streamable HTTP server in this gateway's open configuration. ` +
          "If it was just added, restart the gateway and ask again.",
      };
    }
    if (request.kind === "logout") {
      try {
        await new FileMcpOAuthStateStore(mcpOAuthStatePath(options.dataDir, config.url), config.url).clear();
      } catch {
        return { status: "refused", text: `The stored grant for "${request.name}" could not be deleted.` };
      }
      await settle(context, request.id, "done", "stored grant deleted");
      return {
        status: "applied",
        text: `Deleted the stored OAuth grant for "${request.name}". A live connection is unaffected; a refresh ` +
          "that completes afterwards cannot restore the deleted grant. After the next start the entry reports " +
          "`auth-required` until an owner approves a new login.",
      };
    }
    return startLogin(context, request, config, flow);
  };

  return {
    extension: defineExtension({
      name: "nanobot-mcp-admin",
      tools: [
        defineTool({
          name: MCP_ADMIN_TOOL_NAME,
          description:
            "MCP server management. `status` reports configured servers and owner approval requests. `propose` " +
            "records a server entry, `login` an OAuth login, `logout` a stored-grant deletion, `remove` an entry " +
            "removal. A proposal only records a request: the owner must approve it with `/mcp approve <id>` in a " +
            "terminal or in the authenticated Telegram owner chat. Nothing is configured, connected or authorized " +
            "before that, and this tool never returns credentials.",
          parameters: Type.Object({
            action: Type.Unsafe<string>({ type: "string", enum: ["status", "propose", "login", "logout", "remove"] }),
            name: Type.Optional(Type.String({
              description: "Server name: letters, digits, _ and - only.",
            })),
            server: Type.Optional(Type.Unsafe<Record<string, unknown>>({
              type: "object",
              additionalProperties: true,
              description:
                "Verbatim MCP config entry for `propose`: exactly one of `command` (stdio) or `url` (HTTP), plus " +
                "optional `args`, `cwd`, `env`, `headers`, `oauth`, `description`, `timeoutSeconds`, `enabled`. " +
                "`env` and `headers` values are host environment variable NAMES, never secrets.",
            })),
          }),
          outputLimits: { maxBytes: 32 * 1024, maxLines: 500, retain: "head" },
          async execute(args, api, context) {
            const action = typeof args.action === "string" ? args.action : "";
            if (action === "status") {
              return { output: [{ type: "text" as const, text: renderMcpListing(await listingOf(context)) }] };
            }
            if (action !== "propose" && action !== "login" && action !== "logout" && action !== "remove") {
              return {
                output: [{
                  type: "text" as const,
                  text: "action must be \"status\", \"propose\", \"login\", \"logout\" or \"remove\".",
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
            const configured = configuredEntry(name);
            if (action === "login" || action === "logout") {
              if (configured === undefined || !("url" in configured)) {
                return {
                  output: [{
                    type: "text" as const,
                    text: `Server "${name}" is not a configured Streamable HTTP server in this gateway's open ` +
                      "configuration. Propose its entry first (an approved entry connects at the next start).",
                  }],
                  isError: true,
                };
              }
            }
            if (action === "remove" && configured === undefined) {
              return {
                output: [{ type: "text" as const, text: `Server "${name}" is not configured in this gateway's open configuration.` }],
                isError: true,
              };
            }
            let entry: McpServerConfig | undefined;
            if (action === "propose") {
              try {
                entry = proposeEntry(options.edit.workspace, name, args.server);
              } catch (error) {
                return {
                  output: [{
                    type: "text" as const,
                    text: `Proposal rejected: ${error instanceof Error ? error.message : "invalid entry"}.`,
                  }],
                  isError: true,
                };
              }
            }
            let id: string;
            try {
              id = await propose(
                context,
                api.conversationId,
                action === "propose" ? "config" : action,
                name,
                action === "propose" ? (args.server as Record<string, JsonValue>) : undefined,
              );
            } catch (error) {
              return {
                output: [{
                  type: "text" as const,
                  text: `Proposal not recorded: ${error instanceof Error ? error.message : "failed"}.`,
                }],
                isError: true,
              };
            }
            const what = action === "propose"
              ? `a server entry for "${name}"${entry !== undefined && "url" in entry && entry.oauth === true ? " that uses an owner-approved OAuth login" : ""}`
              : action === "login"
                ? `an OAuth login for "${name}"`
                : action === "logout"
                  ? `deleting the stored OAuth grant for "${name}"`
                  : `removing the server entry "${name}"`;
            return {
              output: [{
                type: "text" as const,
                text: `Recorded owner approval request ${id} for ${what}. Nothing is configured, connected or ` +
                  `authorized yet. Ask the owner to review it with \`/mcp show ${id}\` and to run ` +
                  `\`/mcp approve ${id}\` or \`/mcp deny ${id}\` in a terminal or in the authenticated Telegram ` +
                  "owner chat. A configuration change connects at the next gateway start; an approved OAuth login " +
                  "hands the owner a one-time authorization URL.",
              }],
              details: { requestId: id, kind: action, name },
            };
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
            return undefined;
          },
        }),
      ],
    }),
    list: listingOf,
    async show(id, context) {
      if (!ID_PATTERN.test(id)) {
        return { found: false, text: `No MCP owner approval request ${bounded(id, 32)} exists.` };
      }
      const request = await findRequest(context, id);
      if (request === undefined) {
        return { found: false, text: `No MCP owner approval request ${bounded(id, 32)} exists.` };
      }
      const state = request.status === "pending" || request.status === "running" ? "" : ` (already ${request.status})`;
      return {
        found: true,
        text: `${renderShow(request, { edit: options.edit, config: options.config })}${state}`,
      };
    },
    async approve(id, context) {
      if (!ID_PATTERN.test(id)) {
        return { status: "refused", text: `No MCP owner approval request ${bounded(id, 32)} exists.` };
      }
      if (inFlight.has(id)) {
        return {
          status: "refused",
          text: `Request ${id} is already being applied or is waiting for its browser callback; finish or cancel it first.`,
        };
      }
      // Reserve first, then claim durably: no second decision can start for this request while the
      // approval is between asynchronous steps.
      const flow = reserve(id);
      try {
        const claimed = await claim(context, id);
        if (claimed.kind === "missing") {
          return { status: "refused", text: `No MCP owner approval request ${bounded(id, 32)} exists.` };
        }
        if (claimed.kind === "taken") {
          return {
            status: "refused",
            text: `Request ${claimed.request.id} is already ${claimed.request.status} ` +
              `(${claimed.request.outcome ?? "settled"}); nothing was done.`,
          };
        }
        const result = await applyRequest(context, claimed.request, flow);
        if (result.status === "refused") {
          // A decision that proved to have no effect leaves the request available for the owner.
          await releaseClaim(context, id).catch(() => undefined);
        }
        return result;
      } catch (error) {
        await releaseClaim(context, id).catch(() => undefined);
        return {
          status: "refused",
          text: `Request ${id} could not be applied (${error instanceof Error ? error.message : "failed"}); ` +
            "nothing was confirmed.",
        };
      } finally {
        // A started login keeps its reservation until its completion settles; every other outcome is
        // done when this call returns.
        if (flow.run === undefined && inFlight.get(id) === flow) inFlight.delete(id);
        flow.finish();
      }
    },
    async deny(id, context) {
      if (!ID_PATTERN.test(id)) {
        return { status: "refused", text: `No MCP owner approval request ${bounded(id, 32)} exists.` };
      }
      // Repair any interrupted request durably first, so this decision reports it as settled instead of
      // claiming an unknown effect is still running.
      await read(context);
      const decided = await options.requests.write(context, (requests) => {
        const index = requests.findIndex((entry) => entry.id === id);
        if (index < 0) return { kind: "missing" as const };
        const stored = requests[index]!;
        if (stored.status === "done" || stored.status === "failed") {
          return { kind: "settled" as const, request: detach(stored) };
        }
        // Read the live reservation inside the decision, so an approval that claimed between the
        // caller's first read and this commit is still recognized.
        const live = inFlight.get(id);
        // A non-login approval is a short atomic write; a denial cannot stop it halfway and must not
        // claim it did. The owner can wait for it to settle instead.
        if (live !== undefined && live.phase === "applying") {
          return { kind: "applying" as const, request: detach(stored) };
        }
        // A `running` request with no live flow was interrupted by a restart; its effect is unknown.
        if (stored.status === "running" && live === undefined) {
          return { kind: "interrupted" as const, request: detach(stored) };
        }
        // Denying is a decision, not history worth keeping: the request is consumed and nothing applied.
        requests.splice(index, 1);
        return { kind: "removed" as const, request: detach(stored) };
      });
      if (decided.kind === "missing") {
        return { status: "refused", text: `No MCP owner approval request ${bounded(id, 32)} exists.` };
      }
      if (decided.kind === "settled") {
        return {
          status: "refused",
          text: `Request ${decided.request.id} is already ${decided.request.status} ` +
            `(${decided.request.outcome ?? "settled"}); nothing was done.`,
        };
      }
      if (decided.kind === "applying") {
        return {
          status: "refused",
          text: `Request ${decided.request.id} is already being applied and cannot be stopped halfway. ` +
            "Nothing was denied; wait for it to settle and then decide again if needed.",
        };
      }
      if (decided.kind === "interrupted") {
        return {
          status: "refused",
          text: `Request ${decided.request.id} was interrupted before it settled, so its effect is unknown and it ` +
            "cannot be denied now. Nothing was done by this denial; `/mcp` repairs the request list.",
        };
      }
      const live = inFlight.get(id);
      if (live !== undefined && live.phase === "login") {
        // The flow observes this abort during startup and through the browser wait.
        silent.add(id);
        live.abort.abort();
      }
      return {
        status: "applied",
        text: decided.request.status === "running"
          ? `Denied MCP request ${decided.request.id}: it was already running, so any live login was canceled. ` +
            (decided.request.kind === "config"
              ? "Its configuration write may already have completed; review the configuration. "
              : "") +
            "A grant it had already stored is kept; ask for a logout to delete it."
          : `Denied MCP request ${decided.request.id} (${decided.request.kind} ${decided.request.name}): nothing was ` +
            "configured, connected or authorized.",
      };
    },
    async close() {
      for (const [id, flow] of [...inFlight]) {
        // Shutdown answers nobody with a model turn; the outcome stays in the request list.
        silent.add(id);
        flow.abort.abort();
        // A login that has not returned its URL yet also observes the abort. Waiting for the approving call
        // first means a started login's run is final here, and its own completion is then the outcome to
        // keep; the store is still open, so the request is not left unapprovably `running` for the next open.
        await flow.done.catch(() => undefined);
        const outcome = await flow.run?.completion.catch(() => undefined);
        if (inFlight.get(id) === flow) inFlight.delete(id);
        silent.delete(id);
        // A login whose completion rejected has no reported result; the next open repairs it as interrupted.
        if (outcome === undefined) continue;
        await settleLogin(id, outcome).catch(() => undefined);
      }
    },
  };
}
