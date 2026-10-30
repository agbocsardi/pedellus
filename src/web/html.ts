/**
 * Readable-text extraction for `web_fetch`.
 *
 * Parsing is delegated to htmlparser2 (a maintained HTML tokenizer/DOM), never
 * a regex tag stripper and never a browser. Nothing is executed: script, style,
 * template and embedded-content subtrees contribute no text, and the page's
 * markup cannot add tools, policy or instructions to the host. Extracted links
 * stay explicitly labelled as untrusted page data.
 */
import { parseDocument } from "htmlparser2";

/** Minimal structural view of the parser's DOM; no transitive type imports. */
interface HtmlNode {
  readonly type: string;
  readonly name?: string;
  readonly data?: string;
  readonly attribs?: Readonly<Record<string, string>>;
  readonly children?: readonly HtmlNode[];
}

export interface HtmlExtraction {
  readonly title?: string;
  readonly text: string;
  readonly links: readonly string[];
  readonly textTruncated: boolean;
}

const SKIPPED_ELEMENTS = new Set([
  "script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "canvas", "math",
]);

const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "dd", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table",
  "tbody", "thead", "tfoot", "tr", "ul",
]);

const HEADING_ELEMENTS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const MIN_MAIN_CHARS = 200;
/** A hostile page cannot make extraction recurse without bound. */
const MAX_DOM_DEPTH = 256;

function element(node: HtmlNode): boolean {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

function hidden(node: HtmlNode): boolean {
  const attribs = node.attribs;
  if (attribs === undefined) return false;
  if (Object.hasOwn(attribs, "hidden")) return true;
  return attribs["aria-hidden"] === "true";
}

function findFirst(node: HtmlNode, name: string, depth = 0): HtmlNode | undefined {
  if (depth > MAX_DOM_DEPTH) return undefined;
  if (element(node) && node.name?.toLowerCase() === name) return node;
  for (const child of node.children ?? []) {
    const found = findFirst(child, name, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Approximate visible text length, used only to prefer a real content container. */
function visibleLength(node: HtmlNode, depth = 0): number {
  if (depth > MAX_DOM_DEPTH) return 0;
  if (node.type === "text") return node.data?.length ?? 0;
  if (!element(node)) {
    return (node.children ?? []).reduce((total, child) => total + visibleLength(child, depth + 1), 0);
  }
  const name = node.name?.toLowerCase() ?? "";
  if (SKIPPED_ELEMENTS.has(name) || hidden(node)) return 0;
  return (node.children ?? []).reduce((total, child) => total + visibleLength(child, depth + 1), 0);
}

function textOf(node: HtmlNode, depth = 0): string {
  if (depth > MAX_DOM_DEPTH) return "";
  if (node.type === "text") return node.data ?? "";
  if (!element(node) || SKIPPED_ELEMENTS.has(node.name?.toLowerCase() ?? "")) return "";
  return (node.children ?? []).map((child) => textOf(child, depth + 1)).join("");
}

function collapse(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function chooseRoot(document: HtmlNode): HtmlNode {
  for (const name of ["main", "article"]) {
    const candidate = findFirst(document, name);
    if (candidate !== undefined && visibleLength(candidate) >= MIN_MAIN_CHARS) return candidate;
  }
  return findFirst(document, "body") ?? document;
}

interface WalkState {
  readonly parts: string[];
  readonly links: string[];
  readonly seenLinks: Set<string>;
  readonly base: URL;
  readonly maxLinks: number;
}

function addLink(state: WalkState, href: string | undefined): void {
  if (href === undefined || state.links.length >= state.maxLinks) return;
  let resolved: URL;
  try {
    resolved = new URL(href, state.base);
  } catch {
    return;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
  if (resolved.username !== "" || resolved.password !== "") return;
  const href_ = resolved.toString();
  if (state.seenLinks.has(href_)) return;
  state.seenLinks.add(href_);
  state.links.push(href_);
}

function walk(node: HtmlNode, state: WalkState, depth = 0): void {
  if (depth > MAX_DOM_DEPTH) return;
  if (node.type === "text") {
    state.parts.push(node.data ?? "");
    return;
  }
  if (!element(node)) {
    for (const child of node.children ?? []) walk(child, state, depth + 1);
    return;
  }
  const name = node.name?.toLowerCase() ?? "";
  if (SKIPPED_ELEMENTS.has(name) || hidden(node)) return;
  if (name === "a") addLink(state, node.attribs?.href);
  if (name === "li") state.parts.push("\n• ");
  else if (name === "br") state.parts.push("\n");
  else if (HEADING_ELEMENTS.has(name)) state.parts.push("\n\n");
  else if (BLOCK_ELEMENTS.has(name)) state.parts.push("\n");
  for (const child of node.children ?? []) walk(child, state, depth + 1);
  if (HEADING_ELEMENTS.has(name)) state.parts.push("\n\n");
  else if (BLOCK_ELEMENTS.has(name) || name === "tr") state.parts.push("\n");
  else if (name === "td" || name === "th") state.parts.push(" ");
}

function normalizeText(parts: readonly string[]): string {
  return parts
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract a title, visible readable text, and bounded absolute links from one
 * HTML document. `text` is capped at `maxTextChars`; the caller reports the
 * truncation instead of pretending the page ended there.
 */
export function extractHtml(
  html: string,
  documentUrl: URL,
  options: { readonly maxTextChars: number; readonly maxLinks: number; readonly maxTitleChars: number },
): HtmlExtraction {
  const document = parseDocument(html) as unknown as HtmlNode;
  const titleNode = findFirst(document, "title");
  const title = titleNode === undefined
    ? undefined
    : collapse(textOf(titleNode)).slice(0, options.maxTitleChars) || undefined;

  const baseNode = findFirst(document, "base");
  const baseHref = baseNode?.attribs?.href;
  let base = documentUrl;
  if (baseHref !== undefined) {
    try {
      const candidate = new URL(baseHref, documentUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") base = candidate;
    } catch {
      // A malformed <base> keeps the document URL; it never grants another scheme.
    }
  }

  const state: WalkState = {
    parts: [],
    links: [],
    seenLinks: new Set<string>(),
    base,
    maxLinks: options.maxLinks,
  };
  walk(chooseRoot(document), state);
  const full = normalizeText(state.parts);
  const textTruncated = full.length > options.maxTextChars;
  const text = (textTruncated ? full.slice(0, options.maxTextChars) : full).trimEnd();
  return {
    ...(title === undefined ? {} : { title }),
    text,
    links: Object.freeze([...state.links]),
    textTruncated,
  };
}
