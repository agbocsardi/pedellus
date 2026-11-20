import { LIMITS, type UploadError } from "./protocol";

/** Protocol v2, Files: `kind` comes from the announced type only, never the bytes. */
export function attachmentKind(type: string): "image" | "audio" | "file" {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

/** Same-origin file download; the cookie travels with it. */
export function fileUrl(id: string): string {
  return `/v1/files/${encodeURIComponent(id)}`;
}

const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(size: number): string {
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${SIZE_UNITS[unit]}`;
}

export type UploadOutcome =
  | { ok: true; id: string }
  | { ok: false; error: UploadError | "network" | "http"; retry: boolean };

/**
 * POST one file's raw bytes to `/v1/upload` (protocol v2, Files). The body is
 * the blob itself, the cookie authenticates, and `X-Filename` is the original
 * name percent-encoded as UTF-8. Failures carry whether trying again is honest.
 */
export async function uploadFile(blob: Blob, name: string, type: string): Promise<UploadOutcome> {
  const headers: Record<string, string> = {
    "Content-Type": type || "application/octet-stream",
    "X-Filename": encodeURIComponent(name),
  };
  let res: Response;
  try {
    res = await fetch("/v1/upload", { method: "POST", credentials: "same-origin", headers, body: blob });
  } catch {
    return { ok: false, error: "network", retry: true };
  }
  const body = (await res.json().catch(() => undefined)) as { id?: unknown; error?: unknown } | undefined;
  if (res.status === 201 && typeof body?.id === "string" && LIMITS.uploadIdPattern.test(body.id)) {
    return { ok: true, id: body.id };
  }
  const error = body?.error;
  switch (error) {
    case "rate_limited":
      return { ok: false, error, retry: true };
    case "bad_request":
    case "unsupported":
    case "unauthorized":
    case "too_large":
      return { ok: false, error, retry: false };
  }
  // A 5xx or an unexpected body is worth one more try; the bytes are still local.
  return { ok: false, error: "http", retry: true };
}

/** One owner-facing line for a failed upload; never echoes gateway internals. */
export function uploadErrorText(error: string, name: string): string {
  switch (error) {
    case "too_large":
      return `${name} is too large for this gateway.`;
    case "rate_limited":
      return `Too many uploads right now. ${name} was not uploaded.`;
    case "unauthorized":
      return "Pairing is no longer valid. Pair this device again.";
    case "unsupported":
      return "This gateway does not accept files.";
    case "bad_request":
      return `The gateway rejected ${name}.`;
    default:
      return `Could not upload ${name}. It will retry when the connection is back.`;
  }
}
