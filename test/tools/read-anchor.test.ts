import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { anchorFor, getText, setupIntegrationTest, toolError, withTempDir, withTempFile } from "../support/fixtures";

function contentRows(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^[A-Za-z]{4}│/.test(line))
    .map((line) => line.slice(5));
}

describe("read tool - anchor addressing", () => {
  it("reads a window around a served anchor", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(first, "l3");
      const result = getText(await readTool.execute("r2", { path: "sample.txt", anchor, before: 1, after: 1 }, undefined, undefined, ctx));
      expect(contentRows(result)).toEqual(["l2", "l3", "l4"]);
    });
  });

  it("defaults the window to the anchor line and the next 20 lines", async () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(first, "line 5");
      const result = getText(await readTool.execute("r2", { path: "sample.txt", anchor }, undefined, undefined, ctx));
      const rows = contentRows(result);
      expect(rows).toHaveLength(21);
      expect(rows[0]).toBe("line 5");
      expect(rows[rows.length - 1]).toBe("line 25");
    });
  });

  it("reads an inclusive anchored range regardless of anchor order", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const from = anchorFor(first, "l4");
      const to = anchorFor(first, "l2");
      const result = getText(await readTool.execute("r2", { path: "sample.txt", from, to }, undefined, undefined, ctx));
      expect(contentRows(result)).toEqual(["l2", "l3", "l4"]);
    });
  });

  it("keeps an untouched line's anchor readable after an edit elsewhere", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const one = anchorFor(first, "l1");
      const four = anchorFor(first, "l4");
      await editTool.execute("e1", { remove_from: one, remove_to: one, text: "L1" }, undefined, undefined, ctx);
      const result = getText(await readTool.execute("r2", { path: "sample.txt", anchor: four, after: 0 }, undefined, undefined, ctx));
      expect(contentRows(result)).toEqual(["l4"]);
    });
  });

  it("rejects a stale anchor", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const two = anchorFor(first, "l2");
      await editTool.execute("e1", { remove_from: two, remove_to: two, text: "L2" }, undefined, undefined, ctx);
      const message = await toolError(() => readTool.execute("r2", { path: "sample.txt", anchor: two }, undefined, undefined, ctx));
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(message).toContain("Call read()");
    });
  });

  it("rejects an anchor owned by another file", async () => {
    await withTempDir("read-anchor-cross-", async (dir) => {
      const { ctx, readTool } = setupIntegrationTest(dir);
      await writeFile(join(dir, "a.txt"), "alpha\n", "utf-8");
      await writeFile(join(dir, "b.txt"), "beta\n", "utf-8");
      const a = getText(await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(a, "alpha");
      const message = await toolError(() => readTool.execute("r2", { path: "b.txt", anchor }, undefined, undefined, ctx));
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(message).toContain("a.txt");
    });
  });

  it("explains a case-only mismatch", async () => {
    await withTempFile("sample.txt", "alpha\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(first, "alpha");
      const wrong = anchor === anchor.toLowerCase() ? anchor.toUpperCase() : anchor.toLowerCase();
      const message = await toolError(() => readTool.execute("r2", { path: "sample.txt", anchor: wrong }, undefined, undefined, ctx));
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(message).toContain("case-sensitive");
      expect(message).toContain(anchor);
    });
  });

  it("rejects mixed anchor and offset addressing", async () => {
    await withTempFile("sample.txt", "l1\nl2\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(first, "l1");
      expect(await toolError(() => readTool.execute("r2", { path: "sample.txt", anchor, offset: 1 }, undefined, undefined, ctx))).toContain("[E_BAD_SHAPE]");
    });
  });

  it("rejects a partial range and orphaned window fields", async () => {
    await withTempFile("sample.txt", "l1\nl2\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(first, "l1");
      expect(await toolError(() => readTool.execute("r2", { path: "sample.txt", from: anchor }, undefined, undefined, ctx))).toContain("[E_BAD_SHAPE]");
      expect(await toolError(() => readTool.execute("r3", { path: "sample.txt", before: 2 }, undefined, undefined, ctx))).toContain("[E_BAD_SHAPE]");
    });
  });

  it("rejects a malformed anchor", async () => {
    await withTempFile("sample.txt", "l1\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      expect(await toolError(() => readTool.execute("r1", { path: "sample.txt", anchor: "no" }, undefined, undefined, ctx))).toContain("[E_BAD_REF]");
    });
  });

  it("reads the empty-file row by anchor", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "empty.txt" }, undefined, undefined, ctx));
      const anchor = first.split("│")[0]!;
      const result = getText(await readTool.execute("r2", { path: "empty.txt", anchor }, undefined, undefined, ctx));
      expect(result).toContain("File is empty. Use replace to insert content.");
    });
  });
});
