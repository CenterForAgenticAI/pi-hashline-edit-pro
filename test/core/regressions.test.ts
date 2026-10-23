import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import { initHasher } from "../../src/hashline";
import { contentChecksum } from "../../src/hashline/hasher";
import { hashSource } from "../../src/hashline";
import { ANCHOR_COUNT, anchorAt } from "../../src/hashline/alphabet";
import { HASH_PROBE_STRIDE } from "../../src/hashline/hash";
import { initRegistry, resetRegistryForTests, allocateAnchor, freeAnchors, mintAnchor, alignOwnership, foldRegistryEvents, parseRegistryLog, buildCompactedLog, shouldCompactSidecar, ownerOf, SIDECAR_COMPACT_LINE_BYTES, SIDECAR_HEADER_BYTES, MINT_PROBE_LIMIT } from "../../src/anchor-registry";
import { resolveEditTarget } from "../../src/edit-common";
import { resolveReadOffset } from "../../src/read";
import { buildServedMap } from "../../src/served";
import { tryReadNormFile } from "../../src/file-reader";
import { ensureBatchBase, resetBatchStateForTests } from "../../src/batch";
import { genDiff } from "../../src/replace-diff";
import { withTempDir, setupIntegrationTest, getText, toolError } from "../support/fixtures";
import { ANCHOR_POOL_EXHAUSTED_PREFIX } from "../../src/constants";

beforeAll(async () => {
  await initHasher();
});

beforeEach(async () => {
  await initRegistry(undefined);
});

afterEach(() => {
  resetRegistryForTests();
  resetBatchStateForTests();
  vi.restoreAllMocks();
});

describe("resolveEditTarget cross file", () => {
  it("rejects anchors owned by different files", () => {
    const a = allocateAnchor("/a-gap.ts", "ck-a");
    const b = allocateAnchor("/b-gap.ts", "ck-b");
    let message = "";
    try {
      resolveEditTarget(a, b);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[E_BAD_SHAPE]");
    expect(message).toContain("different files");
  });
  it("resolves anchors owned by the same file", () => {
    const a = allocateAnchor("/same-gap.ts", "ck-1");
    const b = allocateAnchor("/same-gap.ts", "ck-2");
    expect(resolveEditTarget(a, b)).toBe("/same-gap.ts");
  });
  it("resolves a ref that differs only in case from an owned anchor", () => {
    const anchor = allocateAnchor("/case-gap.ts", "ck-case");
    const wrong = anchor.toUpperCase();
    expect(resolveEditTarget(wrong)).toBe("/case-gap.ts");
  });
  it("rejects an unknown anchor even when its case differs", () => {
    const anchor = allocateAnchor("/case-none.ts", "ck-none");
    const unknown = (anchor[0].toLowerCase() === "a" ? "B" : "A") + anchor.slice(1);
    let message = "";
    try {
      resolveEditTarget(unknown);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[E_STALE_ANCHOR]");
  });
  it("reports different files when a case variant resolves to another file", () => {
    const valid = allocateAnchor("/fold-target.ts", "ck-target");
    const other = allocateAnchor("/fold-other.ts", "ck-other");
    const wrongCaseOfOther = other.toUpperCase();
    let message = "";
    try {
      resolveEditTarget(valid, wrongCaseOfOther);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[E_BAD_SHAPE]");
    expect(message).toContain("different files");
  });
});

describe("stale anchor messages", () => {
  it("reports a freed anchor as stale rather than not owned", () => {
    const anchor = allocateAnchor("/freed.ts", "ck-freed");
    freeAnchors("/freed.ts");
    let message = "";
    try {
      resolveEditTarget(anchor);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[E_STALE_ANCHOR]");
    expect(message).toContain("is stale: it was valid earlier in this session");
    expect(message).not.toContain("not owned in this session");
  });

  it("reports a never-served anchor as never served", () => {
    let message = "";
    try {
      resolveEditTarget("zzzzx");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[E_STALE_ANCHOR]");
    expect(message).toContain("was never served in this session");
  });

  it("reports a freed read offset anchor as stale", () => {
    const anchor = allocateAnchor("/offset.ts", "ck-offset");
    freeAnchors("/offset.ts");
    let message = "";
    try {
      resolveReadOffset(anchor, ["a"], ["aaaaz"], "/offset.ts");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[E_STALE_ANCHOR]");
    expect(message).toContain("is stale: it was valid earlier in this session");
  });
});

describe("buildServedMap duplicates", () => {
  it("uses the first occurrence for a duplicated anchor", async () => {
    const fileHashes = ["aaaax", "bbbbx", "aaaax"];
    const fileLines = ["first", "second", "third"];
    const entries = buildServedMap(fileHashes, fileLines, ["aaaax"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]![0]).toBe("aaaax");
    expect(entries[0]![1]).toBe(contentChecksum(hashSource("first")));
  });
  it("skips wanted anchors absent from the file", () => {
    const entries = buildServedMap(["aaaax", "bbbbx"], ["x", "y"], ["zzzzx"]);
    expect(entries).toEqual([]);
  });
});

describe("tryReadNormFile contract", () => {
  it("rethrows anchor pool exhaustion instead of swallowing", async () => {
    await withTempDir("reader-pool-", async (dir) => {
      const target = join(dir, "f.txt");
      await writeFile(target, "a\nb\n", "utf-8");
      const hashline = await import("../../src/hashline");
      const spy = vi.spyOn(hashline, "lineHashes").mockRejectedValueOnce(new Error(`${ANCHOR_POOL_EXHAUSTED_PREFIX}; use write for very large files.`));
      try {
        await expect(tryReadNormFile(target, dir)).rejects.toThrow(ANCHOR_POOL_EXHAUSTED_PREFIX);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
  it("returns undefined for a binary file with NUL bytes", async () => {
    await withTempDir("reader-binary-", async (dir) => {
      const target = join(dir, "b.bin");
      await writeFile(target, Buffer.from([0x41, 0x00, 0x42]));
      expect(await tryReadNormFile(target, dir)).toBeUndefined();
    });
  });
});

describe("batch stale key", () => {
  it("rejects ensureBatchBase for an untracked batch", async () => {
    const member = { batchKey: 999999, display: 9, total: 1, target: "/x-gap.ts", kind: "replace", args: {}, order: 1, size: 1, last: true } as never;
    await expect(ensureBatchBase({ member, targetPath: "/x-gap.ts", mutationTargetPath: "/x-gap.ts", cwd: "/tmp" })).rejects.toThrow(/\[E_STALE_ANCHOR\].*no longer tracked/);
  });
});

describe("grep glob question mark", () => {
  it("matches a single character but not two", async () => {
    await withTempDir("grep-qmark-", async (dir) => {
      await writeFile(join(dir, "a1.ts"), "needle one\n", "utf-8");
      await writeFile(join(dir, "a12.ts"), "needle two\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "needle", glob: "a?.ts" }, undefined, undefined, ctx);
      const text = getText(result);
      expect(text).toContain("a1.ts");
      expect(text).not.toContain("a12.ts");
      const metrics = (result as { details?: { metrics?: { matches?: number; files?: number } } }).details?.metrics;
      expect(metrics?.matches).toBe(1);
      expect(metrics?.files).toBe(1);
    });
  });
});

describe("grep regex compatibility", () => {
  it("rejects an invalid k-angle backreference with ripgrep's error", async () => {
    await withTempDir("grep-kref-", async (dir) => {
      await writeFile(join(dir, "s.txt"), "hello\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      expect(await toolError(() => grepTool.execute("g1", { pattern: "\\k<foo>", path: "s.txt" }, undefined, undefined, ctx))).toContain("[E_GREP_FAILED]");
    });
  });
  it("accepts quantified alternation", async () => {
    await withTempDir("grep-alt-", async (dir) => {
      await writeFile(join(dir, "s.txt"), "ab\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "(a|b)+", path: "s.txt" }, undefined, undefined, ctx);
      expect(getText(result)).toContain("│ab");
    });
  });
  it("accepts two variable quantifiers", async () => {
    await withTempDir("grep-twoq-", async (dir) => {
      await writeFile(join(dir, "s.txt"), "aaabbb\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "a{1,2}b{3,4}", path: "s.txt" }, undefined, undefined, ctx);
      expect(getText(result)).toContain("│aaabbb");
    });
  });
  it("accepts a single variable quantifier", async () => {
    await withTempDir("grep-oneq-", async (dir) => {
      await writeFile(join(dir, "s.txt"), "aab\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "a{1,2}b", path: "s.txt" }, undefined, undefined, ctx);
      expect(getText(result)).toContain("aab");
    });
  });
  it("accepts quantifier inside a character class", async () => {
    await withTempDir("grep-class-", async (dir) => {
      await writeFile(join(dir, "s.txt"), "a*\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "[a*]+", path: "s.txt" }, undefined, undefined, ctx);
      expect(getText(result)).toContain("a*");
    });
  });
  it("accepts a lazy quantifier", async () => {
    await withTempDir("grep-lazy-", async (dir) => {
      await writeFile(join(dir, "s.txt"), "aab\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "a*?b", path: "s.txt" }, undefined, undefined, ctx);
      expect(getText(result)).toContain("aab");
    });
  });
  it("accepts a thousand repetitions", async () => {
    await withTempDir("grep-bound-ok-", async (dir) => {
      await writeFile(join(dir, "s.txt"), "aaa\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const ok = await grepTool.execute("g1", { pattern: "a{1000}", path: "s.txt" }, undefined, undefined, ctx);
      expect(getText(ok)).toContain("No matches found.");
      const okMetrics = (ok as { details?: { metrics?: { matches?: number } } }).details?.metrics;
      expect(okMetrics?.matches).toBe(0);
    });
  });
  it("accepts a thousand and one repetitions", async () => {
    await withTempDir("grep-bound-bad-", async (dir) => {
      await writeFile(join(dir, "s.txt"), "aaa\n", "utf-8");
      const { ctx, getTool } = setupIntegrationTest(dir);
      const grepTool = getTool("grep");
      const result = await grepTool.execute("g1", { pattern: "a{1001}", path: "s.txt" }, undefined, undefined, ctx);
      expect(getText(result)).toBe("No matches found.");
    });
  });
});

describe("buildCompactedLog roundtrip", () => {
  it("preserves owned and minted history through parse and fold", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [["aaaax", "ck1"], ["bbbbx", "ck2"]] },
      { kind: "allocate", path: "/b.ts", rows: [["ccccx", "ck3"]] },
      { kind: "minted", anchors: ["ddddx"] },
    ] as never);
    const log = buildCompactedLog("sessfile", state as never);
    expect(log.split("\n")[0]).toContain("sessfile");
    const refolded = foldRegistryEvents(parseRegistryLog(log));
    const owned = (refolded as unknown as { owned: Map<string, { path: string; checksum: string }> }).owned;
    expect(owned.get("aaaax")).toEqual({ path: "/a.ts", checksum: "ck1" });
    expect(owned.get("bbbbx")).toEqual({ path: "/a.ts", checksum: "ck2" });
    expect(owned.get("ccccx")).toEqual({ path: "/b.ts", checksum: "ck3" });
    expect(owned.size).toBe(3);
    const minted = (refolded as unknown as { everMinted: Set<string> }).everMinted;
    expect(minted.has("aaaax")).toBe(true);
    expect(minted.has("bbbbx")).toBe(true);
    expect(minted.has("ccccx")).toBe(true);
    expect(minted.has("ddddx")).toBe(true);
  });
});

describe("buildCompactedLog byte bounds", () => {
  it("keeps every compacted line within the header read cap", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [anchorAt(i), "0123456789abcdef"]);
    const state = foldRegistryEvents([{ kind: "allocate", path: "/big.ts", rows }] as never);
    const log = buildCompactedLog("sessfile", state as never);
    const lines = log.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    const maxLineBytes = Math.max(...lines.map((line) => Buffer.byteLength(line, "utf-8")));
    expect(maxLineBytes).toBeLessThanOrEqual(SIDECAR_COMPACT_LINE_BYTES);
    expect(maxLineBytes).toBeLessThanOrEqual(SIDECAR_HEADER_BYTES);
    expect(maxLineBytes).toBeGreaterThan(SIDECAR_HEADER_BYTES / 2);
    const owned = (foldRegistryEvents(parseRegistryLog(log)) as unknown as { owned: Map<string, unknown> }).owned;
    expect(owned.size).toBe(5000);
  });
});

describe("shouldCompactSidecar thresholds", () => {
  it("returns false for a small log", () => {
    expect(shouldCompactSidecar("a\nb\n")).toBe(false);
  });
  it("returns true for byte size over one megabyte", () => {
    expect(shouldCompactSidecar("x".repeat(1024 * 1024))).toBe(true);
  });
  it("returns true for five thousand lines", () => {
    expect(shouldCompactSidecar("\n".repeat(5000))).toBe(true);
  });
});

describe("mintAnchor recycle", () => {
  it("purges the recycled anchor from served maps", () => {
    const empty = foldRegistryEvents([]);
    const state = empty as unknown as { owned: Map<string, never>; served: Map<string, Map<string, string>>; everMinted: Set<string>; probe: number };
    for (let k = 1; k <= MINT_PROBE_LIMIT; k++) {
      state.everMinted.add(anchorAt((k * HASH_PROBE_STRIDE) % ANCHOR_COUNT));
    }
    const finalProbe = (MINT_PROBE_LIMIT * HASH_PROBE_STRIDE) % ANCHOR_COUNT;
    const predicted = anchorAt((finalProbe + 1) % ANCHOR_COUNT);
    state.served.set("/s.ts", new Map([[predicted, "stale"]]));
    const result = mintAnchor(empty as never);
    expect(result).toBe(predicted);
    expect(state.served.get("/s.ts")?.has(predicted)).toBe(false);
  });
});

describe("alignOwnership cross path", () => {
  it("mints a fresh anchor instead of reusing another file anchor", () => {
    const original = allocateAnchor("/cross-a.ts", "ck-cross");
    const aligned = alignOwnership("/cross-b.ts", [original], ["ck-cross"], ["ck-cross"], { shadow: true });
    expect(aligned.anchors[0]).not.toBe(original);
    expect(ownerOf(original)?.path).toBe("/cross-a.ts");
  });
});

describe("genDiff guarded input", () => {
  it("bounds output and aligns line numbers under a tiny byte budget", () => {
    const oldContent = "a".repeat(600 * 1024);
    const newContent = "b".repeat(600 * 1024);
    const result = genDiff(oldContent, newContent, 2, ["hhhh"], ["gggg"], { maxBytes: 100 });
    expect(result.diff).toContain("diff truncated at");
    expect(result.diff.split("\n")).toHaveLength(result.lineNumbers.length);
    expect(Buffer.byteLength(result.diff, "utf-8")).toBeLessThanOrEqual(500);
  });
  it("emits a leading ellipsis when the change starts after the context window", () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line-${i}-` + "x".repeat(55));
    const changed = [...lines];
    changed[10000] = "CHANGED-" + "y".repeat(55);
    const oldContent = lines.join("\n");
    const newContent = changed.join("\n");
    const result = genDiff(oldContent, newContent, 2);
    expect(result.diff).toContain("diff truncated at");
    expect(result.diff.split("\n")[0]).toBe(" ...");
    expect(result.diff.split("\n")).toHaveLength(result.lineNumbers.length);
  });
});
