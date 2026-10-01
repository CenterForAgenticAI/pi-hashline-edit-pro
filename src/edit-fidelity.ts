import { splitLines } from "./utils";
import { HASH_LEN, HASH_SEP } from "./hashline";
import type { DiffSpan } from "./replace-diff";

const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const LOOKALIKE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;
const LOOKALIKE_DASH_RE = /[\u2010-\u2015\u2212]/u;
const LOOKALIKE_QUOTE_RE = /[\u2018\u2019\u201c\u201d]/u;
const MAX_MISSING_HINTS = 3;
const INSERT_REFERENCE_WINDOW = 5;
const REFERENCE_INDENT = " ".repeat(HASH_LEN + HASH_SEP.length);

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

function formatCodePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

interface ReferenceRow {
  line: string;
  index: number;
}

function renderReferenceRow(reference: ReferenceRow, anchor: string | undefined): string {
  const prefix = anchor === undefined ? " ".repeat(HASH_LEN) : anchor;
  return `${prefix}${HASH_SEP}${reference.line}`;
}

function hiddenCharHint(char: string, reference: ReferenceRow, anchor: string | undefined): string {
  const column = [...reference.line].indexOf(char) + 1;
  return [
    `[H_UNICODE_LOST] The new text is missing ${formatCodePoint(char)}.`,
    renderReferenceRow(reference, anchor),
    `${REFERENCE_INDENT}└ ${formatCodePoint(char)} at col ${column}`,
  ].join("\n");
}

function referenceRows(lines: string[], start: number, end: number): ReferenceRow[] {
  const from = Math.max(0, start - INSERT_REFERENCE_WINDOW);
  const to = Math.min(lines.length - 1, end + INSERT_REFERENCE_WINDOW);
  const rows: ReferenceRow[] = [];
  for (let index = from; index <= to; index++) rows.push({ line: lines[index]!, index });
  return rows;
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

export function fidelityHints(
  originalContent: string,
  resultContent: string,
  spans: readonly DiffSpan[] | undefined,
  originalHashes?: readonly string[],
): string[] {
  if (spans === undefined || spans.length === 0) return [];
  const oldLines = splitLines(originalContent);
  const newLines = splitLines(resultContent);
  const hints: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const removedCount = span.end >= span.start ? span.end - span.start + 1 : 0;
    const removed = removedCount > 0 ? oldLines.slice(span.start, span.end + 1) : [];
    const inserted = newLines.slice(span.start + offset, span.start + offset + span.replacementCount);
    if (removed.length > 0 && inserted.length > 0) {
      const carried = span.carry;
      const payload = carried === undefined ? inserted : inserted.filter((_, index) => index !== carried);
      const payloadText = payload.join("\n");
      const references: ReferenceRow[] = carried === undefined
        ? removed.map((line, index) => ({ line, index: span.start + index }))
        : referenceRows(oldLines, span.start, span.end);
      const missing = new Map<string, ReferenceRow>();
      for (const reference of references) {
        for (const char of reference.line) {
          if (missing.has(char) || !isFidelitySensitiveChar(char) || payloadText.includes(char)) continue;
          missing.set(char, reference);
        }
      }
      if (carried === undefined && removed.length === 1 && inserted.length === 1) {
        const chars = [...missing.keys()];
        if (isDeliberateCharFix(removed[0]!, inserted[0]!, chars)) missing.clear();
      }
      for (const [char, reference] of missing) {
        if (seen.has(char) || hints.length >= MAX_MISSING_HINTS) continue;
        seen.add(char);
        hints.push(hiddenCharHint(char, reference, originalHashes?.[reference.index]));
      }
    }
    offset += span.replacementCount - removedCount;
  }
  return hints;
}
