import { describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anchorFor, getText, setupIntegrationTest, withTempDir } from "../support/fixtures";

const state = vi.hoisted(() => ({ tamper: "", missing: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (target: unknown, options?: unknown) => {
      if (state.missing !== "" && String(target).endsWith(state.missing)) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      if (state.tamper !== "" && String(target).endsWith(state.tamper)) return "external change\n";
      return (actual.readFile as unknown as (path: unknown, opts?: unknown) => Promise<string>)(target, options);
    },
  };
});

async function setupMove(dir: string) {
  writeFileSync(join(dir, "a.ts"), "alpha\nbeta\ngamma\n", "utf-8");
  writeFileSync(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
  const tools = setupIntegrationTest(dir);
  const aText = getText(await tools.readTool.execute("r1", { path: "a.ts" }, undefined, undefined, tools.ctx));
  const bText = getText(await tools.readTool.execute("r2", { path: "b.ts" }, undefined, undefined, tools.ctx));
  return { ...tools, beta: anchorFor(aText, "beta"), two: anchorFor(bText, "two") };
}

describe("cross-file move stale guard", () => {
  it("aborts without writing when the destination changed after the move started", async () => {
    await withTempDir("transfer-stale-dest-", async (dir) => {
      const { ctx, getTool, beta, two } = await setupMove(dir);
      state.tamper = "b.ts";
      const result = await getTool("move").execute("m1", { source_from: beta, source_to: beta, direction: "after", anchor: two }, undefined, undefined, ctx);
      state.tamper = "";
      expect(getText(result)).toContain("[E_OP_ABORTED]");
      expect(getText(result)).toContain("b.ts changed after the move started");
      expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
      expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\n");
    });
  });

  it("aborts without writing when the source changed after the move started", async () => {
    await withTempDir("transfer-stale-source-", async (dir) => {
      const { ctx, getTool, beta, two } = await setupMove(dir);
      state.tamper = "a.ts";
      const result = await getTool("move").execute("m1", { source_from: beta, source_to: beta, direction: "after", anchor: two }, undefined, undefined, ctx);
      state.tamper = "";
      expect(getText(result)).toContain("[E_OP_ABORTED]");
      expect(getText(result)).toContain("a.ts changed after the move started");
      expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
      expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\n");
    });
  });

  it("aborts without writing when the destination was deleted after the move started", async () => {
    await withTempDir("transfer-deleted-dest-", async (dir) => {
      const { ctx, getTool, beta, two } = await setupMove(dir);
      state.missing = "b.ts";
      const result = await getTool("move").execute("m1", { source_from: beta, source_to: beta, direction: "after", anchor: two }, undefined, undefined, ctx);
      state.missing = "";
      expect(getText(result)).toContain("[E_OP_ABORTED]");
      expect(getText(result)).toContain("b.ts was deleted after the move started");
      expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
      expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\n");
    });
  });

  it("aborts without writing when the source was deleted after the move started", async () => {
    await withTempDir("transfer-deleted-source-", async (dir) => {
      const { ctx, getTool, beta, two } = await setupMove(dir);
      state.missing = "a.ts";
      const result = await getTool("move").execute("m1", { source_from: beta, source_to: beta, direction: "after", anchor: two }, undefined, undefined, ctx);
      state.missing = "";
      expect(getText(result)).toContain("[E_OP_ABORTED]");
      expect(getText(result)).toContain("a.ts was deleted after the move started");
      expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
      expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\n");
    });
  });
});
