import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { replaceMatchPreview } from "../../src/replace-match";
import { anchorFor, extractHash, getText, setupIntegrationTest, useTestHome, withTempFile, toolError } from "../support/fixtures";

useTestHome();

function anchorOf(text: string, needle: string): string {
  return extractHash(text.split("\n").find((row) => row.includes(needle))!);
}

const ROUTES = '{\n  "routes": [\n    {"id": "checkout-5", "feature": "legacyCheckout", "retries": 3},\n    {"id": "checkout-6", "feature": "legacyCheckout", "retries": 3}\n  ]\n}\n';

describe("replace_match", () => {
  it("replaces a substring and leaves the rest of the line byte-identical", async () => {
    await withTempFile("routes.json", ROUTES, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "routes.json" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, '"checkout-5"');
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, match: "legacyCheckout", replacement: "stableCheckout" },
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
      await getTool("replace_match").execute("w1", { replace_from: first, replace_to: first, match: "legacyCheckout", replacement: "stableCheckout" }, undefined, undefined, ctx);
      await getTool("replace_match").execute("w2", { replace_from: second, replace_to: second, match: "legacyCheckout", replacement: "stableCheckout" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe(['test("a", () => {', '  feature: "stableCheckout",', "});", 'test("b", () => {', '  feature: "stableCheckout",', "});", ""].join("\n"));
    });
  });

  it("preserves an invisible character and the trailing comma", async () => {
    const content = 'alpha\n    feature: "legacy\u200bCheckout",\nomega\n';
    await withTempFile("cases.test.ts", content, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "cases.test.ts" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, "feature:");
      await getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, match: "legacy\u200bCheckout", replacement: "stable\u200bCheckout" },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe('alpha\n    feature: "stable\u200bCheckout",\nomega\n');
    });
  });

  it("refuses when match is not found and returns the current row", async () => {
    await withTempFile("routes.json", ROUTES, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "routes.json" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, '"checkout-5"');
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, match: "legacyCheckouX", replacement: "stableCheckout" },
        undefined, undefined, ctx,
      ));
      expect(message).toMatch(/\[E_SUBSTRING_NOT_FOUND\]/);
      expect(message).toContain(`${anchor}│    {"id": "checkout-5"`);
    });
  });

  it("replaces every occurrence of match inside the line", async () => {
    await withTempFile("dup.txt", "keep\nlegacy = legacy\nlegacy\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "dup.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "legacy = legacy");
      const result = await getTool("replace_match").execute("w1", { replace_from: anchor, replace_to: anchor, match: "legacy", replacement: "stable" }, undefined, undefined, ctx);
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("keep\nstable = stable\nlegacy\n");
    });
  });

  it("replaces the fragment on every line of the range", async () => {
    await withTempFile("block.txt", "top\nlegacy = legacy\nkeep\nlegacy\nbottom\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "block.txt" }, undefined, undefined, ctx));
      const top = anchorFor(text, "top");
      const bottom = anchorFor(text, "bottom");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: top, replace_to: bottom, match: "legacy", replacement: "stable" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("top\nstable = stable\nkeep\nstable\nbottom\n");
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(diff).toContain(` ${top}│top`);
      expect(diff).toContain(` ${bottom}│bottom`);
    });
  });

  it("matches interior lines against the current file", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const a = anchorFor(text, "a");
      const c = anchorFor(text, "c");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "a\nB\nc\nd\n", "utf-8");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: a, replace_to: c, match: "B", replacement: "b" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\n");
    });
  });

  it("keeps the trailing empty line when the range ends on it", async () => {
    await withTempFile("checkout.md", "before\n\n```\n\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "checkout.md" }, undefined, undefined, ctx));
      const fence = anchorFor(text, "```");
      const trailingEmpty = text.split("\n").filter((row) => /^[A-Za-z]{4}│$/.test(row)).pop()!.split("│")[0]!;
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: fence, replace_to: trailingEmpty, match: "```", replacement: "```done" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("before\n\n```done\n\n");
    });
  });

  it("keeps an interior blank line when the range ends on it", async () => {
    await withTempFile("sample.txt", "a\nb\n\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const b = anchorFor(text, "b");
      const blank = text.split("\n").filter((row) => /^[A-Za-z]{4}│$/.test(row)).pop()!.split("│")[0]!;
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: b, replace_to: blank, match: "b", replacement: "B" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nB\n\nc\n");
    });
  });

  it("accepts a trailing line break as the line's terminator", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: beta, replace_to: beta, match: "beta\n", replacement: "BETA\n" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("keeps the line when the replacement is empty", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: beta, replace_to: beta, match: "beta", replacement: "" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\n\ngamma\n");
    });
  });

  it("keeps one empty line per fully replaced line across a range", async () => {
    await withTempFile("sample.txt", "legacy\nkeep\nlegacy\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const legacyRows = text.split("\n").filter((row) => row.includes("│legacy"));
      const first = legacyRows[0]!.split("│")[0]!;
      const last = legacyRows[1]!.split("│")[0]!;
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: first, replace_to: last, match: "legacy", replacement: "" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("\nkeep\n\n");
    });
  });

  it("counts a lone line break in replacement as an empty fragment", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: beta, replace_to: beta, match: "beta", replacement: "\n" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\n\ngamma\n");
    });
  });

  it("refuses a lone line break as match", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        { replace_from: beta, replace_to: beta, match: "\n", replacement: "x" },
        undefined, undefined, ctx,
      ));
      expect(message).toContain("[E_BAD_SHAPE]");
      expect(message).toContain("must be a non-empty string holding the exact text to find");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("points the old field names at their replacements", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const preview = await replaceMatchPreview(
        { replace_from: "Hasu", replace_to: "Hasu", old_string: "beta", new_string: "BETA" },
        cwd,
      );
      const message = "error" in preview ? preview.error : "";
      expect(message).toContain("[E_BAD_SHAPE]");
      expect(message).toContain('use "match"');
      expect(message).toContain('"replacement"');
    });
  });

  it("refuses a string that spans lines", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const matchMessage = await toolError(() => getTool("replace_match").execute(
        "w1",
        { replace_from: beta, replace_to: beta, match: "beta\ngamma", replacement: "x" },
        undefined, undefined, ctx,
      ));
      expect(matchMessage).toContain("[E_BAD_SHAPE]");
      expect(matchMessage).toContain("match must stay within one line");
      const replacementMessage = await toolError(() => getTool("replace_match").execute(
        "w2",
        { replace_from: beta, replace_to: beta, match: "beta", replacement: "x\ny" },
        undefined, undefined, ctx,
      ));
      expect(replacementMessage).toContain("[E_BAD_SHAPE]");
      expect(replacementMessage).toContain("replacement must stay within one line");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("reports a noop when match and replacement are identical", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, match: "beta", replacement: "beta" },
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
      await getTool("replace").execute("e1", { remove_from: anchor, remove_to: anchor, text: "BETA" }, undefined, undefined, ctx);
      expect(await toolError(() => getTool("replace_match").execute("w1", { replace_from: anchor, replace_to: anchor, match: "BETA", replacement: "beta" }, undefined, undefined, ctx))).toMatch(/\[E_STALE_ANCHOR\]/);
    });
  });

  it("refuses when a boundary anchor was never shown", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt", limit: 1 }, undefined, undefined, ctx);
      const hashes = await lineHashes(content, join(cwd, "sample.txt"));
      expect(await toolError(() => getTool("replace_match").execute("w1", { replace_from: hashes[0]!, replace_to: hashes[3]!, match: "a", replacement: "A" }, undefined, undefined, ctx))).toMatch(/\[E_RANGE_STALE\]/);
    });
  });

  it("undoes the edit in one step", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      await getTool("replace_match").execute("w1", { replace_from: anchor, replace_to: anchor, match: "beta", replacement: "gamma" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
      const undone = await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("accepts remove_from/remove_to aliases", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const result = await getTool("replace_match").execute(
        "w1",
        { remove_from: anchor, remove_to: anchor, match: "beta", replacement: "gamma" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
    });
  });

  it("previews remove_from/remove_to aliases", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const preview = await replaceMatchPreview({ remove_from: anchor, remove_to: anchor, match: "beta", replacement: "gamma" }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("gamma");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("rejects replace_old/replace_new aliases", async () => {
    await withTempFile("routes.json", ROUTES, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "routes.json" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, '"checkout-5"');
      await expect(
        getTool("replace_match").execute(
          "w1",
          { replace_from: anchor, replace_to: anchor, replace_old: "legacyCheckout", replace_new: "stableCheckout" },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow("[E_BAD_SHAPE]");
      expect(await readFile(path, "utf-8")).toBe(ROUTES);
    });
  });

  it("hints at literal escaped text in replacement", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, match: "beta", replacement: String.raw`stable\u200bCheckout` },
        undefined, undefined, ctx,
      );
      expect(result.details.hints).toContainEqual(expect.stringContaining('[H_LITERAL_ESCAPE] replacement:'));
      expect(result.details.metrics?.warnings).toBe(0);
    });
  });

  it("computes a preview without writing", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const preview = await replaceMatchPreview({ replace_from: anchor, replace_to: anchor, match: "beta", replacement: "gamma" }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("gamma");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("names the first mismatch when match looks like a retyped copy", async () => {
    await withTempFile("routes.json", ROUTES, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "routes.json" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, '"checkout-5"');
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        {
          replace_from: anchor,
          replace_to: anchor,
          match: '    {"id": "checkout-5", "feature": "legacyCheckouX", "retries": 3},',
          replacement: "x",
        },
        undefined, undefined, ctx,
      ));
      expect(message).toContain("the first mismatch is at line 3");
      expect(message).toContain("use replace with the same anchor");
    });
  });

  it("escapes an invisible mismatch character instead of printing it raw", async () => {
    const content = 'const label = "caf\u00a0";\n';
    await withTempFile("labels.ts", content, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "labels.ts" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, "caf");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        {
          replace_from: anchor,
          replace_to: anchor,
          match: 'const label = "caf ";',
          replacement: "x",
        },
        undefined, undefined, ctx,
      ));
      expect(message).toContain("the first mismatch is at line 1");
      expect(message).toContain(String.raw`the file has "\u00a0"`);
      expect(message).toContain('where match has " "');
    });
  });

  it("escapes a non-ASCII look-alike mismatch character", async () => {
    const content = 'const label = "caf\u0435";\n';
    await withTempFile("labels.ts", content, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "labels.ts" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, "caf");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        {
          replace_from: anchor,
          replace_to: anchor,
          match: 'const label = "cafe";',
          replacement: "x",
        },
        undefined, undefined, ctx,
      ));
      expect(message).toContain("the first mismatch is at line 1");
      expect(message).toContain(String.raw`the file has "\u0435"`);
      expect(message).toContain('where match has "e"');
    });
  });

  it("reports the code-point column for a mismatch after an astral character", async () => {
    const content = '// note 😀 const label = "caf\u00a0";\n';
    await withTempFile("labels.ts", content, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "labels.ts" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, "caf");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        {
          replace_from: anchor,
          replace_to: anchor,
          match: '// note 😀 const label = "caf ";',
          replacement: "x",
        },
        undefined, undefined, ctx,
      ));
      expect(message).toContain("the first mismatch is at line 1, col 29");
      expect(message).toContain(String.raw`the file has "\u00a0"`);
      expect(message).toContain('where match has " "');
    });
  });

  it("escapes an astral mismatch character as a full surrogate pair", async () => {
    const content = 'const label = "caf😀";\n';
    await withTempFile("labels.ts", content, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "labels.ts" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, "caf");
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        {
          replace_from: anchor,
          replace_to: anchor,
          match: 'const label = "caf😁";',
          replacement: "x",
        },
        undefined, undefined, ctx,
      ));
      expect(message).toContain("the first mismatch is at line 1, col 19");
      expect(message).toContain(String.raw`the file has "\ud83d\ude00"`);
      expect(message).toContain(String.raw`where match has "\ud83d\ude01"`);
    });
  });
});

describe("replace_match requirePath", () => {
  it("requires a matching path and rejects a wrong one", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      await mkdir(join(cwd, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(join(cwd, ".config", "pi-hashline-edit-pro", "config.json"), JSON.stringify({ autoRead: true, requirePath: true }), "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      expect(await toolError(() => getTool("replace_match").execute("w1", { replace_from: anchor, replace_to: anchor, match: "beta", replacement: "gamma" }, undefined, undefined, ctx))).toMatch(/requires a non-empty "path"/);
      expect(await toolError(() => getTool("replace_match").execute("w2", { path: "other.txt", replace_from: anchor, replace_to: anchor, match: "beta", replacement: "gamma" }, undefined, undefined, ctx))).toMatch(/does not match anchor ownership/);
      await getTool("replace_match").execute("w3", { path: "sample.txt", replace_from: anchor, replace_to: anchor, match: "beta", replacement: "gamma" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
    });
  });
});
