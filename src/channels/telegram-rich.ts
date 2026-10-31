/**
 * Telegram Bot API 10.1 rich-message support.
 *
 * A rich message carries GitHub-flavored markdown (or HTML, or explicit blocks) and allows far more
 * text than `sendMessage` (32,768 characters against 4,096), so assistant text reaches Telegram
 * without a lossy markdown→HTML conversion and without being chopped into many messages.
 *
 * Everything here is transport-independent: the adapter decides when to use it, and a rejection it
 * can prove safe (an unsupported method or a body Telegram refused to parse) falls back to plain
 * text rather than failing the delivery.
 */

/** Rich message body limit: 32,768 UTF-8 characters, also bounded by 500 blocks and 16 nesting levels. */
export const RICH_TEXT_LIMIT = 32_768;
/** `sendMessage` limit after entity parsing; the plain-text fallback stays inside it. */
export const PLAIN_TEXT_LIMIT = 4_096;

/**
 * Process-wide latch. A server that answers a rich send with an unsupported method will keep doing
 * so, so the adapter stops trying for the rest of the process instead of paying a failed request per
 * message. Cleared only by a restart (or a test that resets it).
 */
export const telegramRichSupport = { unavailable: false };

export function richMessagesEnabled(): boolean {
  return !telegramRichSupport.unavailable;
}

export function disableRichMessages(): void {
  telegramRichSupport.unavailable = true;
}

/** The parts of a failed Bot API call that classify it. */
export type TelegramFailure = {
  readonly status: number;
  readonly description: string | undefined;
};

const CAPABILITY_MARKERS = ["method not found", "unknown method"];

/**
 * True when the server has no rich-message method at all: a Bot API older than 10.1 answers an
 * unknown method with 404/`Not Found`, and a strict server may reject the parameter as invalid.
 */
export function isRichCapabilityRejection(failure: TelegramFailure): boolean {
  if (failure.status === 404) return true;
  const description = (failure.description ?? "").toLowerCase();
  if (CAPABILITY_MARKERS.some((marker) => description.includes(marker))) return true;
  return description.startsWith("bad request: invalid parameter");
}

const FORMAT_MARKERS = [
  "can't parse",
  "cannot parse",
  "unsupported start tag",
  "unsupported end tag",
  "message is too long",
  "rich_message",
];

/**
 * True when Telegram refused the rich body itself. A 400 rejection is a proven non-send, so the same
 * text may be retried once as plain text; an ambiguous outcome must never be retried.
 */
export function isRichFormatRejection(failure: TelegramFailure): boolean {
  if (failure.status !== 400) return false;
  const description = (failure.description ?? "").toLowerCase();
  return FORMAT_MARKERS.some((marker) => description.includes(marker));
}

/** Inline constructs that can start anywhere on a line. */
const ALWAYS_ESCAPED = /[\\`*[\]<>~$]/;
/** Block constructs that only matter as the first character of a line. */
const LINE_START_MARKDOWN = new Set(["#", "-", "+", "=", "|"]);
const ORDERED_LIST_START = /^(\d{1,9})([.)])/;
const ALPHANUMERIC = /[A-Za-z0-9]/;

/**
 * Escape text that is content rather than markdown, so a rich message renders it literally.
 *
 * Host-generated notices (status listings, command help, digest reports, control acknowledgements)
 * contain paths, ids, `*` selection markers and `<preset>` placeholders; sent as rich markdown, those
 * would italicize, start a list or be read as an unsupported HTML tag. Escaping only what actually
 * starts a construct keeps the readable text unchanged — Markdown renders a backslash escape as the
 * bare character — and an underscore between two alphanumerics stays bare, so `media/2026_10_31.jpg`
 * and `@other_bot` keep their literal form.
 */
export function escapeTelegramLiteral(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const escaped = escapeInline(line);
      const ordered = ORDERED_LIST_START.exec(escaped);
      if (ordered !== null) {
        return `${ordered[1]}\\${ordered[2]}${escaped.slice(ordered[0].length)}`;
      }
      const first = escaped[0];
      return first !== undefined && LINE_START_MARKDOWN.has(first) ? `\\${escaped}` : escaped;
    })
    .join("\n");
}

function escapeInline(line: string): string {
  let escaped = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    // An underscore between two alphanumerics cannot open emphasis, so a path or a username keeps
    // its literal form; anywhere else it could pair with another one into italics.
    const intrawordUnderscore = char === "_" &&
      ALPHANUMERIC.test(line[index - 1] ?? "") && ALPHANUMERIC.test(line[index + 1] ?? "");
    const needsEscape = char === "_" ? !intrawordUnderscore : ALWAYS_ESCAPED.test(char);
    escaped += needsEscape ? `\\${char}` : char;
  }
  return escaped;
}

/**
 * Split rich markdown without leaving a fenced code block unbalanced.
 *
 * A cut inside a fence closes it and reopens the same fence in the next chunk, so each part is
 * independently valid markdown. Cuts prefer a line boundary, then a word boundary. The limit counts
 * UTF-16 units, which is never smaller than Telegram's character count for the same text.
 */
export function splitRichText(text: string, limit: number = RICH_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let remaining = text.replace(/^\s+/, "");
  if (remaining === "") return text === "" ? [] : [text];
  while (remaining !== "") {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    const within = remaining.slice(0, limit);
    let cut = within.lastIndexOf("\n");
    if (cut <= 0) cut = within.lastIndexOf(" ");
    if (cut <= 0) cut = limit;
    // Never split a surrogate pair: a lone half is not a character to Telegram.
    if (cut > 0 && cut < remaining.length && isHighSurrogate(remaining.charCodeAt(cut - 1))) cut -= 1;
    if (cut <= 0) {
      // A pathological limit below one character; keep progress rather than looping.
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
      continue;
    }
    const fence = openFenceAt(remaining, cut);
    if (fence !== undefined && fence.opening > 0) {
      // Cutting before the fence keeps it whole in the next chunk, which is valid markdown.
      cut = fence.opening;
    } else if (fence !== undefined) {
      const closed = closeFenceAt(remaining, cut, limit, fence.fence);
      chunks.push(closed.chunk);
      remaining = closed.remaining.replace(/^\s+/, "");
      continue;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  return chunks;
}

/**
 * The fence this cut falls inside, when any. Only ``` fences are tracked, so a cut inside a ~~~
 * block can split it; the body then renders as text rather than failing the whole message.
 */
function openFenceAt(text: string, cut: number): { opening: number; fence: string } | undefined {
  if ((text.slice(0, cut).split("```").length - 1) % 2 === 0) return undefined;
  const opening = text.lastIndexOf("```", cut - 1);
  if (opening < 0) return { opening: 0, fence: "```" };
  const lineEnd = text.indexOf("\n", opening);
  return { opening, fence: lineEnd < 0 ? text.slice(opening) : text.slice(opening, lineEnd) };
}

/** Close a fence that starts the chunk and reopen the same fence line in the remainder. */
function closeFenceAt(
  text: string,
  cut: number,
  limit: number,
  fence: string,
): { chunk: string; remaining: string } {
  if (limit <= "\n```".length) return { chunk: text.slice(0, limit), remaining: text.slice(limit) };
  let at = cut;
  let closing = "\n```";
  // A fence that opens in this chunk needs room for its own first line and a closing line.
  const openingLength = text.startsWith(`${fence}\n`) ? fence.length + 1 : fence.length;
  if (at < openingLength && openingLength + closing.length > limit) {
    // The fence itself is too close to the limit to grow: cut the raw text and continue.
    return { chunk: text.slice(0, limit), remaining: text.slice(limit) };
  }
  if (at + closing.length > limit) {
    const budget = limit - closing.length;
    if (budget <= 0) {
      closing = "```";
      at = limit - closing.length;
    } else {
      const within = text.slice(0, budget);
      const adjusted = within.lastIndexOf("\n") > 0 ? within.lastIndexOf("\n") : within.lastIndexOf(" ");
      at = adjusted > 0 ? adjusted : budget;
    }
  }
  return {
    chunk: `${text.slice(0, at)}${closing}`,
    remaining: `${fence}\n${text.slice(at).replace(/^\n/, "")}`,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
