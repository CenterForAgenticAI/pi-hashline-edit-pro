import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { clipLine } from "../utils";
import type { OutlineSymbol } from "./parsers";

const DEFAULT_MAX_ROWS = 400;
const DEFAULT_MAX_DEPTH = 6;
const MAX_DETAIL_CHARS = 60;
const PREVIEW_HEAD_LINES = 20;
const PREVIEW_TAIL_LINES = 10;
const PREVIEW_LINE_CHARS = 200;

export interface OutlineRow {
	line: number;
	anchor: string;
	text: string;
}

export interface OutlineRender {
	text: string;
	rows: OutlineRow[];
	servedHashes: string[];
	truncated: boolean;
}

export interface SymbolOutlineInput {
	displayPath: string;
	languageName?: string;
	totalLines: number;
	hashes: string[];
	symbols: OutlineSymbol[];
	maxRows?: number;
	maxDepth?: number;
	maxBytes?: number;
}

export interface PreviewOutlineInput {
	displayPath: string;
	lines: string[];
	hashes: string[];
	headLines?: number;
	tailLines?: number;
	maxBytes?: number;
}

function servedHashesOf(rows: OutlineRow[]): string[] {
	return [...new Set(rows.map((row) => row.anchor))];
}

function countSymbols(symbols: OutlineSymbol[]): number {
	let total = 0;
	for (const symbol of symbols) {
		total += 1;
		if (symbol.children) total += countSymbols(symbol.children);
	}
	return total;
}

function symbolLabel(symbol: OutlineSymbol, depth: number): string {
	const indent = "  ".repeat(depth);
	const name = symbol.name.length > 0 ? ` ${symbol.name}` : "";
	const detail = symbol.detail !== undefined && symbol.detail.length > 0
		? ` ${symbol.detail.length > MAX_DETAIL_CHARS ? `${symbol.detail.slice(0, MAX_DETAIL_CHARS - 3)}...` : symbol.detail}`
		: "";
	const children = symbol.children !== undefined && symbol.children.length > 0 ? ` (${symbol.children.length} children)` : "";
	return `${indent}${symbol.type}${name}${detail}${children} [limit ${symbol.endLine - symbol.startLine + 1}]`;
}

export function renderSymbolOutline(input: SymbolOutlineInput): OutlineRender {
	const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
	const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
	const header = `=== ${input.displayPath}${input.languageName !== undefined ? ` (${input.languageName})` : ""} — ${input.totalLines} lines ===`;
	const rows: OutlineRow[] = [];
	const output: string[] = [header];
	let bytes = Buffer.byteLength(header, "utf-8") + 1;
	let truncated = false;

	const addRow = (line: number, text: string): boolean => {
		const anchor = input.hashes[line - 1];
		if (anchor === undefined) return true;
		const rendered = `${anchor}│${text}`;
		const size = Buffer.byteLength(rendered, "utf-8") + 1;
		if (rows.length >= maxRows || bytes + size > maxBytes) {
			truncated = true;
			return false;
		}
		bytes += size;
		output.push(rendered);
		rows.push({ line, anchor, text });
		return true;
	};

	const walk = (symbols: OutlineSymbol[], depth: number): boolean => {
		for (const symbol of symbols) {
			if (!addRow(symbol.startLine, symbolLabel(symbol, depth))) return false;
			const children = symbol.children ?? [];
			if (children.length === 0) continue;
			if (depth >= maxDepth) {
				output.push(`${"  ".repeat(depth + 1)}(${children.length} nested items)`);
				continue;
			}
			if (!walk(children, depth + 1)) return false;
		}
		return true;
	};

	walk(input.symbols, 0);
	if (truncated) {
		output.push(`... (${countSymbols(input.symbols) - rows.length} more symbols)`);
	}
	return { text: output.join("\n"), rows, servedHashes: servedHashesOf(rows), truncated };
}

export function renderPreviewOutline(input: PreviewOutlineInput): OutlineRender {
	const headCount = input.headLines ?? PREVIEW_HEAD_LINES;
	const tailCount = input.tailLines ?? PREVIEW_TAIL_LINES;
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
	const header = `=== ${input.displayPath} — ${input.lines.length} lines ===`;
	const rows: OutlineRow[] = [];
	const output: string[] = [header];
	let bytes = Buffer.byteLength(header, "utf-8") + 1;
	let truncated = false;
	if (input.lines.length === 0) {
		const anchor = input.hashes[0];
		if (anchor !== undefined) {
			output.push(`${anchor}│`, "[File is empty. Use replace to insert content.]");
			rows.push({ line: 1, anchor, text: "" });
		}
		return { text: output.join("\n"), rows, servedHashes: servedHashesOf(rows), truncated: false };
	}

	const addRow = (index: number): boolean => {
		const line = input.lines[index];
		const anchor = input.hashes[index];
		if (line === undefined || anchor === undefined) return true;
		const text = clipLine(line, PREVIEW_LINE_CHARS);
		const rendered = `${anchor}│${text}`;
		const size = Buffer.byteLength(rendered, "utf-8") + 1;
		if (bytes + size > maxBytes) {
			truncated = true;
			return false;
		}
		bytes += size;
		output.push(rendered);
		rows.push({ line: index + 1, anchor, text });
		return true;
	};

	const head = Math.min(headCount, input.lines.length);
	const tail = Math.min(tailCount, input.lines.length - head);
	for (let index = 0; index < head; index += 1) {
		if (!addRow(index)) break;
	}
	if (!truncated && head + tail < input.lines.length) {
		output.push(`... (${input.lines.length - head - tail} more lines)`);
	}
	if (!truncated) {
		for (let index = input.lines.length - tail; index < input.lines.length; index += 1) {
			if (!addRow(index)) break;
		}
	}
	if (truncated) {
		output.push(`... (${input.lines.length - rows.length} more lines)`);
	}
	return { text: output.join("\n"), rows, servedHashes: servedHashesOf(rows), truncated };
}
