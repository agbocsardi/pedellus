/**
 * Bounded read of one existing workspace file for an outbound Telegram upload.
 *
 * The model names a workspace-relative path; the live adapter resolves it under the configured
 * workspace and pins the bytes before the external call through the channel-neutral reader in
 * `src/media/outbound.ts` (see there for the confinement limits: accidental-damage protection, not
 * hostile-tenant isolation). This module only adds Telegram's per-kind extension rule and method
 * names. Telegram remains the only format validator; the extension check refuses a guaranteed
 * rejection before anything leaves the host. There is no remote-URL fetch, Telegram file-id reuse,
 * extraction, transcoding or upload-backend registry.
 */

import {
  OUTBOUND_FILE_LIMITS,
  OutboundFileRejected,
  outboundRejectionText as sharedRejectionText,
  readOutboundFile,
  type OutboundFile,
  type OutboundRejection,
} from "../media/outbound.js";
import type { TelegramFileKind } from "./telegram-interactions.js";

export const TELEGRAM_OUTBOUND_LIMITS = Object.freeze({
  /**
   * One outbound original. Telegram's Bot API accepts larger multipart uploads, but keeping the
   * same 20 MiB ceiling as stored originals bounds host memory, upload time and the blast radius
   * of a model-chosen path.
   */
  maxFileBytes: OUTBOUND_FILE_LIMITS.maxFileBytes,
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
 * Extensions each native kind actually requires, or `undefined` when Telegram accepts any file as
 * a document. No conversion is performed: a mismatched file is refused before upload instead of
 * being silently sent as a different kind.
 */
const KIND_EXTENSIONS: Readonly<Record<TelegramFileKind, ReadonlySet<string> | undefined>> = Object.freeze({
  document: undefined,
  photo: new Set(["jpg", "jpeg", "png", "webp"]),
  audio: new Set(["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav"]),
  video: new Set(["mp4", "m4v", "mov", "webm"]),
  voice: new Set(["ogg", "oga", "opus"]),
});

/** A permanent refusal: retrying the same path cannot succeed. */
export type TelegramOutboundRejection = OutboundRejection;

/** The shared pre-send refusal, under its historical Telegram name. */
export const TelegramOutboundRejected = OutboundFileRejected;
export type TelegramOutboundRejected = OutboundFileRejected;

export type TelegramOutboundFile = OutboundFile;

/**
 * Resolve and read one workspace file for a bounded upload. Every failure is a fixed pre-send
 * refusal that never discloses the original host path.
 */
export async function readTelegramOutboundFile(options: {
  readonly workspace: string;
  readonly path: string;
  readonly kind: TelegramFileKind;
  readonly maxBytes?: number;
}): Promise<TelegramOutboundFile> {
  const allowed = KIND_EXTENSIONS[options.kind];
  return readOutboundFile({
    workspace: options.workspace,
    path: options.path,
    maxBytes: options.maxBytes ?? TELEGRAM_OUTBOUND_LIMITS.maxFileBytes,
    ...(allowed === undefined ? {} : { allowedExtensions: allowed }),
  });
}

/** Fixed model-facing explanation for a refusal; never includes a path or bytes. */
export function outboundRejectionText(kind: TelegramFileKind, reason: TelegramOutboundRejection): string {
  return sharedRejectionText(reason, {
    maxBytes: TELEGRAM_OUTBOUND_LIMITS.maxFileBytes,
    kind,
    fallbackKind: "document",
  });
}
