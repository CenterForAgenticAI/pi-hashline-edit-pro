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
        { replace_from: anchor, replace_to: anchor, old_string: "legacyCheckout", new_string: "stableCheckout" },
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
      await getTool("replace_match").execute("w1", { replace_from: first, replace_to: first, old_string: "legacyCheckout", new_string: "stableCheckout" }, undefined, undefined, ctx);
      await getTool("replace_match").execute("w2", { replace_from: second, replace_to: second, old_string: "legacyCheckout", new_string: "stableCheckout" }, undefined, undefined, ctx);
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
        { replace_from: anchor, replace_to: anchor, old_string: "legacy\u200bCheckout", new_string: "stable\u200bCheckout" },
        undefined, undefined, ctx,
      );
      expect(await readFile(path, "utf-8")).toBe('alpha\n    feature: "stable\u200bCheckout",\nomega\n');
    });
  });

  it("refuses when old_string is not found and returns the current row", async () => {
    await withTempFile("routes.json", ROUTES, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "routes.json" }, undefined, undefined, ctx));
      const anchor = anchorOf(text, '"checkout-5"');
      const message = await toolError(() => getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, old_string: "legacyCheckouX", new_string: "stableCheckout" },
        undefined, undefined, ctx,
      ));
      expect(message).toMatch(/\[E_SUBSTRING_NOT_FOUND\]/);
      expect(message).toContain(`${anchor}│    {"id": "checkout-5"`);
    });
  });

  it("replaces every occurrence of old_string inside the range", async () => {
    await withTempFile("dup.txt", "legacy\nkeep\nlegacy\nlegacy\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "dup.txt" }, undefined, undefined, ctx));
      const legacyRows = text.split("\n").filter((row) => /│legacy$/.test(row));
      expect(legacyRows).toHaveLength(3);
      const first = extractHash(legacyRows[0]!);
      const last = extractHash(legacyRows[1]!);
      const result = await getTool("replace_match").execute("w1", { replace_from: first, replace_to: last, old_string: "legacy", new_string: "stable" }, undefined, undefined, ctx);
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("stable\nkeep\nstable\nlegacy\n");
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
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: foo, replace_to: bar, old_string: "foo\nbar", new_string: "one\ntwo\nthree" },
        undefined, undefined, ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("top\none\ntwo\nthree\nbottom\n");
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(diff).toContain(` ${top}│top`);
      expect(diff).toContain(` ${bottom}│bottom`);
    });
  });

  it("reports a noop when old_string and new_string are identical", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, old_string: "beta", new_string: "beta" },
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
      expect(await toolError(() => getTool("replace_match").execute("w1", { replace_from: anchor, replace_to: anchor, old_string: "BETA", new_string: "beta" }, undefined, undefined, ctx))).toMatch(/\[E_STALE_ANCHOR\]/);
    });
  });

  it("matches the interior against the current file and tolerates an external interior change", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const hashes = await lineHashes(content, join(cwd, "sample.txt"));
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "a\nB\nc\nd\n", "utf-8");
      const result = await getTool("replace_match").execute("w1", { replace_from: hashes[0]!, replace_to: hashes[2]!, old_string: "a\nB\nc", new_string: "a\nb\nc" }, undefined, undefined, ctx);
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\n");
    });
  });

  it("refuses when a boundary anchor was never shown", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt", limit: 1 }, undefined, undefined, ctx);
      const hashes = await lineHashes(content, join(cwd, "sample.txt"));
      expect(await toolError(() => getTool("replace_match").execute("w1", { replace_from: hashes[0]!, replace_to: hashes[3]!, old_string: "a", new_string: "A" }, undefined, undefined, ctx))).toMatch(/\[E_RANGE_STALE\]/);
    });
  });

  it("undoes the edit in one step", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      await getTool("replace_match").execute("w1", { replace_from: anchor, replace_to: anchor, old_string: "beta", new_string: "gamma" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
      const undone = await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("rejects remove_from/remove_to aliases", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      await expect(
        getTool("replace_match").execute(
          "w1",
          { remove_from: anchor, remove_to: anchor, old_string: "beta", new_string: "gamma" },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow("[E_BAD_SHAPE]");
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

  it("hints at literal escaped text in new_string", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const result = await getTool("replace_match").execute(
        "w1",
        { replace_from: anchor, replace_to: anchor, old_string: "beta", new_string: String.raw`stable\u200bCheckout` },
        undefined, undefined, ctx,
      );
      expect(result.details.hints).toContainEqual(expect.stringContaining('[H_LITERAL_ESCAPE] new_string:'));
      expect(result.details.metrics?.warnings).toBe(0);
    });
  });

  it("computes a preview without writing", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const anchor = anchorFor(text, "beta");
      const preview = await replaceMatchPreview({ replace_from: anchor, replace_to: anchor, old_string: "beta", new_string: "gamma" }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("gamma");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
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
        { replace_from: fence, replace_to: trailingEmpty, old_string: "```", new_string: "```done" },
        undefined,
        undefined,
        ctx,
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
        { replace_from: b, replace_to: blank, old_string: "b", new_string: "B" },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nB\n\nc\n");
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
      expect(await toolError(() => getTool("replace_match").execute("w1", { replace_from: anchor, replace_to: anchor, old_string: "beta", new_string: "gamma" }, undefined, undefined, ctx))).toMatch(/requires a non-empty "path"/);
      expect(await toolError(() => getTool("replace_match").execute("w2", { path: "other.txt", replace_from: anchor, replace_to: anchor, old_string: "beta", new_string: "gamma" }, undefined, undefined, ctx))).toMatch(/does not match anchor ownership/);
      await getTool("replace_match").execute("w3", { path: "sample.txt", replace_from: anchor, replace_to: anchor, old_string: "beta", new_string: "gamma" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\n");
    });
  });
});
