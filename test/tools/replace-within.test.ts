import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { replaceWithinPreview } from "../../src/replace-within";
import { anchorFor, extractHash, getText, setupIntegrationTest, useTestHome, withTempFile } from "../support/fixtures";

useTestHome();

function anchorOf(text: string, needle: string): string {
  return extractHash(text.split("\n").find((row) => row.includes(needle))!);
}

const ROUTES = '{\n  "routes": [\n    {"id": "checkout-5", "feature": "legacyCheckout", "retries": 3},\n    {"id": "checkout-6", "feature": "legacyCheckout", "retries": 3}\n  ]\n}\n';

describe("replace_within", () => {
  it("replaces a substring and leaves the rest of the line byte-identical", async () => {
    await withTempFile("routes.json", ROUTES, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "routes.json" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, '"checkout-5"');
      const result = await getTool("replace_within").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, replace_old: "legacyCheckout", replace_new: "stableCheckout" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe('{\n  "routes": [\n    {"id": "checkout-5", "feature": "stableCheckout", "retries": 3},\n    {"id": "checkout-6", "feature": "legacyCheckout", "retries": 3}\n  ]\n}\n');
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(diff).toContain('"feature": "stableCheckout", "retries": 3},');
    });
  });

  it("chains several calls whose anchors all came from one read", async () => {
    const content = ['test("a", () => {', '  feature: "legacyCheckout",', "});", 'test("b", () => {', '  feature: "legacyCheckout",', "});", ""].join("\n");
    await withTempFile("cases.test.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "cases.test.ts" }, undefined, undefined, ctx));
      const rows = text.split("\n").filter((row) => row.includes('│  feature: "legacyCheckout"'));
      const first = rows[0]!.split("│")[0]!;
      const second = rows[1]!.split("│")[0]!;
      await getTool("replace_within").execute("w1", { replace_from: first, replace_to: first, replace_old: "legacyCheckout", replace_new: "stableCheckout" }, undefined, undefined, ctx);
      await getTool("replace_within").execute("w2", { replace_from: second, replace_to: second, replace_old: "legacyCheckout", replace_new: "stableCheckout" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe(['test("a", () => {', '  feature: "stableCheckout",', "});", 'test("b", () => {', '  feature: "stableCheckout",', "});", ""].join("\n"));
    });
  });

  it("preserves an invisible character and the trailing comma", async () => {
    const content = 'alpha\n    feature: "legacy\u200bCheckout",\nomega\n';
    await withTempFile("cases.test.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "cases.test.ts" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, "feature:");
      await getTool("replace_within").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, replace_old: "legacy\u200bCheckout", replace_new: "stable\u200bCheckout" },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe('alpha\n    feature: "stable\u200bCheckout",\nomega\n');
    });
  });

  it("refuses when replace_old is not found and returns the current row", async () => {
    await withTempFile("routes.json", ROUTES, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "routes.json" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, '"checkout-5"');
      let caught: Error | undefined;
      try {
        await getTool("replace_within").execute(
          "w1",
          { replace_from: anchor, replace_to: anchor, replace_old: "legacyCheckouX", replace_new: "stableCheckout" },
          undefined, undefined, ctx,
        );
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/\[E_SUBSTRING_NOT_FOUND\]/);
      expect(caught!.message).toContain(`${anchor}│    {"id": "checkout-5"`);
    });
  });

  it("refuses an ambiguous replace_old and names the matching lines", async () => {
    await withTempFile("dup.txt", "legacy\nkeep\nlegacy\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "dup.txt" }, undefined, undefined, ctx));
      const first = anchorFor(text, "legacy");
      const rows = text.split("\n").filter((row) => row.includes("│"));
      const last = rows[rows.length - 1]!.split("│")[0]!;
      let caught: Error | undefined;
      try {
        await getTool("replace_within").execute("w1", { replace_from: first, replace_to: last, replace_old: "legacy", replace_new: "stable" }, undefined, undefined, ctx);
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/\[E_SUBSTRING_AMBIGUOUS\]/);
      expect(caught!.message).toContain("matching lines 1, 3");
    });
  });

  it("replaces across a range and keeps the anchors outside it", async () => {
    await withTempFile("block.txt", "top\nfoo\nbar\nbottom\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "block.txt" }, undefined, undefined, ctx));
      const top = anchorFor(text, "top");
      const bottom = anchorFor(text, "bottom");
      const foo = anchorFor(text, "foo");
      const bar = anchorFor(text, "bar");
      const result = await getTool("replace_within").execute(
        "w1",
        { replace_from: foo, replace_to: bar, replace_old: "foo\nbar", replace_new: "one\ntwo\nthree" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("top\none\ntwo\nthree\nbottom\n");
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(diff).toContain(` ${top}│top`);
      expect(diff).toContain(` ${bottom}│bottom`);
    });
  });

  it("reports a noop when replace_old and replace_new are identical", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const result = await getTool("replace_within").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, replace_old: "beta", replace_new: "beta" },
        undefined, undefined, ctx,
      );
      expect(result.details.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("rejects a stale anchor", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      await getTool("replace").execute("e1", { remove_from: anchor, remove_to: anchor, replacement_lines: "BETA" }, undefined, undefined, ctx);
      await expect(
        getTool("replace_within").execute("w1", { replace_from: anchor, replace_to: anchor, replace_old: "BETA", replace_new: "beta" }, undefined, undefined, ctx),
      ).rejects.toThrow(/\[E_STALE_ANCHOR\]/);
    });
  });

  it("verifies the range against the served record", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const hashes = await lineHashes(content, join(cwd, "sample.txt"));
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "a\nB\nc\nd\n", "utf-8");
      await expect(
        getTool("replace_within").execute("w1", { replace_from: hashes[0]!, replace_to: hashes[2]!, replace_old: "a\nB\nc", replace_new: "a\nb\nc" }, undefined, undefined, ctx),
      ).rejects.toThrow(/\[E_RANGE_STALE\]/);
    });
  });

  it("undoes the edit in one step", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      await getTool("replace_within").execute("w1", { replace_from: anchor, replace_to: anchor, replace_old: "beta", replace_new: "gamma" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
      const undone = await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("accepts remove_from/remove_to aliases through prepareArguments", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      await getTool("replace_within").execute(
        "w1",
        { remove_from: anchor, remove_to: anchor, replace_old: "beta", replace_new: "gamma" },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
    });
  });

  it("hints at literal escaped text in replace_new", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const result = await getTool("replace_within").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, replace_old: "beta", replace_new: String.raw`stable\u200bCheckout` },
        undefined, undefined, ctx,
      );
      expect(result.details.hints).toContainEqual(expect.stringContaining('[H_LITERAL_ESCAPE] "replace_new"'));
      expect(result.details.metrics?.warnings).toBe(0);
    });
  });

  it("computes a preview without writing", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const preview = await replaceWithinPreview({ replace_from: anchor, replace_to: anchor, replace_old: "beta", replace_new: "gamma" }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("gamma");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });
});

describe("replace_within requirePath", () => {
  it("requires a matching path and rejects a wrong one", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      await mkdir(join(cwd, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(join(cwd, ".config", "pi-hashline-edit-pro", "config.json"), JSON.stringify({ autoRead: true, requirePath: true }), "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      await expect(
        getTool("replace_within").execute("w1", { replace_from: anchor, replace_to: anchor, replace_old: "beta", replace_new: "gamma" }, undefined, undefined, ctx),
      ).rejects.toThrow(/requires a non-empty "path"/);
      await expect(
        getTool("replace_within").execute("w2", { path: "other.txt", replace_from: anchor, replace_to: anchor, replace_old: "beta", replace_new: "gamma" }, undefined, undefined, ctx),
      ).rejects.toThrow(/does not match anchor ownership/);
      await getTool("replace_within").execute("w3", { path: "sample.txt", replace_from: anchor, replace_to: anchor, replace_old: "beta", replace_new: "gamma" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
    });
  });
});
