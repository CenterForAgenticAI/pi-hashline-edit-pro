import { splitLines } from "./utils";
import type { DiffSpan } from "./replace-diff";

const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const LOOKALIKE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;
const LOOKALIKE_DASH_RE = /[\u2010-\u2015\u2212]/u;
const LOOKALIKE_QUOTE_RE = /[\u2018\u2019\u201c\u201d]/u;
const MAX_LISTED_CHARS = 3;

const CHAR_NAMES: Readonly<Record<number, string>> = {
  0x00a0: "no-break space",
  0x200b: "zero-width space",
  0x200c: "zero-width non-joiner",
  0x200d: "zero-width joiner",
  0x200e: "left-to-right mark",
  0x200f: "right-to-left mark",
  0x2011: "non-breaking hyphen",
  0x202f: "narrow no-break space",
  0x2060: "word joiner",
  0xfeff: "zero-width no-break space",
};

const LOOKALIKE_SUBSTITUTES: Readonly<Record<string, string>> = {
  "\u00a0": " ",
  "\u1680": " ",
  "\u2000": " ",
  "\u2001": " ",
  "\u2002": " ",
  "\u2003": " ",
  "\u2004": " ",
  "\u2005": " ",
  "\u2006": " ",
  "\u2007": " ",
  "\u2008": " ",
  "\u2009": " ",
  "\u200a": " ",
  "\u202f": " ",
  "\u205f": " ",
  "\u3000": " ",
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": "\"",
  "\u201d": "\"",
};

export function isFidelitySensitiveChar(char: string): boolean {
  return INVISIBLE_RE.test(char) || LOOKALIKE_SPACE_RE.test(char) || LOOKALIKE_DASH_RE.test(char) || LOOKALIKE_QUOTE_RE.test(char);
}

function describeChar(char: string): string {
  const codePoint = char.codePointAt(0)!;
  const hex = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  const name = CHAR_NAMES[codePoint];
  return name === undefined ? hex : `${hex} (${name})`;
}

function unicodeLostHint(chars: string[]): string {
  const listed = chars.slice(0, MAX_LISTED_CHARS).map(describeChar).join(", ");
  const more = chars.length > MAX_LISTED_CHARS ? ` (+${chars.length - MAX_LISTED_CHARS} more)` : "";
  return `[H_UNICODE_LOST] The removed line contained ${listed}${more}, which the replacement does not. If the request did not ask to remove it, copy the character from the served row.`;
}

function withCharsRestored(line: string, chars: readonly string[], replacementFor: (char: string) => string): string {
  let out = line;
  for (const char of chars) out = out.split(char).join(replacementFor(char));
  return out;
}

function isDeliberateCharFix(oldLine: string, newLine: string, lostChars: readonly string[]): boolean {
  if (lostChars.length === 0) return false;
  if (withCharsRestored(oldLine, lostChars, (char) => LOOKALIKE_SUBSTITUTES[char] ?? "") === newLine) return true;
  return withCharsRestored(oldLine, lostChars, () => "") === newLine;
}

export function fidelityHints(originalContent: string, resultContent: string, spans: readonly DiffSpan[] | undefined): string[] {
  if (spans === undefined || spans.length === 0) return [];
  const oldLines = splitLines(originalContent);
  const newLines = splitLines(resultContent);
  const lost = new Set<string>();
  let offset = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const removedCount = span.end >= span.start ? span.end - span.start + 1 : 0;
    const removed = removedCount > 0 ? oldLines.slice(span.start, span.end + 1) : [];
    const inserted = newLines.slice(span.start + offset, span.start + offset + span.replacementCount);
    if (removed.length > 0 && inserted.length > 0) {
      const insertedText = inserted.join("\n");
      const dropped: string[] = [];
      for (const line of removed) {
        for (const char of line) {
          if (!dropped.includes(char) && isFidelitySensitiveChar(char) && !insertedText.includes(char)) dropped.push(char);
        }
      }
      const deliberateFix = removed.length === 1 && inserted.length === 1 && isDeliberateCharFix(removed[0]!, inserted[0]!, dropped);
      if (!deliberateFix) {
        for (const char of dropped) lost.add(char);
      }
    }
    offset += span.replacementCount - removedCount;
  }
  return lost.size > 0 ? [unicodeLostHint([...lost].sort())] : [];
}
