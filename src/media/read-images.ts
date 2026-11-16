import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ImageLimits, ImageProcessor } from "@earendil-works/pi-durable/tools";

/**
 * Model-facing bounds for one image returned by the native `read` tool.
 *
 * The dimensions follow the usual provider guidance for screenshots and photos;
 * the byte ceiling is deliberately below the native 4.5 MiB default so one
 * transcript image cannot add a multi-megabyte payload to every later request
 * that still carries it. They are fixed safety bounds, not quality settings.
 *
 * `maxPixels` and `maxSourceBytes` bound decode work before Photon sees the
 * bytes: a small PNG can declare an enormous canvas, and a decode that exhausts
 * memory cannot be recovered. An image outside them is refused with the native
 * read error instead of being decoded or sent raw.
 */
export const READ_IMAGE_LIMITS = Object.freeze({
  maxWidth: 1568,
  maxHeight: 1568,
  /** Base64 characters of one prepared image; the original file is untouched. */
  maxBytes: 1024 * 1024,
  /** Declared pixels of the source image before any decoding. */
  maxPixels: 50_000_000,
  /**
   * Compressed source bytes before any decoding. The native read tool has
   * already loaded the file bytes when it calls a processor, so this bounds
   * decode work and the model-facing payload, not that native transient read.
   */
  maxSourceBytes: 64 * 1024 * 1024,
});

/**
 * The model-facing image processor for native `read`. Photon is the native
 * facility and pinned dependency of Durable; it is loaded lazily on the first
 * image so a text-only gateway never starts its worker.
 *
 * Every image is decoded and re-encoded only on the model-bound copy the read
 * tool returns; the file on disk is never written. The caller's own model
 * resize limits still narrow the result. A load, decode or encode failure
 * returns no image, which the read tool reports as an error, rather than
 * falling back to the unbounded raw payload.
 */
export function createReadImageProcessor(): ImageProcessor {
  let images: Promise<ImageProcessor> | undefined;
  return {
    async prepare(bytes, mimeType, limits) {
      if (bytes.byteLength === 0 || bytes.byteLength > READ_IMAGE_LIMITS.maxSourceBytes) {
        return undefined;
      }
      const size = imagePixelSize(bytes, mimeType);
      // Without readable dimensions the decode size is unknown, so refuse
      // instead of handing unbounded work to the decoder.
      if (size === undefined || !withinPixelLimit(size.width, size.height)) return undefined;
      try {
        images ??= createNodePhotonImages();
        const processor = await images;
        return await processor.prepare(bytes, mimeType, boundedLimits(limits));
      } catch {
        return undefined;
      }
    },
  };
}

function boundedLimits(limits: ImageLimits): ImageLimits {
  return {
    maxWidth: Math.min(limits.maxWidth, READ_IMAGE_LIMITS.maxWidth),
    maxHeight: Math.min(limits.maxHeight, READ_IMAGE_LIMITS.maxHeight),
    maxBytes: Math.min(limits.maxBytes, READ_IMAGE_LIMITS.maxBytes),
  };
}

function withinPixelLimit(width: number, height: number): boolean {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return false;
  }
  const pixels = width * height;
  return Number.isSafeInteger(pixels) && pixels <= READ_IMAGE_LIMITS.maxPixels;
}

/**
 * Width and height a supported image declares in its header, without decoding
 * it. Mirrors the native reader's formats: PNG, GIF, WebP, JPEG and BMP.
 */
function imagePixelSize(
  bytes: Uint8Array,
  mimeType: string,
): { readonly width: number; readonly height: number } | undefined {
  switch (mimeType) {
    case "image/png":
      return bytes.length < 24
        ? undefined
        : { width: uint32BE(bytes, 16), height: uint32BE(bytes, 20) };
    case "image/gif":
      return bytes.length < 10
        ? undefined
        : { width: uint16LE(bytes, 6), height: uint16LE(bytes, 8) };
    case "image/webp": {
      if (bytes.length < 30) return undefined;
      if (asciiAt(bytes, 12, "VP8 ")) {
        return { width: uint16LE(bytes, 26) & 0x3fff, height: uint16LE(bytes, 28) & 0x3fff };
      }
      if (asciiAt(bytes, 12, "VP8L")) {
        const bits = uint32LE(bytes, 21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (asciiAt(bytes, 12, "VP8X")) {
        const uint24 = (offset: number): number =>
          uint16LE(bytes, offset) + ((bytes[offset + 2] ?? 0) << 16);
        return { width: uint24(24) + 1, height: uint24(27) + 1 };
      }
      return undefined;
    }
    case "image/jpeg": {
      for (let offset = 2; offset + 9 <= bytes.length;) {
        if (bytes[offset] !== 0xff) return undefined;
        const marker = bytes[offset + 1];
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker !== undefined && marker >= 0xc0 && marker <= 0xcf
          && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: uint16BE(bytes, offset + 7), height: uint16BE(bytes, offset + 5) };
        }
        offset += 2 + uint16BE(bytes, offset + 2);
      }
      return undefined;
    }
    case "image/bmp":
      return bmpPixelSize(bytes);
    default:
      return undefined;
  }
}

function bmpPixelSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 26) return undefined;
  const headerSize = uint32LE(bytes, 14);
  if (headerSize === 12) {
    return { width: uint16LE(bytes, 18), height: uint16LE(bytes, 20) };
  }
  if (headerSize < 40 || headerSize > 124 || bytes.length < 30) return undefined;
  return { width: int32LE(bytes, 18), height: Math.abs(int32LE(bytes, 22)) };
}

function uint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);
}

function uint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0);
}

function uint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0);
}

function uint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0)
    + ((bytes[offset + 1] ?? 0) << 8)
    + ((bytes[offset + 2] ?? 0) << 16)
    + (bytes[offset + 3] ?? 0) * 0x1000000;
}

function int32LE(bytes: Uint8Array, offset: number): number {
  return uint32LE(bytes, offset) | 0;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}
