/**
 * Bounded read of one existing workspace file for an outbound Telegram upload.
 *
 * The model names a workspace-relative path; the live adapter resolves it under
 * the configured workspace and pins the bytes before the external call. A later
 * write, replacement or growth cannot change what Telegram receives or make the
 * outcome ambiguous; a file that shrinks, grows or is replaced while it is read
 * is refused. A symlinked path may not escape the workspace.
 *
 * That confinement is accidental-damage protection for an owner-controlled
 * workspace, not hostile-tenant isolation. The path is canonicalised and the
 * final component is re-opened with `O_NOFOLLOW`, but Node has no `openat`, so a
 * local process that replaces a parent directory between resolution and open is
 * not fully excluded.
 *
 * This module deliberately has no remote-URL fetch, Telegram file-id reuse,
 * extraction, transcoding, FFmpeg dependency or upload-backend registry. Telegram
 * remains the only format validator; the small extension check below only refuses
 * a guaranteed rejection before anything leaves the host.
 */

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { MEDIA_LIMITS, sanitizeOriginalName } from "../media/attachments.js";
import { validTelegramFilePath, type TelegramFileKind } from "./telegram-interactions.js";

export const TELEGRAM_OUTBOUND_LIMITS = Object.freeze({
  /**
   * One outbound original. Telegram's Bot API accepts larger multipart uploads, but
   * keeping the same 20 MiB ceiling as stored originals bounds host memory, upload
   * time and the blast radius of a model-chosen path.
   */
  maxFileBytes: 20 * 1024 * 1024,
});

/** Bot API method for each kind; documents are the only untyped fallback. */
export const TELEGRAM_SEND_METHODS: Readonly<Record<TelegramFileKind, string>> = Object.freeze({
  document: "sendDocument",
  photo: "sendPhoto",
  audio: "sendAudio",
  video: "sendVideo",
  voice: "sendVoice",
});

/**
 * Extensions each native kind actually requires, or `undefined` when Telegram
 * accepts any file as a document. No conversion is performed: a mismatched file is
 * refused before upload instead of being silently sent as a different kind.
 */
const KIND_EXTENSIONS: Readonly<Record<TelegramFileKind, ReadonlySet<string> | undefined>> = Object.freeze({
  document: undefined,
  photo: new Set(["jpg", "jpeg", "png", "webp"]),
  audio: new Set(["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav"]),
  video: new Set(["mp4", "m4v", "mov", "webm"]),
  voice: new Set(["ogg", "oga", "opus"]),
});

/** A permanent refusal: retrying the same path cannot succeed. */
export type TelegramOutboundRejection =
  | "unsafe-path"
  | "not-found"
  | "not-a-file"
  | "too-large"
  | "empty"
  | "unreadable"
  | "unsupported-format";

export class TelegramOutboundRejected extends Error {
  readonly reason: TelegramOutboundRejection;

  constructor(reason: TelegramOutboundRejection) {
    super(`outbound file rejected: ${reason}`);
    this.name = "TelegramOutboundRejected";
    this.reason = reason;
  }
}

export interface TelegramOutboundFile {
  /** Pinned bytes; exactly the file's size at open time, never more. */
  readonly bytes: Buffer;
  /** Bounded display name for Telegram; derived from the resolved file name only. */
  readonly filename: string;
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Bounded upload name for an already-validated file. The kind check uses the
 * extension of the original resolved basename before any sanitize/truncate step,
 * and this helper keeps that suffix inside the 120-character display-name bound
 * whenever it fits, so a long valid name is not refused as a wrong format and
 * the service still sees the same kind hint.
 */
function outboundFilename(originalName: string, extension: string): string {
  const sanitized = sanitizeOriginalName(originalName);
  const suffix = extension === "" ? "" : `.${extension}`;
  if (suffix === "" || suffix.length >= MEDIA_LIMITS.maxOriginalNameChars) {
    return sanitized ?? "file";
  }
  if (sanitized !== undefined && sanitized.toLowerCase().endsWith(suffix)) return sanitized;
  const stemSource = originalName.length > suffix.length
    ? originalName.slice(0, originalName.length - suffix.length)
    : originalName;
  const stem = (sanitizeOriginalName(stemSource) ?? "file").replace(/[. ]+$/, "") || "file";
  const room = MEDIA_LIMITS.maxOriginalNameChars - suffix.length;
  return `${stem.slice(0, room)}${suffix}`;
}

/**
 * Resolve and read one workspace file for a bounded upload. Every failure is a
 * fixed pre-send refusal that never discloses the original host path.
 */
export async function readTelegramOutboundFile(options: {
  readonly workspace: string;
  readonly path: string;
  readonly kind: TelegramFileKind;
  readonly maxBytes?: number;
}): Promise<TelegramOutboundFile> {
  const maxBytes = options.maxBytes ?? TELEGRAM_OUTBOUND_LIMITS.maxFileBytes;
  if (!validTelegramFilePath(options.path)) throw new TelegramOutboundRejected("unsafe-path");

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(options.workspace));
  } catch {
    throw new TelegramOutboundRejected("not-found");
  }
  const target = resolve(canonicalRoot, ...options.path.split("/"));
  if (!insideRoot(canonicalRoot, target)) throw new TelegramOutboundRejected("unsafe-path");

  let resolved: string;
  try {
    // Resolving first makes every intermediate symlink explicit: a path that leaves
    // the workspace is refused, never followed.
    resolved = await realpath(target);
  } catch {
    throw new TelegramOutboundRejected("not-found");
  }
  if (!insideRoot(canonicalRoot, resolved)) throw new TelegramOutboundRejected("unsafe-path");

  // The kind hint is derived from the resolved file name before the display name is
  // bounded: truncating first could drop a valid `.png` suffix and falsely refuse it.
  const originalName = basename(resolved);
  const extension = extensionOf(originalName);
  const allowed = KIND_EXTENSIONS[options.kind];
  if (allowed !== undefined && !allowed.has(extension)) {
    throw new TelegramOutboundRejected("unsupported-format");
  }
  const filename = outboundFilename(originalName, extension);

  let handle;
  try {
    // `O_NONBLOCK` keeps a FIFO or device path from blocking the adapter: it opens
    // immediately and is then refused because it is not a regular file. `O_NOFOLLOW`
    // re-checks the final component, which was canonical above but could be swapped
    // for a symlink before the open.
    handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new TelegramOutboundRejected("unsafe-path");
    throw new TelegramOutboundRejected(code === "EACCES" || code === "EPERM" ? "unreadable" : "not-found");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TelegramOutboundRejected("not-a-file");
    if (stat.size > maxBytes) throw new TelegramOutboundRejected("too-large");
    if (stat.size === 0) throw new TelegramOutboundRejected("empty");
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // A file truncated while it was read is a pre-send refusal, not a partial upload.
    if (offset !== bytes.length) throw new TelegramOutboundRejected("unreadable");
    // A file that grew after the size was taken is refused rather than silently truncated
    // to a prefix: the caller can retry once the file is stable.
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: extra } = await handle.read(trailing, 0, 1, offset);
    if (extra > 0) throw new TelegramOutboundRejected("unreadable");
    return { bytes, filename };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Fixed model-facing explanation for a refusal; never includes a path or bytes. */
export function outboundRejectionText(kind: TelegramFileKind, reason: TelegramOutboundRejection): string {
  switch (reason) {
    case "unsafe-path":
      return "the path must be an existing regular file inside the configured workspace";
    case "not-found":
      return "no such file exists inside the configured workspace";
    case "not-a-file":
      return "the path is not a regular file";
    case "too-large":
      return `the file is larger than ${TELEGRAM_OUTBOUND_LIMITS.maxFileBytes / (1024 * 1024)} MiB`;
    case "empty":
      return "the file is empty";
    case "unreadable":
      return "the file could not be read as one stable snapshot";
    case "unsupported-format":
      return `a ${kind} send needs a supported file extension; no conversion is performed`;
  }
}
