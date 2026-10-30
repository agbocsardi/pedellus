import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink, link } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Shared, channel-neutral attachment storage under the configured workspace.
 *
 * Originals are kept byte-for-byte; nothing here reads a document's contents. A
 * caller without an attachment store (attachment-disabled channel) never reaches
 * this module, so its behavior is unchanged.
 */

export const MEDIA_LIMITS = {
  /** One stored original; Telegram's ordinary Bot API `getFile` ceiling. */
  maxFileBytes: 20 * 1024 * 1024,
  /** Concurrent stores/transcriptions across all chats; polling never waits on these. */
  maxConcurrentWork: 2,
  /** Untrusted original filename kept as bounded metadata only. */
  maxOriginalNameChars: 120,
} as const;

export type MediaKind = "photo" | "audio" | "document";

export type MediaRejectionReason =
  | "too-large"
  | "unsafe-path"
  | "unsafe-directory"
  | "empty"
  | "unavailable";

/**
 * A permanent refusal: retrying the same bytes or path cannot succeed. Transport
 * failures and aborts are ordinary errors and stay on the caller's retry path.
 */
export class MediaRejected extends Error {
  readonly reason: MediaRejectionReason;

  constructor(reason: MediaRejectionReason) {
    super(`media rejected: ${reason}`);
    this.name = "MediaRejected";
    this.reason = reason;
  }
}

export interface MediaStoreOptions {
  /** Absolute configured workspace root; the media directory must stay inside it. */
  readonly workspace: string;
  /** Workspace-relative directory for originals; default `media`. */
  readonly directory?: string;
  readonly maxFileBytes?: number;
}

export interface SaveMediaRequest {
  readonly kind: MediaKind;
  readonly identity: string;
  readonly mimeType?: string;
  readonly originalName?: string;
  /** Announced size, checked before any byte is written. */
  readonly declaredBytes?: number;
  readonly body: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface StoredMedia {
  readonly kind: MediaKind;
  readonly identity: string;
  /** Workspace-relative locator with `/` separators, safe to show to the model. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
  readonly mimeType?: string;
  readonly originalName?: string;
}

export interface MediaStore {
  /** Workspace-relative directory (posix separators). */
  readonly directory: string;
  readonly maxFileBytes: number;
  /** Deterministic locator for one identity; no download needed to compute it. */
  locator(identity: string, kind: MediaKind, mimeType?: string): string;
  /** Atomic, deduplicating store of one original file. */
  save(request: SaveMediaRequest): Promise<StoredMedia>;
  /** Read a stored original without following symlinks or escaping the media root. */
  read(relativePath: string): Promise<Buffer>;
  /** Absolute path for a locator produced by this store, under the canonical workspace root. */
  absolute(relativePath: string): Promise<string>;
  /** Resolve a stored original that already exists and is a regular file. */
  existing(relativePath: string): Promise<StoredMedia | undefined>;
}

/** Validate and normalize a workspace-relative media directory (default `media`). */
export function validateMediaDirectory(value: unknown): string {
  if (value === undefined) return "media";
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("media.directory must be a non-empty workspace-relative path");
  }
  const directory = value.trim();
  if (isAbsolute(directory) || directory.includes("\\") || /[\u0000-\u001f\u007f]/.test(directory)) {
    throw new Error("media.directory must be a workspace-relative path using / separators");
  }
  const segments = directory.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("media.directory must not contain empty, . or .. segments");
  }
  if (directory.length > 128) throw new Error("media.directory is too long");
  return segments.join("/");
}

/** Bounded printable metadata; never used to build a filesystem path. */
export function sanitizeOriginalName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/]/g, "_").trim();
  if (cleaned === "") return undefined;
  return cleaned.slice(0, MEDIA_LIMITS.maxOriginalNameChars);
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
});

const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "audio/ogg": ".oga",
  "audio/opus": ".opus",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
});

const DOCUMENT_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/octet-stream": ".bin",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
});

function normalizedMime(mimeType: string | undefined): string | undefined {
  if (mimeType === undefined) return undefined;
  const base = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return base === "" ? undefined : base;
}

function extensionFor(kind: MediaKind, mimeType: string | undefined): string {
  const mime = normalizedMime(mimeType);
  if (kind === "photo") return (mime === undefined ? undefined : IMAGE_EXTENSIONS[mime]) ?? ".jpg";
  if (kind === "audio") return (mime === undefined ? undefined : AUDIO_EXTENSIONS[mime]) ?? ".oga";
  return (mime === undefined ? undefined : DOCUMENT_EXTENSIONS[mime]) ?? ".bin";
}

function identityHash(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/**
 * Create and verify every level of the workspace-relative media directory. The
 * canonical workspace root is already resolved (an operator alias is allowed),
 * but no component below it may be a symlink, so the media subtree cannot escape
 * the workspace.
 */
async function ensureMediaRoot(
  canonicalWorkspaceRoot: string,
  segments: readonly string[],
): Promise<void> {
  let current = canonicalWorkspaceRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MediaRejected("unsafe-directory");
  }
}

export function createMediaStore(options: MediaStoreOptions): MediaStore {
  const directory = validateMediaDirectory(options.directory);
  const configuredWorkspaceRoot = resolve(options.workspace);
  const segments = directory.split("/");
  const maxFileBytes = options.maxFileBytes ?? MEDIA_LIMITS.maxFileBytes;

  /**
   * The configured workspace root may itself be an operator symlink: the shipped
   * CLI forwards `config.workspace` unchanged, and the gateway accepts a
   * canonicalized operator root. Resolve it once and operate only on the
   * canonical path, so a later repoint of the alias cannot redirect media writes.
   * Every descendant is still checked individually.
   */
  let canonicalWorkspaceRoot: Promise<string> | undefined;
  const workspaceRoot = (): Promise<string> => {
    canonicalWorkspaceRoot ??= (async () => {
      try {
        return await realpath(configuredWorkspaceRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(configuredWorkspaceRoot, { recursive: true, mode: 0o700 });
        return await realpath(configuredWorkspaceRoot);
      }
    })();
    return canonicalWorkspaceRoot;
  };
  const mediaRoot = async (): Promise<string> => resolve(await workspaceRoot(), ...segments);

  const absolute = async (relativePath: string): Promise<string> => {
    const root = await mediaRoot();
    const target = resolve(await workspaceRoot(), ...relativePath.split("/"));
    if (!insideRoot(root, target)) throw new MediaRejected("unsafe-path");
    return target;
  };

  const locator = (identity: string, kind: MediaKind, mimeType?: string): string => {
    return `${directory}/${kind}-${identityHash(identity)}${extensionFor(kind, mimeType)}`;
  };

  const inspect = async (relativePath: string): Promise<StoredMedia | undefined> => {
    const target = await absolute(relativePath);
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    // A symlink or a multiply-linked file is never accepted as our stored original.
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new MediaRejected("unsafe-path");
    }
    if (stat.size > maxFileBytes) throw new MediaRejected("too-large");
    return {
      kind: kindOfLocator(relativePath),
      identity: "",
      relativePath,
      absolutePath: target,
      bytes: stat.size,
    };
  };

  /**
   * A concurrent store of the same identity briefly leaves its complete temporary
   * hard link in place, so a multiply-linked read is retried before it is refused.
   * The retry is bounded and only applies to that transient window; a real
   * symlink or hardlink is still refused.
   */
  const existing = async (relativePath: string): Promise<StoredMedia | undefined> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await inspect(relativePath);
      } catch (error) {
        if (!(error instanceof MediaRejected) || error.reason !== "unsafe-path" || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
  };

  return {
    directory,
    maxFileBytes,
    locator,
    absolute,
    existing,

    async save(request: SaveMediaRequest): Promise<StoredMedia> {
      const { signal } = request;
      if (signal?.aborted) throw signal.reason;
      if (request.declaredBytes !== undefined && request.declaredBytes > maxFileBytes) {
        throw new MediaRejected("too-large");
      }
      const relativePath = locator(request.identity, request.kind, request.mimeType);
      const target = await absolute(relativePath);
      const mimeType = request.mimeType === undefined ? undefined : normalizedMime(request.mimeType);
      const metadata = {
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(request.originalName === undefined ? {} : { originalName: request.originalName }),
        kind: request.kind,
        identity: request.identity,
      };
      await ensureMediaRoot(await workspaceRoot(), segments);

      const already = await existing(relativePath);
      if (already !== undefined) {
        // The identity is content-stable and publication is atomic, so a complete
        // existing file is this attachment; a retry or reopen never re-downloads it.
        return { ...already, ...metadata };
      }

      const temporary = join(await mediaRoot(), `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
      const handle = await open(temporary, "wx", 0o600);
      let bytes = 0;
      try {
        for await (const chunk of request.body) {
          if (signal?.aborted) throw signal.reason;
          if (!(chunk instanceof Uint8Array)) throw new Error("media body yielded a non-byte chunk");
          bytes += chunk.byteLength;
          if (bytes > maxFileBytes) throw new MediaRejected("too-large");
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
            offset += bytesWritten;
          }
        }
        if (bytes === 0) throw new MediaRejected("empty");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      try {
        await handle.close();
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }

      try {
        // `link` never overwrites: a concurrent store of the same identity wins and
        // this complete temporary copy is discarded instead of replacing it.
        await link(temporary, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
        let winner: StoredMedia | undefined;
        try {
          winner = await existing(relativePath);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
        if (winner === undefined) throw new MediaRejected("unsafe-path");
        return { ...winner, ...metadata };
      }
      await unlink(temporary).catch(() => undefined);
      return { ...metadata, relativePath, absolutePath: target, bytes };
    },

    async read(relativePath: string): Promise<Buffer> {
      const stored = await existing(relativePath);
      if (stored === undefined) throw new Error("stored media file is missing");
      return readFile(stored.absolutePath);
    },
  };
}

/** Recover the media kind from this store's own locator shape. */
function kindOfLocator(relativePath: string): MediaKind {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  if (name.startsWith("photo-")) return "photo";
  if (name.startsWith("audio-")) return "audio";
  return "document";
}
