import { describe, expect, it, vi } from "vitest";
import * as registry from "../../src/anchor-registry";
import {
  anchorFor,
  assistantMessage,
  getText,
  setupIntegrationTest,
  toolCall,
  withTempFile,
} from "../support/fixtures";

const FREED = "/project/old.ts";

describe("anchor reclaim warnings", () => {
  it("appends the notice to read output", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const spy = vi.spyOn(registry, "takeReclaimedPaths").mockReturnValueOnce([FREED]);
      try {
        const result = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
        const text = getText(result);
        expect(text).toContain("[W_ANCHOR_RECLAIMED]");
        expect(text).toContain(FREED);
        expect(text).toContain("least recently read or edited");
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("adds the notice to replace warnings and model-visible text", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r0", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const spy = vi.spyOn(registry, "takeReclaimedPaths").mockReturnValueOnce([FREED]);
      try {
        const result = await getTool("replace").execute(
          "e1",
          { remove_from: beta, remove_to: beta, replacement_lines: ["BETA"] },
          undefined,
          undefined,
          ctx,
        );
        expect(result.details.warnings).toEqual(expect.arrayContaining([expect.stringContaining("[W_ANCHOR_RECLAIMED]")]));
        expect(getText(result)).toContain("[W_ANCHOR_RECLAIMED]");
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("adds a note to anchor_grep output", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const spy = vi.spyOn(registry, "takeReclaimedPaths").mockReturnValueOnce([FREED]);
      try {
        const result = await getTool("anchor_grep").execute(
          "g1",
          { pattern: "beta", path: "sample.txt" },
          undefined,
          undefined,
          ctx,
        );
        const text = getText(result);
        expect(text).toContain("[W_ANCHOR_RECLAIMED]");
        expect(text).toContain(FREED);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("adds the notice to the combined batch result", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r0", { path: "sample.txt" }, undefined, undefined, ctx));
      const betaArgs = { remove_from: anchorFor(text, "beta"), remove_to: anchorFor(text, "beta"), replacement_lines: ["BETA"] };
      const gammaArgs = { remove_from: anchorFor(text, "gamma"), remove_to: anchorFor(text, "gamma"), replacement_lines: ["GAMMA"] };
      await handlers.get("message_end")!(
        { type: "message_end", message: assistantMessage([toolCall("b1", "replace", betaArgs), toolCall("b2", "replace", gammaArgs)]) },
        ctx,
      );
      const spy = vi.spyOn(registry, "takeReclaimedPaths").mockReturnValueOnce([FREED]);
      try {
        await getTool("replace").execute("b1", betaArgs, undefined, undefined, ctx);
        const last = await getTool("replace").execute("b2", gammaArgs, undefined, undefined, ctx);
        expect(last.details.warnings).toEqual(expect.arrayContaining([expect.stringContaining("[W_ANCHOR_RECLAIMED]")]));
        expect(getText(last)).toContain("[W_ANCHOR_RECLAIMED]");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
