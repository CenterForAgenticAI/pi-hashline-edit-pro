import {
	ANCHOR_LEN,
	HASH_CLASS,
} from "./hash";
import { ALPH_RE } from "./alphabet";
import { NEW_CONTENT_NOT_ARRAY_MSG } from "../constants";
import { splitWithEndings } from "../line-endings";
import type { LineEnding } from "../normalize";

const HASH_EXTRACT_RE = new RegExp(HASH_CLASS);

export type Anchor = { hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a 4-character anchor (letters only, e.g. "Hasu").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the anchor alone (e.g. "Hasu"): no line numbers or trailing content.`;
	}
	if (trimmed.includes("│") && trimmed.includes("\n")) {
		const lines = trimmed.split(/\r?\n/);
		const first = lines[0] ?? "";
		const last = lines[lines.length - 1] ?? "";
		const hashRe = HASH_EXTRACT_RE;
		const firstMatch = first.match(hashRe);
		const lastMatch = last.match(hashRe);
		const firstHash = firstMatch?.[0] ?? "Hasu";
		const lastHash = lastMatch?.[0] ?? "Hasu";
		const preview = first.slice(0, 60);
		return `[E_BAD_REF] Invalid anchor — remove_from and remove_to must each be a single bare 4-character anchor (letters only, e.g. "Hasu"), not a block with HASH│content. Received ${lines.length} lines starting "${preview}…" — use only the first hash "${firstHash}" as remove_from and "${lastHash}" as remove_to, and put the new content (without HASH│) in replacement_lines.`;
	}
	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${trimmed}": use only the 4-character anchor, drop everything from "│" onward.`;
	}

	return `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 4-character anchor (letters only, e.g. "Hasu").`;
}

export function parseHashRef(ref: string): Anchor {
	const trimmed = ref.trim();

	if (
		trimmed.length === ANCHOR_LEN &&
		ALPH_RE.test(trimmed)
	) {
		return { hash: trimmed };
	}

	throw new Error(diagRef(ref));
}

const JSON_ENVELOPE_RE = /^\s*\["(.*)"\]\.\s*$/;

function unwrapJsonEnvelope(line: string): string {
  const match = line.match(JSON_ENVELOPE_RE);
  if (!match) return line;
  const withoutDot = line.trim().slice(0, -1);
  try {
    const parsed: unknown = JSON.parse(withoutDot);
    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") {
      return parsed[0];
    }
    return line;
  } catch {
    return match[1]!;
  }
}

export interface ParsedText {
	lines: string[];
	separators: (LineEnding | undefined)[];
}

export function parseTextWithSeparators(edit: string[]): ParsedText {
	if (!Array.isArray(edit) || edit.some((line) => typeof line !== "string")) {
		throw new Error(NEW_CONTENT_NOT_ARRAY_MSG);
	}
	const lines: string[] = [];
	const separators: (LineEnding | undefined)[] = [];
	for (const element of edit) {
		const text = unwrapJsonEnvelope(element);
		const parsed = splitWithEndings(text);
		const lineCount = text.endsWith("\n") || text.endsWith("\r") ? parsed.lines.length - 1 : parsed.lines.length;
		for (let index = 0; index < lineCount; index++) {
			lines.push(parsed.lines[index]!);
			separators.push(parsed.endings[index]!);
		}
	}
	return { lines, separators };
}

export function parseText(edit: string[]): string[] {
	return parseTextWithSeparators(edit).lines;
}

export function parsePayloadText(text: string): ParsedText {
	if (text.length === 0) return { lines: [], separators: [] };
	const parsed = splitWithEndings(text);
	const lineCount = text.endsWith("\n") || text.endsWith("\r") ? parsed.lines.length - 1 : parsed.lines.length;
	return { lines: parsed.lines.slice(0, lineCount), separators: parsed.endings.slice(0, lineCount) };
}
