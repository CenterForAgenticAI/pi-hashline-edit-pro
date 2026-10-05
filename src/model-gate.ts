export interface ModelLike {
  id?: string;
  provider?: string;
  api?: string;
}

export const ANCHOR_TOOL_NAMES: readonly string[] = [
  "read",
  "replace",
  "replace_match",
  "insert",
  "copy",
  "move",
  "anchor_grep",
  "undo_last_change",
];

const GLOB_CACHE_LIMIT = 64;
const regexCache = new Map<string, RegExp>();

function globRegexFor(glob: string): RegExp {
  const cached = regexCache.get(glob);
  if (cached !== undefined) return cached;
  let source = "^";
  for (const char of glob) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  const regex = new RegExp(`${source}$`, "i");
  if (regexCache.size >= GLOB_CACHE_LIMIT) {
    const oldest = regexCache.keys().next().value;
    if (oldest !== undefined) regexCache.delete(oldest);
  }
  regexCache.set(glob, regex);
  return regex;
}

export function modelLabels(model: ModelLike): string[] {
  const labels: string[] = [];
  if (typeof model.id === "string" && model.id.length > 0) {
    labels.push(model.id);
    if (typeof model.provider === "string" && model.provider.length > 0) {
      labels.push(`${model.provider}/${model.id}`);
    }
  }
  if (typeof model.api === "string" && model.api.length > 0) labels.push(model.api);
  return labels;
}

export function modelDisabled(model: ModelLike | undefined, globs: readonly string[]): boolean {
  if (model === undefined || globs.length === 0) return false;
  const labels = modelLabels(model);
  if (labels.length === 0) return false;
  return globs.some((glob) => labels.some((label) => globRegexFor(glob).test(label)));
}
