/**
 * The model-facing `app` channel tool: deliver one workspace file into the app thread the agent is
 * answering, as a downloadable attachment (`send`) or as a sandboxed artifact (`artifact`).
 *
 * It is a separate channel capability, not a `toolAllowlist` coding-tool name, and it grants no
 * coding authority: the host decides which conversations may use it, and the model never supplies a
 * thread, device or session key. The runtime offers it only in a mapped app chat conversation
 * (including an admitted app side-thread fork); the running adapter must also be attached and
 * re-derives the thread from the host-owned session key at call time.
 *
 * Both actions name one existing regular file inside the configured workspace. The host resolves
 * that path with the shared outbound resolver (workspace-relative, no traversal, no symlink
 * escape, one stable read) and copies it into the app file store. The durable effect is one commit:
 * a referenced file record and an assistant `message` carrying its `AttachmentInfo`. Repeating one
 * execution is idempotent because the message id is derived from the durable tool task id.
 *
 * `send` accepts any regular workspace file up to `LIMITS.uploadBytes`; `artifact` accepts only
 * `.html`, `.htm` or `.svg` up to `LIMITS.artifactBytes` and is stored with `kind: "artifact"`, so
 * `GET /v1/files/<id>?view=artifact` serves it inline under the protocol's sandbox policy.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";
import { validOutboundFilePath } from "../media/outbound.js";
import { APP_LIMITS } from "./app-protocol.js";
import { createSingleHostRegistry, type SingleHostRegistry } from "./contracts.js";

export const APP_TOOL_NAME = "app";

/** Gateway-only bounds for the tool's own text arguments; the file bounds come from protocol v2. */
export const APP_ACTION_LIMITS = Object.freeze({
  /** Tool call id bound, mirroring the Telegram action record. */
  callIdChars: 200,
  /** Workspace-relative path bound, the same syntax and bound Telegram sends use. */
  filePathChars: 1_024,
  /** Optional `send` caption bound; it becomes the assistant message text. */
  captionChars: 1_024,
  /** Optional `artifact` title bound; it becomes the assistant message text. */
  titleChars: 120,
});

/** One workspace file the agent wants delivered, already validated by the tool surface. */
export type AppFileRequest = {
  /** `send`: any regular workspace file; `artifact`: an `.html`/`.htm`/`.svg` explainer. */
  readonly action: "send" | "artifact";
  /** Workspace-relative path of one existing regular file. */
  readonly path: string;
  /** `send` only: bounded caption, which may be empty. */
  readonly caption?: string;
  /** `artifact` only: bounded title shown as the message text. */
  readonly title?: string;
};

export type AppFileOutcome = {
  readonly ok: boolean;
  /** Model-facing result text. Fixed wording; never raw error text, host paths or file contents. */
  readonly text: string;
};

/**
 * Live adapter surface. The host re-derives the thread from the session key, so a call naming any
 * other conversation shape is refused here rather than trusted from the model.
 */
export interface AppActionHost {
  act(
    sessionKey: string,
    callId: string,
    request: AppFileRequest,
    context: Context,
  ): Promise<AppFileOutcome>;
}

/** One host per process, attached by the running app adapter and detached when it stops. */
export type AppActionRegistry = SingleHostRegistry<AppActionHost>;

export function createAppActionRegistry(): AppActionRegistry {
  return createSingleHostRegistry<AppActionHost>();
}

export interface AppToolOptions {
  readonly registry: AppActionRegistry;
  /** Host-owned mapping from a mapped conversation to its exact session key. */
  readonly sessionKeyFor: (conversationId: ConversationId) => string | undefined;
}

function textResult(text: string): { output: { type: "text"; text: string }[] } {
  return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text }], isError: true };
}

export function createAppTool(options: AppToolOptions): { readonly extension: Extension } {
  const tool = defineTool({
    name: APP_TOOL_NAME,
    // The durable commit is keyed by the tool task id, so a recovered execution either finds its
    // message already committed or commits it once; it never delivers the same file twice.
    replay: "safe",
    // The host re-authorizes every call against its own thread state; Code Mode adds no grant.
    callers: ["model", "tools"],
    description:
      "Deliver one existing file from the configured workspace into the app thread this conversation " +
      "belongs to. action=send attaches any regular workspace file (at most " +
      `${APP_LIMITS.uploadBytes / (1024 * 1024)} MiB) to a new assistant message, with an optional caption. ` +
      `action=artifact delivers one .html, .htm or .svg file (at most ${APP_LIMITS.artifactBytes / (1024 * 1024)} MiB) ` +
      "as a sandboxed artifact the app previews in an isolated frame, with an optional title used as the " +
      "message text. The path is resolved inside the configured workspace: absolute paths, `..` " +
      "segments, symlink escapes, directories and special files are refused, and nothing outside the " +
      "workspace can be sent. The file's bytes are copied unchanged; nothing is converted, fetched " +
      "from a URL or read back to you. The thread is fixed by this conversation and cannot be chosen. " +
      "This tool only delivers files; ordinary answers are already delivered automatically.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("send"),
        Type.Literal("artifact"),
      ], { description: "send: attach one workspace file; artifact: deliver one .html/.htm/.svg as a sandboxed artifact." }),
      path: Type.String({
        description: "Workspace-relative path of an existing regular file, for example reports/summary.pdf.",
      }),
      caption: Type.Optional(Type.String({
        description: `action=send: optional caption, at most ${APP_ACTION_LIMITS.captionChars} characters.`,
      })),
      title: Type.Optional(Type.String({
        description: `action=artifact: optional title, at most ${APP_ACTION_LIMITS.titleChars} characters.`,
      })),
    }),
    outputLimits: { maxBytes: 16 * 1024, maxLines: 200, retain: "head" },
    async execute(args, api, context) {
      const sessionKey = options.sessionKeyFor(api.conversationId);
      if (sessionKey === undefined) {
        return errorResult("App file delivery is not available in this conversation.");
      }
      const host = options.registry.current();
      if (host === undefined) {
        return errorResult("The app channel is not running, so no file can be delivered.");
      }
      if (context.abortSignal?.aborted) throw new Error("Operation aborted");

      const action = args.action;
      if (action !== "send" && action !== "artifact") {
        return errorResult("action must be send or artifact.");
      }
      const path = args.path;
      if (!validOutboundFilePath(path, APP_ACTION_LIMITS.filePathChars)) {
        return errorResult("path must be a workspace-relative path inside the configured workspace, " +
          "for example reports/summary.html; absolute paths, `..` segments, empty segments and " +
          "Windows separators are refused.");
      }
      if (action === "artifact" && typeof args.title === "string" &&
          (args.title.length > APP_ACTION_LIMITS.titleChars || /[\u0000-\u001f\u007f]/.test(args.title))) {
        return errorResult(`A title is limited to ${APP_ACTION_LIMITS.titleChars} printable characters.`);
      }
      if (action === "send" && typeof args.caption === "string" && args.caption.length > APP_ACTION_LIMITS.captionChars) {
        return errorResult(`A caption is limited to ${APP_ACTION_LIMITS.captionChars} characters.`);
      }
      const caption = action === "send" && typeof args.caption === "string" && args.caption.trim() !== ""
        ? args.caption
        : undefined;
      const title = action === "artifact" && typeof args.title === "string" && args.title.trim() !== ""
        ? args.title
        : undefined;
      // Durable task ids identify executions; a retried call id keeps the same message identity.
      const actionId = `tool:${api.taskId}`;
      if (actionId.length > APP_ACTION_LIMITS.callIdChars) {
        return errorResult("This app delivery has no usable call identity and was not taken.");
      }
      const request: AppFileRequest = {
        action,
        path,
        ...(caption === undefined ? {} : { caption }),
        ...(title === undefined ? {} : { title }),
      };
      const outcome = await host.act(sessionKey, actionId, request, context);
      return outcome.ok
        ? { output: [{ type: "text" as const, text: outcome.text }], details: { action } }
        : errorResult(outcome.text);
    },
  });
  return { extension: defineExtension({ name: "nanobot-app-tool", tools: [tool] }) };
}
