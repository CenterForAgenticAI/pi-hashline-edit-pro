import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createReadTool,
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
import { lineHashes, fmtRegion, fmtRow, HASH_SEP, MAX_HASH_LINES, parseHashRef, resolveAnchorLine, AnchorMismatchError, type Anchor } from "./hashline";
import { toCwd } from "./paths";
import { abortIf, makePrepareArguments, numberedRead, visLines, splitLines } from "./utils";
import { loadP, loadGuide } from "./prompts";
import { withReadPrompts, DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common";
import { valAccess } from "./validation";
import { withAnchorSession, adoptAnchors, ownerOf, ownersDifferingOnlyByCase, formatAnchorReclaimNotice, takeReclaimedPaths } from "./anchor-registry";
import { serveRows } from "./served";
import { Text } from "@earendil-works/pi-tui";
import { anchoredLine, readResultSchema, withStructuredErrors, type AnchoredLine, type ReadResult } from "./structured";
import { buildFileOutline } from "./outline";
const R_DESC = loadP("../prompts/read.md");
const R_SNIPPET = loadP("../prompts/read-snippet.md");
function readGuide(): string[] {
  return loadGuide("../prompts/read-guidelines.md");
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

const READ_ANCHOR_DEFAULT_AFTER = 20;

export type ReadAddress =
	| { kind: "offset" }
	| { kind: "window"; anchor: Anchor; before: number; after: number }
	| { kind: "range"; from: Anchor; to: Anchor }
	| { kind: "outline" };

export interface ReadAddressInput {
	offset?: number;
	limit?: number;
	anchor?: string;
	before?: number;
	after?: number;
	from?: string;
	to?: string;
	outline?: boolean;
}

function nonNegativeInteger(value: number | undefined, field: string): number {
	if (value === undefined) return 0;
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`[E_BAD_SHAPE] Read request field "${field}" must be a non-negative integer.`);
	}
	return value;
}

export function parseReadAddress(input: ReadAddressInput): ReadAddress {
	const anchored = input.anchor !== undefined;
	const ranged = input.from !== undefined || input.to !== undefined;
	const addressed = input.offset !== undefined || input.limit !== undefined;
	const outlined = input.outline === true;
	if (outlined && (anchored || ranged || addressed || input.before !== undefined || input.after !== undefined)) {
		throw new Error('[E_BAD_SHAPE] Read request field "outline" cannot be combined with offset, limit, anchor, from, to, before, or after.');
	}
	if (outlined) return { kind: "outline" };
	if (anchored && ranged) {
		throw new Error('[E_BAD_SHAPE] Read request cannot combine "anchor" with "from"/"to".');
	}
	if ((anchored || ranged) && addressed) {
		throw new Error('[E_BAD_SHAPE] Read request cannot combine anchor addressing with "offset"/"limit".');
	}
	if (ranged && (input.from === undefined || input.to === undefined)) {
		throw new Error('[E_BAD_SHAPE] Read request requires both "from" and "to" anchors.');
	}
	if (!anchored && (input.before !== undefined || input.after !== undefined)) {
		throw new Error('[E_BAD_SHAPE] Read request fields "before" and "after" require an "anchor".');
	}
	if (anchored) {
		return {
			kind: "window",
			anchor: parseHashRef(input.anchor!),
			before: nonNegativeInteger(input.before, "before"),
			after: input.after === undefined ? READ_ANCHOR_DEFAULT_AFTER : nonNegativeInteger(input.after, "after"),
		};
	}
	if (ranged) {
		return { kind: "range", from: parseHashRef(input.from!), to: parseHashRef(input.to!) };
	}
	return { kind: "offset" };
}

export function resolveReadWindow(
	address: ReadAddress,
	fileLines: string[],
	fileHashes: string[],
	resolvedPath: string,
	offset?: number,
	limit?: number,
): { offset?: number; limit?: number } {
	if (address.kind === "offset" || address.kind === "outline") return { offset, limit };
	const totalLines = fileLines.length;
	let first: number;
	let last: number;
	const resolveRef = (ref: Anchor): number => {
		const owner = ownerOf(ref.hash);
		if (owner === undefined) {
			const folded = ownersDifferingOnlyByCase(ref.hash);
			const hint = folded.length > 0 ? ` Anchors are case-sensitive; ${folded.map((match) => `"${match.anchor}"`).join(", ")} differs only in case.` : "";
			throw new Error(`[E_STALE_ANCHOR] "${ref.hash}" is not owned in this session.${hint} Call read() on ${resolvedPath} first.`);
		}
		if (owner.path !== resolvedPath) {
			throw new Error(`[E_STALE_ANCHOR] "${ref.hash}" is owned by ${owner.path}. Call read() on ${resolvedPath} for fresh anchors.`);
		}
		return resolveAnchorLine(ref, fileLines, fileHashes, resolvedPath);
	};
	try {
		if (address.kind === "window") {
			const line = resolveRef(address.anchor);
			first = Math.max(1, line - address.before);
			last = Math.min(totalLines, line + address.after);
		} else {
			const start = resolveRef(address.from);
			const end = resolveRef(address.to);
			first = Math.min(start, end);
			last = Math.max(start, end);
		}
	} catch (error) {
		if (error instanceof AnchorMismatchError) adoptAnchors(resolvedPath, error.feedbackMap);
		throw error;
	}
	return { offset: first, limit: last - first + 1 };
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
				Type.Integer({
					minimum: 1,
					description: "Line number to start reading from (1-indexed)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Maximum number of lines to read",
				}),
			),
			anchor: Type.Optional(
				Type.String({
					description: "4-char anchor of the line to center the read on; combine with before/after. Cannot be combined with offset/limit/from/to.",
				}),
			),
			before: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Lines to show before the anchor line (default 0)",
				}),
			),
			after: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Lines to show after the anchor line (default 20)",
				}),
			),
			from: Type.Optional(
				Type.String({
					description: "4-char anchor of the first line of an anchored range; requires to. Cannot be combined with offset/limit/anchor.",
				}),
			),
			to: Type.Optional(
				Type.String({
					description: "4-char anchor of the last line of an anchored range; requires from.",
				}),
			),
			outline: Type.Optional(
				Type.Boolean({
					description: "Return an anchor-stamped structural outline of a large file instead of its lines. Cannot be combined with offset/limit/anchor/from/to.",
				}),
			),
		}),
		outputSchema: readResultSchema,
		executionMode: "sequential",
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

				const address = parseReadAddress(params);
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
				const outline = address.kind === "outline" && normalized.length > 0
					? await buildFileOutline({ displayPath: rawPath, content: normalized, hashes: fileHashes })
					: undefined;
				const preview = outline === undefined
					? await fmtReadPreview(
						normalized,
						resolveReadWindow(address, fileLines, fileHashes, resolvedPath, params.offset, params.limit),
						fileHashes,
						resolvedPath,
					)
					: undefined;
				serveRows(resolvedPath, fileHashes, fileLines, outline?.servedHashes ?? preview?.servedHashes ?? []);
				const snapshotId = await safeSnapId(absolutePath, "read");
				const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
				const previewText = [
					outline?.text ?? preview?.text ?? "",
					hadUtf8DecodeErrors ? "[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]" : undefined,
					reclaimNotice,
				].filter((part): part is string => part !== undefined).join("\n\n");

				const anchoredLines = outline !== undefined
					? outline.rows.map((row) => anchoredLine(row.line, row.text, row.anchor))
					: preview?.anchoredLines ?? [];
				const totalLines = outline !== undefined ? fileHashes.length : preview?.totalLines ?? 0;
				const startLine = outline !== undefined ? 1 : preview?.startLine ?? 1;
				const nextOffset = preview?.nextOffset;
				const truncated = outline !== undefined ? outline.truncated : preview?.truncation !== undefined;
				const structuredContent: ReadResult = {
					ok: true,
					kind: "read",
					path: rawPath,
					text: previewText,
					lines: anchoredLines,
					totalLines,
					startLine,
					nextOffset: nextOffset ?? null,
					truncated,
					blockedByLongLine: preview?.blockedByLongLine ?? false,
					hadUtf8DecodeErrors,
				};
				return {
					content: [{ type: "text", text: previewText }],
					details: {
						truncation: preview?.truncation,
						snapshotId,
						offset: startLine,
						...(nextOffset !== undefined
							? { nextOffset }
							: {}),
						metrics: {
							truncated,
							...(nextOffset !== undefined
								? { next_offset: nextOffset }
								: {}),
						},
					},
					structuredContent,
				};
			}));
		},
	});
}
