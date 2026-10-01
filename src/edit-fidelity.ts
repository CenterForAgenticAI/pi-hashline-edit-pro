import { splitLines } from "./utils";
import { HASH_LEN, HASH_SEP, canon } from "./hashline";
import type { DiffSpan } from "./replace-diff";

const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const LOOKALIKE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;
const LOOKALIKE_DASH_RE = /[\u2010-\u2015\u2212]/u;
const LOOKALIKE_QUOTE_RE = /[\u2018\u2019\u201c\u201d]/u;
const MAX_FIDELITY_HINTS = 3;
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

interface IndexedLine {
  line: string;
  index: number;
}

interface SwappedChar {
  oldChar: string;
  newChar: string;
  column: number;
}

interface SwapCandidate {
  reference: ReferenceRow;
  swapped: SwappedChar;
}

function containsSensitiveChar(line: string): boolean {
  return INVISIBLE_RE.test(line) || LOOKALIKE_SPACE_RE.test(line) || LOOKALIKE_DASH_RE.test(line) || LOOKALIKE_QUOTE_RE.test(line);
}

function normalizeSensitiveChars(line: string): string {
  let normalized = "";
  for (const char of line) normalized += isFidelitySensitiveChar(char) ? "?" : char;
  return normalized;
}

function swappedCharPair(oldLine: string, newLine: string): SwappedChar | undefined {
  const oldChars = [...oldLine];
  const newChars = [...newLine];
  if (oldChars.length !== newChars.length) return undefined;
  let swapped: SwappedChar | undefined;
  for (let index = 0; index < oldChars.length; index += 1) {
    const oldChar = oldChars[index]!;
    const newChar = newChars[index]!;
    if (oldChar === newChar) continue;
    if (!isFidelitySensitiveChar(oldChar) || !isFidelitySensitiveChar(newChar)) return undefined;
    swapped ??= { oldChar, newChar, column: index + 1 };
  }
  return swapped;
}

function swappedCandidate(line: string, matches: IndexedLine[], spanStart: number, spanEnd: number): SwapCandidate | undefined {
  const candidates: SwapCandidate[] = [];
  for (const match of matches) {
    if (match.line === line) continue;
    const swapped = swappedCharPair(match.line, line);
    if (swapped === undefined) continue;
    candidates.push({ reference: { line: match.line, index: match.index }, swapped });
  }
  return candidates.find((candidate) => candidate.reference.index >= spanStart && candidate.reference.index <= spanEnd) ?? candidates[0];
}

function swappedCharHint(swapped: SwappedChar, reference: ReferenceRow, anchor: string | undefined): string {
  const label = anchor === undefined ? "the replaced line" : `${anchor}${HASH_SEP}`;
  return [
    `[H_UNICODE_SWAPPED] The new text uses ${formatCodePoint(swapped.newChar)} where ${label} uses ${formatCodePoint(swapped.oldChar)}.`,
    renderReferenceRow(reference, anchor),
    `${REFERENCE_INDENT}└ ${formatCodePoint(swapped.oldChar)} at col ${swapped.column} → ${formatCodePoint(swapped.newChar)}`,
  ].join("\n");
}

function trailingWhitespaceHint(oldLine: string, newLine: string, reference: ReferenceRow, anchor: string | undefined): string {
  const oldTrail = oldLine.length - oldLine.trimEnd().length;
  const newTrail = newLine.length - newLine.trimEnd().length;
  const column = newLine.trimEnd().length + 1;
  const label = anchor === undefined ? "the replaced line" : `${anchor}${HASH_SEP}`;
  return [
    `[H_TRAILING_WHITESPACE] The new text differs from ${label} only by trailing whitespace.`,
    renderReferenceRow(reference, anchor),
    `${REFERENCE_INDENT}└ ${newTrail} trailing whitespace character(s) at col ${column}; the replaced line had ${oldTrail}.`,
  ].join("\n");
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
  let sensitiveIndex: Map<string, IndexedLine[]> | undefined;
  const sensitiveLines = (): Map<string, IndexedLine[]> => {
    if (sensitiveIndex === undefined) {
      sensitiveIndex = new Map();
      for (let index = 0; index < oldLines.length; index += 1) {
        const line = oldLines[index]!;
        if (!containsSensitiveChar(line)) continue;
        const key = normalizeSensitiveChars(line);
        const list = sensitiveIndex.get(key) ?? [];
        list.push({ line, index });
        sensitiveIndex.set(key, list);
      }
    }
    return sensitiveIndex;
  };
  let offset = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const removedCount = span.end >= span.start ? span.end - span.start + 1 : 0;
    const removed = removedCount > 0 ? oldLines.slice(span.start, span.end + 1) : [];
    const inserted = newLines.slice(span.start + offset, span.start + offset + span.replacementCount);
    if (span.carry === undefined && removed.length > 0 && inserted.length > 0) {
      const references: ReferenceRow[] = removed.map((line, index) => ({ line, index: span.start + index }));
      const swapKeys = new Set<string>();
      const swaps: SwapCandidate[] = [];
      let candidates: Map<string, IndexedLine[]> | undefined;
      for (const line of inserted) {
        if (!containsSensitiveChar(line)) continue;
        candidates ??= sensitiveLines();
        const matches = candidates.get(normalizeSensitiveChars(line));
        if (matches === undefined) continue;
        const candidate = swappedCandidate(line, matches, span.start, span.end);
        if (candidate === undefined) continue;
        const key = `${candidate.reference.index}:${candidate.swapped.oldChar}`;
        if (swapKeys.has(key)) continue;
        swapKeys.add(key);
        swaps.push(candidate);
      }
      const payloadText = inserted.join("\n");
      const missing = new Map<string, ReferenceRow>();
      for (const reference of references) {
        for (const char of reference.line) {
          if (missing.has(char) || !isFidelitySensitiveChar(char) || payloadText.includes(char)) continue;
          if (swapKeys.has(`${reference.index}:${char}`)) continue;
          missing.set(char, reference);
        }
      }
      if (removed.length === 1 && inserted.length === 1) {
        const chars = [...missing.keys()];
        if (isDeliberateCharFix(removed[0]!, inserted[0]!, chars)) missing.clear();
      }
      for (const [char, reference] of missing) {
        if (seen.has(char) || hints.length >= MAX_FIDELITY_HINTS) continue;
        seen.add(char);
        hints.push(hiddenCharHint(char, reference, originalHashes?.[reference.index]));
      }
      for (const candidate of swaps) {
        if (hints.length >= MAX_FIDELITY_HINTS) break;
        const key = `swap:${candidate.reference.index}:${candidate.swapped.oldChar}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push(swappedCharHint(candidate.swapped, candidate.reference, originalHashes?.[candidate.reference.index]));
      }
      if (removed.length === inserted.length) {
        for (let index = 0; index < removed.length; index += 1) {
          if (hints.length >= MAX_FIDELITY_HINTS) break;
          const oldLine = removed[index]!;
          const newLine = inserted[index]!;
          if (oldLine === newLine || canon(oldLine) !== canon(newLine)) continue;
          const key = `trailing:${span.start + index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hints.push(trailingWhitespaceHint(oldLine, newLine, { line: newLine, index: span.start + index }, originalHashes?.[span.start + index]));
        }
      }
    }
    offset += span.replacementCount - removedCount;
  }
  return hints;
}
