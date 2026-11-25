import { stripVTControlCharacters } from "node:util";

/**
 * Terminal text hygiene shared by the terminal's renderers: every model, host and stored string is
 * stripped of terminal controls and bidi/format marks, unpaired surrogates become U+FFFD, and
 * bounds never cut a surrogate pair.
 */

export function safeLabel(value: string, max: number): string {
  return completePrefix(sanitizeTerminalText(value).replace(/\s+/gu, " ").trim(), max) || "(empty)";
}

/**
 * An exact session key usable as one CLI token in a printed hint, or `undefined` when printing it
 * would change it: whitespace, terminal sanitization (LRM/RLM/ALM, bidi isolates, C0/C1 controls,
 * unpaired surrogates) or more than 200 code units.
 */
export function historySessionToken(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 200) return undefined;
  if (/\s/u.test(value)) return undefined;
  // The exact key must survive terminal sanitization unchanged: LRM/RLM/ALM, bidi
  // isolates, C0/C1 controls and unpaired surrogates would otherwise change it.
  return sanitizeTerminalText(value) === value ? value : undefined;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? completePrefix(sanitizeTerminalText(error.name), 80) || "Error" : "unknown error";
}

export function stripTerminalControls(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/g, "");
}

/** Sanitize a live partial: a trailing high surrogate may still be completed by the next frame. */
export function sanitizePartialText(text: string): string {
  return replaceUnpairedSurrogates(stripTerminalControls(text), true);
}

export function sanitizeTerminalText(text: string): string {
  return replaceUnpairedSurrogates(stripTerminalControls(text), false);
}

function replaceUnpairedSurrogates(text: string, preserveTrailingHigh: boolean): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (isLowSurrogate(text.charCodeAt(index + 1))) result += text[index]! + text[++index]!;
      else if (preserveTrailingHigh && index === text.length - 1) result += text[index]!;
      else result += "�";
    } else if (isLowSurrogate(code)) result += "�";
    else result += text[index]!;
  }
  return result;
}

/** At most `maxCodeUnits` of `text`, never ending inside a surrogate pair. */
export function completePrefix(text: string, maxCodeUnits: number): string {
  let length = Math.min(text.length, Math.max(0, maxCodeUnits));
  if (length > 0 && isHighSurrogate(text.charCodeAt(length - 1))) length--;
  return text.slice(0, length);
}

export function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
export function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
