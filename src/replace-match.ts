import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import * as Diff from "diff";
import { execPipeline, noteAnchorError, previewFromPipe, previewError, type ReplaceDetails } from "./replace";
import { commitEdit } from "./commit";
import { readNormFile, type NormFile } from "./file-reader";
import { fmtRegion, MAX_HASH_LINES, parseHashRef, planEdit, preserveDeletionSeparators, resEdit, resolveAnchorLine, stripAnchorRow, type Anchor } from "./hashline";
import { servedForPath, withAnchorSession } from "./anchor-registry";
import { batchMemberFor, executeBatchMember, noteBatchFailure, registerBatchPlanner, type BatchMemberPlan, type BatchPlannerInput } from "./batch";
import { loadP, loadGuidelines } from "./prompts";
import {
  assertReplaceMatchReq,
  buildReplaceMatchToolSchema,
  getReplaceMatchInput,
  normReq,
  type ReplaceMatchReq,
} from "./payload-contract";
import { literalEscapeHints, makePrepareArguments, splitLines } from "./utils";
import { toLF } from "./normalize";
import { isFidelitySensitiveChar } from "./edit-fidelity";
import { countNewlines } from "./line-endings";
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
  warnings: string[];
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

const RETYPE_DIFF_MAX_CHARS = 20_000;
const RETYPE_MAX_EDIT_LENGTH = 2000;
const RETYPE_MIN_UNCHANGED_CHARS = 40;
const RETYPE_MIN_UNCHANGED_MULTILINE = 20;
const RETYPE_EXAMPLE_MAX_CHARS = 40;
const WHOLE_RANGE_MIN_CHARS = 40;
const WHOLE_RANGE_MIN_LINES = 2;
const NEAR_MISS_MIN_OLD_CHARS = 20;
const NEAR_MISS_MATCH_RATIO = 0.8;

interface RetypeAnalysis {
  changed: number;
  unchanged: number;
  middle: { oldFragment: string; newFragment: string };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix;
  let suffix = 0;
  while (suffix < limit && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return suffix;
}

function analyzeRetype(oldText: string, newText: string): RetypeAnalysis {
  const prefix = commonPrefixLength(oldText, newText);
  const suffix = commonSuffixLength(oldText, newText, prefix);
  const middle = {
    oldFragment: oldText.slice(prefix, oldText.length - suffix),
    newFragment: newText.slice(prefix, newText.length - suffix),
  };
  if (oldText.length + newText.length <= RETYPE_DIFF_MAX_CHARS) {
    const parts = Diff.diffChars(oldText, newText, { maxEditLength: RETYPE_MAX_EDIT_LENGTH }) as Array<{ added?: boolean; removed?: boolean; value: string }> | undefined;
    if (parts !== undefined) {
      let changed = 0;
      let removed = 0;
      for (const part of parts) {
        if (part.added === true) changed += part.value.length;
        else if (part.removed === true) {
          changed += part.value.length;
          removed += part.value.length;
        }
      }
      return { changed, unchanged: oldText.length - removed, middle };
    }
  }
  return { changed: middle.oldFragment.length + middle.newFragment.length, unchanged: prefix + suffix, middle };
}

function retypeSuggestion(analysis: RetypeAnalysis): string {
  const { oldFragment, newFragment } = analysis.middle;
  if (oldFragment.length === 0 && newFragment.length === 0) return "Send only the fragment that changes instead.";
  if (oldFragment.length === 0) return "Send the added text with insert instead.";
  if (
    oldFragment.length > RETYPE_EXAMPLE_MAX_CHARS ||
    newFragment.length > RETYPE_EXAMPLE_MAX_CHARS ||
    oldFragment.includes("\n") ||
    newFragment.includes("\n")
  ) {
    return "Send only the fragment that changes instead.";
  }
  return `Send old_string ${JSON.stringify(oldFragment)} and new_string ${JSON.stringify(newFragment)} instead.`;
}

function retypeWarning(oldText: string, newText: string): string | undefined {
  const analysis = analyzeRetype(oldText, newText);
  if (analysis.changed === 0) return undefined;
  const minUnchanged = oldText.includes("\n") ? RETYPE_MIN_UNCHANGED_MULTILINE : RETYPE_MIN_UNCHANGED_CHARS;
  if (analysis.unchanged < minUnchanged) return undefined;
  const lineCount = oldText.split("\n").length;
  return `[W_REPLACE_MATCH_RETYPE] "old_string" retypes ${analysis.unchanged} unchanged character(s) across ${lineCount} line(s). ${retypeSuggestion(analysis)}`;
}

function wholeRangeWarning(oldText: string, rangeText: string, lineCount: number, start: number, end: number, startHash: string, endHash: string): string | undefined {
  if (oldText !== rangeText) return undefined;
  if (lineCount < WHOLE_RANGE_MIN_LINES && oldText.length < WHOLE_RANGE_MIN_CHARS) return undefined;
  return `[W_REPLACE_MATCH_WHOLE_RANGE] "old_string" is the entire selected range (${formatMatchRange(start, end)}); the anchors already identify it. Use replace with remove_from "${startHash}", remove_to "${endHash}" and the new text, or send only the fragment that changes.`;
}

function multiMatchWarning(count: number, start: number, end: number, displayPath: string): string {
  return `[W_REPLACE_MATCH_MULTI] "old_string" matched ${count} occurrences in ${formatMatchRange(start, end)} of ${displayPath}; every one was replaced. Narrow the range or send a longer fragment if you meant only one.`;
}

function describeChar(char: string | undefined): string {
  if (char === undefined) return "the end of the text";
  const codePoint = char.codePointAt(0)!;
  const shown = JSON.stringify(char);
  return isFidelitySensitiveChar(char) || codePoint < 0x20 || codePoint > 0x7e
    ? `${shown} (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`
    : shown;
}

function nearMissDetail(oldText: string, rangeText: string, start: number): string | undefined {
  if (oldText.length < NEAR_MISS_MIN_OLD_CHARS && !oldText.includes("\n")) return undefined;
  const prefix = commonPrefixLength(oldText, rangeText);
  const suffix = commonSuffixLength(oldText, rangeText, prefix);
  const comparable = Math.min(oldText.length, rangeText.length);
  if (prefix + suffix < Math.floor(comparable * NEAR_MISS_MATCH_RATIO)) return undefined;
  const lineOffset = countNewlines(rangeText.slice(0, prefix));
  const column = prefix - rangeText.lastIndexOf("\n", prefix - 1);
  return `the first mismatch is at line ${start + lineOffset}, col ${column}: the file has ${describeChar(rangeText[prefix])} where old_string has ${describeChar(oldText[prefix])}.`;
}

function notFoundMessage(displayPath: string, start: number, end: number, fileHashes: string[], fileLines: string[], rangeText: string, oldText: string): string {
  const rangeLength = end - start + 1;
  const shownCount = Math.min(rangeLength, MAX_RANGE_STALE_LINES);
  const shown = fmtRegion(fileHashes.slice(start - 1, start - 1 + shownCount), fileLines.slice(start - 1, start - 1 + shownCount));
  const more = rangeLength > shownCount ? `\n[The range has ${rangeLength} lines; showing the first ${shownCount}.]` : "";
  const nearMiss = nearMissDetail(oldText, rangeText, start);
  const advice = nearMiss !== undefined
    ? `${nearMiss} That looks like a retyped copy of the range; send only the fragment that changes (copy it from the served row), or use replace with the same anchors.`
    : "Copy only the fragment that changes from the served row (comparison uses LF breaks and excludes the last line's terminator) and retry; for a whole-line or whole-range rewrite use replace with the same anchors.";
  return `[E_SUBSTRING_NOT_FOUND] "old_string" was not found in ${formatMatchRange(start, end)} of ${displayPath}. Current rows:\n\n${shown}${more}\n\n${advice}`;
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
  const newText = toLF(req.new_string);
  const { text: replacement, count } = replaceAllOccurrences(rangeText, oldText, req.new_string);
  if (count === 0) {
    throw new Error(notFoundMessage(displayPath, start, end, preload.fileHashes, fileLines, rangeText, oldText));
  }
  const startRef = fromLine <= toLine ? refs.from : refs.to;
  const endRef = fromLine <= toLine ? refs.to : refs.from;
  const servedOverride = trustRangeServed(fileLines, preload.fileHashes, served, start, end);
  const warnings: string[] = [];
  const retype = retypeWarning(oldText, newText);
  if (retype !== undefined) {
    warnings.push(retype);
  } else {
    const wholeRange = wholeRangeWarning(oldText, rangeText, rangeLines.length, start, end, startRef.hash, endRef.hash);
    if (wholeRange !== undefined) warnings.push(wholeRange);
  }
  if (count > 1) warnings.push(multiMatchWarning(count, start, end, displayPath));
  return {
    editParams: {
      remove_from: startRef.hash,
      remove_to: endRef.hash,
      text: replacement,
    },
    warnings,
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
    warnings: [...warnings, ...hints, ...resWarnings, ...matchPlan.warnings],
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
    await throwIfStrictInput(plan.warnings);
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
    guidelines: loadGuidelines("../tool-prompts/replace-match-guidelines.md"),
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
          await throwIfStrictInput(plan.warnings);
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
            prefixWarnings: [...warnings, ...hints, ...plan.warnings],
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
