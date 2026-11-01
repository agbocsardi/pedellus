import type { Context } from "@earendil-works/chord";

/**
 * Channel-neutral owner delivery for one MCP login.
 *
 * A login is initiated by a model turn in an authenticated foreground conversation. The
 * one-time authorization URL is handed to the live surface that owns that exact session, and
 * never returned from the tool, written to a transcript or put in a durable channel outbox.
 * A completion notice uses the same route.
 */
export interface McpAuthorizationLink {
  readonly requestId: string;
  readonly name: string;
  readonly url: string;
  readonly expiresAtMs: number;
}

export interface McpOwnerSurface {
  /** True only for the exact authenticated session this attachment owns right now. */
  owns(sessionKey: string): boolean;
  /** Deliver the one-time URL directly to the owner. Rejection cancels the just-started login. */
  deliverAuthorization(sessionKey: string, authorization: McpAuthorizationLink, context: Context): Promise<void>;
  /** Deliver one fixed, credential-free login outcome. Best effort; never a model turn. */
  deliverNotice(sessionKey: string, text: string, context: Context): Promise<void>;
}

export interface McpSurfaceRegistry {
  attach(host: McpOwnerSurface): () => void;
  surfaceFor(sessionKey: string): McpOwnerSurface | undefined;
}

export function createMcpSurfaceRegistry(): McpSurfaceRegistry {
  const hosts: McpOwnerSurface[] = [];
  return {
    attach(host) {
      hosts.push(host);
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        const index = hosts.indexOf(host);
        if (index >= 0) hosts.splice(index, 1);
      };
    },
    surfaceFor(sessionKey) {
      return hosts.find((host) => host.owns(sessionKey));
    },
  };
}

/**
 * Whether a message is an OAuth authorization response rather than ordinary chat input.
 *
 * Deliberately narrow: an absolute http(s) URL carrying both `state` and `code`/`error`. Such
 * text is handled by the login lifecycle and never admitted as a model message, so a stale or
 * foreign callback cannot carry an authorization code or state into a transcript or prompt.
 */
export function looksLikeOAuthCallback(text: string): boolean {
  if (text.length === 0 || text.length > 8_192) return false;
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed) || /\s/.test(trimmed)) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.searchParams.get("state") === null) return false;
  return url.searchParams.has("code") || url.searchParams.has("error");
}
