/**
 * App channel files: uploaded originals, their durable upload records, the attachment context the
 * model turn sees, and the lookup behind `GET /v1/files/<id>`.
 *
 * The wire contract is normative in `pwa/protocol/v2.md` (*Files*). Uploads are device-private and
 * pending until an admitted `send` references them; only then may any paired device download them.
 * Records live in one conversation document next to the channel state, so an upload is durable
 * before its id is answered and an admitted reference is durable before the turn is acked.
 *
 * Storage is the shared channel-neutral media store (`src/media/attachments.ts`): originals are kept
 * byte-for-byte under `<workspace>/<media.directory>/app`, the bytes are never sniffed, and the
 * announced type only selects a bounded metadata label and a known locator suffix. Nothing here
 * grants tool authority; the stored files are ordinary workspace files like Telegram's.
 */
import { randomBytes } from "node:crypto";
import { copyJson } from "@earendil-works/chord";
import type { Context, Draft } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Conversation, Tx } from "@earendil-works/pi-durable";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  attachmentContextText,
  createMediaStore,
  MediaRejected,
  sanitizeOriginalName,
  type AttachmentSpeech,
  type MediaAttachmentView,
  type MediaKind,
  type MediaStore,
} from "../media/attachments.js";
import {
  createTranscriber,
  TRANSCRIPTION_FAILURE_TEXT,
  type Transcriber,
  type TranscriberOptions,
} from "../media/transcription.js";
import { APP_LIMITS, type AppUploadRecord } from "./app-protocol.js";
// The listener owns the transport bounds and the host contract they hand over; this module
// implements that contract for the app adapter.
import { AppUploadTooLarge, type AppUploadOutcome } from "./app-listener.js";
import type { AttachmentInfo } from "./generated/protocol-v2.js";

/** Gateway-only bounds the app never sees; the wire bounds come from the generated protocol. */
export const APP_FILE_LIMITS = {
  /** An upload no admitted message references is discarded after this long. */
  uploadTtlMs: 24 * 60 * 60_000,
  /** Unreferenced uploads one device may hold at once; further uploads answer `rate_limited`. */
  pendingPerDevice: 200,
  /** Upload records retained (referenced records stay downloadable); beyond this, `rate_limited`. */
  maxRecords: 4_000,
  /** `LIMITS.uploadsPerMinute` is enforced over this rolling window, per device. */
  rateWindowMs: 60_000,
  /** Announced MIME is untrusted metadata; keep it bounded and printable. */
  maxTypeChars: 120,
  /** Recognized speech is untrusted user content; the transcript is cut at this many characters. */
  maxTranscriptChars: 8_000,
  /** The adapter scan runs often, so discard work is throttled here. */
  pruneIntervalMs: 60_000,
  /** Code-owned child directory, so app originals never share names with another channel's. */
  childDirectory: "app",
} as const;

/** The announced type served when the client sends none or an unusable one. */
export const APP_DEFAULT_TYPE = "application/octet-stream";

/** The persisted upload registry; it carries no authority on its own. */
export type AppFilesChannelState = { uploads: AppUploadRecord[] };

export const AppFilesState = defineDoc<AppFilesChannelState>({
  kind: "nanobot.app-files",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
  initial: () => ({ uploads: [] }),
});

/** The operator's attachment opt-in, mirroring the other channels' `media` block. */
export type AppMediaOptions = {
  readonly workspace: string;
  /** Workspace-relative directory; default `media`. */
  readonly directory?: string;
  readonly transcription?: TranscriberOptions;
};

/** One upload body, handed over by the listener with its transport bounds already applied. */
export type AppUploadRequest = {
  readonly deviceId: string;
  readonly name: string;
  readonly mimeType: string | undefined;
  readonly body: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
};

/** One download target: resolved by the store, so no path is ever built from request input. */
export type AppDownloadFile = {
  readonly absolutePath: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly name: string;
  readonly kind: AttachmentInfo["kind"];
};

/** A refused attachment id; the whole admission is abandoned, so nothing is consumed. */
export class AppFileRejected extends Error {
  constructor() {
    super("app attachment reference refused");
    this.name = "AppFileRejected";
  }
}

export type AppFiles = {
  /** `hello.uploads`: the operator configured media storage. */
  readonly available: boolean;
  /** Durably admit one upload before its id is answered. */
  upload(request: AppUploadRequest): Promise<AppUploadOutcome>;
  /**
   * Validate and consume upload ids inside one admission transaction. Throws `AppFileRejected`
   * when any id is unknown, foreign, expired or already used, so the caller admits nothing.
   */
  claim(
    tx: Tx,
    claim: { readonly deviceId: string; readonly ids: readonly string[]; readonly atMs: number; readonly messageId: string },
  ): Promise<AppUploadRecord[]>;
  /** The bounded wire shape an admitted message echoes. */
  infos(records: readonly AppUploadRecord[]): AttachmentInfo[];
  /** The turn's content, like Telegram's: text, bounded metadata, native image content. */
  prepare(
    records: readonly AppUploadRecord[] | undefined,
    text: string,
    signal?: AbortSignal,
  ): Promise<string | (TextContent | ImageContent)[]>;
  /** The file one durable message references, or `undefined` when it is not downloadable. */
  download(id: string): Promise<AppDownloadFile | undefined>;
  /** Drop unreferenced uploads past their TTL: the record here, then the file. */
  prune(atMs: number): Promise<void>;
};

const STORE_KINDS: Readonly<Record<AttachmentInfo["kind"], MediaKind>> = Object.freeze({
  image: "photo",
  audio: "audio",
  file: "document",
});

/** A bounded, printable announced type; anything else is served as a generic binary. */
export function announcedMimeType(value: unknown): string {
  if (typeof value !== "string") return APP_DEFAULT_TYPE;
  const base = value.split(";", 1)[0]!.trim().toLowerCase();
  if (base === "" || base.length > APP_FILE_LIMITS.maxTypeChars) return APP_DEFAULT_TYPE;
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(base) ? base : APP_DEFAULT_TYPE;
}

/** The attachment kind is decided by the announced type only; the bytes are never sniffed. */
function kindOfType(type: string): AttachmentInfo["kind"] {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

/** `f_` plus 22 base64url characters, matching `LIMITS.uploadIdPattern`. */
function newUploadId(): string {
  return `f_${randomBytes(16).toString("base64url")}`;
}

export function createAppFiles(options: {
  readonly media?: AppMediaOptions;
  /** The app state conversation that owns the upload records. */
  readonly conversation: Conversation;
  readonly context: Context;
  readonly now: () => number;
}): AppFiles {
  const { conversation, context, now } = options;
  const media = options.media;
  const store: MediaStore | undefined = media === undefined
    ? undefined
    : createMediaStore({
      workspace: media.workspace,
      ...(media.directory === undefined ? {} : { directory: media.directory }),
      childDirectory: APP_FILE_LIMITS.childDirectory,
      maxFileBytes: APP_LIMITS.uploadBytes,
    });
  const transcriber: Transcriber | undefined = media === undefined
    ? undefined
    : createTranscriber({ ...(media.transcription ?? {}) });
  /** Rolling upload timestamps per device; in memory, so a restart clears the window. */
  const windows = new Map<string, number[]>();
  let lastPrunedAtMs = Number.NEGATIVE_INFINITY;

  const read = async (): Promise<AppFilesChannelState> => conversation.commit(
    async (tx) => copyJson(await tx.doc(AppFilesState, conversation.id)) as unknown as AppFilesChannelState,
    context,
  );

  const rateLimited = (deviceId: string, atMs: number): boolean => {
    const recent = (windows.get(deviceId) ?? []).filter((stamp) => atMs - stamp < APP_FILE_LIMITS.rateWindowMs);
    if (recent.length >= APP_LIMITS.uploadsPerMinute) {
      windows.set(deviceId, recent);
      return true;
    }
    recent.push(atMs);
    windows.set(deviceId, recent);
    return false;
  };

  /**
   * Drop unreferenced uploads past their TTL: the record commits first, then the file. A failed
   * pass deletes nothing (the records survived it) and is simply retried by the next scan.
   */
  const prune = async (atMs: number): Promise<void> => {
    if (store === undefined || atMs - lastPrunedAtMs < APP_FILE_LIMITS.pruneIntervalMs) return;
    lastPrunedAtMs = atMs;
    const expired: AppUploadRecord[] = [];
    try {
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(AppFilesState, conversation.id);
        const keep: Draft<AppUploadRecord>[] = [];
        for (const record of doc.uploads) {
          // A referenced upload stays downloadable for as long as its message exists.
          if (record.referencedAtMs === undefined && atMs - record.createdAtMs >= APP_FILE_LIMITS.uploadTtlMs) {
            expired.push({ ...record });
          } else keep.push(record);
        }
        if (expired.length > 0) doc.uploads = keep;
      }, context);
    } catch {
      lastPrunedAtMs = Number.NEGATIVE_INFINITY;
      return;
    }
    for (const record of expired) await store.remove(record.path).catch(() => undefined);
  };

  const transcribe = async (record: AppUploadRecord, signal?: AbortSignal): Promise<AttachmentSpeech> => {
    if (transcriber === undefined || !transcriber.enabled) return { disabled: true };
    const absolute = await store!.absolute(record.path);
    const outcome = await transcriber.transcribe(absolute, {
      ...(signal === undefined ? {} : { signal }),
    });
    if (outcome.ok) return { transcript: outcome.text.slice(0, APP_FILE_LIMITS.maxTranscriptChars) };
    if (outcome.reason === "cancelled") throw signal?.reason ?? new Error("App transcription cancelled");
    return { failure: TRANSCRIPTION_FAILURE_TEXT[outcome.reason] };
  };

  return {
    available: store !== undefined,

    async upload(request: AppUploadRequest): Promise<AppUploadOutcome> {
      if (store === undefined) return { status: "unsupported" };
      const atMs = now();
      // Bound the name before the window: a request refused for its metadata does no work and
      // must not spend the uploader's quota.
      const name = sanitizeOriginalName(request.name);
      if (name === undefined) return { status: "bad-request" };
      if (rateLimited(request.deviceId, atMs)) return { status: "rate-limited" };
      // Expired records must not hold the record cap against a fresh upload.
      await prune(atMs);
      const type = announcedMimeType(request.mimeType);
      const kind = kindOfType(type);
      const id = newUploadId();
      let stored;
      try {
        stored = await store.save({
          kind: STORE_KINDS[kind],
          identity: `app:upload:${id}`,
          mimeType: type,
          originalName: name,
          body: request.body,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error) {
        if (error instanceof AppUploadTooLarge || request.signal?.aborted === true) throw error;
        if (error instanceof MediaRejected) {
          // A permanent refusal of these bytes; retrying them cannot succeed.
          return { status: error.reason === "too-large" ? "too-large" : "bad-request" };
        }
        return { status: "internal" };
      }
      const record: AppUploadRecord = {
        id, deviceId: request.deviceId, name, type, size: stored.bytes, kind, path: stored.relativePath, createdAtMs: atMs,
      };
      let admitted = false;
      try {
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(AppFilesState, conversation.id);
          const pending = doc.uploads.filter((entry) =>
            entry.deviceId === request.deviceId && entry.referencedAtMs === undefined).length;
          if (doc.uploads.length >= APP_FILE_LIMITS.maxRecords || pending >= APP_FILE_LIMITS.pendingPerDevice) return;
          doc.uploads.push(record);
          admitted = true;
        }, context);
      } catch (error) {
        await store.remove(record.path).catch(() => undefined);
        throw error;
      }
      if (!admitted) {
        // The store succeeded but the durable record could not be admitted: keep no orphan file.
        await store.remove(record.path).catch(() => undefined);
        return { status: "rate-limited" };
      }
      return { status: "created", id };
    },

    async claim(tx, claim): Promise<AppUploadRecord[]> {
      if (store === undefined) throw new AppFileRejected();
      if (claim.ids.length > APP_LIMITS.maxAttachments) throw new AppFileRejected();
      const seen = new Set<string>();
      for (const id of claim.ids) {
        // Each id is used at most once, so a repeated id in one send is a reuse.
        if (!APP_LIMITS.uploadIdPattern.test(id) || seen.has(id)) throw new AppFileRejected();
        seen.add(id);
      }
      const doc = await tx.doc(AppFilesState, conversation.id);
      const chosen: AppUploadRecord[] = [];
      for (const id of claim.ids) {
        const record = doc.uploads.find((entry) => entry.id === id);
        if (record === undefined || record.deviceId !== claim.deviceId || record.referencedAtMs !== undefined ||
            claim.atMs - record.createdAtMs >= APP_FILE_LIMITS.uploadTtlMs) {
          throw new AppFileRejected();
        }
        chosen.push({ ...record, referencedAtMs: claim.atMs, messageId: claim.messageId });
      }
      // Marked only after every id validated: a refused send consumes nothing.
      for (const record of chosen) {
        const index = doc.uploads.findIndex((entry) => entry.id === record.id);
        doc.uploads[index] = record;
      }
      return chosen;
    },

    infos(records: readonly AppUploadRecord[]): AttachmentInfo[] {
      return records.map((record) => ({
        id: record.id, name: record.name, type: record.type, size: record.size, kind: record.kind,
      }));
    },

    async prepare(records, text, signal) {
      if (store === undefined || records === undefined || records.length === 0) return text;
      const images: ImageContent[] = [];
      const blocks: string[] = [];
      for (const record of records) {
        const storeKind = STORE_KINDS[record.kind];
        let view: MediaAttachmentView = {
          kind: storeKind,
          mimeType: record.type,
          originalName: record.name,
          status: "failed",
          note: "the stored file is missing",
        };
        const found = await store.existing(record.path).catch(() => undefined);
        if (found !== undefined) {
          view = {
            kind: storeKind,
            mimeType: record.type,
            originalName: record.name,
            status: "stored",
            relativePath: record.path,
            bytes: found.bytes,
          };
          if (record.kind === "image") {
            // Read the bytes before the block claims image content is attached.
            try {
              const bytes = await store.read(record.path);
              images.push({ type: "image", data: bytes.toString("base64"), mimeType: record.type });
            } catch {
              view = { ...view, status: "failed", note: "the stored image could not be read" };
            }
          }
        }
        const speech = view.status === "stored" && record.kind === "audio"
          ? await transcribe(record, signal)
          : {};
        blocks.push(attachmentContextText("App", view, speech));
      }
      const joined = [text, ...blocks].filter((part) => part.trim() !== "").join("\n\n");
      if (images.length === 0) return joined;
      const content: (TextContent | ImageContent)[] = [];
      if (joined !== "") content.push({ type: "text", text: joined });
      content.push(...images);
      return content;
    },

    async download(id: string): Promise<AppDownloadFile | undefined> {
      if (store === undefined || !APP_LIMITS.uploadIdPattern.test(id)) return undefined;
      const state = await read();
      const record = state.uploads.find((entry) => entry.id === id);
      // Pending (unreferenced) uploads are private to their device and never downloadable.
      if (record === undefined || record.referencedAtMs === undefined) return undefined;
      const stored = await store.existing(record.path).catch(() => undefined);
      if (stored === undefined) return undefined;
      return {
        absolutePath: stored.absolutePath,
        bytes: stored.bytes,
        mimeType: record.type,
        name: record.name,
        kind: record.kind,
      };
    },

    prune,
  };
}
