import { splitLines } from "./utils";
import { HASH_LEN, HASH_SEP, canon } from "./hashline";
import type { DiffSpan } from "./replace-diff";

const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const LOOKALIKE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;
const LOOKALIKE_DASH_RE = /[\u2010-\u2015\u2212]/u;
const LOOKALIKE_QUOTE_RE = /[\u2018\u2019\u201c\u201d]/u;
const LOOKALIKE_PUNCT_RE = /[\u3002\uff0e\uff61]/u;
const MAX_FIDELITY_HINTS = 3;
const INSERT_REFERENCE_WINDOW = 5;
const SIMILARITY_RUN = 10;
const INSERT_GRAM_BUDGET = 200_000;
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
  "\u3002": ".",
  "\uff0e": ".",
  "\uff61": ".",
};

export function isFidelitySensitiveChar(char: string): boolean {
  return INVISIBLE_RE.test(char) || LOOKALIKE_SPACE_RE.test(char) || LOOKALIKE_DASH_RE.test(char) || LOOKALIKE_QUOTE_RE.test(char) || LOOKALIKE_PUNCT_RE.test(char);
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
  return INVISIBLE_RE.test(line) || LOOKALIKE_SPACE_RE.test(line) || LOOKALIKE_DASH_RE.test(line) || LOOKALIKE_QUOTE_RE.test(line) || LOOKALIKE_PUNCT_RE.test(line);
}

function normalizeSensitiveChars(line: string): string {
  let normalized = "";
  for (const char of line) normalized += isFidelitySensitiveChar(char) ? "?" : char;
  return normalized;
}

function isLookalikeSwap(oldChar: string, newChar: string): boolean {
  if (isFidelitySensitiveChar(oldChar) && isFidelitySensitiveChar(newChar)) return true;
  return LOOKALIKE_SUBSTITUTES[newChar] === oldChar;
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
    if (!isLookalikeSwap(oldChar, newChar)) return undefined;
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

function leadingWhitespace(line: string): string {
  const trimmed = line.trimStart();
  return line.slice(0, line.length - trimmed.length);
}

function indentMismatchHint(payloadLine: string, reference: ReferenceRow, anchor: string | undefined): string | undefined {
  const payloadIndent = leadingWhitespace(payloadLine);
  const referenceIndent = leadingWhitespace(reference.line);
  if (payloadIndent.length >= referenceIndent.length || !referenceIndent.startsWith(payloadIndent)) return undefined;
  const grams = gramSet([payloadLine], SIMILARITY_RUN);
  if (grams === undefined || !sharesRun(reference.line, grams, SIMILARITY_RUN)) return undefined;
  const label = anchor === undefined ? "the nearby line" : `${anchor}${HASH_SEP}`;
  return [
    `[H_INDENT_MISMATCH] The new line is missing leading whitespace that ${label} has.`,
    renderReferenceRow(reference, anchor),
    `${REFERENCE_INDENT}└ expected ${referenceIndent.length} leading whitespace character(s) at col 1; the new line has ${payloadIndent.length}.`,
  ].join("\n");
}

function referenceRows(lines: string[], start: number, end: number): ReferenceRow[] {
  const from = Math.max(0, start - INSERT_REFERENCE_WINDOW);
  const to = Math.min(lines.length - 1, end + INSERT_REFERENCE_WINDOW);
  const rows: ReferenceRow[] = [];
  for (let index = from; index <= to; index++) rows.push({ line: lines[index]!, index });
  return rows;
}

function gramSet(lines: readonly string[], size: number): Set<string> | undefined {
  const grams = new Set<string>();
  let total = 0;
  for (const line of lines) {
    total += line.length;
    if (total > INSERT_GRAM_BUDGET) return undefined;
    const chars = [...line];
    for (let index = 0; index + size <= chars.length; index += 1) grams.add(chars.slice(index, index + size).join(""));
  }
  return grams;
}

function sharesRun(line: string, grams: Set<string>, size: number): boolean {
  const chars = [...line];
  for (let index = 0; index + size <= chars.length; index += 1) {
    if (grams.has(chars.slice(index, index + size).join(""))) return true;
  }
  return false;
}

const LITERAL_ESCAPE_HINT_PREFIX = "[H_LITERAL_ESCAPE] ";
const LITERAL_ESCAPE_TEXT_RE = /contains the literal escaped text "(.*)"$/;
const MAX_LITERAL_ESCAPE_ROWS = 3;

function literalEscapeColumn(line: string, escape: string): number {
  const index = line.indexOf(escape);
  return index < 0 ? 1 : [...line.slice(0, index)].length + 1;
}

function literalEscapeHintRows(
  resultContent: string,
  spans: readonly DiffSpan[],
  resultHashes: readonly string[],
  escape: string,
): ReferenceRow[] {
  const newLines = splitLines(resultContent);
  const rows: ReferenceRow[] = [];
  let offset = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const removedCount = span.end >= span.start ? span.end - span.start + 1 : 0;
    const inserted = newLines.slice(span.start + offset, span.start + offset + span.replacementCount);
    for (let index = 0; index < inserted.length; index += 1) {
      if (span.carry === index) continue;
      const line = inserted[index]!;
      if (!line.includes(escape)) continue;
      const resultIndex = span.start + offset + index;
      if (resultIndex >= 0 && resultIndex < resultHashes.length) rows.push({ line, index: resultIndex });
    }
    offset += span.replacementCount - removedCount;
  }
  return rows;
}

export function annotateLiteralEscapeHints(
  hints: string[],
  resultContent: string,
  spans: readonly DiffSpan[] | undefined,
  resultHashes: readonly string[],
): string[] {
  if (spans === undefined || spans.length === 0) return hints;
  return hints.map((hint) => {
    if (!hint.startsWith(LITERAL_ESCAPE_HINT_PREFIX)) return hint;
    const escape = LITERAL_ESCAPE_TEXT_RE.exec(hint)?.[1];
    if (escape === undefined || escape.length === 0) return hint;
    const rows = literalEscapeHintRows(resultContent, spans, resultHashes, escape);
    if (rows.length === 0) return hint;
    const shown = rows.slice(0, MAX_LITERAL_ESCAPE_ROWS);
    const lines = shown.map((row) => `${renderReferenceRow(row, resultHashes[row.index])}\n${REFERENCE_INDENT}└ "${escape}" at col ${literalEscapeColumn(row.line, escape)}`);
    if (rows.length > shown.length) lines.push(`${REFERENCE_INDENT}... (+${rows.length - shown.length} more line(s))`);
    return `${hint}\n${lines.join("\n")}`;
  });
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
    if (removed.length > 0 && inserted.length > 0) {
      const carried = span.carry;
      const payload = carried === undefined ? inserted : inserted.filter((_, index) => index !== carried);
      const payloadText = payload.join("\n");
      const references: ReferenceRow[] = carried === undefined
        ? removed.map((line, index) => ({ line, index: span.start + index }))
        : referenceRows(oldLines, span.start, span.end);
      const insertGate = carried === undefined ? null : (gramSet(payload, SIMILARITY_RUN) ?? new Set<string>());
      const swapKeys = new Set<string>();
      const swaps: SwapCandidate[] = [];
      let candidates: Map<string, IndexedLine[]> | undefined;
      for (const line of payload) {
        if (!containsSensitiveChar(line)) continue;
        candidates ??= sensitiveLines();
        const matches = [...(candidates.get(normalizeSensitiveChars(line)) ?? []), ...references];
        const candidate = swappedCandidate(line, matches, span.start, span.end);
        if (candidate === undefined) continue;
        const key = `${candidate.reference.index}:${candidate.swapped.oldChar}`;
        if (swapKeys.has(key)) continue;
        swapKeys.add(key);
        swaps.push(candidate);
      }
      const missing = new Map<string, ReferenceRow>();
      for (const reference of references) {
        if (insertGate !== null && !sharesRun(reference.line, insertGate, SIMILARITY_RUN)) continue;
        for (const char of reference.line) {
          if (missing.has(char) || !isFidelitySensitiveChar(char) || payloadText.includes(char)) continue;
          if (swapKeys.has(`${reference.index}:${char}`)) continue;
          missing.set(char, reference);
        }
      }
      if (carried === undefined && removed.length === 1 && inserted.length === 1) {
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
      const indentPairs: Array<{ payloadLine: string; reference: ReferenceRow }> = carried !== undefined
        ? payload.map((payloadLine) => ({ payloadLine, reference: { line: oldLines[span.start] ?? "", index: span.start } }))
        : removed.length === payload.length
          ? payload.map((payloadLine, index) => ({ payloadLine, reference: { line: removed[index]!, index: span.start + index } }))
          : [];
      for (const { payloadLine, reference } of indentPairs) {
        if (hints.length >= MAX_FIDELITY_HINTS) break;
        const indentHint = indentMismatchHint(payloadLine, reference, originalHashes?.[reference.index]);
        if (indentHint === undefined) continue;
        const key = `indent:${reference.index}:${payloadLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push(indentHint);
      }
      if (carried === undefined && removed.length === inserted.length) {
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
