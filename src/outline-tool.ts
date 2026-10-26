import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { buildFileOutline } from "./outline";
import { MAX_HASH_LINES } from "./hashline";
import { loadFileKindAndText } from "./file-kind";
import { readNormFile, safeSnapId } from "./file-reader";
import { serveRows } from "./served";
import { toCwd, toDisplayPath } from "./paths";
import { formatAnchorReclaimNotice, takeReclaimedPaths, withAnchorSession } from "./anchor-registry";
import { valAccess, valKind } from "./validation";
import { abortIf, isRec, makePrepareArguments, rejectUnknownFields, splitLines } from "./utils";
import { loadP, loadGuidelines } from "./prompts";
import { DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common";
import { anchoredLine, outlineResultSchema, withStructuredErrors, type OutlineStructured } from "./structured";

const OUTLINE_DEFAULT_DEPTH = 2;
export const OUTLINE_MAX_DEPTH = 10;

export interface OutlineDetails {
	truncated?: boolean;
	complete?: boolean;
	snapshotId?: string;
	metrics?: { rows: number; truncated: boolean };
}

function buildOutlineToolSchema(codemode: boolean) {
	return Type.Object({
		path: Type.String({
			description: "Path to the file to outline (relative or absolute).",
		}),
		depth: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: OUTLINE_MAX_DEPTH,
				description: `Nesting depth to show: 0 lists top-level symbols only, 1 adds their members (default 2, maximum ${OUTLINE_MAX_DEPTH}).`,
			}),
		),
		...(codemode
			? {
				anchors: Type.Optional(
					Type.Boolean({
						description: "Return { text, lines, notices } with editable anchors instead of the plain outline text to a codemode script.",
					}),
				),
			}
			: {}),
	}, { additionalProperties: true });
}

export function outlineDepth(value: unknown): number {
	if (value === undefined) return OUTLINE_DEFAULT_DEPTH;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > OUTLINE_MAX_DEPTH) {
		throw new Error(`[E_BAD_SHAPE] Outline request field "depth" must be an integer from 0 to ${OUTLINE_MAX_DEPTH}.`);
	}
	return value;
}

export interface OutlineReq {
	path: string;
	depth: number;
	anchors: boolean;
}

const OUTLINE_KEYS = new Set(["path", "depth", "anchors"]);

export function normOutlineReq(request: unknown, allowAnchors = false): OutlineReq {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Outline request must be an object.");
	}
	rejectUnknownFields(request, OUTLINE_KEYS, "Outline request");
	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error('[E_BAD_SHAPE] Outline request requires a non-empty "path" string.');
	}
	if (request.anchors !== undefined) {
		if (typeof request.anchors !== "boolean") {
			throw new Error('[E_BAD_SHAPE] Outline request field "anchors" must be a boolean when provided.');
		}
		if (!allowAnchors) {
			throw new Error('[E_BAD_SHAPE] Outline request field "anchors" is only valid in a codemode session.');
		}
	}
	return { path: request.path, depth: outlineDepth(request.depth), anchors: request.anchors === true };
}

export function regOutline(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
	const prompted = {
		description: loadP("../tool-prompts/outline.md"),
		snippet: loadP("../tool-prompts/outline-snippet.md"),
		guidelines: loadGuidelines("../tool-prompts/outline-guidelines.md").map((guideline) => guideline.text),
	};
	if (flags.codemode) prompted.guidelines.push("`outline`: a codemode script receives the served outline text; pass `anchors: true` to receive `{ text, lines, notices }` with editable anchors.");
	pi.registerTool({
		name: "outline",
		defaultActive: false,
		label: "Outline",
		description: prompted.description,
		promptSnippet: prompted.snippet,
		promptGuidelines: prompted.guidelines,
		prepareArguments: makePrepareArguments(),
		parameters: buildOutlineToolSchema(flags.codemode),
		outputSchema: outlineResultSchema,
		executionMode: "sequential",
		renderCall(args: any, theme: any, context: any) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const path = typeof args?.path === "string" && args.path.length > 0 ? args.path : "...";
			text.setText(`${theme.fg("toolTitle", theme.bold("outline"))} ${theme.fg("accent", path)}`);
			return text;
		},
		renderResult(result, { isPartial, expanded }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Outlining..."), 0, 0);
			const raw = (result.content?.[0] as { text?: string } | undefined)?.text;
			if (typeof raw !== "string") return new Text("", 0, 0);
			if (context.isError) return new Text(theme.fg("error", raw), 0, 0);
			if (expanded !== true && context.expanded !== true) return new Text("", 0, 0);
			return new Text(raw, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return withStructuredErrors(signal, {}, () => withAnchorSession(ctx, async () => {
				const request = normOutlineReq(params, flags.codemode);
				const rawPath = request.path;
				const depth = request.depth;
				const absolutePath = toCwd(rawPath, ctx.cwd);

				abortIf(signal);
				await valAccess(absolutePath, rawPath);

				abortIf(signal);
				const file = await loadFileKindAndText(absolutePath, { maxLines: MAX_HASH_LINES, displayPath: rawPath });
				valKind(file, rawPath);
				const { normalized, fileHashes, absolutePath: resolvedPath, hadUtf8DecodeErrors } = await readNormFile(
					rawPath,
					ctx.cwd,
					{ signal, preloadedFile: file, maxLines: MAX_HASH_LINES },
				);

				abortIf(signal);
				const displayPath = toDisplayPath(ctx.cwd, resolvedPath, rawPath);
				const fileLines = splitLines(normalized);
				const section = await buildFileOutline({
					displayPath,
					content: normalized,
					hashes: fileHashes,
					maxDepth: depth,
				});
				serveRows(resolvedPath, fileHashes, fileLines, section.servedHashes);

				const snapshotId = await safeSnapId(absolutePath, "outline");
				const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
				const notices = [
					hadUtf8DecodeErrors ? "[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]" : undefined,
					reclaimNotice,
				].filter((part): part is string => part !== undefined);
				const text = [section.text, ...notices].join("\n\n");
				const served = new Set(section.servedHashes);
				const structuredContent: OutlineStructured = {
					ok: true,
					kind: "outline",
					path: rawPath,
					text: section.text,
					totalLines: normalized.length === 0 ? 0 : fileLines.length,
					depth,
					lines: section.rows.filter((row) => served.has(row.anchor)).map((row) => anchoredLine(row.line, row.text, row.anchor)),
					truncated: section.truncated,
					complete: section.complete,
					notices,
				};
				const anchorsRequested = request.anchors;
				const details: OutlineDetails = {
					truncated: section.truncated,
					complete: section.complete,
					snapshotId,
					metrics: { rows: section.rows.length, truncated: section.truncated },
				};
				return {
					content: [{ type: "text", text }],
					details,
					structuredContent: flags.codemode && !anchorsRequested ? text : structuredContent,
				};
			}));
		},
	});
}
