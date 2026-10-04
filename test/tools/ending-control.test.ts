import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { anchorFor, assistantMessage, getText, setupIntegrationTest, toolCall, withTempFile } from "../support/fixtures";

describe("line endings via embedded breaks", () => {
  it("adds a missing final newline when the last line is replaced with a trailing break", async () => {
    await withTempFile("sample.txt", "alpha\nbeta", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const result = await editTool.execute(
        "e1",
        { remove_from: beta, remove_to: beta, text: ["beta\n"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("changes a CRLF line to LF without adding a blank line", async () => {
    await withTempFile("sample.txt", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const result = await editTool.execute(
        "e1",
        { remove_from: beta, remove_to: beta, text: ["beta\n"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\r\nbeta\ngamma\r\n");
    });
  });

  it("changes an LF line to CRLF without adding a blank line", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      await editTool.execute(
        "e1",
        { remove_from: beta, remove_to: beta, text: ["beta\r\n"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\r\ngamma\n");
    });
  });

  it("inserts a block ending with a break without a blank line", async () => {
    await withTempFile("sample.txt", "one\ntwo\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const one = anchorFor(text, "one");
      await getTool("insert").execute(
        "i1",
        { anchor: one, direction: "after", text: ["x", "y\n"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("one\nx\ny\ntwo\n");
    });
  });

  it("adds the final newline when inserting at end of file", async () => {
    await withTempFile("sample.txt", "one\ntwo", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const two = anchorFor(text, "two");
      await getTool("insert").execute(
        "i1",
        { anchor: two, direction: "after", text: ["x\n"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("one\ntwo\nx\n");
    });
  });

  it("reports no changes when the requested ending already matches", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const result = await editTool.execute(
        "e1",
        { remove_from: beta, remove_to: beta, text: ["beta\n"] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("No changes made");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("undo restores the original line endings", async () => {
    await withTempFile("sample.txt", "alpha\r\nbeta\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      await getTool("replace").execute(
        "e1",
        { remove_from: beta, remove_to: beta, text: ["beta\n"] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\r\nbeta\n");
      const undone = await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\r\nbeta\r\n");
    });
  });

  it("applies two ending-only replacements as one batch with one undo", async () => {
    await withTempFile("sample.txt", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const beta = anchorFor(text, "beta");
      const firstArgs = { remove_from: alpha, remove_to: alpha, text: ["alpha\n"] };
      const secondArgs = { remove_from: beta, remove_to: beta, text: ["beta\n"] };
      const message = assistantMessage([toolCall("b1", "replace", firstArgs), toolCall("b2", "replace", secondArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);
      const first = await getTool("replace").execute("b1", firstArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");
      const last = await getTool("replace").execute("b2", secondArgs, undefined, undefined, ctx);
      expect(last.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\r\n");
      await handlers.get("turn_end")!(
        { type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "b1" }, { toolCallId: "b2" }] },
        ctx,
      );
      const undone = await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\r\nbeta\r\ngamma\r\n");
    });
  });

  it("applies a mixed batch whose last member adds the final newline", async () => {
    await withTempFile("sample.txt", "one\ntwo", async ({ cwd, path }) => {
      const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const one = anchorFor(text, "one");
      const two = anchorFor(text, "two");
      const firstArgs = { remove_from: one, remove_to: one, text: ["ONE"] };
      const secondArgs = { remove_from: two, remove_to: two, text: ["two\n"] };
      const message = assistantMessage([toolCall("m1", "replace", firstArgs), toolCall("m2", "replace", secondArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);
      await getTool("replace").execute("m1", firstArgs, undefined, undefined, ctx);
      const last = await getTool("replace").execute("m2", secondArgs, undefined, undefined, ctx);
      expect(last.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("ONE\ntwo\n");
    });
  });
});
