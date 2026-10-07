import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createReadTool,
	createReadToolDefinition,
	formatSize,
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadFileKindAndText } from "./file-kind";
import { MAX_OVERSIZED_WARNING_LINES } from "./constants";
import { readNormFile, safeSnapId } from "./file-reader";
import { lineHashes, fmtRegion, fmtRow, HASH_SEP, MAX_HASH_LINES, parseHashRef, resolveAnchorLine, AnchorMismatchError } from "./hashline";
import { toCwd } from "./paths";
import { abortIf, isRec, makePrepareArguments, numberedRead, visLines, splitLines } from "./utils";
import { loadP, loadGuide } from "./prompts";
import { withReadPrompts, DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common";
import { valAccess } from "./validation";
import { withAnchorSession, adoptAnchors, ownerOf, ownersDifferingOnlyByCase, formatAnchorReclaimNotice, takeReclaimedPaths } from "./anchor-registry";
import { serveRows } from "./served";
import { snapshotCache } from "./hash-store/cache";
import { Text } from "@earendil-works/pi-tui";
import { anchoredLine, readResultSchema, withStructuredErrors, type AnchoredLine, type ReadResult } from "./structured";
const R_DESC = loadP("../tool-prompts/read.md");
const R_SNIPPET = loadP("../tool-prompts/read-snippet.md");
function readGuide(): string[] {
  return loadGuide("../tool-prompts/read-guidelines.md");
}
function normPosInt(
	value: number | undefined,
	name: "offset" | "limit",
): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`);
	}

	return value;
}

export function formatPaginationHint(
	startLine: number,
	endLine: number,
	totalLines: number,
	nextOffset: number,
	byteLimit?: number,
): string {
	const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
	return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}

export async function fmtReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes?: string[],
	path?: string,
	maxLineBytes = DEFAULT_MAX_BYTES,
	maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{ text: string; truncation?: TruncationResult; nextOffset?: number; servedHashes: string[]; anchoredLines: AnchoredLine[]; totalLines: number; startLine: number; blockedByLongLine: boolean }> {
	const allLines = visLines(text);
	const totalLines = allLines.length;
	const startLine = normPosInt(options.offset, "offset") ?? 1;
	if (totalLines === 0) {
		if (startLine === 1) {
      const allHashes = precomputedHashes ?? await (path ? lineHashes(text, path) : lineHashes(text));
      const emptyLineHash = allHashes[0] ?? "";
      return {
				text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use replace to insert content.]`,
				servedHashes: emptyLineHash ? [emptyLineHash] : [],
				anchoredLines: emptyLineHash ? [anchoredLine(1, "", emptyLineHash)] : [],
				totalLines: 0,
				startLine,
				blockedByLongLine: false,
			};
		}
		return {
			text: `Offset ${startLine} is beyond end of file (0 lines). Use replace to insert content.`,
			servedHashes: [],
			anchoredLines: [],
			totalLines: 0,
			startLine,
			blockedByLongLine: false,
		};
	}
	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
			servedHashes: [],
			anchoredLines: [],
			totalLines,
			startLine,
			blockedByLongLine: false,
		};
	}

	const limit = normPosInt(options.limit, "limit");
	const endIdx = limit
		? Math.min(startLine - 1 + limit, totalLines)
		: totalLines;
	const selected = allLines.slice(startLine - 1, endIdx);
	const allHashes = precomputedHashes ?? await (path ? lineHashes(text, path) : lineHashes(text));
	const selectedHashes = allHashes.slice(startLine - 1, endIdx);
	const formatted = fmtRegion(selectedHashes, selected);
	const maxBytes = maxLineBytes;
	const rowSizes = selected.map((line, index) => ({
		lineNumber: startLine + index,
		bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
	}));
	if (rowSizes.some((row) => row.bytes > maxBytes)) {
		const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
		const rows = rowSizes.map((row, index) =>
			row.bytes > maxBytes
				? fmtRow(selectedHashes[index]!, `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`)
				: fmtRegion([selectedHashes[index]!], [selected[index]!]),
		);
		const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
		const shownRowCount = skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
		const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
		const servedHashes: string[] = [];
		for (let index = 0; index < Math.min(shownRowCount, rows.length); index++) {
			servedHashes.push(selectedHashes[index]!);
		}
		const completeRowCount = skippedTruncation.lastLinePartial ? Math.max(0, shownRowCount - 1) : shownRowCount;
		const anchoredLines: AnchoredLine[] = [];
		for (let index = 0; index < Math.min(completeRowCount, rows.length); index++) {
			const anchor = selectedHashes[index]!;
			anchoredLines.push(anchoredLine(startLine + index, rows[index]!.slice(anchor.length + HASH_SEP.length), anchor));
		}
		const listed = oversized.slice(0, MAX_OVERSIZED_WARNING_LINES);
		const hiddenCount = oversized.length - listed.length;
		const lineLabel = oversized.length === 1
			? `Line ${oversized[0]!.lineNumber}`
			: `Lines ${listed.map((row) => row.lineNumber).join(', ')}${hiddenCount > 0 ? `, ... (+${hiddenCount} more)` : ''}`;
		const verb = oversized.length === 1 ? 'exceeds' : 'exceed';
		const addresses = listed.map((row) => `${row.lineNumber}p`).join(';');
		const moreHint = hiddenCount > 0
			? ` ${hiddenCount} more oversized line(s). Use read with offset to inspect them.`
			: '';
		const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}${moreHint}]`;
		let preview = skippedTruncation.content;
		let nextOffset: number | undefined;
		if (shownRowCount > 0 && (skippedTruncation.truncated || lastShownLine < totalLines)) {
			nextOffset = lastShownLine + 1;
			preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.truncated ? skippedTruncation.maxBytes : undefined)}`;
		} else {
			preview += `\n\n${warning}`;
		}
		return {
			text: preview,
			truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
			...(nextOffset !== undefined ? { nextOffset } : {}),
			servedHashes,
			anchoredLines,
			totalLines,
			startLine,
			blockedByLongLine: oversized.some((row) => row.lineNumber <= lastShownLine),
		};
	}

	const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });

	let preview = truncation.content;
	let nextOffset: number | undefined;
	const shownCount = truncation.content === "" ? 0 : truncation.content.split("\n").length;
	const servedHashes = selectedHashes.slice(0, shownCount);
	const completeRowCount = truncation.lastLinePartial ? Math.max(0, shownCount - 1) : shownCount;
	const anchoredLines = selected.slice(0, completeRowCount).map((line, index) => anchoredLine(startLine + index, line, selectedHashes[index]!));
	if (truncation.truncated) {
		const endLineDisplay = startLine + truncation.outputLines - 1;
		nextOffset = endLineDisplay + 1;
		if (truncation.truncatedBy === "lines") {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
		} else {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
		}
	} else if (endIdx < totalLines) {
		nextOffset = endIdx + 1;
		preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
	}

	return {
		text: preview,
		truncation: truncation.truncated ? truncation : undefined,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		servedHashes,
		anchoredLines,
		totalLines,
		startLine,
		blockedByLongLine: false,
	};
}

export function resolveReadOffset(
	offset: number | string | undefined,
	fileLines: string[],
	fileHashes: string[],
	resolvedPath: string,
): number | undefined {
	if (offset === undefined || typeof offset === "number") return offset;
	if (/^\d+$/.test(offset)) return Number(offset);
	const ref = parseHashRef(offset);
	const owner = ownerOf(ref.hash);
	if (owner === undefined) {
		const folded = ownersDifferingOnlyByCase(ref.hash);
		const hint = folded.length > 0 ? ` Anchors are case-sensitive; ${folded.map((match) => `"${match.anchor}"`).join(", ")} differs only in case.` : "";
		throw new Error(`[E_STALE_ANCHOR] "${ref.hash}" is not owned in this session.${hint} Call read() on ${resolvedPath} first.`);
	}
	if (owner.path !== resolvedPath) {
		throw new Error(`[E_STALE_ANCHOR] "${ref.hash}" is owned by ${owner.path}. Call read() on ${resolvedPath} for fresh anchors.`);
	}
	try {
		return resolveAnchorLine(ref, fileLines, fileHashes, resolvedPath);
	} catch (error) {
		if (error instanceof AnchorMismatchError) adoptAnchors(resolvedPath, error.feedbackMap);
		throw error;
	}
}

const builtinReadRenderCall = createReadToolDefinition(process.cwd()).renderCall as
	(args: unknown, theme: any, context: any) => Text;

function normalizeReadCallArgs(args: unknown): unknown {
	if (!isRec(args)) return args;
	const normalized: Record<string, unknown> = { ...args };
	for (const key of ["offset", "limit"]) {
		const value = normalized[key];
		if (typeof value === "string" && /^\d+$/.test(value)) normalized[key] = Number(value);
	}
	return normalized;
}

function anchorRefOf(args: unknown): { anchor: string; limit: number | undefined; path: string | undefined } | undefined {
	if (!isRec(args)) return undefined;
	const { offset, limit, path } = args;
	if (typeof offset !== "string" || offset.length === 0 || /^\d+$/.test(offset)) return undefined;
	const validLimit = typeof limit === "number" && Number.isInteger(limit) && limit >= 1 ? limit : undefined;
	if (limit !== undefined && validLimit === undefined) return undefined;
	return { anchor: offset, limit: validLimit, path: typeof path === "string" ? path : undefined };
}

function cachedHashes(path: string): string[] | undefined {
	const cached = snapshotCache.get(path);
	if (cached !== undefined) return cached.hashes;
	try {
		return snapshotCache.get(realpathSync(path))?.hashes;
	} catch {
		return undefined;
	}
}

function anchorLineOf(anchor: string, path: string | undefined, cwd: unknown): number | undefined {
	if (path === undefined || typeof cwd !== "string") return undefined;
	const hashes = cachedHashes(toCwd(path, cwd));
	if (hashes === undefined) return undefined;
	const index = hashes.indexOf(anchor);
	return index < 0 ? undefined : index + 1;
}

function renderReadCall(args: unknown, theme: any, context: any): Text {
	const normalized = normalizeReadCallArgs(args);
	const rendered = builtinReadRenderCall(normalized, theme, context);
	const ref = anchorRefOf(normalized);
	if (ref === undefined) return rendered;
	const marker = `:${ref.anchor}`;
	const text = (rendered as unknown as { text: string }).text;
	const index = text.lastIndexOf(marker);
	if (index < 0) return rendered;
	const line = anchorLineOf(ref.anchor, ref.path, context?.cwd);
	if (line === undefined && ref.limit === undefined) return rendered;
	const lineLabel = line === undefined ? "" : ` (${line})`;
	const limitLabel = ref.limit === undefined ? "" : ` +${ref.limit}`;
	const suffix = theme.fg("warning", `${lineLabel}${limitLabel}`);
	rendered.setText(`${text.slice(0, index + marker.length)}${suffix}${text.slice(index + marker.length)}`);
	return rendered;
}

export function regRead(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  const prompted = withReadPrompts({ description: R_DESC, snippet: R_SNIPPET, guidelines: readGuide() }, flags);
  pi.registerTool({
    name: "read",
    label: "Read",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
		prepareArguments: makePrepareArguments(),
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to read (relative or absolute)",
			}),
			offset: Type.Optional(
				Type.Union([
					Type.Integer({
						minimum: 1,
						description: "Line number to start reading from (1-indexed)",
					}),
					Type.String({
						description: "4-char anchor of a served line to start reading from",
					}),
				], { description: "Line number (1-indexed) or a served anchor to start reading from" }),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Maximum number of lines to read from offset",
				}),
			),
		}),
		outputSchema: readResultSchema,
		executionMode: "sequential",
		renderCall: renderReadCall,
		renderResult(result, { isPartial, expanded }, theme, context) {
			if (isPartial) return new Text((theme as unknown as { fg: (a:string,b:string)=>string }).fg("warning", "Reading..."), 0, 0);
			const raw = (result.content?.[0] as { text?: string } | undefined)?.text;
			if (typeof raw !== "string") return new Text("", 0, 0);
			if ((context as unknown as { isError?: boolean }).isError) return new Text((theme as unknown as { fg: (a:string,b:string)=>string }).fg("error", raw), 0, 0);
			const isExpanded = expanded === true || (context as unknown as { expanded?: boolean }).expanded === true;
			if (!isExpanded) return new Text("", 0, 0);
			const details = (result as unknown as { details?: { offset?: number } }).details;
			const off = details?.offset ?? (context as unknown as { args?: { offset?: number } }).args?.offset ?? 1;
			return new Text(numberedRead(raw, off), 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return withStructuredErrors(signal, {}, () => withAnchorSession(ctx, async () => {
				const rawPath = params.path;
				const absolutePath = toCwd(rawPath, ctx.cwd);

				abortIf(signal);
				await valAccess(absolutePath, rawPath);

				abortIf(signal);
				const file = await loadFileKindAndText(absolutePath, { maxLines: MAX_HASH_LINES, displayPath: rawPath });
				if (file.kind === "image") {
					const builtinRead = createReadTool(ctx.cwd);
					const executeBuiltinRead = builtinRead.execute as unknown as (
						toolCallId: string,
						input: typeof params,
						abortSignal: typeof signal,
						onUpdate: typeof _onUpdate,
						context: typeof ctx,
					) => ReturnType<typeof builtinRead.execute>;
					const imageResult = await executeBuiltinRead(_toolCallId, params, signal, _onUpdate, ctx);
					const imageStructured: ReadResult = { ok: true, kind: "image", path: rawPath, mimeType: file.mimeType };
					return { ...imageResult, structuredContent: imageStructured };
				}
	      const { normalized, fileHashes, hadUtf8DecodeErrors, absolutePath: resolvedPath } = await readNormFile(
	        rawPath, ctx.cwd, { signal, preloadedFile: file, maxLines: MAX_HASH_LINES },
	      );
				const fileLines = splitLines(normalized);
				const offset = resolveReadOffset(params.offset, fileLines, fileHashes, resolvedPath);
				const preview = await fmtReadPreview(
					normalized,
					{ offset, limit: params.limit },
					fileHashes,
					resolvedPath,
				);
				serveRows(resolvedPath, fileHashes, fileLines, preview.servedHashes);
				const snapshotId = await safeSnapId(absolutePath, "read");
				const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
				const previewText = [
					preview.text,
					hadUtf8DecodeErrors ? "[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]" : undefined,
					reclaimNotice,
				].filter((part): part is string => part !== undefined).join("\n\n");

				const structuredContent: ReadResult = {
					ok: true,
					kind: "read",
					path: rawPath,
					text: previewText,
					lines: preview.anchoredLines,
					totalLines: preview.totalLines,
					startLine: preview.startLine,
					nextOffset: preview.nextOffset ?? null,
					truncated: preview.truncation !== undefined,
					blockedByLongLine: preview.blockedByLongLine,
					hadUtf8DecodeErrors,
				};
				return {
					content: [{ type: "text", text: previewText }],
					details: {
						truncation: preview.truncation,
						snapshotId,
						offset: preview.startLine,
						...(preview.nextOffset !== undefined
							? { nextOffset: preview.nextOffset }
							: {}),
						metrics: {
							truncated: preview.truncation !== undefined,
							...(preview.nextOffset !== undefined
								? { next_offset: preview.nextOffset }
								: {}),
						},
					},
					structuredContent,
				};
			}));
		},
	});
}
