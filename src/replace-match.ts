import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { execPipeline, noteAnchorError, previewFromPipe, previewError, type ReplaceDetails } from "./replace";
import { commitEdit } from "./commit";
import { readNormFile, type NormFile } from "./file-reader";
import { fmtRegion, MAX_HASH_LINES, parseHashRef, resolveAnchorLine, stripAnchorRow, type Anchor } from "./hashline";
import { withAnchorSession } from "./anchor-registry";
import { loadP, loadGuide } from "./prompts";
import {
  assertReplaceMatchReq,
  buildReplaceMatchToolSchema,
  getReplaceMatchInput,
  type ReplaceMatchReq,
} from "./payload-contract";
import { literalEscapeHints, splitLines } from "./utils";
import { toLF } from "./normalize";
import { MAX_RANGE_STALE_LINES } from "./constants";
import {
  DEFAULT_EDIT_FLAGS,
  editRenderResultWrapper,
  editToolBase,
  queuedEdit,
  resolveEditTargetWithRequirement,
  throwIfStrictInput,
  tryResolveEditTarget,
  withReplaceMatchPrompts,
  type EditToolFlags,
} from "./edit-common";
import { makeRenderCall, type RPreview, type RRState } from "./replace-render";

interface MatchRefs {
  from: Anchor;
  to: Anchor;
}

export interface MatchPlan {
  editParams: { remove_from: string; remove_to: string; text: string };
}

function formatMatchRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function offsetLineNumber(rangeLines: string[], offset: number): number {
  let cursor = 0;
  for (let index = 0; index < rangeLines.length; index++) {
    const length = rangeLines[index]!.length;
    if (offset <= cursor + length) return index + 1;
    cursor += length + 1;
  }
  return rangeLines.length;
}

function matchOffsets(text: string, oldText: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const found = text.indexOf(oldText, from);
    if (found < 0) return offsets;
    offsets.push(found);
    from = found + 1;
  }
}

function notFoundMessage(displayPath: string, start: number, end: number, fileHashes: string[], fileLines: string[]): string {
  const rangeLength = end - start + 1;
  const shownCount = Math.min(rangeLength, MAX_RANGE_STALE_LINES);
  const shown = fmtRegion(fileHashes.slice(start - 1, start - 1 + shownCount), fileLines.slice(start - 1, start - 1 + shownCount));
  const more = rangeLength > shownCount ? `\n[The range has ${rangeLength} lines; showing the first ${shownCount}.]` : "";
  return `[E_SUBSTRING_NOT_FOUND] "old_string" was not found in ${formatMatchRange(start, end)} of ${displayPath}. Current rows:\n\n${shown}${more}\n\nCopy old_string exactly from the served row (comparison uses LF breaks and excludes the last line's terminator) and retry.`;
}

function ambiguousMessage(displayPath: string, start: number, end: number, matchLines: number[]): string {
  const shownCount = 8;
  const shown = matchLines.slice(0, shownCount).join(", ");
  const more = matchLines.length > shownCount ? ` (+${matchLines.length - shownCount} more)` : "";
  return `[E_SUBSTRING_AMBIGUOUS] "old_string" occurs ${matchLines.length} times in ${formatMatchRange(start, end)} of ${displayPath} (matching lines ${shown}${more}). Narrow replace_from/replace_to to one line, or extend old_string so it matches exactly once.`;
}

export function parseMatchAnchors(req: ReplaceMatchReq): { refs: MatchRefs; warnings: string[] } {
  const warnings: string[] = [];
  const from = stripAnchorRow(req.replace_from.trim(), "replace_from entry", warnings);
  const to = stripAnchorRow(req.replace_to.trim(), "replace_to entry", warnings);
  return { refs: { from: parseHashRef(from), to: parseHashRef(to) }, warnings };
}

export function buildReplaceMatchEdit(req: ReplaceMatchReq, refs: MatchRefs, preload: NormFile, displayPath: string): MatchPlan {
  const fileLines = splitLines(preload.normalized);
  const fromLine = resolveAnchorLine(refs.from, fileLines, preload.fileHashes, displayPath);
  const toLine = resolveAnchorLine(refs.to, fileLines, preload.fileHashes, displayPath);
  const start = Math.min(fromLine, toLine);
  const end = Math.max(fromLine, toLine);
  const rangeLines = fileLines.slice(start - 1, end);
  const rangeText = rangeLines.join("\n");
  const oldText = toLF(req.old_string);
  const offsets = matchOffsets(rangeText, oldText);
  if (offsets.length === 0) {
    throw new Error(notFoundMessage(displayPath, start, end, preload.fileHashes, fileLines));
  }
  if (offsets.length > 1) {
    throw new Error(ambiguousMessage(displayPath, start, end, offsets.map((offset) => start - 1 + offsetLineNumber(rangeLines, offset))));
  }
  const matchOffset = offsets[0]!;
  const replacement = rangeText.slice(0, matchOffset) + req.new_string + rangeText.slice(matchOffset + oldText.length);
  const startRef = fromLine <= toLine ? refs.from : refs.to;
  const endRef = fromLine <= toLine ? refs.to : refs.from;
  return {
    editParams: {
      remove_from: startRef.hash,
      remove_to: endRef.hash,
      text: replacement,
    },
  };
}

export async function replaceMatchPreview(request: unknown, cwd: string, signal?: AbortSignal): Promise<RPreview> {
  try {
    const normalized: unknown = request;
    assertReplaceMatchReq(normalized);
    const req = normalized;
    const { refs, warnings } = parseMatchAnchors(req);
    await throwIfStrictInput(warnings);
    const targetPath = await resolveEditTargetWithRequirement({
      removeFrom: req.replace_from,
      removeTo: req.replace_to,
      providedPath: req.path,
      cwd,
    });
    const preload = await readNormFile(targetPath, cwd, {
      accessMode: constants.R_OK,
      maxLines: MAX_HASH_LINES,
      noPersist: true,
      allocation: "shadow",
      signal,
    });
    const plan = buildReplaceMatchEdit(req, refs, preload, targetPath);
    const pipe = await execPipeline(targetPath, plan.editParams, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
      preloadedNorm: preload,
      signal,
    });
    return previewFromPipe(pipe);
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return previewError(error);
  }
}

type ReplaceMatchToolDef = ToolDefinition<any, ReplaceDetails, RRState> & { renderShell?: "default" | "self" };

export function buildReplaceMatchToolDef(flags: EditToolFlags = DEFAULT_EDIT_FLAGS): ReplaceMatchToolDef {
  const prompted = withReplaceMatchPrompts({
    description: loadP("../prompts/replace-match.md"),
    snippet: loadP("../prompts/replace-match-snippet.md"),
    guidelines: loadGuide("../prompts/replace-match-guidelines.md"),
  }, flags);
  return {
    name: "replace_match",
    label: "Replace Match",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    ...editToolBase,
    parameters: buildReplaceMatchToolSchema(flags.requirePath),
    renderCall: makeRenderCall(replaceMatchPreview, {
      getInput: getReplaceMatchInput,
      toolName: "replace_match",
      resolveTarget: (input) => (typeof input.replace_from === "string" ? tryResolveEditTarget(input.replace_from, input.replace_to) : undefined),
    }),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withAnchorSession(ctx, async () => {
        const normalized: unknown = params;
        assertReplaceMatchReq(normalized);
        const req = normalized;
        const { refs, warnings } = parseMatchAnchors(req);
        await throwIfStrictInput(warnings);
        const hints = [...literalEscapeHints([req.old_string], "old_string"), ...literalEscapeHints([req.new_string], "new_string")];
        const targetPath = await resolveEditTargetWithRequirement({
          removeFrom: req.replace_from,
          removeTo: req.replace_to,
          providedPath: req.path,
          cwd: ctx.cwd,
        });
        return queuedEdit(targetPath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
          const preload = await readNormFile(targetPath, ctx.cwd, {
            signal,
            accessMode: constants.R_OK | constants.W_OK,
            maxLines: MAX_HASH_LINES,
          });
          let plan: MatchPlan;
          try {
            plan = buildReplaceMatchEdit(req, refs, preload, targetPath);
          } catch (error) {
            await noteAnchorError(preload.absolutePath, error);
            throw error;
          }
          const pipe = await execPipeline(targetPath, plan.editParams, ctx.cwd, {
            accessMode: constants.R_OK | constants.W_OK,
            signal,
            preloadedNorm: preload,
          });
          return commitEdit(pipe, {
            path: pipe.path,
            absolutePath,
            mutationTargetPath,
            editAnchors: [plan.editParams.remove_from, plan.editParams.remove_to],
            prefixWarnings: [...warnings, ...hints],
            signal,
            verb: "replaced",
            noopNoun: "Replacement",
          });
        });
      });
    },
  };
}

export function regReplaceMatch(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildReplaceMatchToolDef(flags));
}
