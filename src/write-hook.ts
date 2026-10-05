import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HASH_CLASS } from "./hashline/alphabet";
import { HASH_SEP } from "./hashline/hash";
import { servedForPath, withAnchorSession } from "./anchor-registry";
import { resolveInCwd } from "./fs-write";
import { abortIf, splitLines, isRec } from "./utils";
import type { ModelLike } from "./model-gate";

const HASH_ECHO_RE = new RegExp(`^(?: *[0-9]+ ${HASH_SEP} )?[+ -]?(${HASH_CLASS})${HASH_SEP}`);

function searchEcho(lines: string[], served: ReadonlyMap<string, string> | ReadonlySet<string>): { line: number; hash: string } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const match = HASH_ECHO_RE.exec(lines[i]!);
    if (match && served.has(match[1]! as never)) return { line: i + 1, hash: match[1]! };
  }
  return undefined;
}

export function findServedHashEcho(content: string, served: ReadonlyMap<string, string> | ReadonlySet<string>): { line: number; hash: string } | undefined {
  return searchEcho(splitLines(content), served);
}

export async function servedHashEchoDenial(rawPath: string, content: string, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  abortIf(signal);
  const { resolved } = await resolveInCwd(rawPath, cwd);
  abortIf(signal);
  const served = servedForPath(resolved);
  if (!served || served.size === 0) return undefined;
  const echo = findServedHashEcho(content, served);
  if (!echo) return undefined;
  return `[E_WRITE_HASH_ECHO] Refused write to ${rawPath}: line ${echo.line} contains the copied ${echo.hash}${HASH_SEP} anchor served for this file. Remove the copied anchors and retry.`;
}

export function registerWriteHook(pi: ExtensionAPI, isModelDisabled?: (model: ModelLike | undefined) => boolean): void {
  pi.on("tool_call", async (event, ctx) => withAnchorSession(ctx, async () => {
    if (event.toolName !== "write") return;
    if (isModelDisabled?.(ctx.model)) return;
    const input = event.input as Record<string, unknown> | undefined;
    if (!input || !isRec(input)) return;
    const rawPath = input.path as unknown;
    const content = input.content as unknown;
    if (typeof rawPath !== "string" || typeof content !== "string") return;
    const signal = ctx.signal;
    try {
      const reason = await servedHashEchoDenial(rawPath, content, ctx.cwd, signal);
      if (reason !== undefined) return { block: true, reason };
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error("write hook failed:", error);
    }
    return;
  }));
}
