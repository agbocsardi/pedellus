/**
 * The `app` channel's loopback HTTP+WebSocket listener: static file serving, the one-time pairing
 * endpoint and the authenticated device stream.
 *
 * This module owns transport mechanics only — sockets, bodies, cookies, MIME types and path safety.
 * Every authority decision (pairing redemption, token authentication, frame semantics) is delegated
 * to the adapter's host, so no policy lives here. The bind address is fixed to 127.0.0.1: the
 * listener is published with `tailscale serve`, never exposed directly.
 *
 * Tailscale identity headers are ignored by construction: nothing here reads them, and the device
 * cookie is the only authentication.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpath, stat, open } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { WebSocketServer, WebSocket, type WebSocket as WebSocketType } from "ws";
import { journalEvent } from "../observability.js";
import {
  APP_CLOSE,
  APP_LIMITS,
  resolveStaticPath,
  staticMimeType,
} from "./app-protocol.js";

const HOST = "127.0.0.1";
const NOT_FOUND_BODY = JSON.stringify({ error: "not_found" });
const PAIR_ERRORS: Readonly<Record<string, [number, string]>> = Object.freeze({
  "bad-request": [400, JSON.stringify({ error: "bad_request" })],
  invalid: [401, JSON.stringify({ error: "invalid_code" })],
  "rate-limited": [429, JSON.stringify({ error: "rate_limited" })],
});

/** One live authenticated device stream, handed to the adapter after the upgrade completed. */
export interface AppDeviceSession {
  readonly deviceId: string;
  readonly label: string;
  /** Send one already-JSON-encoded frame; a dead socket swallows the write. */
  send(text: string): void;
  /** Close with a protocol close code; the socket is gone afterwards. */
  close(code: number, reason?: string): void;
  isOpen(): boolean;
}

/** The authority surface the adapter implements behind the listener. */
export interface AppListenerHost {
  /** Redeem one pairing code from `POST /v1/pair`; the host owns expiry, single use and the rate limit. */
  pairRedeem(code: string, label: string): Promise<
    | { readonly status: "created"; readonly token: string }
    | { readonly status: "bad-request" }
    | { readonly status: "invalid" }
    | { readonly status: "rate-limited" }
  >;
  /** Resolve one cookie token to its live device, or `undefined` when unknown or revoked. */
  authenticate(token: string): Promise<{ readonly deviceId: string; readonly label: string } | undefined>;
  /** One authenticated stream was opened; the adapter owns its frames from here on. */
  onSocket(session: AppDeviceSession, hooks: AppSessionHooks): void;
}

/** Registration hooks the adapter attaches to one live session. */
export interface AppSessionHooks {
  onFrame(handler: (frame: string) => void): void;
  onClosed(handler: () => void): void;
}

export interface AppListener {
  /** The bound port (the requested one, or the ephemeral one when 0 was requested). */
  readonly port: number;
  close(): Promise<void>;
}

/** The exact byte length of one received frame, across ws's possible data shapes. */
function frameBytes(data: import("ws").RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data.byteLength;
}

/** Fixed-cookie extraction: the only header that authenticates a stream. */
function deviceCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    if (trimmed.slice(0, equals) !== APP_LIMITS.cookieName) continue;
    const value = trimmed.slice(equals + 1);
    return value === "" ? undefined : value;
  }
  return undefined;
}

export async function startAppListener(options: {
  readonly port: number;
  readonly staticRoot: string;
  readonly host: AppListenerHost;
  /** Fatal listener errors after serving started; without a handler the process would crash. */
  readonly onError?: (error: unknown) => void;
}): Promise<AppListener> {
  const staticRoot = resolve(options.staticRoot);
  let staticRootReal: string;
  try {
    staticRootReal = await realpath(staticRoot);
  } catch (cause) {
    throw new Error("app.staticRoot could not be resolved on this host", { cause });
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: APP_LIMITS.frameBytes * 8 });

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "internal" }));
      } else response.destroy();
    });
  });

  // The upgrade is always completed for /v1/stream; an unknown or revoked cookie then closes 4401,
  // so the browser can tell an authentication failure from a network failure.
  server.on("upgrade", (request, socket, head) => {
    if (request.url === undefined || resolveStaticPath(request.url) === undefined) {
      socket.destroy();
      return;
    }
    const path = request.url.split("?", 1)[0]!;
    if (path !== "/v1/stream") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket as never, head, (ws) => {
      void handOffStream(ws, request).catch(() => undefined);
    });
  });

  async function handOffStream(ws: WebSocketType, request: IncomingMessage): Promise<void> {
    const token = deviceCookie(request.headers.cookie);
    const device = token === undefined ? undefined : await options.host.authenticate(token);
    if (device === undefined) {
      ws.close(APP_CLOSE.unauthorized, "unpaired");
      return;
    }
    let frameHandler: ((frame: string) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    let didClose = false;
    const session: AppDeviceSession = {
      deviceId: device.deviceId,
      label: device.label,
      isOpen: () => ws.readyState === WebSocket.OPEN,
      send(text) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(text);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    ws.on("message", (data) => {
      // The frame bound is enforced here, mechanically, before any state-bearing code sees it.
      if (frameBytes(data) > APP_LIMITS.frameBytes) {
        session.close(APP_CLOSE.protocol, "frame too large");
        return;
      }
      frameHandler?.(data.toString());
    });
    ws.on("close", () => {
      didClose = true;
      closeHandler?.();
    });
    options.host.onSocket(session, {
      onFrame(handler) { frameHandler = handler; },
      onClosed(handler) {
        if (didClose) handler();
        else closeHandler = handler;
      },
    });
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawPath = request.url ?? "/";
    if (request.method === "POST" && rawPath.split("?", 1)[0] === "/v1/pair") {
      await pairEndpoint(request, response);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (rawPath.split("?", 1)[0] === "/v1/stream") {
      // A stream without an upgrade is not a usable endpoint; the static root is not searched.
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    await serveStatic(request, response);
  }

  async function pairEndpoint(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > APP_LIMITS.frameBytes) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "bad_request" }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let body: { code?: unknown; label?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: unknown; label?: unknown };
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    const code = body.code;
    const label = body.label;
    if (typeof code !== "string" || code.length === 0 || code.length > 64 ||
        typeof label !== "string" || label.length === 0 || label.length > 200) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    const result = await options.host.pairRedeem(code, label);
    if (result.status !== "created") {
      const [status, text] = PAIR_ERRORS[result.status]!;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(text);
      return;
    }
    // Exactly the protocol's cookie attributes. `Max-Age=34560000` (400 days) is required by v1:
    // iOS drops session cookies when a home-screen app closes, so without it every suspension
    // would force a re-pairing.
    response.setHeader(
      "set-cookie",
      `${APP_LIMITS.cookieName}=${result.token}; HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=34560000`,
    );
    response.writeHead(204);
    response.end();
  }

  async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const resolved = resolveStaticPath(request.url ?? "/");
    if (resolved === undefined) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    const segments = resolved.segments.length === 0 ? ["index.html"] : resolved.segments;
    const target = join(staticRoot, ...segments);
    let real: string;
    let info;
    try {
      // Path safety is containment against the resolved root: a symlink that escapes the build
      // directory resolves outside it and is refused, like an explicit traversal.
      real = await realpath(target);
      info = await stat(real);
    } catch {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(NOT_FOUND_BODY);
      return;
    }
    if ((real !== staticRootReal && !real.startsWith(`${staticRootReal}${sep}`)) || !info.isFile()) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(NOT_FOUND_BODY);
      return;
    }
    if (info.size > 64 * 1024 * 1024) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    const handle = await open(real, "r");
    try {
      const name = segments.at(-1)!;
      const headers: Record<string, string | number> = {
        "content-type": staticMimeType(name),
        "content-length": info.size,
      };
      if (name === "sw.js") headers["cache-control"] = "no-store";
      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      for await (const chunk of handle.createReadStream()) {
        if (!response.write(chunk)) {
          await new Promise<void>((resolveWrite) => response.once("drain", () => resolveWrite()));
        }
      }
      response.end();
    } finally {
      await handle.close();
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(options.port, HOST, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : options.port;
  server.on("error", (error) => options.onError?.(error));
  journalEvent("app.listener.serving", { port: boundPort });
  return {
    port: boundPort,
    close() {
      return new Promise<void>((resolveClose, rejectClose) => {
        sockets.close(() => undefined);
        for (const client of sockets.clients) client.terminate();
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    },
  };
}
