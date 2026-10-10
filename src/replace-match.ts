import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { execPipeline, noteAnchorError, previewFromPipe, previewError, type ReplaceDetails } from "./replace";
import { commitEdit } from "./commit";
import { readNormFile, type NormFile } from "./file-reader";
import { fmtRegion, MAX_HASH_LINES, parseHashRef, planEdit, preserveDeletionSeparators, resEdit, resolveAnchorLine, stripAnchorRow, type Anchor } from "./hashline";
import { servedForPath, withAnchorSession } from "./anchor-registry";
import { batchMemberFor, executeBatchMember, noteBatchFailure, registerBatchPlanner, type BatchMemberPlan, type BatchPlannerInput } from "./batch";
import { loadP, loadGuide } from "./prompts";
import {
  assertReplaceMatchReq,
  buildReplaceMatchToolSchema,
  getReplaceMatchInput,
  normReq,
  type ReplaceMatchReq,
} from "./payload-contract";
import { literalEscapeHints, makePrepareArguments, splitLines } from "./utils";
import { toLF } from "./normalize";
import { MAX_RANGE_STALE_LINES } from "./constants";
import {
  assertBoundaryLinesServed,
  DEFAULT_EDIT_FLAGS,
  editRenderResultWrapper,
  editToolBase,
  queuedEdit,
  resolveEditTargetWithRequirement,
  throwIfStrictInput,
  tryResolveEditTarget,
  trustRangeServed,
  withReplaceMatchPrompts,
  type EditToolFlags,
} from "./edit-common";
import { makeRenderCall, type RPreview, type RRState } from "./replace-render";
import { editResultSchema, withStructuredErrors } from "./structured";

interface MatchRefs {
  from: Anchor;
  to: Anchor;
}

export interface MatchPlan {
  editParams: { remove_from: string; remove_to: string; text: string };
  servedOverride?: ReadonlyMap<string, string>;
}

function formatMatchRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function replaceAllOccurrences(text: string, oldText: string, newText: string): { text: string; count: number } {
  let out = "";
  let cursor = 0;
  let count = 0;
  for (;;) {
    const found = text.indexOf(oldText, cursor);
    if (found < 0) break;
    out += text.slice(cursor, found) + newText;
    cursor = found + oldText.length;
    count += 1;
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(cursor), count };
}

function notFoundMessage(displayPath: string, start: number, end: number, fileHashes: string[], fileLines: string[]): string {
  const rangeLength = end - start + 1;
  const shownCount = Math.min(rangeLength, MAX_RANGE_STALE_LINES);
  const shown = fmtRegion(fileHashes.slice(start - 1, start - 1 + shownCount), fileLines.slice(start - 1, start - 1 + shownCount));
  const more = rangeLength > shownCount ? `\n[The range has ${rangeLength} lines; showing the first ${shownCount}.]` : "";
  return `[E_SUBSTRING_NOT_FOUND] "old_string" was not found in ${formatMatchRange(start, end)} of ${displayPath}. Current rows:\n\n${shown}${more}\n\nCopy old_string exactly from the served row (comparison uses LF breaks and excludes the last line's terminator) and retry.`;
}

export function parseMatchAnchors(req: ReplaceMatchReq): { refs: MatchRefs; warnings: string[] } {
  const warnings: string[] = [];
  const from = stripAnchorRow(req.replace_from.trim(), "replace_from entry", warnings);
  const to = stripAnchorRow(req.replace_to.trim(), "replace_to entry", warnings);
  return { refs: { from: parseHashRef(from), to: parseHashRef(to) }, warnings };
}

export function buildReplaceMatchEdit(
  req: ReplaceMatchReq,
  refs: MatchRefs,
  preload: NormFile,
  displayPath: string,
  served?: ReadonlyMap<string, string>,
): MatchPlan {
  const fileLines = splitLines(preload.normalized);
  const fromLine = resolveAnchorLine(refs.from, fileLines, preload.fileHashes, displayPath);
  const toLine = resolveAnchorLine(refs.to, fileLines, preload.fileHashes, displayPath);
  const start = Math.min(fromLine, toLine);
  const end = Math.max(fromLine, toLine);
  assertBoundaryLinesServed(fileLines, preload.fileHashes, served, start, end, displayPath);
  const rangeLines = fileLines.slice(start - 1, end);
  const rangeText = `${rangeLines.join("\n")}${rangeLines[rangeLines.length - 1] === "" ? "\n" : ""}`;
  const oldText = toLF(req.old_string);
  const { text: replacement, count } = replaceAllOccurrences(rangeText, oldText, req.new_string);
  if (count === 0) {
    throw new Error(notFoundMessage(displayPath, start, end, preload.fileHashes, fileLines));
  }
  const startRef = fromLine <= toLine ? refs.from : refs.to;
  const endRef = fromLine <= toLine ? refs.to : refs.from;
  const servedOverride = trustRangeServed(fileLines, preload.fileHashes, served, start, end);
  return {
    editParams: {
      remove_from: startRef.hash,
      remove_to: endRef.hash,
      text: replacement,
    },
    ...(servedOverride !== undefined ? { servedOverride } : {}),
  };
}

function planReplaceMatchBatchMember(input: BatchPlannerInput): BatchMemberPlan {
  const req = normReq(input.member.args, "replace");
  assertReplaceMatchReq(req);
  const { refs, warnings } = parseMatchAnchors(req);
  const hints = [...literalEscapeHints([req.old_string], "old_string"), ...literalEscapeHints([req.new_string], "new_string")];
  const preload = { normalized: input.base.content, fileHashes: input.base.hashes } as NormFile;
  const matchPlan = buildReplaceMatchEdit(req, refs, preload, input.displayPath, input.served);
  const resWarnings: string[] = [];
  const hedit = resEdit(matchPlan.editParams, resWarnings);
  const effectiveHedit = preserveDeletionSeparators(hedit, input.base.baseLines, input.base.hashes);
  const planned = planEdit(input.base.content, effectiveHedit, input.base.hashes, {
    filePath: input.displayPath,
    servedHashes: matchPlan.servedOverride ?? input.served,
    signal: input.signal,
    baseFileLines: input.base.baseLines,
  });
  return {
    hedit,
    warnings: [...warnings, ...hints, ...resWarnings],
    planned,
    foldedLines: 0,
    ...(matchPlan.servedOverride !== undefined ? { servedOverride: matchPlan.servedOverride } : {}),
  };
}

registerBatchPlanner("replace_match", planReplaceMatchBatchMember);

export async function replaceMatchPreview(request: unknown, cwd: string, signal?: AbortSignal): Promise<RPreview> {
  try {
    const normalized = normReq(request, "replace");
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
    const plan = buildReplaceMatchEdit(req, refs, preload, targetPath, servedForPath(preload.absolutePath));
    const pipe = await execPipeline(targetPath, plan.editParams, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
      preloadedNorm: preload,
      served: plan.servedOverride,
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
    description: loadP("../tool-prompts/replace-match.md"),
    snippet: loadP("../tool-prompts/replace-match-snippet.md"),
    guidelines: loadGuide("../tool-prompts/replace-match-guidelines.md"),
  }, flags);
  return {
    name: "replace_match",
    label: "Replace Match",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    ...editToolBase,
    prepareArguments: makePrepareArguments("replace"),
    parameters: buildReplaceMatchToolSchema(flags.requirePath),
    outputSchema: editResultSchema,
    renderCall: makeRenderCall(replaceMatchPreview, {
      getInput: getReplaceMatchInput,
      toolName: "replace_match",
      resolveTarget: (input) => (typeof input.replace_from === "string" ? tryResolveEditTarget(input.replace_from, input.replace_to) : undefined),
    }),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withStructuredErrors(signal, { diff: "" }, () => withAnchorSession(ctx, async () => {
        const normalized = normReq(params, "replace");
        assertReplaceMatchReq(normalized);
        const req = normalized;
        const member = batchMemberFor(_toolCallId);
        let refs: MatchRefs;
        let warnings: string[];
        try {
          ({ refs, warnings } = parseMatchAnchors(req));
          if (member === undefined) await throwIfStrictInput(warnings);
        } catch (error) {
          if (member) noteBatchFailure(member, error);
          throw error;
        }
        const hints = [...literalEscapeHints([req.old_string], "old_string"), ...literalEscapeHints([req.new_string], "new_string")];
        const targetPath = await resolveEditTargetWithRequirement({
          removeFrom: req.replace_from,
          removeTo: req.replace_to,
          providedPath: req.path,
          cwd: ctx.cwd,
          anchorTarget: member?.target,
        }).catch((error: unknown) => {
          if (member) noteBatchFailure(member, error);
          throw error;
        });
        return queuedEdit(targetPath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
          if (member) {
            return executeBatchMember({ member, targetPath, mutationTargetPath, cwd: ctx.cwd, signal });
          }
          const preload = await readNormFile(targetPath, ctx.cwd, {
            signal,
            accessMode: constants.R_OK | constants.W_OK,
            maxLines: MAX_HASH_LINES,
          });
          let plan: MatchPlan;
          try {
            plan = buildReplaceMatchEdit(req, refs, preload, targetPath, servedForPath(preload.absolutePath));
          } catch (error) {
            await noteAnchorError(mutationTargetPath, error);
            throw error;
          }
          const pipe = await execPipeline(targetPath, plan.editParams, ctx.cwd, {
            accessMode: constants.R_OK | constants.W_OK,
            signal,
            preloadedNorm: preload,
            served: plan.servedOverride,
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
      }));
    },
  };
}

export function regReplaceMatch(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildReplaceMatchToolDef(flags));
}
