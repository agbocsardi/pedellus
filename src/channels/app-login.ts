import type { Context } from "@earendil-works/chord";
import type { McpAuthorizationLink, McpOwnerSurface } from "../mcp/surface.js";

/**
 * The app channel's MCP login owner surface.
 *
 * A login starts in an authenticated app thread and the one-time authorization URL goes to the
 * devices that are streaming right now, as a non-durable `login` frame (pwa/protocol/v2.md, "MCP
 * login"). It is never appended to the durable event log, never written to channel state, never
 * pushed and never logged. When no hello'd stream is open the delivery fails, which cancels the
 * just-started attempt instead of leaving it waiting for a phone that is not listening.
 *
 * The completion notice is the opposite: one fixed, credential-free line that belongs in the
 * thread, so it uses the ordinary durable notice queue alongside every other host notice.
 */
export interface AppLoginHost {
  /** The thread this exact app session key names while it is open, or undefined. */
  threadFor(sessionKey: string): string | undefined;
  /**
   * Send one already-JSON-encoded frame to every currently hello'd open device stream and return
   * how many received it. Zero means nobody could open the link.
   */
  broadcast(thread: string, frame: string): number;
  /** Append one fixed, credential-free notice to that thread through the durable notice queue. */
  notice(thread: string, text: string): Promise<void>;
}

/** The non-durable frame the app renders as its login card. It carries no cursor. */
export function appLoginFrame(thread: string, authorization: McpAuthorizationLink): string {
  return JSON.stringify({
    type: "event",
    event: "login",
    thread,
    server: authorization.name,
    url: authorization.url,
    expiresAt: new Date(authorization.expiresAtMs).toISOString(),
  });
}

export function createAppLoginSurface(host: AppLoginHost): McpOwnerSurface {
  return {
    owns(sessionKey) {
      return host.threadFor(sessionKey) !== undefined;
    },
    async deliverAuthorization(sessionKey, authorization, _context: Context) {
      const thread = host.threadFor(sessionKey);
      if (thread === undefined) throw new Error("the requesting app thread is no longer open");
      if (!Number.isFinite(authorization.expiresAtMs) || authorization.expiresAtMs <= Date.now()) {
        throw new Error("authorization URL expired before delivery");
      }
      const delivered = host.broadcast(thread, appLoginFrame(thread, authorization));
      // No device is streaming, so no surface can show the one-time URL: refuse the delivery and
      // let the lifecycle cancel the attempt rather than wait for a browser nobody will open.
      if (delivered === 0) throw new Error("no connected app device can receive the authorization URL");
    },
    async deliverNotice(sessionKey, text) {
      const thread = host.threadFor(sessionKey);
      if (thread === undefined) return;
      await host.notice(thread, text);
    },
  };
}
