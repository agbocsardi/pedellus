/**
 * Channel-neutral rich-text splitting shared by every Markdown-rendering channel.
 *
 * The caller passes its own per-message limit; nothing here knows a channel's API or escaping.
 */

/**
 * Split rich text into bounded chunks while keeping simple triple-backtick (```) fences balanced.
 *
 * Fence matching is inherited from Telegram's splitter: it tracks literal ``` markers by parity
 * rather than full CommonMark fence nesting (tilde ~~~ fences, longer ```` fences and inline
 * triple-backticks are not parsed as nested fences). A cut inside an open ``` block moves before
 * its opening marker when possible, closes and reopens the same fence line in the next chunk, or
 * falls back to an unbalanced split when the limit is too small to fit the closing and reopening
 * fence. Cuts prefer a line boundary, then a word boundary, and never split a surrogate pair. The limit
 * counts UTF-16 units, which is never smaller than a character count.
 */
export function splitRichText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError("rich text limit must be at least 2");
  let remaining = text;
  while (remaining !== "") {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    const within = remaining.slice(0, limit);
    let cut = within.lastIndexOf("\n");
    if (cut <= 0) cut = within.lastIndexOf(" ");
    if (cut <= 0) cut = limit;
    // Never split a surrogate pair: a lone half is not a character to any channel.
    if (cut > 0 && cut < remaining.length && isHighSurrogate(remaining.charCodeAt(cut - 1))) cut -= 1;
    if (cut <= 0) {
      // A pathological limit below one character; keep progress rather than looping.
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
      continue;
    }
    const fence = openFenceAt(remaining, cut);
    if (fence !== undefined && fence.opening > 0) {
      // Cutting before the opening ``` keeps that block whole in the next chunk.
      cut = fence.opening;
    } else if (fence !== undefined) {
      // Reopening an almost-limit-sized header can consume almost no original text per chunk,
      // multiplying a short input into gigabytes. For unusually long headers, cut raw instead.
      if (fence.fence.length > limit / 4) {
        let end = limit;
        if (end < remaining.length && isHighSurrogate(remaining.charCodeAt(end - 1))) end--;
        chunks.push(remaining.slice(0, end));
        remaining = remaining.slice(end);
        continue;
      }
      const closed = closeFenceAt(remaining, cut, limit, fence.fence);
      chunks.push(closed.chunk);
      remaining = closed.remaining;
      continue;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

/**
 * The opening ``` marker this cut falls inside, when the prefix contains an odd number of literal
 * ``` markers. Only simple triple-backtick parity is tracked (not CommonMark ~~~ or nested
 * longer-backtick fences); any unparsed block falls back to plain text on the channel side.
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
      at = adjusted > openingLength ? adjusted : budget;
    }
  }
  if (at <= openingLength) at = limit - closing.length;
  if (at > 0 && isHighSurrogate(text.charCodeAt(at - 1))) at -= 1;
  if (at <= openingLength) return { chunk: text.slice(0, cut), remaining: text.slice(cut) };
  return {
    chunk: `${text.slice(0, at)}${closing}`,
    remaining: `${fence}\n${text.slice(at)}`,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
