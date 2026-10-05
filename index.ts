import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline";
import { regReplaceMatch } from "./src/replace-match";
import { regReplace } from "./src/replace";
import { regInsert } from "./src/insert";
import { regCopy, regMove } from "./src/copy-move";
import { regGrep } from "./src/grep";
import { regUndo, clearUndo } from "./src/replace-undo";
import { regRead, fmtReadPreview } from "./src/read";
import { ANCHOR_TOOL_NAMES, modelDisabled, type ModelLike } from "./src/model-gate";
import { buildAutoReadAllInjection, autoReadAllBudget } from "./src/auto-read-all";
import { clearAutoReadAllComplete } from "./src/auto-read-all-state";
import type { RMetrics } from "./src/replace-response";
import type { ReplaceDetails } from "./src/replace";
import { extractHints, extractWarnings } from "./src/replace-render";
import { MAX_HASH_LINES } from "./src/hashline";
import { withStructuredText } from "./src/structured";
import type { AutoReadAllMode } from "./src/config";
import {
  readConfig,
  readConfigWithStatus,
  toggleAutoRead,
  cycleAutoReadAllMode,
  toggleAnchorGrep,
  toggleCopyMove,
  toggleReplaceMatch,
  toggleRequirePath,
  toggleStrictInput,
  adjustDiffContextLines,
  setAutoReadAllIgnoreFromText,
  setDisableOnModelsFromText,
} from "./src/config";
import { loadHashStore, pruneMissing } from "./src/hash-store";
import { initRegistry, gcRegistrySidecars, clearRegistry, freeAnchors, sessionKeyFor, withAnchorSession, releaseRegistrySession, formatAnchorReclaimNotice, takeReclaimedPaths } from "./src/anchor-registry";
import { serveRows } from "./src/served";
import { finalizeTurn, planAssistantMessage } from "./src/batch";
import { currentEditFlags } from "./src/edit-common";
import { HashlineConfigOverlay } from "./src/config-ui";
import { registerWriteHook } from "./src/write-hook";
import { readNormFile } from "./src/file-reader";
import { loadFileKindAndText } from "./src/file-kind";
import { resolveInCwd } from "./src/fs-write";
import { valAccess } from "./src/validation";
import { splitLines } from "./src/utils";
import { AUTO_READ_ALL_CUSTOM_TYPE } from "./src/constants";

export default function (pi: ExtensionAPI): void {
  regRead(pi);

  regReplace(pi);
  regReplaceMatch(pi);
  regInsert(pi);
  regCopy(pi);
  regMove(pi);
  regGrep(pi);
  regUndo(pi);
  registerWriteHook(pi, (model) => modelDisabled(model, disableOnModels));

  let autoRead = true;
  let autoReadAll: AutoReadAllMode = "off";
  let autoReadAllIgnore: string[] = [];
  let disableOnModels: string[] = [];
  let autoReadAllInjected = false;
  let grepWasActive = false;
  const baseAnchorTools = new Set<string>();
  let gateApplied = false;

  async function refreshEditTools(): Promise<void> {
    try {
      const flags = await currentEditFlags(pi.getActiveTools().includes("codemode"));
      regRead(pi, flags);
      regReplace(pi, flags);
      regReplaceMatch(pi, flags);
      regInsert(pi, flags);
      regCopy(pi, flags);
      regMove(pi, flags);
      regGrep(pi, flags);
      regUndo(pi, flags);
    } catch (error) {
      console.error("Failed to refresh edit tools:", error);
    }
  }

  async function syncModelGate(model: ModelLike | undefined): Promise<void> {
    if (disableOnModels.length > 0 && modelDisabled(model, disableOnModels)) {
      const active = pi.getActiveTools();
      const next = active.filter((tool) => !ANCHOR_TOOL_NAMES.includes(tool));
      if (grepWasActive && !next.includes("grep")) next.push("grep");
      pi.setActiveTools(next);
      gateApplied = true;
      return;
    }
    if (!gateApplied) return;
    gateApplied = false;
    const config = await readConfig();
    const enabled = ANCHOR_TOOL_NAMES.filter((tool) => {
      if (!baseAnchorTools.has(tool)) return false;
      if (tool === "replace_match") return config.replaceMatchEnabled !== false;
      if (tool === "copy" || tool === "move") return config.copyMoveEnabled !== false;
      if (tool === "anchor_grep") return config.anchorGrepEnabled === true;
      return true;
    });
    let next = [...new Set([...pi.getActiveTools(), ...enabled])];
    if (enabled.includes("anchor_grep") && grepWasActive) next = next.filter((tool) => tool !== "grep");
    pi.setActiveTools(next);
  }

  pi.on("session_start", async (_event, ctx) => withAnchorSession(ctx, async () => {
    const active = pi.getActiveTools();
    grepWasActive = active.includes("grep");
    baseAnchorTools.clear();
    for (const tool of ANCHOR_TOOL_NAMES) {
      if (active.includes(tool)) baseAnchorTools.add(tool);
    }
    pi.setActiveTools(active.filter((t) => t !== "edit"));
    await initHasher();
    loadHashStore()
      .then(async store => {
        const missing = await pruneMissing(store);
        for (const path of missing) freeAnchors(path);
      })
      .catch(err => {
        console.error("Failed to load hash store:", err);
      });
    const sessionManager = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager;
    const sessionFile = sessionManager?.getSessionFile?.();
    if (sessionKeyFor(ctx) === undefined) await initRegistry(sessionFile);
    await gcRegistrySidecars();
    const { config, corrupted } = await readConfigWithStatus();
    if (corrupted && (ctx as { hasUI?: boolean }).hasUI) ctx.ui.notify("Hashline config was corrupt and was reset to defaults", "warning");
    autoRead = config.autoRead;
    autoReadAll = config.autoReadAll ?? "off";
    autoReadAllIgnore = config.autoReadAllIgnore ?? [];
    disableOnModels = config.disableOnModels ?? [];
    const sessionBranch = (ctx as { sessionManager?: { getBranch?: () => Array<{ type?: string; customType?: string }> } }).sessionManager?.getBranch?.() ?? [];
    autoReadAllInjected = sessionBranch.some((entry) => entry.type === "custom_message" && entry.customType === AUTO_READ_ALL_CUSTOM_TYPE);
    await refreshEditTools();
    pi.setActiveTools(
      pi.getActiveTools().filter((t) => {
        if (config.anchorGrepEnabled ? t === "grep" : t === "anchor_grep") return false;
        if (config.copyMoveEnabled === false && (t === "copy" || t === "move")) return false;
        if (config.replaceMatchEnabled === false && t === "replace_match") return false;
        return true;
      }),
    );
    await syncModelGate(ctx.model);
    const debugValue = process.env.PI_HASHLINE_DEBUG;
    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify(`Hashline Edit mode active`, "info");
    }
  }));

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const key = sessionKeyFor(ctx);
      clearAutoReadAllComplete(key);
      if (key !== undefined) releaseRegistrySession(key);
    } catch (error) {
      console.error("Failed to release anchor registry session:", error);
    }
  });
  pi.on("model_select", async (event, ctx) => withAnchorSession(ctx, async () => {
    await syncModelGate(event.model);
  }));

  pi.on("before_agent_start", async (_event, ctx) => withAnchorSession(ctx, async () => {
    await syncModelGate(ctx.model);
    if (autoReadAll === "off" || autoReadAllInjected) return;
    if (modelDisabled(ctx.model, disableOnModels)) return;
    autoReadAllInjected = true;
    try {
      const injection = await buildAutoReadAllInjection(ctx.cwd, autoReadAllBudget(ctx.model), autoReadAll, autoReadAllIgnore, sessionKeyFor(ctx));
      if (!injection) return;
      if (ctx.hasUI) ctx.ui.notify(`Auto-read all: attached ${injection.files} file(s) with anchors`, "info");
      return { message: { customType: AUTO_READ_ALL_CUSTOM_TYPE, content: injection.text, display: false } };
    } catch (error) {
      console.error("Auto-read all failed:", error);
      return;
    }
  }));

  pi.registerCommand("hashline-config", {
    description: "Open the hashline settings window (auto-read, auto-read all, ignore folders/files, disable on models, diff context, grep, copy/move, replace_match, path, strict input)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/hashline-config requires interactive mode", "error");
        return;
      }
      await ctx.ui.custom<void>(async (tui, theme, _keybindings, done) => {
        const overlay = new HashlineConfigOverlay({
          tui,
          theme,
          done,
          onToggle: async (key, delta, value) => {
            if (key === "autoRead") autoRead = await toggleAutoRead();
            else if (key === "autoReadAll") { autoReadAll = await cycleAutoReadAllMode(); autoReadAllInjected = false; }
            else if (key === "autoReadAllIgnore") autoReadAllIgnore = await setAutoReadAllIgnoreFromText(value ?? "");
            else if (key === "disableOnModels") disableOnModels = await setDisableOnModelsFromText(value ?? "");
            else if (key === "diffContextLines") await adjustDiffContextLines(delta ?? 1);
            else if (key === "anchorGrepEnabled") {
              const enabled = await toggleAnchorGrep();
              const active = pi.getActiveTools();
              pi.setActiveTools(enabled ? [...new Set([...active.filter((t) => t !== "grep"), "anchor_grep"])] : [...new Set([...active.filter((t) => t !== "anchor_grep"), ...(grepWasActive ? ["grep"] : [])])]);
              if (enabled) baseAnchorTools.add("anchor_grep");
              else baseAnchorTools.delete("anchor_grep");
            }
            else if (key === "copyMoveEnabled") {
              const enabled = await toggleCopyMove();
              const active = pi.getActiveTools();
              pi.setActiveTools(enabled ? [...new Set([...active, "copy", "move"])] : active.filter((t) => t !== "copy" && t !== "move"));
              for (const tool of ["copy", "move"]) {
                if (enabled) baseAnchorTools.add(tool);
                else baseAnchorTools.delete(tool);
              }
            }
            else if (key === "replaceMatchEnabled") {
              const enabled = await toggleReplaceMatch();
              const active = pi.getActiveTools();
              pi.setActiveTools(enabled ? [...new Set([...active, "replace_match"])] : active.filter((t) => t !== "replace_match"));
              if (enabled) baseAnchorTools.add("replace_match");
              else baseAnchorTools.delete("replace_match");
            }
            else if (key === "requirePath") await toggleRequirePath();
            else if (key === "strictInput") await toggleStrictInput();
            await refreshEditTools();
            await syncModelGate(ctx.model);
          },
        });
        await overlay.load();
        return overlay;
      }, {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", minWidth: 60, maxHeight: "90%" },
      });
    },
  });

  pi.registerCommand("clear-anchors", {
    description: "Clear the session's anchor claims (path-free resolution state); anchors are re-claimed on the next read",
    handler: async (_args, ctx) => withAnchorSession(ctx, async () => {
      clearRegistry();
      ctx.ui.notify(`Anchor claims cleared for this session`, "info");
    }),
  });
  pi.on("message_end", async (event, ctx) => withAnchorSession(ctx, async () => {
    try {
      await planAssistantMessage(event.message, ctx.cwd);
    } catch (error) {
      console.error("Failed to plan edit batch:", error);
    }
  }));
  pi.on("turn_end", async (event) => {
    try {
      const ids = (event.toolResults ?? []).map((result) => (result as { toolCallId?: unknown }).toolCallId).filter((id): id is string => typeof id === "string");
      await finalizeTurn(ids);
    } catch (error) {
      console.error("Failed to finalize edit batch:", error);
    }
  });
  pi.on("tool_result", async (event, ctx) => withAnchorSession(ctx, async () => {
    if (event.isError) return;
    const gated = modelDisabled(ctx.model, disableOnModels);

    if (event.toolName === "write") {
      const writtenPath = (event.input as Record<string, unknown>)?.path;
      let resolvedPath: string | undefined;
      if (typeof writtenPath === "string") {
        try {
          resolvedPath = (await resolveInCwd(writtenPath, ctx.cwd)).resolved;
          freeAnchors(resolvedPath);
          await clearUndo(resolvedPath);
        } catch (error) {
          console.error("Failed to clear undo after write:", error);
        }
      }
      if (!autoRead || gated) return;
      if (typeof writtenPath !== "string") return;
      try {
        resolvedPath ??= (await resolveInCwd(writtenPath, ctx.cwd)).resolved;
        await valAccess(resolvedPath, writtenPath);
        const file = await loadFileKindAndText(resolvedPath, { maxLines: MAX_HASH_LINES, displayPath: writtenPath });
        if (file.kind !== "text") return;
        const { normalized, fileHashes, absolutePath } = await readNormFile(
          writtenPath, ctx.cwd, { maxLines: MAX_HASH_LINES, preloadedFile: file },
        );
        const preview = await fmtReadPreview(
          normalized,
          {},
          fileHashes,
          absolutePath,
          DEFAULT_MAX_BYTES,
          DEFAULT_MAX_LINES,
        );
        const fileLines = splitLines(normalized);
        serveRows(absolutePath, fileHashes, fileLines, preview.servedHashes);
        const reclaimNotice = formatAnchorReclaimNotice(takeReclaimedPaths());
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}${reclaimNotice !== undefined ? `\n\n${reclaimNotice}` : ""}` },
          ],
        };
      } catch (error) {
        console.error("Auto-read after write failed:", error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read failed: ${message} ---` },
          ],
        };
      }
    }

    if (
      event.toolName !== "replace" &&
      event.toolName !== "replace_match" &&
      event.toolName !== "insert" &&
      event.toolName !== "copy" &&
      event.toolName !== "move" &&
      event.toolName !== "undo_last_change"
    ) return;
    if (!autoRead || gated) return;

    const metrics = (event.details as { metrics?: RMetrics } | undefined)?.metrics;
    if (metrics?.classification === "noop") return;

    const batched = (event.details as { batch?: { last?: boolean } } | undefined)?.batch;
    if (batched?.last === false) return;
    const toolDetails = event.details as ReplaceDetails | undefined;
    const diff = toolDetails?.diff;
    const detailWarnings = Array.isArray(toolDetails?.warnings) ? toolDetails.warnings.filter((w): w is string => typeof w === "string") : [];
    const detailHints = Array.isArray(toolDetails?.hints) ? toolDetails.hints.filter((h): h is string => typeof h === "string") : [];
    if (typeof diff !== "string") return;
    const hasDiff = diff.length > 0;

    const rendered = (event.content ?? [])
      .filter(
        (entry): entry is { type: "text"; text: string } =>
          entry.type === "text" && typeof entry.text === "string",
      )
      .map((entry) => entry.text)
      .join("\n");
    const warnings = detailWarnings.length ? `Warnings:\n${detailWarnings.join("\n")}` : extractWarnings(rendered);
    const hints = detailHints.length ? `Hints:\n${detailHints.join("\n")}` : extractHints(rendered);
    const notices = [warnings, hints].filter((part): part is string => part !== undefined).join("\n\n");
    const emptyDiffNotice = "[post-edit] applied successfully; the diff is empty (no content change: whitespace or line endings only).";
    const noticeText = hasDiff ? (notices ? `${diff}\n\n${notices}` : diff) : notices ? `${emptyDiffNotice}\n\n${notices}` : emptyDiffNotice;
    const structured = (event as { structuredContent?: unknown }).structuredContent;
    return {
      content: [
        {
          type: "text",
          text: noticeText,
        },
      ],
      ...(structured !== undefined ? { structuredContent: withStructuredText(structured, noticeText) } : {}),
    };
  }));
}
