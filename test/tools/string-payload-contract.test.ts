import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";
import { anchorFor, assistantMessage, getText, setupIntegrationTest, toolCall, withTempFile } from "../support/fixtures";

describe("string payload contract", () => {
  it("inserts a quoted payload ending in a newline without adding a blank line", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      await getTool("insert").execute(
        "i1",
        { anchor: beta, direction: "before", lines: "inserted line 1\ninserted line 2\n" },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\ninserted line 1\ninserted line 2\nbeta\ngamma\n");
    });
  });

  it("keeps a quoted payload's internal blank line", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      await getTool("insert").execute("i1", { anchor: alpha, direction: "after", lines: "one\n\ntwo\n" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\none\n\ntwo\nbeta\n");
    });
  });

  it("inserts nothing for an empty lines string", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const result = await getTool("insert").execute("i1", { anchor: alpha, direction: "after", lines: "" }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("No changes made");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("inserts one blank line for a newline-only lines string", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      await getTool("insert").execute("i1", { anchor: alpha, direction: "after", lines: "\n" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\n\nbeta\n");
    });
  });

  it("replaces a range with the exact text and no trailing blank line", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const b = anchorFor(text, "b");
      await getTool("replace").execute("e1", { remove_from: b, remove_to: b, replacement_lines: "B1\nB2" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("a\nB1\nB2\nc\n");
    });
  });

  it("deletes a range for an empty replacement string", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const b = anchorFor(text, "b");
      await getTool("replace").execute("e1", { remove_from: b, remove_to: b, replacement_lines: "" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("a\nc\n");
    });
  });

  it("writes one blank line for a newline-only replacement string", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const b = anchorFor(text, "b");
      await getTool("replace").execute("e1", { remove_from: b, remove_to: b, replacement_lines: "\n" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("a\n\nc\n");
    });
  });

  it("sets a line's ending from a trailing break without adding a blank line", async () => {
    await withTempFile("sample.ts", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      await getTool("replace").execute("e1", { remove_from: beta, remove_to: beta, replacement_lines: "beta\n" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\r\nbeta\ngamma\r\n");
    });
  });

  it("applies a string-payload batch as one commit", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const firstArgs = { remove_from: beta, remove_to: beta, replacement_lines: "beta1\nbeta2" };
      const secondArgs = { remove_from: gamma, remove_to: gamma, replacement_lines: "GAMMA" };
      await handlers.get("message_end")!(
        { type: "message_end", message: assistantMessage([toolCall("b1", "replace", firstArgs), toolCall("b2", "replace", secondArgs)]) },
        ctx,
      );
      const replace = getTool("replace");
      await replace.execute("b1", firstArgs, undefined, undefined, ctx);
      const last = await replace.execute("b2", secondArgs, undefined, undefined, ctx);
      expect(last.content[0].text).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta1\nbeta2\nGAMMA\ndelta\n");
    });
  });

  it("keeps a trailing blank line when a legacy array is still used", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const b = anchorFor(text, "b");
      await getTool("replace").execute("e1", { remove_from: b, remove_to: b, replacement_lines: ["B", ""] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("a\nB\n\nc\n");
    });
  });

  it("rejects an array for the string schema at the tool boundary", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
      const b = anchorFor(text, "b");
      const { assertReq } = await import("../../src/payload-contract");
      expect(() => assertReq({ remove_from: b, remove_to: b, replacement_lines: ["B"] })).toThrow(
        '[E_BAD_SHAPE] "replacement_lines" must be a string',
      );
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });
});
