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

describe("read tool - offset addressing", () => {
  it("reads a limited window from a served anchor", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(first, "l3");
      const result = getText(await readTool.execute("r2", { path: "sample.txt", offset: anchor, limit: 2 }, undefined, undefined, ctx));
      expect(contentRows(result)).toEqual(["l3", "l4"]);
    });
  });

  it("reads from a served anchor to the end when no limit is given", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(first, "l3");
      const result = getText(await readTool.execute("r2", { path: "sample.txt", offset: anchor }, undefined, undefined, ctx));
      expect(contentRows(result)).toEqual(["l3", "l4", "l5"]);
    });
  });

  it("accepts a numeric offset with a limit", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\nl5\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = getText(await readTool.execute("r1", { path: "sample.txt", offset: 2, limit: 2 }, undefined, undefined, ctx));
      expect(contentRows(result)).toEqual(["l2", "l3"]);
    });
  });

  it("accepts a numeric string offset", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = getText(await readTool.execute("r1", { path: "sample.txt", offset: "2", limit: 1 }, undefined, undefined, ctx));
      expect(contentRows(result)).toEqual(["l2"]);
    });
  });

  it("keeps a served anchor readable after an edit elsewhere", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const one = anchorFor(first, "l1");
      const four = anchorFor(first, "l4");
      await editTool.execute("e1", { remove_from: one, remove_to: one, text: "L1" }, undefined, undefined, ctx);
      const result = getText(await readTool.execute("r2", { path: "sample.txt", offset: four, limit: 1 }, undefined, undefined, ctx));
      expect(contentRows(result)).toEqual(["l4"]);
    });
  });

  it("rejects a stale anchor", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const two = anchorFor(first, "l2");
      await editTool.execute("e1", { remove_from: two, remove_to: two, text: "L2" }, undefined, undefined, ctx);
      const message = await toolError(() => readTool.execute("r2", { path: "sample.txt", offset: two }, undefined, undefined, ctx));
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(message).toContain("Call read()");
    });
  });

  it("rejects an anchor owned by another file", async () => {
    await withTempDir("read-offset-cross-", async (dir) => {
      const { ctx, readTool } = setupIntegrationTest(dir);
      await writeFile(join(dir, "a.txt"), "alpha\n", "utf-8");
      await writeFile(join(dir, "b.txt"), "beta\n", "utf-8");
      const a = getText(await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(a, "alpha");
      const message = await toolError(() => readTool.execute("r2", { path: "b.txt", offset: anchor }, undefined, undefined, ctx));
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
      const message = await toolError(() => readTool.execute("r2", { path: "sample.txt", offset: wrong }, undefined, undefined, ctx));
      expect(message).toContain("[E_STALE_ANCHOR]");
      expect(message).toContain("case-sensitive");
      expect(message).toContain(anchor);
    });
  });

  it("rejects a malformed anchor", async () => {
    await withTempFile("sample.txt", "l1\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      expect(await toolError(() => readTool.execute("r1", { path: "sample.txt", offset: "no" }, undefined, undefined, ctx))).toContain("[E_BAD_REF]");
    });
  });

  it("rejects a non-positive limit", async () => {
    await withTempFile("sample.txt", "l1\nl2\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      expect(await toolError(() => readTool.execute("r1", { path: "sample.txt", offset: 1, limit: 0 }, undefined, undefined, ctx))).toContain("[E_BAD_SHAPE]");
    });
  });

  it("reads the empty-file row by anchor", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const first = getText(await readTool.execute("r1", { path: "empty.txt" }, undefined, undefined, ctx));
      const anchor = first.split("│")[0]!;
      const result = getText(await readTool.execute("r2", { path: "empty.txt", offset: anchor }, undefined, undefined, ctx));
      expect(result).toContain("File is empty. Use replace to insert content.");
    });
  });
});
