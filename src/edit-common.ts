import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveInCwd } from "./fs-write";
import { abortIf, makePrepareArguments } from "./utils";
import { ownerOf, ownersDifferingOnlyByCase, type OwnedAnchor } from "./anchor-registry";
import { assertRangeServed, lineChecksum, parseHashRef, stripAnchorRow } from "./hashline";
import { readConfig } from "./config";
import { makeRenderCall, renderEditResult, type RPreview, type FgT } from "./replace-render";
import type { ReplaceDetails } from "./replace";
export const editPrepare = makePrepareArguments();

export interface EditToolFlags {
  requirePath: boolean;
  strictInput: boolean;
  autoRead: boolean;
  autoReadAllActive: boolean;
  replaceMatchEnabled: boolean;
  copyMoveEnabled: boolean;
  codemode: boolean;
}

export const DEFAULT_EDIT_FLAGS: EditToolFlags = {
  requirePath: false,
  strictInput: false,
  autoRead: true,
  autoReadAllActive: false,
  replaceMatchEnabled: true,
  copyMoveEnabled: true,
  codemode: false,
};

export async function currentEditFlags(codemode = false): Promise<EditToolFlags> {
  const config = await readConfig();
  return {
    requirePath: config.requirePath === true,
    strictInput: config.strictInput === true,
    autoRead: config.autoRead !== false,
    autoReadAllActive: (config.autoReadAll ?? "off") !== "off",
    replaceMatchEnabled: config.replaceMatchEnabled !== false,
    copyMoveEnabled: config.copyMoveEnabled !== false,
    codemode
  };
}

function preferenceGuideline(flags: EditToolFlags): string {
  const tools = gatedEditOps(["read", "replace", "replace_match", "insert", "copy", "move", "undo_last_change"], flags);
  return `Prefer the hashline tools for anything that touches files: ${joinOps(tools, { backtick: true })}.`;
}

const SHARED_EDIT_OPS = ["replace", "replace_match", "insert", "copy", "move"];
const SHARED_PAYLOAD_OPS = ["replace", "replace_match", "insert"];
const SHARED_DIFF_OPS = ["replace", "replace_match", "insert", "copy", "move", "undo_last_change"];
const RESULT_CONTRACT_GUIDELINE =
  'When called from a codemode script, failures resolve to `{ ok: false, kind: "error", error: { code, message } }`; branch on `ok` instead of `try`/`catch`.';
const SCRIPT_BATCH_GUIDELINE =
  "Script calls apply immediately in order, and only the most recent edit per file is undoable.";
const SCRIPT_TRANSFER_GUIDELINE =
  "`copy`/`move`: a call from a codemode script commits on its own and never joins a batch; a script cross-file `move` shows both the source and destination diffs.";
const SCRIPT_UNDO_GUIDELINE =
  "`undo_last_change`: each edit from one codemode script takes the undo slot, so only the most recent is undoable.";

function operationNames(ops: string[], flags: EditToolFlags): string {
  return joinOps(gatedEditOps(ops, flags), { backtick: true, separator: "/" });
}

function batchGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_EDIT_OPS, flags);
  const outcome = flags.autoRead ? "diff" : "result";
  const script = flags.codemode ? ` ${SCRIPT_BATCH_GUIDELINE}` : "";
  return `${tools}: same-file calls in one message are grouped into one batch; earlier calls reply \`In batch N (queued)\` and the last call shows the combined ${outcome}, with one undo for the whole batch.${script}`;
}

function diffGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_DIFF_OPS, flags);
  return `${tools}: in the post-edit diff, \`-anchor│\` rows are dead anchors; \`+anchor│\` and \` anchor│\` rows are live anchors for the next edit.`;
}

function pathGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_EDIT_OPS, flags);
  return flags.requirePath
    ? `${tools}: pass \`path\` matching the file the anchors were served for; it is required and must match anchor ownership.`
    : `${tools}: path resolution is anchor-only; do not pass \`path\`.`;
}

function payloadGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_PAYLOAD_OPS, flags);
  return `${tools}: JSON decoding happens once, before the tool; the tool writes the string it receives and never decodes — \`\\uXXXX\` is the character, \`\\\\uXXXX\` the literal text.`;
}

function strictInputGuideline(flags: EditToolFlags): string {
  const tools = operationNames(SHARED_EDIT_OPS, flags);
  return `${tools}: strict-input mode is on; auto-fixable slips are rejected instead of fixed with warnings.`;
}

function finalizePrompts(
  description: string,
  snippet: string,
  guidelines: string[],
  flags: EditToolFlags,
  options?: { stringPayload?: boolean },
): { description: string; snippet: string; guidelines: string[] } {
  const shared = [batchGuideline(flags), pathGuideline(flags)];
  if (flags.codemode) shared.push(RESULT_CONTRACT_GUIDELINE);
  if (flags.autoRead) shared.push(diffGuideline(flags));
  if (options?.stringPayload !== false) shared.push(payloadGuideline(flags));
  if (flags.strictInput) shared.push(strictInputGuideline(flags));
  return { description, snippet, guidelines: [...guidelines, ...shared] };
}

export function withReplacePrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  let description = base.description;
  const guidelines = [preferenceGuideline(flags), ...base.guidelines];
  if (!flags.replaceMatchEnabled) {
    description = description.replace(/\n?To change only part of a line without retyping the rest, use `replace_match` instead; it preserves every character the request does not name\./, "");
  }
  return finalizePrompts(description, base.snippet, guidelines, flags);
}

export function withReadPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const preference = preferenceGuideline(flags);
  const script = flags.codemode ? [RESULT_CONTRACT_GUIDELINE] : [];
  if (flags.autoReadAllActive) {
    const rewritten = base.guidelines
      .filter((guideline) => !guideline.includes("call again after an edit"))
    return { description: base.description, snippet: base.snippet, guidelines: [preference, ...rewritten, ...script] };
  }
  if (flags.autoRead) return { description: base.description, snippet: base.snippet, guidelines: [preference, ...base.guidelines, ...script] };
  const guidelines = [preference, ...base.guidelines, ...script];
  const mapped = guidelines.map((guideline) => guideline.startsWith("`read`: call again after an edit") ? "`read`: call again after an edit when you need anchors you lack." : guideline);
  return { description: base.description, snippet: base.snippet, guidelines: mapped };
}

export function withInsertPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const guidelines = [...base.guidelines];
  return finalizePrompts(base.description, base.snippet, guidelines, flags);
}

export function withReplaceMatchPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const guidelines = [...base.guidelines];
  return finalizePrompts(base.description, base.snippet, guidelines, flags);
}

function gatedEditOps(ops: string[], flags: EditToolFlags): string[] {
  return ops.filter((op) => {
    if (op === "replace_match") return flags.replaceMatchEnabled;
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

export function withGrepPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  if (!flags.codemode && flags.copyMoveEnabled) return base;
  const guidelines = flags.codemode ? [...base.guidelines, RESULT_CONTRACT_GUIDELINE] : base.guidelines;
  if (flags.copyMoveEnabled) return { ...base, guidelines };
  return { ...base, guidelines, description: base.description.replaceAll("replace, insert, copy, or move", joinOps(gatedEditOps(["replace", "insert", "copy", "move"], flags))) };
}

export function withUndoPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const ops = gatedEditOps(["replace", "replace_match", "insert", "copy", "move"], flags);
  let description = base.description;
  let snippet = base.snippet;
  const script = flags.codemode ? [RESULT_CONTRACT_GUIDELINE, SCRIPT_UNDO_GUIDELINE] : [];
  let guidelines = [...base.guidelines, ...script];
  if (!flags.autoRead) {
    guidelines = guidelines.map((guideline) => guideline.includes("bad diff") ? "`undo_last_change`: only the last `replace`/`replace_match`/`insert`/`copy`/`move` per file is undoable; a `write` clears it, so undo right after a bad edit — review what you're restoring." : guideline);
  }
  if (ops.length !== 5) {
    description = description.replaceAll("replace, replace_match, insert, copy, or move", joinOps(ops));
    snippet = snippet.replaceAll("`replace`, `replace_match`, `insert`, `copy`, or `move`", joinOps(ops, { backtick: true }));
    guidelines = guidelines.map((guideline) => guideline.replaceAll("`replace`/`replace_match`/`insert`/`copy`/`move`", joinOps(ops, { backtick: true, separator: "/" })));
  }
  if (!flags.copyMoveEnabled) {
    guidelines = guidelines.filter((guideline) => !guideline.includes("cross-file `move`"));
  }
  return { description, snippet, guidelines };
}

export function withTransferPrompts(base: { description: string; snippet: string; guidelines: string[] }, flags: EditToolFlags): { description: string; snippet: string; guidelines: string[] } {
  const guidelines = flags.codemode ? [...base.guidelines, SCRIPT_TRANSFER_GUIDELINE] : [...base.guidelines];
  return finalizePrompts(base.description, base.snippet, guidelines, flags, { stringPayload: false });
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

export function trustRangeServed(
  fileLines: string[],
  fileHashes: string[],
  served: ReadonlyMap<string, string> | undefined,
  startLine: number,
  endLine: number,
): ReadonlyMap<string, string> | undefined {
  if (served === undefined) return undefined;
  const merged = new Map(served);
  for (let line = startLine; line <= endLine; line += 1) {
    merged.set(fileHashes[line - 1]!, lineChecksum(fileLines[line - 1]!));
  }
  return merged;
}

export function assertBoundaryLinesServed(
  fileLines: string[],
  fileHashes: string[],
  served: ReadonlyMap<string, string> | undefined,
  startLine: number,
  endLine: number,
  displayPath: string,
): void {
  if (served === undefined) return;
  assertRangeServed(
    {
      content_lines: [],
      hash_bounds: [
        { line: startLine, hash: fileHashes[startLine - 1]! },
        { line: endLine, hash: fileHashes[endLine - 1]! },
      ],
    },
    fileLines,
    fileHashes,
    served,
    displayPath,
  );
}
