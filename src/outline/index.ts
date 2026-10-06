import { visLines } from "../utils";
import { loadOutlineParser } from "./parsers";
import { renderPreviewOutline, renderSymbolOutline, type OutlineRender } from "./render";

export interface FileOutlineInput {
	displayPath: string;
	content: string;
	hashes: string[];
	maxRows?: number;
	maxDepth?: number;
	maxBytes?: number;
	previewHeadLines?: number;
	previewTailLines?: number;
}

export async function buildFileOutline(input: FileOutlineInput): Promise<OutlineRender> {
	const lines = visLines(input.content);
	const parser = await loadOutlineParser();
	const parsed = parser === undefined ? undefined : await parser.parse(input.displayPath, input.content);
	if (parsed !== undefined && parsed.symbols.length > 0) {
		return renderSymbolOutline({
			displayPath: input.displayPath,
			languageName: parsed.languageName,
			totalLines: lines.length,
			hashes: input.hashes,
			symbols: parsed.symbols,
			...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
			...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
			...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
		});
	}
	return renderPreviewOutline({
		displayPath: input.displayPath,
		lines,
		hashes: input.hashes,
		...(input.previewHeadLines !== undefined ? { headLines: input.previewHeadLines } : {}),
		...(input.previewTailLines !== undefined ? { tailLines: input.previewTailLines } : {}),
		...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
	});
}

export { loadOutlineParser } from "./parsers";
export { renderPreviewOutline, renderSymbolOutline } from "./render";
export type { OutlineParse, OutlineParser, OutlineSymbol } from "./parsers";
export type { OutlineRender, OutlineRow } from "./render";
