/**
 * The live host of the model-callable `app` tool (`send`/`artifact`): deliver one workspace file
 * into the app thread the agent is answering.
 *
 * Every call re-derives the thread from the host-owned session key, rechecks that the thread is
 * open, reads one bounded workspace file through the shared outbound resolver and commits the
 * referenced file record with its assistant message in one state commit. A call whose referenced
 * record already exists is answered from that record without touching the file. Nothing the model
 * supplied decides the thread, the device or the storage path.
 */
import {
  OutboundFileRejected,
  outboundRejectionText,
  readOutboundFile,
  validOutboundFilePath,
  type OutboundRejection,
} from "../media/outbound.js";
import type { AppCore } from "./app.js";
import { appendMessage, hasEventId } from "./app.js";
import { AppFileRejected, APP_DEFAULT_TYPE, type AppFiles } from "./app-files.js";
import { APP_LIMITS, APP_STATIC_TYPES } from "./app-protocol.js";
import { openThread } from "./app-threads.js";
import { APP_ACTION_LIMITS, type AppActionHost } from "./app-tool.js";

/** The saved extensions an agent artifact may have, and the exact stored type each is served with. */
const ARTIFACT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
});
const ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(ARTIFACT_TYPES));
const ARTIFACT_REFUSAL = "an artifact must be a .html, .htm or .svg file";

/** One stored type for an agent `send`: the known extension's base type, otherwise generic bytes. */
function sentFileType(extension: string): string {
  const known = extension === "" ? undefined : APP_STATIC_TYPES[`.${extension}`];
  return known?.split(";", 1)[0] ?? APP_DEFAULT_TYPE;
}

/** Fixed pre-send refusal text; never includes a host path, byte count or raw error. */
function refusal(action: "send" | "artifact", reason: OutboundRejection, maxBytes: number): string {
  if (reason === "unsupported-format") {
    return action === "artifact" ? ARTIFACT_REFUSAL : "the file cannot be delivered";
  }
  return outboundRejectionText(reason, { maxBytes });
}

/** The model-facing receipt for one delivered agent file; bounded, workspace-relative, no bytes. */
function receipt(action: "send" | "artifact", path: string, size: number): string {
  return action === "artifact"
    ? `Delivered the workspace file ${path} as a sandboxed artifact (${size} bytes).`
    : `Delivered the workspace file ${path} as one attachment (${size} bytes).`;
}

export function createAppActionHost(options: {
  readonly core: AppCore;
  readonly files: AppFiles;
  /** The configured media workspace; absent means no file storage, so every call is refused. */
  readonly workspace: string | undefined;
  /** The open-or-archived thread one host-owned session key maps to, or `undefined`. */
  threadForSession(sessionKey: string): string | undefined;
}): AppActionHost {
  const { core, files } = options;
  return {
    async act(sessionKey, callId, request, ctx) {
      if (core.stopped() || ctx.abortSignal?.aborted) {
        return { ok: false, text: "The app channel is stopping, so no file was delivered." };
      }
      const thread = options.threadForSession(sessionKey);
      if (thread === undefined) {
        return { ok: false, text: "This conversation is not an app chat thread, so no file was delivered." };
      }
      if (!openThread(core.state(), thread)) {
        return { ok: false, text: "This app thread is archived, so no file was delivered." };
      }
      const workspace = options.workspace;
      if (workspace === undefined || !files.available) {
        return { ok: false, text: "App file storage is not configured, so no file could be delivered." };
      }
      // Defence in depth: the model schema already restricts these, so a decline here means the
      // caller bypassed the declared surface.
      if (request.action !== "send" && request.action !== "artifact") {
        return { ok: false, text: "Unknown app file action; nothing was delivered." };
      }
      const action = request.action;
      const maxBytes = action === "artifact" ? APP_LIMITS.artifactBytes : APP_LIMITS.uploadBytes;
      if (!validOutboundFilePath(request.path, APP_ACTION_LIMITS.filePathChars)) {
        return { ok: false, text: `The file was not delivered: ${refusal(action, "unsafe-path", maxBytes)}.` };
      }
      if (request.caption !== undefined && request.caption.length > APP_ACTION_LIMITS.captionChars) {
        return { ok: false, text: "The file was not delivered: the caption is too long." };
      }
      if (request.title !== undefined && request.title.length > APP_ACTION_LIMITS.titleChars) {
        return { ok: false, text: "The file was not delivered: the title is too long." };
      }
      // One identity per tool execution: a recovered run adopts its own copy instead of storing a
      // second one, and the message id below makes the durable effect idempotent.
      const messageId = `agent:${callId}`;
      // A finished execution of this same tool task already committed its message and referenced
      // record. That record is the anchor (referenced records are never pruned, unlike the trimmed
      // event log), so report the receipt again without reading the workspace or storing anything:
      // a file that was deleted or changed since then cannot turn a delivered file into a failure
      // or an orphan copy.
      const committed = await files.agentCommit(messageId);
      if (committed !== undefined) return { ok: true, text: receipt(action, request.path, committed.size) };
      let file;
      try {
        file = await readOutboundFile({
          workspace,
          path: request.path,
          maxBytes,
          ...(action === "artifact" ? { allowedExtensions: ARTIFACT_EXTENSIONS } : {}),
        });
      } catch (error) {
        const reason = error instanceof OutboundFileRejected ? error.reason : "unreadable";
        return { ok: false, text: `The file was not delivered: ${refusal(action, reason, maxBytes)}.` };
      }
      const artifactType = ARTIFACT_TYPES[file.extension];
      if (action === "artifact" && artifactType === undefined) {
        return { ok: false, text: `The file was not delivered: ${ARTIFACT_REFUSAL}.` };
      }
      const stored = await files.storeAgent({
        identity: `app:agent:${callId}`,
        messageId,
        name: file.filename,
        type: action === "artifact" ? artifactType! : sentFileType(file.extension),
        kind: action === "artifact" ? "artifact" : "file",
        bytes: file.bytes,
        maxBytes,
      });
      if (stored.status !== "stored") {
        const text = stored.status === "unavailable"
          ? "App file storage is not configured, so no file could be delivered."
          : stored.status === "too-large"
            ? `The file was not delivered: it is larger than ${maxBytes / (1024 * 1024)} MiB.`
            : stored.status === "empty"
              ? "The file was not delivered: the file is empty."
              : "The file was not delivered: it could not be stored.";
        return { ok: false, text };
      }
      let appended = false;
      try {
        await core.mutateState(async (doc, tx) => {
          // A recovered execution finds its own message: it appends nothing and stores nothing new.
          if (hasEventId(doc, messageId)) return;
          appendMessage(doc, {
            event: "message",
            thread,
            id: messageId,
            role: "assistant",
            text: action === "artifact" ? (request.title ?? "") : (request.caption ?? ""),
            at: new Date(core.now()).toISOString(),
            attachments: [{ ...stored.file.info }],
          });
          await files.admitAgent(tx, stored.file);
          appended = true;
        }, ctx);
      } catch (error) {
        await stored.file.discard();
        if (error instanceof AppFileRejected) {
          return { ok: false, text: "App file storage is full, so no file was delivered." };
        }
        return { ok: false, text: "The file could not be attached, so no message was delivered." };
      }
      if (!appended) {
        // The in-commit check (the authority) found the message already present, so no record of
        // this execution was admitted; drop a copy only this execution stored.
        await stored.file.discard();
      } else {
        core.publish();
        core.notifyPush(thread);
      }
      return { ok: true, text: receipt(action, request.path, stored.file.record.size) };
    },
  };
}
