/**
 * Channel-neutral outbound media helpers: a workspace-confined file read for a model-requested
 * upload, a bounded-concurrency gate for media work, a size-capped response stream and the one
 * canonical sanitizer for single-line labels in host-generated notices.
 *
 * Workspace confinement is accidental-damage protection for an owner-controlled workspace, not
 * hostile-tenant isolation. The path is canonicalised and the final component is re-opened with
 * `O_NOFOLLOW`, but Node has no `openat`, so a local process that replaces a parent directory
 * between resolution and open is not fully excluded.
 *
 * There is no remote-URL fetch, extraction, transcoding or upload-backend registry here. The
 * channel's own service stays the format validator; the optional extension check only refuses a
 * guaranteed rejection before anything leaves the host.
 */

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { MEDIA_LIMITS, MediaRejected, sanitizeOriginalName } from "./attachments.js";

export const OUTBOUND_FILE_LIMITS = Object.freeze({
  /** One outbound original: the same ceiling as stored originals, bounding memory and upload time. */
  maxFileBytes: 20 * 1024 * 1024,
  /** A workspace-relative path the model may name. */
  pathChars: 1_024,
});

/** A permanent refusal: retrying the same path cannot succeed. */
export type OutboundRejection =
  | "unsafe-path"
  | "not-found"
  | "not-a-file"
  | "too-large"
  | "empty"
  | "unreadable"
  | "unsupported-format";

export class OutboundFileRejected extends Error {
  readonly reason: OutboundRejection;

  constructor(reason: OutboundRejection) {
    super(`outbound file rejected: ${reason}`);
    this.name = "OutboundFileRejected";
    this.reason = reason;
  }
}

export interface OutboundFile {
  /** Pinned bytes; exactly the file's size at open time, never more. */
  readonly bytes: Buffer;
  /** Bounded, sanitized display name derived from the resolved file name only. */
  readonly filename: string;
  /** Lower-case extension of the resolved name, without the dot; `""` when it has none. */
  readonly extension: string;
}

/**
 * A model-named workspace-relative path: no absolute path, backslash, control character, empty,
 * `.` or `..` segment, and no surrounding whitespace.
 */
export function validOutboundFilePath(
  value: unknown,
  maxChars: number = OUTBOUND_FILE_LIMITS.pathChars,
): value is string {
  if (typeof value !== "string" || value === "" || value.length > maxChars) return false;
  if (value !== value.trim()) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
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
 * Bounded upload name for an already-validated file. The kind check uses the extension of the
 * resolved basename before any sanitize/truncate step, and the suffix is kept inside the display
 * bound whenever it fits, so a long valid name is never refused as a wrong format. The composed
 * name goes through the stored-original sanitizer, so a control character in a suffix shaped by a
 * symlink target cannot reach an API field.
 */
function outboundFilename(originalName: string, extension: string): string {
  const sanitized = sanitizeOriginalName(originalName);
  const suffix = extension === "" ? "" : `.${extension}`;
  if (suffix === "" || suffix.length >= MEDIA_LIMITS.maxOriginalNameChars) return sanitized ?? "file";
  if (sanitized !== undefined && sanitized.toLowerCase().endsWith(suffix)) return sanitized;
  const stemSource = originalName.length > suffix.length
    ? originalName.slice(0, originalName.length - suffix.length)
    : originalName;
  const stem = (sanitizeOriginalName(stemSource) ?? "file").replace(/[. ]+$/u, "") || "file";
  const room = MEDIA_LIMITS.maxOriginalNameChars - suffix.length;
  return sanitizeOriginalName(`${stem.slice(0, room)}${suffix}`) ?? "file";
}

/**
 * Resolve and read one workspace file as a single stable snapshot. Every failure is a fixed
 * pre-send {@link OutboundFileRejected} that never discloses the host path. A file that shrinks or
 * grows while it is read is refused instead of being sent as a prefix.
 */
export async function readOutboundFile(options: {
  readonly workspace: string;
  readonly path: string;
  readonly maxBytes?: number;
  /** Extensions (lower case, no dot) the requested kind needs; absent accepts any file. */
  readonly allowedExtensions?: ReadonlySet<string>;
}): Promise<OutboundFile> {
  const maxBytes = options.maxBytes ?? OUTBOUND_FILE_LIMITS.maxFileBytes;
  if (!validOutboundFilePath(options.path)) throw new OutboundFileRejected("unsafe-path");

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(options.workspace));
  } catch {
    throw new OutboundFileRejected("not-found");
  }
  const target = resolve(canonicalRoot, ...options.path.split("/"));
  if (!insideRoot(canonicalRoot, target)) throw new OutboundFileRejected("unsafe-path");

  let resolved: string;
  try {
    // Resolving first makes every intermediate symlink explicit: a path that leaves the
    // workspace is refused, never followed.
    resolved = await realpath(target);
  } catch {
    throw new OutboundFileRejected("not-found");
  }
  if (!insideRoot(canonicalRoot, resolved)) throw new OutboundFileRejected("unsafe-path");

  const originalName = basename(resolved);
  const extension = extensionOf(originalName);
  if (options.allowedExtensions !== undefined && !options.allowedExtensions.has(extension)) {
    throw new OutboundFileRejected("unsupported-format");
  }
  const filename = outboundFilename(originalName, extension);

  let handle;
  try {
    // `O_NONBLOCK` keeps a FIFO or device from blocking the adapter (it is then refused as not a
    // regular file); `O_NOFOLLOW` re-checks a final component swapped for a symlink after resolution.
    handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new OutboundFileRejected("unsafe-path");
    throw new OutboundFileRejected(code === "EACCES" || code === "EPERM" ? "unreadable" : "not-found");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new OutboundFileRejected("not-a-file");
    if (stat.size > maxBytes) throw new OutboundFileRejected("too-large");
    if (stat.size === 0) throw new OutboundFileRejected("empty");
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length) throw new OutboundFileRejected("unreadable");
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: extra } = await handle.read(trailing, 0, 1, offset);
    if (extra > 0) throw new OutboundFileRejected("unreadable");
    return { bytes, filename, extension };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Fixed model-facing explanation for a refusal; never includes a path or bytes. `kind` names the
 * requested send kind for a format refusal, and `fallbackKind` the untyped kind that would accept
 * the same bytes unchanged.
 */
export function outboundRejectionText(
  reason: OutboundRejection,
  options: { readonly maxBytes?: number; readonly kind?: string; readonly fallbackKind?: string } = {},
): string {
  switch (reason) {
    case "unsafe-path":
      return "the path must be an existing regular file inside the configured workspace";
    case "not-found":
      return "no such file exists inside the configured workspace";
    case "not-a-file":
      return "the path is not a regular file";
    case "too-large":
      return `the file is larger than ${(options.maxBytes ?? OUTBOUND_FILE_LIMITS.maxFileBytes) / (1024 * 1024)} MiB`;
    case "empty":
      return "the file is empty";
    case "unreadable":
      return "the file could not be read as one stable snapshot";
    case "unsupported-format": {
      const subject = options.kind === undefined ? "this send" : `a ${options.kind} send`;
      const fallback = options.fallbackKind === undefined
        ? ""
        : `; resend as kind=${options.fallbackKind} to send these bytes unchanged`;
      return `${subject} needs a matching file extension${fallback} (no conversion is performed)`;
    }
  }
}

/**
 * Bounded concurrency for media work (downloads, storage, transcription), so a burst of
 * attachments never blocks admission order. A released slot passes straight to the oldest waiter;
 * an aborted waiter leaves the queue without taking a slot.
 */
export class WorkGate {
  readonly #max: number;
  #active = 0;
  readonly #waiters: {
    resolve(): void;
    readonly signal: AbortSignal | undefined;
    onAbort: (() => void) | undefined;
  }[] = [];

  constructor(max: number) {
    this.#max = Math.max(1, Math.trunc(Number.isFinite(max) ? max : 1));
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("media work cancelled"));
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, signal, onAbort: undefined as (() => void) | undefined };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason ?? new Error("media work cancelled"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#active -= 1;
      return;
    }
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve();
  }
}

/**
 * Stream one response body, refusing an advertised or actual size above `maxBytes` with
 * `MediaRejected("too-large")`. The reader is always cancelled, so an abandoned or refused download
 * never leaves its stream open; the URL is never part of an error.
 */
export async function* boundedResponseBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(advertised) && advertised > maxBytes) throw new MediaRejected("too-large");
  if (response.body === null) throw new Error("media response has no body");
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
 * C0/C1 controls, DEL, bidi embeddings/overrides/isolates and marks (LRM, RLM, ALM), line and
 * paragraph separators, and the zero-width no-break space: none of them belongs in one printable
 * line of a host notice, and a bidi or format character could visually reorder it.
 */
const LABEL_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/**
 * The one canonical single-line label for host-generated notice text: non-string input becomes
 * empty, unsafe characters become spaces, unpaired surrogates become U+FFFD, whitespace collapses,
 * and the result is cut to `max` UTF-16 units without splitting a surrogate pair. `empty` is the
 * text for a label with nothing printable left; `stripBrackets` removes `[` and `]`, so the label
 * cannot forge a `[name]:` transcript prefix.
 */
export function boundedLabel(
  value: unknown,
  max: number,
  options: { readonly empty?: string; readonly stripBrackets?: boolean } = {},
): string {
  let text = typeof value === "string" ? value : "";
  if (options.stripBrackets === true) text = text.replace(/[[\]]/gu, "");
  const cleaned = replaceUnpairedSurrogates(text.replace(LABEL_UNSAFE, " "))
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned === "") return options.empty ?? "(empty)";
  let end = Math.min(cleaned.length, Math.max(0, Math.trunc(max)));
  if (end > 0 && end < cleaned.length && isHighSurrogate(cleaned.charCodeAt(end - 1))) end -= 1;
  const bounded = cleaned.slice(0, end).trimEnd();
  return bounded === "" ? options.empty ?? "(empty)" : bounded;
}

function replaceUnpairedSurrogates(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (isLowSurrogate(text.charCodeAt(index + 1))) result += text[index]! + text[++index]!;
      else result += "\ufffd";
    } else if (isLowSurrogate(code)) {
      result += "\ufffd";
    } else {
      result += text[index]!;
    }
  }
  return result;
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
