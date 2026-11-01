import { chmod, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import type { Conversation, Cursor, EntryId, Tx } from "@earendil-works/pi-durable";
import type { HistoryEpisodeQuery } from "../history/episodes.js";
import type { BackgroundStatus } from "../background-status.js";
import type { HistoryQuery } from "../history/index.js";
import type { MemoryDigestStatusView, MemoryDigestWriter } from "../history/memory-digest.js";
import type { MediaStore } from "../media/attachments.js";
import {
  LocalAttachmentError,
  prepareLocalAttachment,
  type LocalAttachment,
  type LocalAttachmentRejection,
} from "../media/local.js";
import type { Gateway, GatewayMcpAdmin, GatewayModelSelectionRequest } from "../runtime.js";
import {
  inProcessTerminalConversation,
  projectEntry,
  type TerminalEntryQuery,
  type TerminalSettlement,
  type TerminalSubmission,
  type TerminalWatch,
} from "../terminal/conversation.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  LOCAL_PROTOCOL_VERSION,
  LocalGatewayError,
  LocalRequestError,
  conversationToken,
  errorBody,
  optionalCursor,
  optionalString,
  parseRequestLine,
  requireInteger,
  requireObject,
  requireString,
  type LocalRequestEnvelope,
  type LocalServerMessage,
} from "./protocol.js";

export interface LocalGatewayHostOptions {
  /** Absolute path inside the private data directory. */
  readonly socketPath: string;
  readonly gateway: Gateway;
  /** Gateway owner context; its cancellation stops serving. */
  readonly context: Context;
  /** Configured coding tools, reported for read-only `/tools` diagnostics. */
  readonly tools: readonly string[];
  /** Whether the gateway was opened with a workspace context provider. */
  readonly contextRefresh: boolean;
  /** Whether named model presets are configured. */
  readonly presets: boolean;
  /** Configured CLI-scoped workspace media store; absent keeps local attachments unavailable. */
  readonly attachments?: { readonly store: MediaStore };
  /** Host-owned process replacement; acknowledge the request before tearing down connections. */
  readonly restart?: {
    readonly supported: boolean;
    request(acknowledge: () => Promise<void>): Promise<void>;
  };
}

export interface LocalGatewayServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Private Unix socket path; refuses a path the platform cannot represent. */
export function gatewaySocketPath(canonicalDataDir: string): string {
  const path = resolve(canonicalDataDir, "gateway.sock");
  if (Buffer.byteLength(path, "utf8") > 100) {
    throw new LocalGatewayError("address", "configured data directory is too long for a local socket path");
  }
  return path;
}

/** True when some process answers on the socket; an unresponsive listener still owns it. */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolveLive) => {
    const socket = connect({ path });
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveLive(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(true));
  });
}

/**
 * Serve the already-open gateway on its private local socket.
 *
 * Ownership comes from the Durable store lock, which the gateway acquired before
 * this call: a second gateway cannot reach this point for the same store. A stale
 * socket file is removed only after a connection attempt fails; a live listener is
 * refused instead of replaced.
 */
export async function serveLocalGateway(options: LocalGatewayHostOptions): Promise<LocalGatewayServer> {
  if (await socketIsLive(options.socketPath)) {
    throw new LocalGatewayError("address", "another gateway already serves this local endpoint");
  }
  try {
    await unlink(options.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new LocalGatewayError("address", "stale local endpoint could not be removed");
    }
  }

  const connections = new Set<LocalConnection>();
  let closing = false;
  const server: Server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const connection = new LocalConnection(socket, options);
    connections.add(connection);
    void connection.closed.finally(() => connections.delete(connection));
  });
  let listening = false;
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => { rejectListen(error); };
      server.once("error", onError);
      server.listen(options.socketPath, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
    listening = true;
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    server.close();
    if (listening) await unlink(options.socketPath).catch(() => undefined);
    throw new LocalGatewayError("address", "local gateway endpoint could not be opened");
  }

  let closed = false;
  return {
    socketPath: options.socketPath,
    async close() {
      if (closed) return;
      closed = true;
      closing = true;
      const stopped = [...connections].map((connection) => connection.close());
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await Promise.allSettled(stopped);
      await unlink(options.socketPath).catch(() => undefined);
    },
  };
}

/** One attached CLI connection: scoped to one `cli:<name>` conversation. */
class LocalConnection {
  readonly closed: Promise<void>;
  private readonly socket: Socket;
  private readonly options: LocalGatewayHostOptions;
  private readonly scope;
  private readonly finishClosed: () => void;
  private gatewayConversation: Conversation | undefined;
  private surface: ReturnType<typeof inProcessTerminalConversation> | undefined;
  private watch: TerminalWatch | undefined;
  private sessionKey: string | undefined;
  private detachMcpSurface: (() => void) | undefined;
  private readonly submissions = new Map<number, TerminalSubmission>();
  private settled = new Map<number, TerminalSettlement>();
  private settledOrder: number[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private queue: string[] = [];
  private draining = false;
  private finished = false;

  constructor(socket: Socket, options: LocalGatewayHostOptions) {
    this.socket = socket;
    this.options = options;
    this.scope = withCancel(options.context);
    let resolveClosed!: () => void;
    this.closed = new Promise<void>((resolveFinished) => { resolveClosed = resolveFinished; });
    this.finishClosed = () => resolveClosed();
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.shutdown());
    socket.on("close", () => this.shutdown());
  }

  /** Stop the local observer; durably admitted work keeps running in the gateway. */
  async close(): Promise<void> {
    this.finished = true;
    this.detachMcpSurface?.();
    this.detachMcpSurface = undefined;
    this.scope.cancel(new Error("local client disconnected"));
    try {
      await this.watch?.stop();
    } catch {
      // A stopped or failed watch needs no further cleanup.
    }
    this.watch = undefined;
    this.socket.destroy();
    this.submissions.clear();
    this.settled = new Map();
    this.settledOrder = [];
    this.finishClosed();
  }

  private shutdown(): void {
    if (this.finished) return;
    this.finished = true;
    this.detachMcpSurface?.();
    this.detachMcpSurface = undefined;
    this.scope.cancel(new Error("local client disconnected"));
    void this.watch?.stop().catch(() => undefined);
    this.watch = undefined;
    this.socket.destroy();
    this.submissions.clear();
    this.settled = new Map();
    this.settledOrder = [];
    this.finishClosed();
  }

  private onData(chunk: Buffer): void {
    if (this.finished) return;
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > LOCAL_PROTOCOL_LIMITS.maxRequestLineBytes) {
      this.protocolFailure("request line exceeds the local transport bound");
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) this.queue.push(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.queue.length > LOCAL_PROTOCOL_LIMITS.maxPendingRequests * 2) {
      this.protocolFailure("too many queued requests");
      return;
    }
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.finished) {
        const line = this.queue.shift();
        if (line === undefined) break;
        await this.handleLine(line);
      }
    } finally {
      this.draining = false;
    }
  }

  private async handleLine(line: string): Promise<void> {
    let request: LocalRequestEnvelope;
    try {
      request = parseRequestLine(line);
    } catch {
      // Without a trustworthy envelope there is no request scope to continue.
      this.send({ id: 0, error: { code: "invalid", message: "invalid request envelope" } });
      this.shutdown();
      return;
    }
    try {
      const result = await this.dispatch(request);
      if (!this.finished && request.method !== "restart") this.send({ id: request.id, result });
    } catch (error) {
      if (!this.finished) this.send({ id: request.id, error: errorBody(error) });
    }
  }

  private async dispatch(request: LocalRequestEnvelope): Promise<unknown> {
    if (request.method === "attach") return this.attach(request.params);
    if (this.surface === undefined || this.sessionKey === undefined || this.gatewayConversation === undefined) {
      throw new LocalRequestError("unavailable", "attach must be the first request");
    }
    switch (request.method) {
      case "watch":
        return this.startWatch();
      case "submit":
        return this.submit(request.params);
      case "submitAttachment":
        return this.submitAttachment(request.params);
      case "submissionStatus":
        return this.submissionStatus(request.params);
      case "answer": {
        const params = requireObject(request.params);
        onlyKeys(params, ["entryId"]);
        return this.surface.answer(requireInteger(params, "entryId", 1, LOCAL_PROTOCOL_LIMITS.maxEntryId), this.scope.context);
      }
      case "status": {
        // The background summary is an additive capability field on the same request: it is the
        // gateway's own bounded read for this already-attached conversation, and a host read failure
        // leaves the core status exactly as before rather than claiming an idle background.
        const status = await this.surface.status(this.scope.context);
        let background: BackgroundStatus | undefined;
        try {
          background = await this.options.gateway.backgroundStatus(this.sessionKey, this.scope.context);
        } catch {
          background = undefined;
        }
        return background === undefined ? status : { ...status, background };
      }
      case "entries": {
        const params = requireObject(request.params);
        onlyKeys(params, ["query", "limit", "cursor"]);
        return this.surface.entries(
          entryQuery(params.query),
          requireInteger(params, "limit", 1, LOCAL_PROTOCOL_LIMITS.maxEntryPage),
          optionalCursor(params, "cursor") as Cursor | undefined,
          this.scope.context,
        );
      }
      case "compact":
        return { taskId: await this.surface.compact(this.scope.context) };
      case "abort":
        await this.surface.abort(this.scope.context);
        return {};
      case "reset":
        return this.options.gateway.resetSession(this.sessionKey, this.scope.context);
      case "restart": {
        onlyKeys(requireObject(request.params ?? {}), []);
        if (!this.options.restart?.supported) {
          throw new LocalRequestError("unavailable", "gateway process restart is unavailable on this host");
        }
        await this.options.restart.request(() => new Promise<void>((resolveSent, rejectSent) => {
          this.socket.write(`${JSON.stringify({ id: request.id, result: {} })}\n`, (error) => {
            if (error) rejectSent(error);
            else resolveSent();
          });
        }));
        return {};
      }
      case "listModels":
        return this.options.gateway.listModels(this.sessionKey, this.scope.context);
      case "selectModel": {
        const params = requireObject(request.params);
        onlyKeys(params, ["selection"]);
        return this.options.gateway.selectModel(
          this.sessionKey,
          modelSelection(params.selection),
          this.scope.context,
        );
      }
      case "selectModelPreset": {
        const params = requireObject(request.params);
        onlyKeys(params, ["name"]);
        return this.options.gateway.selectModelPreset(
          this.sessionKey,
          requireString(params, "name", LOCAL_PROTOCOL_LIMITS.maxLabelChars),
          this.scope.context,
        );
      }
      case "refreshContext": {
        if (!this.options.contextRefresh) {
          throw new LocalRequestError("unavailable", "workspace context is not configured");
        }
        return this.options.gateway.refreshContext(this.sessionKey, this.scope.context);
      }
      case "mcpList":
        onlyKeys(requireObject(request.params ?? {}), []);
        return { listing: await this.mcpAdmin().list(this.scope.context) };
      case "mcpCallback": {
        const params = requireObject(request.params);
        onlyKeys(params, ["text"]);
        return this.mcpAdmin().submitCallback(
          this.sessionKey,
          requireString(params, "text", 8_192),
          this.scope.context,
        );
      }
      case "digestStart":
        return this.options.gateway.memoryDigest.start(this.digestWriter(), this.scope.context);
      case "digestStatus": {
        // The live run's origin conversation is host-internal ownership metadata: it lets the host
        // label a run as this chat's or another's. Only that bounded view crosses the socket, so no
        // other chat's conversation ID is exposed and a later internal field is not either.
        const status = await this.options.gateway.memoryDigest.status(this.digestWriter(), this.scope.context);
        // Annotated with the projected shape, so a new internal status field must be admitted here
        // deliberately instead of reaching the socket by accident.
        const projected: MemoryDigestStatusView = {
          liveTaskId: status.liveTaskId,
          latest: status.latest,
          pendingNotices: status.pendingNotices,
          canStart: status.canStart,
          refusal: status.refusal,
        };
        return projected;
      }
      case "historySearch": {
        const params = requireObject(request.params);
        onlyKeys(params, ["query"]);
        return this.options.gateway.historySearch(historyQuery(params.query), this.scope.context);
      }
      case "historyEpisodes": {
        const params = requireObject(request.params);
        onlyKeys(params, ["session", "query"]);
        return this.options.gateway.listHistoryEpisodes(
          historySession(params.session, this.sessionKey),
          episodeQuery(params.query),
          this.scope.context,
        );
      }
      case "historyEpisode": {
        const params = requireObject(request.params);
        onlyKeys(params, ["session", "startEntryId"]);
        return this.options.gateway.historyEpisode(
          historySession(params.session, this.sessionKey),
          requireInteger(params, "startEntryId", 1, LOCAL_PROTOCOL_LIMITS.maxEntryId),
          this.scope.context,
        );
      }
      case "historyEntries": {
        const params = requireObject(request.params);
        onlyKeys(params, ["session", "query", "limit", "cursor"]);
        const page = await this.options.gateway.historyEntries(
          historySession(params.session, this.sessionKey),
          entryQuery(params.query),
          requireInteger(params, "limit", 1, LOCAL_PROTOCOL_LIMITS.maxEntryPage),
          optionalCursor(params, "cursor") as Cursor | undefined,
          this.scope.context,
        );
        return {
          conversationId: page.conversationId,
          items: page.items.map((entry) => projectEntry(entry)),
          ...(page.next === undefined ? {} : { next: page.next }),
        };
      }
      default:
        throw new LocalRequestError("invalid", "unsupported request method");
    }
  }

  private async attach(params: unknown): Promise<unknown> {
    if (this.gatewayConversation !== undefined) {
      throw new LocalRequestError("invalid", "connection is already attached");
    }
    const record = params === undefined ? {} : requireObject(params);
    onlyKeys(record, ["conversation"]);
    const token = conversationToken(record.conversation);
    const sessionKey = `cli:${token}`;
    const conversation = await this.options.gateway.conversationFor(sessionKey, this.scope.context);
    this.gatewayConversation = conversation;
    this.sessionKey = sessionKey;
    this.surface = inProcessTerminalConversation(conversation);
    this.detachMcpSurface = this.options.gateway.mcpSurfaces?.attach({
      owns: (candidate) => candidate === sessionKey,
      deliverAuthorization: async (target, authorization) => {
        if (target !== sessionKey) throw new Error("MCP authorization belongs to another session");
        if (!this.send({ event: "mcpAuthorization", authorization })) {
          throw new Error("the local attachment is no longer connected");
        }
      },
      deliverNotice: async (target, text) => {
        if (target !== sessionKey) return;
        this.send({ event: "mcpNotice", text });
      },
    });
    return {
      protocol: LOCAL_PROTOCOL_VERSION,
      sessionKey,
      conversationId: conversation.id,
      tools: this.options.tools,
      contextRefresh: this.options.contextRefresh,
      presets: this.options.presets,
      attachments: this.options.attachments !== undefined,
      digest: true,
      mcp: this.options.gateway.mcpAdmin !== undefined,
      restart: this.options.restart?.supported === true,
    };
  }

  /**
   * Owner-scoped MCP management is part of the same authenticated local attach: it is the gateway's
   * own owner surface, never a model tool and never a second runtime. Absent means this gateway was
   * opened without an on-disk configuration file, so it has nothing to write.
   */
  private mcpAdmin(): GatewayMcpAdmin {
    const admin = this.options.gateway.mcpAdmin;
    if (admin === undefined) {
      throw new LocalRequestError("unavailable", "MCP management is unavailable in this gateway");
    }
    return admin;
  }

  /** The attached conversation is the digest origin; no other conversation is addressable here. */
  private digestWriter(): MemoryDigestWriter {
    const conversation = this.gatewayConversation!;
    return {
      id: conversation.id,
      commit: (change, context) => conversation.commit(change, context),
    };
  }

  private async startWatch(): Promise<unknown> {
    if (this.surface === undefined) throw new LocalRequestError("unavailable", "attach must be the first request");
    await this.watch?.stop().catch(() => undefined);
    const watch = await this.surface.watch(this.scope.context);
    this.watch = watch;
    watch.start(async (snapshot) => {
      if (this.finished) return;
      this.send({ event: "snapshot", snapshot });
    });
    // The terminal never replays an initial snapshot; this handshake only confirms
    // the subscription without claiming unseen history.
    return {};
  }

  private async submit(params: unknown): Promise<{ readonly id: number }> {
    if (this.surface === undefined) throw new LocalRequestError("unavailable", "attach must be the first request");
    const record = params === undefined ? {} : requireObject(params);
    onlyKeys(record, ["content"]);
    const content = requireString(record, "content", LOCAL_PROTOCOL_LIMITS.maxInputChars);
    const submission = await this.surface.submit(content, this.scope.context);
    this.submissions.set(submission.id, submission);
    this.observe(submission);
    return { id: submission.id };
  }

  /**
   * Store one operator-named local file through the gateway's own media store, then
   * admit the path-only turn like any other input. The path stays operator input; the
   * model receives only the stored workspace-relative locator and bounded metadata,
   * never image content or an automatic vision/transcription call.
   */
  private async submitAttachment(params: unknown): Promise<unknown> {
    if (this.surface === undefined) throw new LocalRequestError("unavailable", "attach must be the first request");
    const ingress = this.options.attachments;
    if (ingress === undefined) {
      throw new LocalRequestError("unavailable", "local attachments are not configured");
    }
    const record = requireObject(params);
    onlyKeys(record, ["path", "content"]);
    const path = requireString(record, "path", LOCAL_PROTOCOL_LIMITS.maxAttachmentPathChars);
    const content = optionalString(record, "content", LOCAL_PROTOCOL_LIMITS.maxInputChars);

    let prepared: LocalAttachment;
    try {
      prepared = await prepareLocalAttachment(ingress.store, {
        path,
        ...(content === undefined ? {} : { text: content }),
        ...(this.scope.context.abortSignal === undefined ? {} : { signal: this.scope.context.abortSignal }),
      });
    } catch (error) {
      if (this.scope.context.abortSignal?.aborted) throw error;
      if (error instanceof LocalAttachmentError) {
        throw new LocalRequestError(attachmentErrorCode(error.rejection), LOCAL_ATTACHMENT_ERROR_TEXT[error.rejection]);
      }
      throw new LocalRequestError("failed", "the attachment could not be prepared");
    }

    const submission = await this.surface.submit(prepared.content, this.scope.context);
    this.submissions.set(submission.id, submission);
    this.observe(submission);
    return {
      id: submission.id,
      attachment: { relativePath: prepared.relativePath, bytes: prepared.bytes },
    };
  }

  private observe(submission: TerminalSubmission): void {
    void submission.wait(this.scope.context).then((settlement) => {
      if (this.finished) return;
      this.submissions.delete(submission.id);
      this.settled.set(submission.id, settlement);
      this.settledOrder.push(submission.id);
      while (this.settledOrder.length > LOCAL_PROTOCOL_LIMITS.maxPendingSnapshots * 4) {
        const oldest = this.settledOrder.shift();
        if (oldest !== undefined) this.settled.delete(oldest);
      }
      this.send({ event: "settled", id: submission.id, settlement });
    }).catch(() => {
      // A disconnected or failed observer settles only the local wait; the
      // durably admitted submission keeps its own gateway-side lifecycle.
    });
  }

  private async submissionStatus(params: unknown): Promise<{ readonly status: string }> {
    const record = requireObject(params);
    onlyKeys(record, ["id"]);
    const id = requireInteger(record, "id", 1, LOCAL_PROTOCOL_LIMITS.maxEntryId);
    const cached = this.settled.get(id);
    if (cached !== undefined) return { status: cached.status };
    const submission = this.submissions.get(id);
    if (submission === undefined) throw new LocalRequestError("unavailable", "unknown submission");
    return { status: (await submission.status(this.scope.context)).status };
  }

  private send(message: LocalServerMessage): boolean {
    if (this.finished || this.socket.destroyed) return false;
    if (this.socket.writableLength > LOCAL_PROTOCOL_LIMITS.maxOutboundBytes) {
      this.shutdown();
      return false;
    }
    try {
      this.socket.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      this.shutdown();
      return false;
    }
  }

  private protocolFailure(message: string): void {
    this.send({ id: 0, error: { code: "invalid", message } });
    this.shutdown();
  }
}

function historySession(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0 || value.length > LOCAL_PROTOCOL_LIMITS.maxLabelChars) {
    throw new LocalRequestError("invalid", "session is not accepted");
  }
  return value;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new LocalRequestError("invalid", "request has an unsupported field");
  }
}

function modelSelection(value: unknown): GatewayModelSelectionRequest {
  const record = requireObject(value);
  onlyKeys(record, ["provider", "modelId", "thinkingLevel"]);
  const provider = requireString(record, "provider", LOCAL_PROTOCOL_LIMITS.maxLabelChars);
  const modelId = requireString(record, "modelId", LOCAL_PROTOCOL_LIMITS.maxLabelChars);
  if (record.thinkingLevel === undefined) return { provider, modelId };
  return {
    provider,
    modelId,
    thinkingLevel: requireString(record, "thinkingLevel", 32) as NonNullable<GatewayModelSelectionRequest["thinkingLevel"]>,
  };
}

function entryQuery(value: unknown): TerminalEntryQuery {
  if (value === undefined) return {};
  const record = requireObject(value);
  onlyKeys(record, ["minEntryId", "maxEntryId", "order"]);
  const order = record.order;
  if (order !== undefined && order !== "ascending" && order !== "descending") {
    throw new LocalRequestError("invalid", "query order is not accepted");
  }
  return {
    ...(record.minEntryId === undefined
      ? {}
      : { minEntryId: requireInteger(record, "minEntryId", 1, LOCAL_PROTOCOL_LIMITS.maxEntryId) as EntryId }),
    ...(record.maxEntryId === undefined
      ? {}
      : { maxEntryId: requireInteger(record, "maxEntryId", 1, LOCAL_PROTOCOL_LIMITS.maxEntryId) as EntryId }),
    ...(order === undefined ? {} : { order }),
  };
}

function historyQuery(value: unknown): HistoryQuery {
  const record = requireObject(value);
  onlyKeys(record, ["text", "scope", "roles", "limit", "cursor"]);
  const scope = record.scope;
  if (scope !== undefined && scope !== "messages" && scope !== "tools" && scope !== "all") {
    throw new LocalRequestError("invalid", "search scope is not accepted");
  }
  let roles: ("user" | "assistant")[] | undefined;
  if (record.roles !== undefined) {
    if (!Array.isArray(record.roles) || record.roles.length === 0 || record.roles.length > 2) {
      throw new LocalRequestError("invalid", "search roles are not accepted");
    }
    roles = record.roles.map((role) => {
      if (role !== "user" && role !== "assistant") throw new LocalRequestError("invalid", "search roles are not accepted");
      return role;
    });
  }
  const query: { -readonly [K in keyof HistoryQuery]?: HistoryQuery[K] } = {};
  if (record.text !== undefined) query.text = requireString(record, "text", 500);
  if (scope !== undefined) query.scope = scope;
  if (roles !== undefined) query.roles = roles;
  if (record.limit !== undefined) query.limit = requireInteger(record, "limit", 1, LOCAL_PROTOCOL_LIMITS.maxHistoryLimit);
  if (record.cursor !== undefined) query.cursor = optionalCursor(record, "cursor") as unknown as NonNullable<HistoryQuery["cursor"]>;
  return query as HistoryQuery;
}

function episodeQuery(value: unknown): HistoryEpisodeQuery {
  if (value === undefined) return {};
  const record = requireObject(value);
  onlyKeys(record, ["limit", "before"]);
  return {
    ...(record.limit === undefined ? {} : { limit: requireInteger(record, "limit", 1, 50) }),
    ...(record.before === undefined
      ? {}
      : { before: requireInteger(record, "before", 1, LOCAL_PROTOCOL_LIMITS.maxEntryId) as EntryId }),
  };
}

/** Fixed, value-free attachment refusals; the operator's path never enters the error text. */
const LOCAL_ATTACHMENT_ERROR_TEXT: Record<LocalAttachmentRejection, string> = {
  path: "attachment path must be an absolute path without control characters",
  unreadable: "attachment file could not be read",
  "too-large": "attachment exceeds the configured size limit",
  empty: "attachment file is empty",
  "store-failed": "attachment could not be stored in the workspace media directory",
};

function attachmentErrorCode(rejection: LocalAttachmentRejection): "invalid" | "failed" {
  return rejection === "unreadable" || rejection === "store-failed" ? "failed" : "invalid";
}

