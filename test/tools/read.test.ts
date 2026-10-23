import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { realpath, symlink, writeFile } from "node:fs/promises";
import { fmtRegion } from "../../src/hashline";
import { fmtReadPreview, insertBeforeExpandHint } from "../../src/read";
import { cacheSnapshot, snapshotCache } from "../../src/hash-store/cache";
import { useTestHome, withTempFile, withTempDir, setupIntegrationTest, makeFakePiRegistry } from "../support/fixtures";
import register from "../../index";

const home = useTestHome();

describe("fmtReadPreview", () => {
  it("returns all lines when no offset or limit given", async () => {
    const text = "alpha\nbeta\ngamma\n";
    const result = await fmtReadPreview(text, {}, undefined, home.testPath);
    expect(result.text).toContain("│alpha");
    expect(result.text).toContain("│beta");
    expect(result.text).toContain("│gamma");
  });

  it("hides the terminal newline sentinel from preview output", async () => {
    const text = "alpha\nbeta\n";
    const result = await fmtReadPreview(text, {}, undefined, home.testPath);
    expect(result.text).toContain("│alpha");
    expect(result.text).toContain("│beta");
    const lines = result.text.split("\n");
    const emptyContentLines = lines.filter((l) => /^[a-z]{5}│$/.test(l));
    expect(emptyContentLines).toHaveLength(0);
  });

  it("keeps continuation hints for partial previews", async () => {
    const text = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    const result = await fmtReadPreview(text, { limit: 3 }, ["atimx", "besrx", "dafox", "emnox", "hdtmx", "ifmsx", "aaaaz", "bbbbz", "ccccz", "ddddz"], home.testPath);
    expect(result.text).toContain("[Showing lines 1-3 of 10. Use offset=dafox to continue.]");
  });

  it("reports when offset is beyond end of content", async () => {
    const text = "a\nb\n";
    const result = await fmtReadPreview(text, { offset: 5 }, undefined, home.testPath);
    expect(result.text).toContain("Offset 5 is beyond end of file");
  });

  it("rejects fractional offsets", async () => {
    await expect(fmtReadPreview("a\nb\n", { offset: 1.5 } as any, undefined, home.testPath)).rejects.toThrow("positive integer");
  });

  it("rejects non-positive limits", async () => {
    await expect(fmtReadPreview("a\nb\n", { limit: 0 } as any, undefined, home.testPath)).rejects.toThrow("positive integer");
  });
});

describe("fmtRegion", () => {
  it("formats lines as HASH|content rows", () => {
    const result = fmtRegion(["ABC", "DEF"], ["hello", "world"]);
    expect(result).toBe("ABC│hello\nDEF│world");
  });

  it("does not pad line numbers (the format drops them)", () => {
    const result = fmtRegion(["X"], ["test"]);
    expect(result).toBe("X│test");
  });
});

describe("read tool - snapshot failure", () => {
  it("succeeds and omits snapshotId when the snapshot computation fails", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const fileReader = await import("../../src/file-reader");
      const spy = vi
        .spyOn(fileReader, "safeSnapId")
        .mockResolvedValue(undefined);
      try {
        const result = await readTool.execute(
          "r1",
          { path: "sample.ts" },
          undefined,
          undefined,
          ctx,
        );
        expect(result.content[0].text).toContain("│aaa");
        expect(result.details.snapshotId).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("read tool - file_path alias", () => {
  it("rejects the file_path alias", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await expect(
        readTool.execute(
          "r1",
          { file_path: "sample.ts" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[E_BAD_SHAPE\]/);
    });
  });
});

describe("read tool - call rendering", () => {
  const theme = {
    fg: (_area: string, text: string) => text,
    bold: (text: string) => text,
  };
  const context = { lastComponent: undefined, expanded: false, isError: false, cwd: process.cwd() };

  function renderCall(args: unknown, cwd: string = process.cwd()): string {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    return (getTool("read").renderCall(args, theme, { ...context, cwd }) as unknown as { text: string }).text;
  }

  it("renders a numeric-string offset and limit as a line range", () => {
    const text = renderCall({ path: "sample.ts", offset: "576", limit: "520" });
    expect(text).toContain("sample.ts");
    expect(text).toContain(":576-1095");
    expect(text).not.toContain("576519");
  });

  it("renders numeric offsets the same way", () => {
    expect(renderCall({ path: "sample.ts", offset: 576, limit: 520 })).toContain(":576-1095");
  });

  it("falls back to the anchor with a +N suffix when its line is not cached", () => {
    const text = renderCall({ path: "sample.ts", offset: "rkhlx", limit: "520" });
    expect(text).toContain(":rkhlx +520");
    expect(text).not.toContain("NaN");
  });

  it("renders the resolved anchor line range with the anchor label", () => {
    const absolute = join(process.cwd(), "anchor-line-sample.ts");
    cacheSnapshot(absolute, "checksum", 3, ["aaaaz", "rkhlx", "bbbbz"]);
    try {
      const text = renderCall({ path: "anchor-line-sample.ts", offset: "rkhlx", limit: 520 });
      expect(text).toContain(":2-521 (rkhlx)");
    } finally {
      snapshotCache.delete(absolute);
    }
  });

  it("renders the resolved anchor line with the anchor label", () => {
    const absolute = join(process.cwd(), "anchor-line-sample.ts");
    cacheSnapshot(absolute, "checksum", 3, ["aaaaz", "rkhlx", "bbbbz"]);
    try {
      const text = renderCall({ path: "anchor-line-sample.ts", offset: "rkhlx" });
      expect(text).toContain(":2 (rkhlx)");
    } finally {
      snapshotCache.delete(absolute);
    }
  });

  it("falls back to the bare anchor when no snapshot is cached", () => {
    const text = renderCall({ path: "anchor-line-uncached.ts", offset: "rkhlx", limit: 520 });
    expect(text).toContain(":rkhlx +520");
    expect(text).not.toMatch(/\(\d+\)/);
    expect(renderCall({ path: "anchor-line-uncached.ts", offset: "rkhlx", limit: 0 })).toContain(":rkhlx");
  });

  it.skipIf(process.platform === "win32")("resolves the line through a symlinked path", async () => {
    await withTempDir("read-call-symlink-", async (dir) => {
      const real = join(dir, "real.ts");
      await writeFile(real, "alpha\nbeta\n", "utf-8");
      await symlink(real, join(dir, "link.ts"));
      const seeded = await realpath(real);
      cacheSnapshot(seeded, "checksum", 2, ["aaaaz", "rkhlx"]);
      try {
        const text = renderCall({ path: "link.ts", offset: "rkhlx", limit: 5 }, dir);
        expect(text).toContain(":2-6 (rkhlx)");
      } finally {
        snapshotCache.delete(seeded);
      }
    });
  });

  it("leaves an unresolved anchor offset unsuffixed", () => {
    const text = renderCall({ path: "sample.ts", offset: "rkhlx" });
    expect(text).toContain(":rkhlx");
    expect(text).not.toContain(":rkhlx +");
  });

  it("keeps the +N suffix ahead of the compact expand hint", () => {
    const text = renderCall({ path: "AGENTS.md", offset: "rkhlx", limit: 560 });
    expect(text).toContain(":rkhlx +560");
    expect(text.indexOf(":rkhlx +560")).toBeLessThan(text.indexOf("to expand"));
  });

  it("renders incomplete and malformed args without throwing", () => {
    expect(renderCall(undefined)).toContain("read");
    expect(renderCall({ path: "sample.ts", offset: "576" })).toContain(":576");
    expect(renderCall("nope")).toBeDefined();
  });
});

describe("read tool - call range insertion", () => {
  it("appends the range when the call has no expand hint", () => {
    expect(insertBeforeExpandHint("read sample.ts", ":2 (rkhlx)")).toBe("read sample.ts:2 (rkhlx)");
  });

  it("inserts the range before a styled compact expand hint", () => {
    const hint = "\x1b[2m (ctrl+o to expand)\x1b[39m";
    expect(insertBeforeExpandHint(`read resource AGENTS.md${hint}`, ":rkhlx +560")).toBe(`read resource AGENTS.md:rkhlx +560${hint}`);
  });

  it("inserts the range before a plain compact expand hint", () => {
    expect(insertBeforeExpandHint("read resource AGENTS.md (ctrl+o to expand)", ":rkhlx +560")).toBe("read resource AGENTS.md:rkhlx +560 (ctrl+o to expand)");
  });
});
