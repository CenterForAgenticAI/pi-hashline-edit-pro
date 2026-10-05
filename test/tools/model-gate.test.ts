import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import register from "../../index";
import { makePiStub, withTempDir } from "../support/fixtures";

const OPENAI = { provider: "openai", id: "gpt-5.1-codex", api: "openai-codex-responses" };
const ANTHROPIC = { provider: "anthropic", id: "claude-sonnet-4", api: "anthropic-messages" };

const ANCHOR_TOOLS = ["read", "replace", "replace_match", "insert", "copy", "move", "anchor_grep", "undo_last_change"];

async function writeConfig(dir: string, config: Record<string, unknown>): Promise<void> {
  const configDir = join(dir, ".config", "pi-hashline-edit-pro");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify(config), "utf-8");
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

function sessionContext(cwd: string, model: unknown) {
  return {
    cwd,
    model,
    hasUI: false,
    ui: { notify: vi.fn() },
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => join(cwd, "session.jsonl"),
      getSessionId: () => "model-gate",
    },
  } as never;
}

function modelSelect(model: unknown, previousModel: unknown) {
  return { type: "model_select", model, previousModel, source: "set" };
}

describe("disableOnModels gate", () => {
  it("disables the anchored surface for a matching model and restores grep", async () => {
    await withTempDir("model-gate-off-", async (dir) => {
      await writeConfig(dir, { autoRead: true, anchorGrepEnabled: true, disableOnModels: ["openai/*"] });
      const { pi, handlers, getActive } = makePiStub([...ANCHOR_TOOLS, "grep", "edit"]);
      register(pi);
      await handlers.get("session_start")!({}, sessionContext(dir, OPENAI));
      expect(getActive()).toEqual(["grep"]);
    });
  });

  it("keeps an already active built-in grep when gating a model", async () => {
    await withTempDir("model-gate-grep-", async (dir) => {
      await writeConfig(dir, { autoRead: true, anchorGrepEnabled: false, disableOnModels: ["openai/*"] });
      const { pi, handlers, getActive } = makePiStub([...ANCHOR_TOOLS, "grep", "edit"]);
      register(pi);
      await handlers.get("session_start")!({}, sessionContext(dir, OPENAI));
      expect(getActive()).toEqual(["grep"]);
    });
  });

  it("keeps the anchored surface for a non-matching model", async () => {
    await withTempDir("model-gate-on-", async (dir) => {
      await writeConfig(dir, { autoRead: true, anchorGrepEnabled: true, disableOnModels: ["openai/*"] });
      const { pi, handlers, getActive } = makePiStub([...ANCHOR_TOOLS, "grep", "edit"]);
      register(pi);
      await handlers.get("session_start")!({}, sessionContext(dir, ANTHROPIC));
      expect(getActive()).toEqual([...ANCHOR_TOOLS]);
    });
  });

  it("switches the surface when the model changes mid-session", async () => {
    await withTempDir("model-gate-switch-", async (dir) => {
      await writeConfig(dir, { autoRead: true, anchorGrepEnabled: true, disableOnModels: ["*gpt*"] });
      const { pi, handlers, getActive } = makePiStub([...ANCHOR_TOOLS, "grep", "edit"]);
      register(pi);
      const ctx = sessionContext(dir, ANTHROPIC);
      await handlers.get("session_start")!({}, ctx);
      expect(getActive()).toEqual([...ANCHOR_TOOLS]);
      await handlers.get("model_select")!(modelSelect(OPENAI, ANTHROPIC), ctx);
      expect(getActive()).toEqual(["grep"]);
      await handlers.get("model_select")!(modelSelect(ANTHROPIC, OPENAI), ctx);
      expect(getActive()).toEqual([...ANCHOR_TOOLS]);
    });
  });

  it("skips the auto-read-all injection for a matching model and injects after a switch", async () => {
    await withTempDir("model-gate-inject-", async (dir) => {
      await writeConfig(dir, { autoRead: true, anchorGrepEnabled: true, autoReadAll: "on", disableOnModels: ["openai/*"] });
      initGitRepo(dir);
      await writeFile(join(dir, "sample.txt"), "alpha\nbeta\n", "utf-8");
      const { pi, handlers } = makePiStub([...ANCHOR_TOOLS, "grep", "edit"]);
      register(pi);
      const gated = sessionContext(dir, OPENAI);
      await handlers.get("session_start")!({}, gated);
      expect(await handlers.get("before_agent_start")!({}, gated)).toBeUndefined();
      const open = sessionContext(dir, ANTHROPIC);
      await handlers.get("model_select")!(modelSelect(ANTHROPIC, OPENAI), open);
      const injected = await handlers.get("before_agent_start")!({}, open) as { message?: { content?: string } } | undefined;
      expect(injected?.message?.content).toContain("=== sample.txt ===");
    });
  });

  it("skips auto-read after write for a matching model", async () => {
    await withTempDir("model-gate-write-", async (dir) => {
      await writeConfig(dir, { autoRead: true, anchorGrepEnabled: true, disableOnModels: ["openai/*"] });
      await writeFile(join(dir, "written.txt"), "hello\n", "utf-8");
      const { pi, handlers } = makePiStub([...ANCHOR_TOOLS, "grep", "edit"]);
      register(pi);
      const gated = sessionContext(dir, OPENAI);
      await handlers.get("session_start")!({}, gated);
      const writeResult = await handlers.get("tool_result")!(
        { toolName: "write", isError: false, input: { path: "written.txt" }, content: [{ type: "text", text: "written" }] },
        gated,
      );
      expect(writeResult).toBeUndefined();
      const open = sessionContext(dir, ANTHROPIC);
      await handlers.get("session_start")!({}, open);
      const openResult = await handlers.get("tool_result")!(
        { toolName: "write", isError: false, input: { path: "written.txt" }, content: [{ type: "text", text: "written" }] },
        open,
      ) as { content?: Array<{ text?: string }> } | undefined;
      expect(openResult?.content?.[1]?.text).toContain("--- Auto-read (hashline anchors) ---");
    });
  });

  it("skips the post-edit diff for a matching model", async () => {
    await withTempDir("model-gate-diff-", async (dir) => {
      await writeConfig(dir, { autoRead: true, anchorGrepEnabled: true, disableOnModels: ["openai/*"] });
      await writeFile(join(dir, "diff.txt"), "alpha\nbeta\n", "utf-8");
      const { pi, handlers } = makePiStub([...ANCHOR_TOOLS, "grep", "edit"]);
      register(pi);
      const gated = sessionContext(dir, OPENAI);
      await handlers.get("session_start")!({}, gated);
      const result = await handlers.get("tool_result")!(
        {
          toolName: "replace",
          isError: false,
          input: { remove_from: "aaaa", remove_to: "aaaa", text: "BETA" },
          details: { diff: " alpha\n-   │beta\n+xxxx│BETA", metrics: { classification: "applied" } },
          content: [{ type: "text", text: "Successfully replaced." }],
        },
        gated,
      );
      expect(result).toBeUndefined();
    });
  });

  it("lets a write echoing a served anchor pass for a matching model", async () => {
    await withTempDir("model-gate-hook-", async (dir) => {
      await writeConfig(dir, { autoRead: true, anchorGrepEnabled: true, disableOnModels: ["openai/*"] });
      await writeFile(join(dir, "echo.txt"), "hello\n", "utf-8");
      const { pi, handlers, getTool } = makePiStub([...ANCHOR_TOOLS, "grep", "edit"]);
      register(pi);
      const open = sessionContext(dir, ANTHROPIC);
      await handlers.get("session_start")!({}, open);
      const read = await getTool("read").execute("r1", { path: "echo.txt" }, undefined, undefined, open);
      const anchor = read.content[0]!.text.match(/([A-Za-z]{4})│hello/)![1]!;
      const gated = sessionContext(dir, OPENAI);
      const gatedResult = await handlers.get("tool_call")!(
        { toolName: "write", input: { path: "echo.txt", content: `${anchor}│copied\n` } },
        gated,
      );
      expect(gatedResult).toBeUndefined();
      const openResult = await handlers.get("tool_call")!(
        { toolName: "write", input: { path: "echo.txt", content: `${anchor}│copied\n` } },
        open,
      );
      expect(openResult).toEqual(expect.objectContaining({ block: true }));
    });
  });
});
