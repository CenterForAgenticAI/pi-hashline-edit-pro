import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { anchorFor, assistantMessage, getText, setupIntegrationTest, toolCall, toolError, withTempDir, withTempFile } from "../support/fixtures";
import { batchMemberFor, finalizeTurn } from "../../src/batch";

describe("batch demotion", () => {
  it("commits the valid members and fails the demoted one on its own call", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const beta = anchorFor(text, "beta");
      const delta = anchorFor(text, "delta");
      const firstArgs = { remove_from: alpha, remove_to: alpha, text: ["ALPHA"] };
      const badArgs = { remove_from: beta, remove_to: "ZZZZ", text: ["NOPE"] };
      const lastArgs = { remove_from: delta, remove_to: delta, text: ["DELTA"] };
      const message = assistantMessage([
        toolCall("a1", "replace", firstArgs),
        toolCall("a2", "replace", badArgs),
        toolCall("a3", "replace", lastArgs),
      ]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("a1", firstArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      const failure = await toolError(() => replace.execute("a2", badArgs, undefined, undefined, ctx));
      expect(failure).toMatch(/^\[E_STALE_ANCHOR\]/);
      expect(failure).not.toContain("Aborts batch");

      const last = await replace.execute("a3", lastArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied");
      expect(last.details.batch).toMatchObject({ id: 1, size: 2, last: true, total: 1 });
      expect(await readFile(path, "utf-8")).toBe("ALPHA\nbeta\ngamma\nDELTA\n");
    });
  });

  it("commits nothing when every member demotes", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const beta = anchorFor(text, "beta");
      const badOne = { remove_from: alpha, remove_to: "ZZZZ", text: ["A"] };
      const badTwo = { remove_from: beta, remove_to: "ZZZZ", text: ["B"] };
      const message = assistantMessage([
        toolCall("b1", "replace", badOne),
        toolCall("b2", "replace", badTwo),
      ]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await toolError(() => replace.execute("b1", badOne, undefined, undefined, ctx));
      expect(first).toMatch(/^\[E_STALE_ANCHOR\]/);
      expect(first).not.toContain("Aborts batch");
      const second = await toolError(() => replace.execute("b2", badTwo, undefined, undefined, ctx));
      expect(second).toMatch(/^\[E_STALE_ANCHOR\]/);
      expect(second).not.toContain("Aborts batch");

      await finalizeTurn(["b1", "b2"]);
      expect(batchMemberFor("b1")).toBeUndefined();
      expect(batchMemberFor("b2")).toBeUndefined();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("keeps a cross-file copy abort fatal inside a destination batch", async () => {
    await withTempDir("batch-demote-cross-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\nthree\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");
      const aText = getText(await read.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(aText, "alpha");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      await writeFile(join(dir, "b.ts"), "ONE\ntwo\nthree\n", "utf-8");
      const replaceArgs = { remove_from: two, remove_to: two, text: ["TWO"] };
      const copyArgs = { source_from: alpha, source_to: alpha, insert_after: one };
      const message = assistantMessage([toolCall("c1", "replace", replaceArgs), toolCall("c2", "copy", copyArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const queued = await replace.execute("c1", replaceArgs, undefined, undefined, ctx);
      expect(getText(queued)).toBe("In batch 1 (queued)");

      const failure = await toolError(() => copy.execute("c2", copyArgs, undefined, undefined, ctx));
      expect(failure).toContain("[E_STALE_ANCHOR]");
      expect(failure).toContain("Aborts batch 1.");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("ONE\ntwo\nthree\n");
    });
  });
});
