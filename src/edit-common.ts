import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveInCwd } from "./fs-write";
import { abortIf, makePrepareArguments } from "./utils";
import { ownerOf, ownersDifferingOnlyByCase, type OwnedAnchor } from "./anchor-registry";
import { parseHashRef, stripAnchorRow } from "./hashline";
import { readConfig } from "./config";
import { makeRenderCall, renderEditResult, type RPreview, type FgT } from "./replace-render";
import type { ReplaceDetails } from "./replace";
export const editPrepare = makePrepareArguments();

export interface EditToolFlags {
  requirePath: boolean;
  strictInput: boolean;
  autoRead: boolean;
  autoReadAllActive: boolean;
  replaceWithinEnabled: boolean;
  copyMoveEnabled: boolean;
}

export const DEFAULT_EDIT_FLAGS: EditToolFlags = {
  requirePath: false,
  strictInput: false,
  autoRead: true,
  autoReadAllActive: false,
  replaceWithinEnabled: true,
  copyMoveEnabled: true
};

export async function currentEditFlags(): Promise<EditToolFlags> {
  const config = await readConfig();
  return {
    requirePath: config.requirePath === true,
    strictInput: config.strictInput === true,
    autoRead: config.autoRead !== false,
    autoReadAllActive: (config.autoReadAll ?? "off") !== "off",
    replaceWithinEnabled: config.replaceWithinEnabled !== false,
    copyMoveEnabled: config.copyMoveEnabled !== false
  };
}

export function withReplacePrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  let description = base.description;
  const snippetParts = [base.snippet];
  let guidelines = [...base.guidelines];
  if (!flags.autoRead) {
    description = description.replace(/\n\nExample:[\s\S]*$/, "");
    guidelines = guidelines.filter((guideline) => !guideline.includes("post-edit diff"));
    description = description.replace("and the last call shows the combined diff,", "and the last call shows the combined result,");
  }
  if (!flags.replaceWithinEnabled) {
    description = description.replace(/\n?To change only part of a line without retyping the rest, use `replace_within` instead; it preserves every character the request does not name\./, "");
  }
  const descriptionParts = [description];
  if (flags.requirePath) {
    descriptionParts.push("Also give `path` matching the file the anchors were served for; it is required and must match anchor ownership.");
    snippetParts.push("; include `path` (required)");
  } else {
    descriptionParts.push("Path resolution is anchor-only; do not pass `path`.");
  }
  if (flags.strictInput) {
    descriptionParts.push("Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.");
  }
  return { description: descriptionParts.join(" "), snippet: snippetParts.join(""), guidelines };
}

export function withReadPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  if (flags.autoReadAllActive) {
    const rewritten = base.guidelines
      .filter((guideline) => !guideline.includes("call again after an edit"))
    return { description: base.description, snippet: base.snippet, guidelines: [...rewritten] };
  }
  const withoutAutoReadAll = base.guidelines.filter((guideline) => !guideline.includes("E_AUTO_READ_ALL"))
  if (flags.autoRead) return { description: base.description, snippet: base.snippet, guidelines: [...withoutAutoReadAll] };
  const guidelines = [...withoutAutoReadAll];
  const mapped = guidelines.map((guideline) => guideline.startsWith("`read`: call again after an edit") ? "`read`: call again after an edit when you need anchors you lack." : guideline);
  return { description: base.description, snippet: base.snippet, guidelines: mapped };
}

export function withInsertPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const baseDescription = flags.autoRead ? base.description : base.description.replace("and the last call shows the combined diff,", "and the last call shows the combined result,");
  const descriptionParts = [baseDescription];
  const snippetParts = [base.snippet];
  const guidelines = [...base.guidelines];
  if (flags.requirePath) {
    descriptionParts.push("Also give `path` matching the file the anchor was served for; it is required and must match anchor ownership.");
    snippetParts.push("; include `path` (required)");
  } else {
    descriptionParts.push("Path resolution is anchor-only; do not pass `path`.");
  }
  if (flags.strictInput) {
    descriptionParts.push("Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.");
  }
  return { description: descriptionParts.join(" "), snippet: snippetParts.join(""), guidelines };
}

export function withReplaceWithinPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const descriptionParts = [base.description];
  const snippetParts = [base.snippet];
  const guidelines = base.guidelines.map((guideline) => flags.copyMoveEnabled ? guideline : guideline.replace(", like `copy` and `move`", ""));
  if (flags.requirePath) {
    descriptionParts.push("Also give `path` matching the file the anchors were served for; it is required and must match anchor ownership.");
    snippetParts.push("; include `path` (required)");
  } else {
    descriptionParts.push("Path resolution is anchor-only; do not pass `path`.");
  }
  if (flags.strictInput) {
    descriptionParts.push("Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.");
  }
  return { description: descriptionParts.join(" "), snippet: snippetParts.join(""), guidelines };
}

function gatedEditOps(ops: string[], flags: EditToolFlags): string[] {
  return ops.filter((op) => {
    if (op === "replace_within") return flags.replaceWithinEnabled;
    if (op === "copy" || op === "move") return flags.copyMoveEnabled;
    return true;
  });
}

function joinOps(ops: string[], options?: { backtick?: boolean; separator?: "/" }): string {
  const formatted = ops.map((op) => (options?.backtick ? `\`${op}\`` : op));
  if (options?.separator === "/") return formatted.join("/");
  if (formatted.length <= 1) return formatted[0] ?? "";
  const last = formatted[formatted.length - 1]!;
  const head = formatted.slice(0, -1).join(", ");
  return formatted.length === 2 ? `${head} or ${last}` : `${head}, or ${last}`;
}

export function withGrepPrompts(base: { description: string; snippet: string }, flags: EditToolFlags): { description: string; snippet: string } {
  if (flags.copyMoveEnabled) return base;
  return { ...base, description: base.description.replaceAll("replace, insert, copy, or move", joinOps(gatedEditOps(["replace", "insert", "copy", "move"], flags))) };
}

export function withUndoPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const ops = gatedEditOps(["replace", "replace_within", "insert", "copy", "move"], flags);
  let description = base.description;
  let snippet = base.snippet;
  let guidelines = [...base.guidelines];
  if (!flags.autoRead) {
    guidelines = guidelines.map((guideline) => guideline.includes("bad diff") ? "`undo_last_change`: only the last `replace`/`replace_within`/`insert`/`copy`/`move` per file is undoable; a `write` clears it, so undo right after a bad edit — review what you're restoring." : guideline);
  }
  if (ops.length !== 5) {
    description = description.replaceAll("replace, replace_within, insert, copy, or move", joinOps(ops));
    snippet = snippet.replaceAll("`replace`, `replace_within`, `insert`, `copy`, or `move`", joinOps(ops, { backtick: true }));
    guidelines = guidelines.map((guideline) => guideline.replaceAll("`replace`/`replace_within`/`insert`/`copy`/`move`", joinOps(ops, { backtick: true, separator: "/" })));
  }
  if (!flags.copyMoveEnabled) {
    guidelines = guidelines.filter((guideline) => !guideline.includes("cross-file `move`"));
  }
  return { description, snippet, guidelines };
}

export function withTransferPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const descriptionParts = [base.description];
  const snippetParts = [base.snippet];
  const guidelines = [...base.guidelines];
  if (flags.requirePath) {
    descriptionParts.push("Also give `path` matching the source or destination file the anchors were served for; it is required and must match anchor ownership.");
    snippetParts.push("; include `path` (required)");
  } else {
    descriptionParts.push("Path resolution is anchor-only; do not pass `path`.");
  }
  if (flags.strictInput) {
    descriptionParts.push("Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.");
  }
  return { description: descriptionParts.join(" "), snippet: snippetParts.join(""), guidelines };
}

function staleAnchorMessage(ref: string, hash: string, owners: Array<OwnedAnchor | undefined>): string {
  const knownPaths = new Set<string>();
  for (const owner of owners) {
    if (owner) knownPaths.add(owner.path);
  }
  const folded = ownersDifferingOnlyByCase(hash, knownPaths);
  const hint =
    folded.length > 0
      ? ` Anchors are case-sensitive; ${folded.map((match) => `"${match.anchor}"`).join(", ")} differs only in case.`
      : "";
  return `[E_STALE_ANCHOR] "${ref}" is not owned in this session.${hint} Call read() on the target file first.`;
}

export function resolveEditTarget(removeFrom: string, removeTo?: string): string {
  const refs = [removeFrom, removeTo].filter((value): value is string => typeof value === "string");
  const hashes = refs.map((ref) => parseHashRef(stripAnchorRow(ref.trim(), "anchor entry")).hash);
  const owners = hashes.map((hash) => ownerOf(hash));
  const missing = owners.findIndex((owner) => !owner);
  if (missing >= 0) {
    throw new Error(staleAnchorMessage(refs[missing]!, hashes[missing]!, owners));
  }
  const paths = new Set(owners.map((owner) => owner!.path));
  if (paths.size > 1) {
    throw new Error(
      `[E_BAD_SHAPE] The anchors are owned by different files (${owners.map((owner) => owner!.path).join(", ")}); edit one file per call.`,
    );
  }
  return owners[0]!.path;
}

export function tryResolveEditTarget(removeFrom: string | undefined, removeTo?: string): string | undefined {
  if (typeof removeFrom !== "string") return undefined;
  try {
    return resolveEditTarget(removeFrom, removeTo);
  } catch {
    return undefined;
  }
}

export interface PathRequirementInput {
  removeFrom?: string;
  removeTo?: string;
  anchor?: string;
  providedPath?: unknown;
  cwd: string;
}

export async function resolveEditTargetWithRequirement(input: PathRequirementInput): Promise<string> {
  const { requirePath } = await readConfig();
  if (!requirePath && input.providedPath !== undefined) {
    throw new Error("[E_BAD_SHAPE] Edit request contains unknown or unsupported fields: path. Path resolution is anchor-only; retry without `path`.");
  }
  if (requirePath && (typeof input.providedPath !== "string" || input.providedPath.length === 0)) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string when require-path mode is on. Provide `path` matching the file the anchors were served for.');
  }
  const anchorTarget = typeof input.anchor === "string"
    ? resolveEditTarget(input.anchor)
    : resolveEditTarget(input.removeFrom as string, input.removeTo);
  if (requirePath) {
    const { resolved } = await resolveInCwd(input.providedPath as string, input.cwd);
    if (resolved !== anchorTarget) {
      throw new Error(`[E_BAD_SHAPE] Provided "path" "${input.providedPath}" does not match anchor ownership "${anchorTarget}".`);
    }
  }
  return anchorTarget;
}

const AUTO_FIX_WARNING_CODES = ["[W_BAD_SHAPE]", "[W_BAD_REF]", "[W_INVALID_PATCH]", "[W_BARE_HASH_PREFIX]"];
export async function throwIfStrictInput(warnings: string[]): Promise<void> {
  const fixes = warnings.filter((warning) => AUTO_FIX_WARNING_CODES.some((code) => warning.startsWith(code)));
  if (fixes.length === 0) return;
  const { strictInput } = await readConfig();
  if (strictInput === true) {
    throw new Error(`[E_BAD_SHAPE] Strict-input mode rejects auto-fixable input:\n${fixes.join("\n")}`);
  }
}

export function editRenderCallWrapper(
  preview: (args: unknown, cwd: string, signal?: AbortSignal) => Promise<RPreview>,
  getInput?: (args: unknown) => { path?: string } | null,
  toolName?: string,
) {
  return makeRenderCall(preview, {
    getInput,
    toolName,
    resolveTarget: (input) => {
      if (typeof input.remove_from === "string") return tryResolveEditTarget(input.remove_from, input.remove_to);
      if (typeof input.anchor === "string") return tryResolveEditTarget(input.anchor);
      return undefined;
    },
  });
}

export function editRenderResultWrapper(
  result: { content?: Array<{ type: string; text?: string }>; details?: ReplaceDetails },
  opts: { isPartial: boolean; expanded?: boolean } | boolean,
  theme: FgT,
  context: any,
) {
  return renderEditResult(result, opts, theme, context);
}

export const editToolBase = {
  prepareArguments: editPrepare,
  executionMode: "sequential" as const,
  renderShell: "default" as const,
};

export async function queuedEdit<T>(
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
  work: (absolute: string, resolved: string) => Promise<T>,
): Promise<T> {
  abortIf(signal);
  const { absolute, resolved } = await resolveInCwd(path, cwd);
  return withFileMutationQueue(resolved, async () => {
    abortIf(signal);
    return work(absolute, resolved);
  });
}

