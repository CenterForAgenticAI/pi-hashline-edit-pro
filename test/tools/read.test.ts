import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { realpath, symlink, writeFile } from "node:fs/promises";
import { fmtRegion } from "../../src/hashline";
import { fmtReadPreview } from "../../src/read";
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
    const emptyContentLines = lines.filter((l) => /^[A-Za-z]{4}│$/.test(l));
    expect(emptyContentLines).toHaveLength(0);
  });

  it("keeps continuation hints for partial previews", async () => {
    const text = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    const result = await fmtReadPreview(text, { limit: 3 }, undefined, home.testPath);
    expect(result.text).toContain("[Showing lines 1-3 of 10. Use offset=4 to continue.]");
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

  it("shows an anchor offset's limit as a +N suffix", () => {
    const text = renderCall({ path: "sample.ts", offset: "RKhl", limit: "520" });
    expect(text).toContain(":RKhl +520");
    expect(text).not.toContain("NaN");
  });

  it("shows the anchor's resolved line before the limit suffix", () => {
    const absolute = join(process.cwd(), "anchor-line-sample.ts");
    cacheSnapshot(absolute, "checksum", 3, ["Aaaa", "RKhl", "Bbbb"]);
    try {
      const text = renderCall({ path: "anchor-line-sample.ts", offset: "RKhl", limit: 520 });
      expect(text).toContain(":RKhl (2) +520");
    } finally {
      snapshotCache.delete(absolute);
    }
  });

  it("shows the anchor's resolved line without a limit", () => {
    const absolute = join(process.cwd(), "anchor-line-sample.ts");
    cacheSnapshot(absolute, "checksum", 3, ["Aaaa", "RKhl", "Bbbb"]);
    try {
      const text = renderCall({ path: "anchor-line-sample.ts", offset: "RKhl" });
      expect(text).toContain(":RKhl (2)");
    } finally {
      snapshotCache.delete(absolute);
    }
  });

  it("leaves the anchor without a line when no snapshot is cached", () => {
    const text = renderCall({ path: "anchor-line-uncached.ts", offset: "RKhl", limit: 520 });
    expect(text).toContain(":RKhl +520");
    expect(text).not.toMatch(/\(\d+\)/);
    expect(renderCall({ path: "anchor-line-uncached.ts", offset: "RKhl", limit: 0 })).toContain(":RKhl");
  });

  it.skipIf(process.platform === "win32")("resolves the line through a symlinked path", async () => {
    await withTempDir("read-call-symlink-", async (dir) => {
      const real = join(dir, "real.ts");
      await writeFile(real, "alpha\nbeta\n", "utf-8");
      await symlink(real, join(dir, "link.ts"));
      const seeded = await realpath(real);
      cacheSnapshot(seeded, "checksum", 2, ["Aaaa", "RKhl"]);
      try {
        const text = renderCall({ path: "link.ts", offset: "RKhl", limit: 5 }, dir);
        expect(text).toContain(":RKhl (2) +5");
      } finally {
        snapshotCache.delete(seeded);
      }
    });
  });

  it("leaves an anchor offset without a limit unsuffixed", () => {
    const text = renderCall({ path: "sample.ts", offset: "RKhl" });
    expect(text).toContain(":RKhl");
    expect(text).not.toContain(":RKhl +");
  });

  it("keeps the +N suffix ahead of the compact expand hint", () => {
    const text = renderCall({ path: "AGENTS.md", offset: "RKhl", limit: 560 });
    expect(text).toContain(":RKhl +560");
    expect(text.indexOf(":RKhl +560")).toBeLessThan(text.indexOf("to expand"));
  });

  it("renders incomplete and malformed args without throwing", () => {
    expect(renderCall(undefined)).toContain("read");
    expect(renderCall({ path: "sample.ts", offset: "576" })).toContain(":576");
    expect(renderCall("nope")).toBeDefined();
  });
});
