import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  anchorFor,
  assistantMessage,
  getText,
  setupIntegrationTest,
  toolCall,
  withTempDir,
  withTempFile,
  toolError,
} from "../support/fixtures";

describe("batched replace_match", () => {
  it("batches replace and replace_match on one file with one undo", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const match = getTool("replace_match");
      const undo = getTool("undo_last_change");

      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const replaceArgs = { remove_from: beta, remove_to: beta, text: ["BETA"] };
      const matchArgs = { replace_from: gamma, replace_to: gamma, old_string: "gamma", new_string: "GAMMA" };
      const message = assistantMessage([toolCall("m1", "replace", replaceArgs), toolCall("m2", "replace_match", matchArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("m1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      const last = await match.execute("m2", matchArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(last.details.metrics.edits_attempted).toBe(2);
      expect(last.details.metrics.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\nGAMMA\n");

      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "m1" }, { toolCallId: "m2" }] }, ctx);

      const undone = await undo.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(getText(undone)).toContain("Undone last change");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("aborts the whole batch when a replace_match substring is missing", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const match = getTool("replace_match");

      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const replaceArgs = { remove_from: beta, remove_to: beta, text: ["BETA"] };
      const matchArgs = { replace_from: gamma, replace_to: gamma, old_string: "missing", new_string: "GAMMA" };
      const message = assistantMessage([toolCall("m1", "replace", replaceArgs), toolCall("m2", "replace_match", matchArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("m1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      expect(await toolError(() => match.execute("m2", matchArgs, undefined, undefined, ctx))).toContain("[E_SUBSTRING_NOT_FOUND]");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });
});

describe("batched same-file copy and move", () => {
  it("batches a same-file copy with a replace and undoes both at once", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");
      const undo = getTool("undo_last_change");

      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const replaceArgs = { remove_from: alpha, remove_to: alpha, text: ["ALPHA"] };
      const copyArgs = { source_from: beta, source_to: beta, insert_after: gamma };
      const message = assistantMessage([toolCall("c1", "replace", replaceArgs), toolCall("c2", "copy", copyArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("c1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      const last = await copy.execute("c2", copyArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(last.details.metrics.edits_attempted).toBe(2);
      expect(await readFile(path, "utf-8")).toBe("ALPHA\nbeta\ngamma\nbeta\n");

      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "c1" }, { toolCallId: "c2" }] }, ctx);

      await undo.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("batches a same-file move with a replace", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const move = getTool("move");

      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const delta = anchorFor(text, "delta");
      const replaceArgs = { remove_from: beta, remove_to: beta, text: ["BETA"] };
      const moveArgs = { source_from: gamma, source_to: gamma, insert_after: delta };
      const message = assistantMessage([toolCall("v1", "replace", replaceArgs), toolCall("v2", "move", moveArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("v1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      const last = await move.execute("v2", moveArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ndelta\ngamma\n");
    });
  });

  it("copies per-line source endings inside a batch", async () => {
    await withTempFile("sample.txt", "a\r\nb\nc\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");

      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const a = anchorFor(text, "a");
      const b = anchorFor(text, "b");
      const c = anchorFor(text, "c");
      const replaceArgs = { remove_from: b, remove_to: b, text: ["B"] };
      const copyArgs = { source_from: a, source_to: a, insert_after: c };
      const message = assistantMessage([toolCall("e1", "replace", replaceArgs), toolCall("e2", "copy", copyArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      await replace.execute("e1", replaceArgs, undefined, undefined, ctx);
      const last = await copy.execute("e2", copyArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(path, "utf-8")).toBe("a\r\nB\nc\na\r\n");
    });
  });

  it("rejects a copy whose insert_after line is replaced by a sibling", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");

      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const replaceArgs = { remove_from: gamma, remove_to: gamma, text: ["GAMMA"] };
      const copyArgs = { source_from: beta, source_to: beta, insert_after: gamma };
      const message = assistantMessage([toolCall("o1", "replace", replaceArgs), toolCall("o2", "copy", copyArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("o1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      expect(await toolError(() => copy.execute("o2", copyArgs, undefined, undefined, ctx))).toContain("[E_BATCH_OVERLAP]");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("aborts a batched copy when the base read frees a source boundary anchor", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { handlers, getTool, ctx } = setupIntegrationTest(cwd);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");

      const text = getText(await read.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const delta = anchorFor(text, "delta");
      await writeFile(path, "alpha\nbeta\nGAMMA\ndelta\n", "utf-8");
      const replaceArgs = { remove_from: alpha, remove_to: alpha, text: ["ALPHA"] };
      const copyArgs = { source_from: beta, source_to: gamma, insert_after: delta };
      const message = assistantMessage([toolCall("s1", "replace", replaceArgs), toolCall("s2", "copy", copyArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("s1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      expect(await toolError(() => copy.execute("s2", copyArgs, undefined, undefined, ctx))).toContain("[E_STALE_ANCHOR]");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nGAMMA\ndelta\n");
    });
  });
});

describe("batched cross-file copy", () => {
  it("batches a cross-file copy with destination edits and undoes them together", async () => {
    await withTempDir("batch-cross-copy-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");
      const undo = getTool("undo_last_change");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const replaceArgs = { remove_from: two, remove_to: two, text: ["TWO"] };
      const copyArgs = { source_from: beta, source_to: beta, insert_after: one };
      const message = assistantMessage([toolCall("d1", "replace", replaceArgs), toolCall("d2", "copy", copyArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("d1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      const last = await copy.execute("d2", copyArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\nTWO\n");

      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "d1" }, { toolCallId: "d2" }] }, ctx);

      await undo.execute("u1", { path: "b.ts" }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\n");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("copies the pre-batch source when the source file is edited in the same message", async () => {
    await withTempDir("batch-cross-snapshot-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const gamma = anchorFor(aText, "gamma");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const aFirstArgs = { remove_from: beta, remove_to: beta, text: ["BETA"] };
      const aLastArgs = { remove_from: gamma, remove_to: gamma, text: ["GAMMA"] };
      const bFirstArgs = { remove_from: two, remove_to: two, text: ["TWO"] };
      const copyArgs = { source_from: beta, source_to: beta, insert_after: one };
      const message = assistantMessage([
        toolCall("a1", "replace", aFirstArgs),
        toolCall("a2", "replace", aLastArgs),
        toolCall("b1", "replace", bFirstArgs),
        toolCall("b2", "copy", copyArgs),
      ]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const aFirst = await replace.execute("a1", aFirstArgs, undefined, undefined, ctx);
      expect(getText(aFirst)).toBe("In batch 1 (queued)");
      const aLast = await replace.execute("a2", aLastArgs, undefined, undefined, ctx);
      expect(getText(aLast)).toContain("Batch 1: 2 edits applied as one commit");

      const bFirst = await replace.execute("b1", bFirstArgs, undefined, undefined, ctx);
      expect(getText(bFirst)).toBe("In batch 2 (queued)");
      const bLast = await copy.execute("b2", copyArgs, undefined, undefined, ctx);
      expect(getText(bLast)).toContain("Batch 2: 2 edits applied as one commit");

      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\nBETA\nGAMMA\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\nTWO\n");
    });
  });

  it("accepts a require-path hint naming the copy source", async () => {
    await withTempDir("batch-cross-copy-path-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      await mkdir(join(dir, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(join(dir, ".config", "pi-hashline-edit-pro", "config.json"), JSON.stringify({ autoRead: true, requirePath: true }), "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const replaceArgs = { path: "b.ts", remove_from: two, remove_to: two, text: ["TWO"] };
      const copyArgs = { path: "a.ts", source_from: beta, source_to: beta, insert_after: one };
      const message = assistantMessage([toolCall("p1", "replace", replaceArgs), toolCall("p2", "copy", copyArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("p1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");
      const last = await copy.execute("p2", copyArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\nTWO\n");
    });
  });


  it("keeps a cross-file copy solo when its source anchors are stale", async () => {
    await withTempDir("batch-cross-copy-stale-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const copy = getTool("copy");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const staleSource = anchorFor(aText, "beta");
      await writeFile(join(dir, "a.ts"), "alpha\nBETA\n", "utf-8");
      await read.execute("ra2", { path: "a.ts" }, undefined, undefined, ctx);
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const replaceArgs = { remove_from: two, remove_to: two, text: ["TWO"] };
      const copyArgs = { source_from: staleSource, source_to: staleSource, insert_after: one };
      const message = assistantMessage([toolCall("q1", "replace", replaceArgs), toolCall("q2", "copy", copyArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const applied = await replace.execute("q1", replaceArgs, undefined, undefined, ctx);
      expect(getText(applied)).toContain("Successfully replaced in b.ts");

      expect(await toolError(() => copy.execute("q2", copyArgs, undefined, undefined, ctx))).toContain("[E_STALE_ANCHOR]");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nTWO\n");
    });
  });
});

describe("batched cross-file move", () => {
  it("batches a cross-file move with destination edits and undoes each side", async () => {
    await withTempDir("batch-cross-move-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const move = getTool("move");
      const undo = getTool("undo_last_change");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const replaceArgs = { remove_from: two, remove_to: two, text: ["TWO"] };
      const moveArgs = { source_from: beta, source_to: beta, insert_after: one };
      const message = assistantMessage([toolCall("m1", "replace", replaceArgs), toolCall("m2", "move", moveArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("m1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      const last = await move.execute("m2", moveArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(getText(last)).toContain("one undo reverts the destination edits");
      expect(getText(last)).toContain("Moved 1 line(s) out of a.ts");
      expect(last.details.patch).toContain("--- a.ts");
      expect(last.details.patch).toContain("-beta");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\ngamma\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\nTWO\n");

      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message, toolResults: [{ toolCallId: "m1" }, { toolCallId: "m2" }] }, ctx);

      await undo.execute("u1", { path: "b.ts" }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\n");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\ngamma\n");
      await undo.execute("u2", { path: "a.ts" }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("leaves the move source untouched when the destination batch aborts", async () => {
    await withTempDir("batch-cross-move-abort-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const move = getTool("move");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const replaceArgs = { remove_from: two, remove_to: two, text: ["TWO"] };
      const moveArgs = { source_from: beta, source_to: beta, insert_after: one };
      const message = assistantMessage([toolCall("m1", "replace", replaceArgs), toolCall("m2", "move", moveArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("m1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      await writeFile(join(dir, "b.ts"), "one\nCHANGED\n", "utf-8");
      expect(await toolError(() => move.execute("m2", moveArgs, undefined, undefined, ctx))).toContain("[E_OP_ABORTED]");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nCHANGED\n");
    });
  });

  it("aborts when the move source changes before the batch commits", async () => {
    await withTempDir("batch-cross-move-source-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const move = getTool("move");
      const undo = getTool("undo_last_change");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const replaceArgs = { remove_from: two, remove_to: two, text: ["TWO"] };
      const moveArgs = { source_from: beta, source_to: beta, insert_after: one };
      const message = assistantMessage([toolCall("m1", "move", moveArgs), toolCall("m2", "replace", replaceArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await move.execute("m1", moveArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");

      await writeFile(join(dir, "a.ts"), "alpha\nBETA\ngamma\n", "utf-8");
      expect(await toolError(() => replace.execute("m2", replaceArgs, undefined, undefined, ctx))).toContain("[E_OP_ABORTED]");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\nBETA\ngamma\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\n");

      const noHistory = await undo.execute("u3", { path: "a.ts" }, undefined, undefined, ctx);
      expect(noHistory.isError).toBe(true);
    });
  });

  it("commits removals from several source files in one batch", async () => {
    await withTempDir("batch-cross-move-multi-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "c.ts"), "x\ny\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\nthree\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const move = getTool("move");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const cText = getText(await read.execute("rc", { path: "c.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const y = anchorFor(cText, "y");
      const one = anchorFor(bText, "one");
      const three = anchorFor(bText, "three");
      const firstArgs = { source_from: beta, source_to: beta, insert_after: one };
      const secondArgs = { source_from: y, source_to: y, insert_after: three };
      const message = assistantMessage([toolCall("n1", "move", firstArgs), toolCall("n2", "move", secondArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await move.execute("n1", firstArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");
      const last = await move.execute("n2", secondArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\n");
      expect(await readFile(join(dir, "c.ts"), "utf-8")).toBe("x\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\ntwo\nthree\ny\n");
    });
  });

  it("accepts a require-path hint naming the move source", async () => {
    await withTempDir("batch-cross-move-path-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      await mkdir(join(dir, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(join(dir, ".config", "pi-hashline-edit-pro", "config.json"), JSON.stringify({ autoRead: true, requirePath: true }), "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const move = getTool("move");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const replaceArgs = { path: "b.ts", remove_from: two, remove_to: two, text: ["TWO"] };
      const moveArgs = { path: "a.ts", source_from: beta, source_to: beta, insert_after: one };
      const message = assistantMessage([toolCall("p1", "replace", replaceArgs), toolCall("p2", "move", moveArgs)]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const first = await replace.execute("p1", replaceArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 1 (queued)");
      const last = await move.execute("p2", moveArgs, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\nTWO\n");
    });
  });

  it("keeps a cross-file move solo when its source file has a same-message batch", async () => {
    await withTempDir("batch-cross-move-source-batch-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const read = getTool("read");
      const replace = getTool("replace");
      const move = getTool("move");

      const aText = getText(await read.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await read.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(aText, "alpha");
      const beta = anchorFor(aText, "beta");
      const gamma = anchorFor(aText, "gamma");
      const one = anchorFor(bText, "one");
      const two = anchorFor(bText, "two");
      const alphaArgs = { remove_from: alpha, remove_to: alpha, text: ["ALPHA"] };
      const betaArgs = { remove_from: beta, remove_to: beta, text: ["BETA"] };
      const firstArgs = { remove_from: one, remove_to: one, text: ["ONE"] };
      const lastArgs = { remove_from: two, remove_to: two, text: ["TWO"] };
      const moveArgs = { source_from: gamma, source_to: gamma, insert_after: two };
      const message = assistantMessage([
        toolCall("a1", "replace", alphaArgs),
        toolCall("a2", "replace", betaArgs),
        toolCall("f1", "replace", firstArgs),
        toolCall("f2", "move", moveArgs),
        toolCall("f3", "replace", lastArgs),
      ]);
      await handlers.get("message_end")!({ type: "message_end", message }, ctx);

      const alphaResult = await replace.execute("a1", alphaArgs, undefined, undefined, ctx);
      expect(getText(alphaResult)).toBe("In batch 1 (queued)");
      const betaResult = await replace.execute("a2", betaArgs, undefined, undefined, ctx);
      expect(getText(betaResult)).toContain("Batch 1: 2 edits applied as one commit");

      const first = await replace.execute("f1", firstArgs, undefined, undefined, ctx);
      expect(getText(first)).toBe("In batch 2 (queued)");

      const moved = await move.execute("f2", moveArgs, undefined, undefined, ctx);
      expect(getText(moved)).toContain("Successfully moved 1 line(s)");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("ALPHA\nBETA\n");

      expect(await toolError(() => replace.execute("f3", lastArgs, undefined, undefined, ctx))).toContain("[E_OP_ABORTED]");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\ngamma\n");
    });
  });
});
