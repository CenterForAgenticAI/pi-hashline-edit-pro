import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "node:fs";
import { execPipeline, type ReplaceDetails, previewFromPipe, previewError } from "./replace";
import { commitEdit } from "./commit";
import { batchMemberFor, ensureBatchBase, executeBatchMember, noteBatchFailure } from "./batch";
import { readNormFile, type NormFile } from "./file-reader";
import { MAX_HASH_LINES, parseHashRef, parsePayloadText, resEdit, resolveAnchorLine, type Anchor, type HEdit, type HTEdit, type StripWarningLocation } from "./hashline";
import type { LineEnding } from "./normalize";
import { stripAnchorRow } from "./hashline/resolve";
import { withAnchorSession } from "./anchor-registry";
import { loadP, loadGuide } from "./prompts";
import { assertInsertReq, normReq, type InsertReq } from "./payload-contract";
import { isRec, literalEscapeHint, splitLines } from "./utils";
import { queuedEdit, editToolBase, editRenderCallWrapper, editRenderResultWrapper, resolveEditTargetWithRequirement, throwIfStrictInput, withInsertPrompts, DEFAULT_EDIT_FLAGS, type EditToolFlags } from "./edit-common";
import type { RPreview, RRState } from "./replace-render";
export { assertInsertReq, type InsertReq };

const insertAnchorSchema = Type.String({
  description:
    "4-char anchor of the line to insert next to (never the row content). A pasted diff row is stripped with a warning; the anchor line is preserved.",
});

const insertDirectionSchema = Type.Union(
  [Type.Literal("after"), Type.Literal("before")],
  { description: '"after" or "before"' },
);
const insertLinesSchema = Type.String({
  description:
    'The exact text to insert. "" inserts nothing, "\\n" is one blank line, and a trailing line break sets the last line\'s ending instead of adding a blank line. Never include the anchor line.',
});

const insertPathRequiredSchema = Type.String({
  description:
    "Path to the file the anchor was served for; required and must match anchor ownership.",
});

const insertToolSchema = Type.Object(
  {
    anchor: insertAnchorSchema,
    direction: insertDirectionSchema,
    lines: insertLinesSchema,
  },
  { additionalProperties: true },
);

export function buildInsertToolSchema(requirePath: boolean): typeof insertToolSchema {
  if (!requirePath) return insertToolSchema;
  return Type.Object(
    {
      path: insertPathRequiredSchema,
      anchor: insertAnchorSchema,
      direction: insertDirectionSchema,
      lines: insertLinesSchema,
    },
    { additionalProperties: true },
  ) as typeof insertToolSchema;
}

export function parseInsertAnchor(raw: string): { ref: Anchor; warnings: string[] } {
  const trimmedAnchor = raw.trim();
  const warnings: string[] = [];
  const anchorText = stripAnchorRow(trimmedAnchor, "anchor entry", warnings);
  return { ref: parseHashRef(anchorText), warnings };
}

export function buildInsertEdit(
  req: InsertReq,
  preload: NormFile,
  ref: Anchor,
  path: string,
): { editParams: HTEdit; anchorLine: string | undefined; contentSeparators: (LineEnding | undefined)[] } {
  const parsed = parsePayloadText(req.lines);
  const fileLines = splitLines(preload.normalized);
  const line = resolveAnchorLine(ref, fileLines, preload.fileHashes, path);
  const anchorLine = preload.normalized.length === 0 ? undefined : fileLines[line - 1];
  const editParams: HTEdit = {
    remove_from: ref.hash,
    remove_to: ref.hash,
    replacement_lines:
      anchorLine === undefined
        ? [...parsed.lines]
        : req.direction === "after"
          ? [anchorLine, ...parsed.lines]
          : [...parsed.lines, anchorLine],
  };
  const contentSeparators = anchorLine === undefined
    ? parsed.separators
    : req.direction === "after"
      ? [undefined, ...parsed.separators]
      : [...parsed.separators, undefined];
  return { editParams, anchorLine, contentSeparators };
}

function insertStripWarning(anchorLine: string | undefined, direction: "before" | "after"): StripWarningLocation {
  return { label: "lines", indexOffset: anchorLine !== undefined && direction === "after" ? -1 : 0 };
}

export async function insertPreview(request: unknown, cwd: string, signal?: AbortSignal): Promise<RPreview> {
  try {
    const normalized = normReq(request);
    assertInsertReq(normalized);
    const previewReq = normalized as InsertReq;
    const { ref, warnings: previewAnchorWarnings } = parseInsertAnchor(previewReq.anchor);
    await throwIfStrictInput(previewAnchorWarnings);
    const targetPath = await resolveEditTargetWithRequirement({
      anchor: previewReq.anchor,
      providedPath: previewReq.path,
      cwd,
    });
    const preload = await readNormFile(targetPath, cwd, {
      accessMode: constants.R_OK,
      maxLines: MAX_HASH_LINES,
      noPersist: true,
      allocation: "shadow",
      signal,
    });
    const { editParams, anchorLine, contentSeparators } = buildInsertEdit(normalized, preload, ref, targetPath);
    const pipe = await execPipeline(targetPath, editParams, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
      preloadedNorm: preload,
      signal,
      stripWarning: insertStripWarning(anchorLine, normalized.direction),
      endingOverrides: contentSeparators,
    });
    return previewFromPipe(pipe);
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return previewError(error);
  }
}

function getInsertInput(args: unknown): { path?: string; anchor?: string; direction?: "before" | "after"; lines?: string } | null {
  let normalized: unknown;
  try {
    normalized = normReq(args);
  } catch {
    return null;
  }
  if (!isRec(normalized)) return null;
  if (
    typeof normalized.anchor !== "string" ||
    (normalized.direction !== "before" && normalized.direction !== "after") ||
    typeof normalized.lines !== "string"
  ) {
    return null;
  }
  return {
    ...(typeof normalized.path === "string" ? { path: normalized.path } : {}),
    anchor: normalized.anchor as string,
    direction: normalized.direction as "before" | "after",
    lines: normalized.lines,
  };
}

type InsertToolDef = ToolDefinition<any, ReplaceDetails, RRState> & { renderShell?: "default" | "self" };

export function buildInsertToolDef(flags: EditToolFlags = DEFAULT_EDIT_FLAGS): InsertToolDef {
  const prompted = withInsertPrompts({
    description: loadP("../prompts/insert.md"),
    snippet: loadP("../prompts/insert-snippet.md"),
    guidelines: loadGuide("../prompts/insert-guidelines.md"),
  }, flags);
  return {
    name: "insert",
    label: "Insert",
    description: prompted.description,
    promptSnippet: prompted.snippet,
    promptGuidelines: prompted.guidelines,
    ...editToolBase,
    parameters: buildInsertToolSchema(flags.requirePath),
    renderCall: editRenderCallWrapper(insertPreview, getInsertInput, "insert"),
    renderResult: editRenderResultWrapper,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return withAnchorSession(ctx, async () => {
        const canonical = normReq(params);
        assertInsertReq(canonical);
        const req = canonical;
        const insertWarnings: string[] = [];
        const literalEscape = literalEscapeHint([req.lines], "lines");
        if (literalEscape !== undefined) insertWarnings.push(literalEscape);
        const targetPath = await resolveEditTargetWithRequirement({
          anchor: req.anchor,
          providedPath: req.path,
          cwd: ctx.cwd,
        }).catch((error: unknown) => {
          const member = batchMemberFor(_toolCallId);
          if (member) noteBatchFailure(member, error);
          throw error;
        });
        let ref: Anchor;
        let anchorWarnings: string[];
        try {
          ({ ref, warnings: anchorWarnings } = parseInsertAnchor(req.anchor));
          await throwIfStrictInput([...anchorWarnings, ...insertWarnings]);
        } catch (error) {
          const member = batchMemberFor(_toolCallId);
          if (member) noteBatchFailure(member, error);
          throw error;
        }
        return queuedEdit(targetPath, ctx.cwd, signal, async (absolutePath, mutationTargetPath) => {
          const member = batchMemberFor(_toolCallId);
          if (member) {
            const base = await ensureBatchBase({ member, targetPath, mutationTargetPath, cwd: ctx.cwd, signal });
            const basePreload = { normalized: base.content, fileHashes: base.hashes } as NormFile;
            const built = buildInsertEdit(req, basePreload, ref, targetPath);
            let hedit: HEdit;
            const resWarnings: string[] = [];
            try {
              hedit = resEdit(built.editParams, resWarnings);
            } catch (error) {
              noteBatchFailure(member, error);
              throw error;
            }
            return executeBatchMember({
              kind: "insert",
              direction: req.direction,
              member,
              targetPath,
              mutationTargetPath,
              cwd: ctx.cwd,
              signal,
              hedit,
              extraWarnings: [...anchorWarnings, ...insertWarnings, ...resWarnings],
              foldedLines: built.anchorLine === undefined ? 0 : 1,
              stripWarning: insertStripWarning(built.anchorLine, req.direction),
              contentSeparators: built.contentSeparators,
            });
          }
          const preload = await readNormFile(targetPath, ctx.cwd, {
            signal,
            accessMode: constants.R_OK | constants.W_OK,
            maxLines: MAX_HASH_LINES,
          });
          const { editParams, anchorLine, contentSeparators } = buildInsertEdit(req, preload, ref, targetPath);
          const pipe = await execPipeline(targetPath, editParams, ctx.cwd, {
            accessMode: constants.R_OK | constants.W_OK,
            signal,
            preloadedNorm: preload,
            stripWarning: insertStripWarning(anchorLine, req.direction),
            endingOverrides: contentSeparators,
          });
          return commitEdit(pipe, {
            path: pipe.path,
            absolutePath,
            mutationTargetPath,
            editAnchors: [editParams.remove_from, editParams.remove_to],
            ...(anchorLine === undefined
              ? {}
              : { anchorCarry: req.direction === "after" ? 0 : editParams.replacement_lines.length - 1 }),
            signal,
            verb: "inserted",
            noopNoun: "Insertion",
            foldedAnchorLines: anchorLine === undefined ? 0 : 1,
            prefixWarnings: [...anchorWarnings, ...insertWarnings],
            endingOverrides: contentSeparators,
          });
        });
      });
    },
  };
}

export function regInsert(pi: ExtensionAPI, flags: EditToolFlags = DEFAULT_EDIT_FLAGS): void {
  pi.registerTool(buildInsertToolDef(flags));
}
