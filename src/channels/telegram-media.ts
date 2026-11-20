import type { Update } from "grammy/types";
import type { AttachmentSpeech, MediaKind } from "../media/attachments.js";
import { attachmentContextText as mediaAttachmentContextText, MediaRejected, sanitizeOriginalName } from "../media/attachments.js";

export type { AttachmentSpeech };

/**
 * Telegram-specific attachment planning and formatting. Downloading and storage
 * stay in the adapter and the shared media store; nothing here talks to the API.
 */

export const TELEGRAM_FILE_ORIGIN = "https://api.telegram.org";

export const TELEGRAM_MEDIA_LIMITS = {
  /** Wall-clock budget for one file download, including the streamed body. */
  downloadTimeoutMs: 60_000,
  /** Telegram's ordinary Bot API `getFile` ceiling. */
  maxFileBytes: 20 * 1024 * 1024,
  /** `file_path` is interpolated into a URL path, so it is validated first. */
  maxFilePathChars: 256,
  /** Announced MIME is untrusted metadata; keep it bounded and printable. */
  maxMimeChars: 120,
} as const;

export type TelegramAttachmentKind = MediaKind;

/**
 * One admitted attachment, durable before any download or model submission.
 * A type alias (not an interface) so Durable's JSON document constraint applies.
 */
export type TelegramPendingAttachment = {
  readonly kind: TelegramAttachmentKind;
  /** Content-stable identity: file-unique id when Telegram provides one, else the update. */
  readonly identity: string;
  readonly fileId: string;
  readonly declaredBytes?: number;
  readonly mimeType?: string;
  readonly originalName?: string;
  status: "pending" | "stored" | "failed";
  relativePath?: string;
  bytes?: number;
  /** Truthful, bounded reason text for a failed storage attempt. */
  note?: string;
};

export type TelegramMediaPlan =
  | { readonly kind: "none" }
  | { readonly kind: "attachment"; readonly attachment: TelegramPendingAttachment }
  | { readonly kind: "unsupported"; readonly label: string };

type TelegramMediaMessage = NonNullable<Update["message"]>;

function safePositive(value: unknown): number | undefined {
  // Keep the announced size even when it is over the limit: the adapter then
  // refuses it before spending a getFile call, instead of downloading to find out.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function mimeMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mime = value.trim().toLowerCase();
  if (mime === "" || mime.length > TELEGRAM_MEDIA_LIMITS.maxMimeChars) return undefined;
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime)) return undefined;
  return mime;
}

function identityFor(kind: TelegramAttachmentKind, uniqueId: string | undefined, botId: string, updateId: number): string {
  if (uniqueId !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(uniqueId)) return `telegram:${kind}:${uniqueId}`;
  return `telegram:${botId}:${updateId}:${kind}`;
}

function attachment(
  kind: TelegramAttachmentKind,
  file: { readonly file_id: string; readonly file_unique_id?: string; readonly file_size?: number },
  identity: string,
  extra: { readonly mimeType?: string | undefined; readonly originalName?: string | undefined } = {},
): TelegramPendingAttachment {
  const mimeType = mimeMetadata(extra.mimeType);
  const originalName = sanitizeOriginalName(extra.originalName);
  const declaredBytes = safePositive(file.file_size);
  return {
    kind,
    identity,
    fileId: file.file_id,
    status: "pending",
    ...(declaredBytes === undefined ? {} : { declaredBytes }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(originalName === undefined ? {} : { originalName }),
  };
}

/**
 * Classify one authenticated private message's media. Photos are submitted as
 * native image content later; voice/audio are transcribed locally after storage;
 * documents are stored as originals with no extraction. Video and similar kinds
 * are explicitly unsupported and never implied to have been read.
 */
export function planTelegramMedia(message: TelegramMediaMessage, botId: string, updateId: number): TelegramMediaPlan {
  // Unsupported kinds are checked first: a Telegram animation carries a
  // backward-compatibility `document` field, and it must never be stored as one.
  if (message.video !== undefined) return { kind: "unsupported", label: "video" };
  if (message.video_note !== undefined) return { kind: "unsupported", label: "video note" };
  if (message.animation !== undefined) return { kind: "unsupported", label: "animation" };
  if (message.sticker !== undefined) return { kind: "unsupported", label: "sticker" };
  if (message.photo !== undefined && message.photo.length > 0) {
    let largest = message.photo[0]!;
    for (const candidate of message.photo) {
      const current = (largest.file_size ?? 0) || largest.width * largest.height;
      const next = (candidate.file_size ?? 0) || candidate.width * candidate.height;
      if (next > current) largest = candidate;
    }
    return {
      kind: "attachment",
      attachment: attachment(
        "photo",
        largest,
        identityFor("photo", largest.file_unique_id, botId, updateId),
        { mimeType: "image/jpeg" },
      ),
    };
  }
  if (message.voice !== undefined) {
    const voice = message.voice;
    return {
      kind: "attachment",
      attachment: attachment("audio", voice, identityFor("audio", voice.file_unique_id, botId, updateId), {
        mimeType: voice.mime_type ?? "audio/ogg",
      }),
    };
  }
  if (message.audio !== undefined) {
    const audio = message.audio;
    return {
      kind: "attachment",
      attachment: attachment("audio", audio, identityFor("audio", audio.file_unique_id, botId, updateId), {
        mimeType: audio.mime_type,
        originalName: audio.file_name,
      }),
    };
  }
  if (message.document !== undefined) {
    const document = message.document;
    return {
      kind: "attachment",
      attachment: attachment("document", document, identityFor("document", document.file_unique_id, botId, updateId), {
        mimeType: document.mime_type,
        originalName: document.file_name,
      }),
    };
  }
  return { kind: "none" };
}

/**
 * Validate the `file_path` Telegram returns before it is interpolated into the
 * fixed file origin's URL path. An absent, absolute, traversal or malformed path
 * is refused; the adapter never builds an arbitrary URL.
 */
export function telegramFilePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > TELEGRAM_MEDIA_LIMITS.maxFilePathChars) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return value;
}

/** The only URL shape this adapter downloads: the fixed HTTPS file origin. */
export function telegramFileUrl(token: string, filePath: string): string {
  const safe = telegramFilePath(filePath);
  if (safe === undefined) throw new MediaRejected("unsafe-path");
  return `${TELEGRAM_FILE_ORIGIN}/file/bot${token}/${safe}`;
}

/** Bound the advertised and actual body size while streaming it to the store. */
export async function* boundedFileBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(advertised) && advertised > maxBytes) throw new MediaRejected("too-large");
  if (response.body === null) throw new Error("Telegram file response has no body");
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) return;
      if (!(value instanceof Uint8Array)) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new MediaRejected("too-large");
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The labeled context block for one Telegram attachment: the shared channel-neutral
 * formatter with this channel's name. A document is never described as read, and a
 * failed transcription never implies understanding.
 */
export function attachmentContextText(
  attachment: TelegramPendingAttachment,
  speech: AttachmentSpeech = {},
): string {
  return mediaAttachmentContextText("Telegram", attachment, speech);
}

/** Fixed notes keep unsupported media explicit without implying extraction. */
export function unsupportedAttachmentText(label: string, caption: string | undefined): string {
  const notice = `[Unsupported Telegram attachment (${label}): it was not downloaded, stored or read.]`;
  return caption === undefined || caption === "" ? notice : `${notice}\nCaption: ${caption}`;
}

/** The pre-media adapter wording, kept for attachment-disabled SDK callers. */
export function disabledAttachmentText(caption: string | undefined): string {
  const notice = "[Unsupported Telegram attachment: this adapter accepts text only.]";
  return caption === undefined || caption === "" ? notice : `${notice} Caption: ${caption}`;
}
