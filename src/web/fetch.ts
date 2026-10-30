/**
 * Public web page reader.
 *
 * Security boundaries, in order:
 * - `http`/`https` only, no userinfo, bounded URL length.
 * - Every hop (including each redirect) is resolved and every returned address
 *   must be ordinary public unicast; the connection is then pinned to that
 *   validated address, so a second DNS answer cannot redirect the socket
 *   (rebinding).
 * - Redirects are followed manually with a hop limit, and each new location is
 *   revalidated before any connection is made.
 * - The request sends a fixed header set only. There is no cookie jar, no
 *   ambient proxy, no browser auth and nothing carried across origins.
 * - Connect, total, streamed-byte and decoded-text bounds are enforced; script,
 *   style and embedded subtrees are never rendered or executed.
 *
 * The transport seam exists for tests with controlled fixtures. No shipped
 * configuration can substitute it or allow private hosts.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { WebAddressError, assertPublicAddress, ipLiteral, normalizeHostname, type PublicAddress } from "./address.js";
import { extractHtml } from "./html.js";
import { nativeWebResolver, type WebResolver } from "./resolver.js";

export const WEB_FETCH_LIMITS = Object.freeze({
  maxUrlChars: 2_048,
  /** Redirects followed before the request fails. */
  maxRedirects: 4,
  /** Streamed body bytes retained; beyond this the page is explicitly truncated. */
  maxBodyBytes: 2 * 1024 * 1024,
  /** Readable text characters returned to the model. */
  maxTextChars: 48 * 1024,
  maxLinks: 40,
  maxTitleChars: 300,
  connectTimeoutMs: 8_000,
  totalTimeoutMs: 20_000,
});

export interface WebTransportResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Release the socket and the body without reading further. Safe to call twice. */
  dispose(): void;
}

export interface WebTransportRequest {
  readonly url: URL;
  /** The validated address the socket must connect to. */
  readonly address: PublicAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type WebTransport = (request: WebTransportRequest) => Promise<WebTransportResponse>;

export type WebFetchErrorCode =
  | "invalid-url"
  | "unsupported-protocol"
  | "credentials-in-url"
  | "address"
  | "redirect"
  | "http"
  | "content-type"
  | "content-encoding"
  | "timed-out"
  | "cancelled"
  | "transport";

export class WebFetchError extends Error {
  constructor(
    readonly code: WebFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

export interface WebFetchResult {
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly title?: string;
  readonly contentType: string;
  readonly retrievedAt: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly bodyTruncated: boolean;
  readonly links: readonly string[];
  readonly redirects: number;
}

export interface PublicWebFetcherOptions {
  readonly resolver?: WebResolver;
  readonly transport?: WebTransport;
  readonly now?: () => Date;
  readonly limits?: Partial<typeof WEB_FETCH_LIMITS>;
}

const REQUEST_HEADERS = Object.freeze({
  accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
  "accept-encoding": "identity",
  "user-agent": "nanobot-web-tools/1.0",
  connection: "close",
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function safeMime(value: string): string {
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : "";
}

function parseTarget(raw: string, limits: typeof WEB_FETCH_LIMITS): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > limits.maxUrlChars) {
    throw new WebFetchError("invalid-url", `The URL must be 1-${limits.maxUrlChars} characters.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError("invalid-url", "The URL is not a valid absolute URL.");
  }
  assertHttpTarget(url);
  return url;
}

function assertHttpTarget(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError("unsupported-protocol", "Only http and https URLs can be fetched.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebFetchError("credentials-in-url", "URLs with embedded credentials are refused.");
  }
  if (normalizeHostname(url.hostname).length === 0) {
    throw new WebFetchError("invalid-url", "The URL has no host.");
  }
  if (url.port === "0") throw new WebFetchError("invalid-url", "The URL port is not usable.");
}

async function readBounded(
  response: WebTransportResponse,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done === true) break;
      const chunk = next.value;
      if (chunk.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    if (truncated && typeof iterator.return === "function") {
      await iterator.return().catch(() => undefined);
    }
  }
  return { bytes: Buffer.concat(chunks, total), truncated };
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]?.trim().toLowerCase();
  try {
    return new TextDecoder(charset ?? "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export class PublicWebFetcher {
  readonly #resolver: WebResolver;
  readonly #transport: WebTransport;
  readonly #now: () => Date;
  readonly #limits: typeof WEB_FETCH_LIMITS;

  constructor(options: PublicWebFetcherOptions = {}) {
    this.#resolver = options.resolver ?? nativeWebResolver;
    this.#transport = options.transport ?? nativeWebTransport(options.limits?.connectTimeoutMs);
    this.#now = options.now ?? (() => new Date());
    this.#limits = { ...WEB_FETCH_LIMITS, ...options.limits };
  }

  async fetch(rawUrl: string, options: { readonly signal?: AbortSignal } = {}): Promise<WebFetchResult> {
    let url = parseTarget(rawUrl, this.#limits);
    const originalUrl = url.toString();
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, this.#limits.totalTimeoutMs);
    const onAbort = () => deadline.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let redirects = 0;
    try {
      while (true) {
        const address = await this.#resolve(url);
        const response = await this.#transport({
          url,
          address,
          headers: REQUEST_HEADERS,
          signal: deadline.signal,
        });
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get("location");
          response.dispose();
          if (location === undefined || location.trim() === "") {
            throw new WebFetchError("redirect", "The page redirected without a usable location.");
          }
          if (redirects >= this.#limits.maxRedirects) {
            throw new WebFetchError("redirect", `The page redirected more than ${this.#limits.maxRedirects} times.`);
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new WebFetchError("redirect", "The page redirected to an invalid URL.");
          }
          assertHttpTarget(next);
          if (next.toString().length > this.#limits.maxUrlChars) {
            throw new WebFetchError("invalid-url", `The redirect URL exceeds ${this.#limits.maxUrlChars} characters.`);
          }
          url = next;
          redirects += 1;
          continue;
        }
        if (response.status < 200 || response.status > 299) {
          response.dispose();
          throw new WebFetchError("http", `The page returned HTTP ${response.status}.`);
        }
        try {
          return await this.#readPage(originalUrl, url, response, redirects);
        } finally {
          response.dispose();
        }
      }
    } catch (error) {
      if (error instanceof WebFetchError) throw error;
      if (timedOut) throw new WebFetchError("timed-out", "The page request timed out.");
      if (options.signal?.aborted === true) throw new WebFetchError("cancelled", "The page request was cancelled.");
      if (error instanceof WebAddressError) throw new WebFetchError("address", error.message);
      throw new WebFetchError("transport", "The page request failed.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async #resolve(url: URL): Promise<PublicAddress> {
    const literal = ipLiteral(url.hostname);
    let answers: readonly PublicAddress[];
    if (literal !== undefined) {
      answers = [assertPublicAddress(literal)];
    } else {
      try {
        answers = await this.#resolver(normalizeHostname(url.hostname));
      } catch (error) {
        if (error instanceof WebAddressError) throw error;
        throw new WebFetchError("address", "The host could not be resolved.");
      }
    }
    if (answers.length === 0) {
      throw new WebFetchError("address", "The host did not resolve to an IP address.");
    }
    // Validate every answer before choosing one, so a mixed answer set is refused outright.
    const validated = answers.map((answer) => assertPublicAddress(answer.address));
    return validated[0]!;
  }

  async #readPage(
    originalUrl: string,
    url: URL,
    response: WebTransportResponse,
    redirects: number,
  ): Promise<WebFetchResult> {
    const contentTypeHeader = response.headers.get("content-type") ?? "";
    const mime = safeMime(contentTypeHeader);
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
      throw new WebFetchError("content-encoding", "The page used an unsupported content encoding.");
    }
    const kind = mime === "text/html" || mime === "application/xhtml+xml"
      ? "html"
      : mime === "text/plain"
        ? "text"
        : mime === "application/json" || mime.endsWith("+json")
          ? "json"
          : undefined;
    if (kind === undefined) {
      throw new WebFetchError(
        "content-type",
        mime === ""
          ? "The page did not declare a supported text content type."
          : `The page content type (${mime.slice(0, 80)}) is not supported; only HTML, plain text and JSON are read.`,
      );
    }

    const { bytes, truncated: bodyTruncated } = await readBounded(response, this.#limits.maxBodyBytes);
    const decoded = decodeBody(bytes, contentTypeHeader);
    let text: string;
    let title: string | undefined;
    let links: readonly string[] = [];
    let textTruncated = false;
    if (kind === "html") {
      const extracted = extractHtml(decoded, url, {
        maxTextChars: this.#limits.maxTextChars,
        maxLinks: this.#limits.maxLinks,
        maxTitleChars: this.#limits.maxTitleChars,
      });
      text = extracted.text;
      title = extracted.title;
      links = extracted.links;
      textTruncated = extracted.textTruncated;
    } else {
      textTruncated = decoded.length > this.#limits.maxTextChars;
      text = (textTruncated ? decoded.slice(0, this.#limits.maxTextChars) : decoded).trimEnd();
    }
    return {
      originalUrl,
      finalUrl: url.toString(),
      status: response.status,
      ...(title === undefined ? {} : { title }),
      contentType: contentTypeHeader,
      retrievedAt: this.#now().toISOString(),
      text,
      textTruncated,
      bodyTruncated,
      links,
      redirects,
    };
  }
}

/** Native socket transport: pin the connection to the pre-validated address. */
export function nativeWebTransport(connectTimeoutMs = WEB_FETCH_LIMITS.connectTimeoutMs): WebTransport {
  return ({ url, address, headers, signal }) => new Promise<WebTransportResponse>((resolve, reject) => {
    const host = normalizeHostname(url.hostname);
    const secure = url.protocol === "https:";
    const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
    const path = `${url.pathname}${url.search}`;
    let promiseSettled = false;
    let released = false;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;

    const cleanup = () => signal.removeEventListener("abort", onAbort);
    /** Free socket, body and listeners exactly once, whether or not the promise settled already. */
    const release = () => {
      if (released) return;
      released = true;
      cleanup();
      response?.destroy();
      request?.destroy();
    };
    const fail = (error: Error) => {
      if (promiseSettled) return;
      promiseSettled = true;
      release();
      reject(error);
    };
    // A deadline or caller abort after the response arrived must still tear down the
    // in-flight body read; `fail` alone would return because the promise already resolved.
    const onAbort = () => {
      fail(new WebFetchError("cancelled", "The page request was cancelled."));
      release();
    };

    if (signal.aborted) {
      reject(new WebFetchError("cancelled", "The page request was cancelled."));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      // The name was resolved and validated already; this is the only lookup that
      // decides where the socket goes, and it returns that exact address.
      if (lookupOptions.all === true) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };

    try {
      const create = secure ? httpsRequest : httpRequest;
      request = create({
        protocol: url.protocol,
        hostname: host,
        port,
        path,
        method: "GET",
        headers: { ...headers, host: url.host },
        agent: false,
        lookup,
        ...(secure && isIP(host) === 0 ? { servername: host } : {}),
      }, (incoming: IncomingMessage) => {
        response = incoming;
        if (promiseSettled) {
          release();
          return;
        }
        promiseSettled = true;
        request?.setTimeout(0);
        const responseHeaders = new Map<string, string>();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") responseHeaders.set(name.toLowerCase(), value);
          else if (Array.isArray(value)) responseHeaders.set(name.toLowerCase(), value.join(", "));
        }
        resolve({
          status: incoming.statusCode ?? 0,
          headers: responseHeaders,
          body: incoming as AsyncIterable<Uint8Array>,
          dispose: release,
        });
      });
      request.setTimeout(connectTimeoutMs, () => {
        fail(new WebFetchError("timed-out", "The page request timed out."));
      });
      request.on("error", () => {
        fail(new WebFetchError("transport", "The page request failed."));
      });
      request.end();
    } catch {
      fail(new WebFetchError("transport", "The page request failed."));
    }
  });
}
