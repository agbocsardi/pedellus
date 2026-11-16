/**
 * Channel-neutral owner delivery for one model-requested question.
 *
 * A question is admitted by the `ask_user` tool in an authenticated mapped ordinary chat, then
 * handed to the live surface that owns that exact session: the attached local terminal, or the
 * authenticated Telegram private chat. The registry never guesses a recipient: two CLI attachments
 * sharing one conversation make delivery ambiguous and it is refused, exactly like MCP login
 * delivery.
 *
 * A surface receives only the bounded question view. It renders it, and for a rich surface owns its
 * own single-use callback check; it never receives a credential, host path, transcript or another
 * chat's text.
 */
import type { Context } from "@earendil-works/chord";
import type { AskQuestionView } from "./ask.js";

export class AskDeliveryUnknown extends Error {
  constructor() { super("Question delivery outcome is unknown"); this.name = "AskDeliveryUnknown"; }
}

export interface AskOwnerSurface {
  /** True only for the exact authenticated session this attachment owns right now. */
  owns(sessionKey: string): boolean;
  /**
   * Render one already-durable question. A definite refusal throws an ordinary error;
   * an ambiguous external outcome throws AskDeliveryUnknown and is quarantined, never resent.
   */
  deliverQuestion(sessionKey: string, question: AskQuestionView, context: Context): Promise<void>;
}

export interface AskSurfaceRegistry {
  attach(host: AskOwnerSurface): () => void;
  /** The unique live surface for this exact session, or `undefined` when none or several own it. */
  surfaceFor(sessionKey: string): AskOwnerSurface | undefined;
}

export function createAskSurfaceRegistry(): AskSurfaceRegistry {
  const hosts: AskOwnerSurface[] = [];
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
      const matches = hosts.filter((host) => host.owns(sessionKey));
      return matches.length === 1 ? matches[0] : undefined;
    },
  };
}
