import { describe, expect, it, beforeEach } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  _lineHashesPure,
  lineHashes,
  HASH_SPACE,
  MAX_HASH_LINES,
} from "../../src/hashline";
import {
  useTestHome,
  withTempFile,
  setupReadTest,
  toolError,
} from "../support/fixtures";
import { initRegistry, lastUsedAtForTests, ownersForPath, resetRegistryForTests } from "../../src/anchor-registry";
import { sessionClaimsDir } from "../../src/paths";

beforeEach(() => {
  resetRegistryForTests();
});


function oversizedContent(): string {
  return Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
}
const home = useTestHome();

describe("hashline limits", () => {
  it("derives the hash space from the alphabet and hash length", () => {
    expect(HASH_SPACE).toBe(1353139);
    expect(MAX_HASH_LINES).toBe(HASH_SPACE);
  });

  it("hashes exactly MAX_HASH_LINES lines with unique anchors", () => {
    const content = Array.from(
      { length: MAX_HASH_LINES },
      (_, i) => `line ${i}`,
    ).join("\n");
    const hashes = _lineHashesPure(content);
    expect(hashes).toHaveLength(MAX_HASH_LINES);
    expect(new Set(hashes).size).toBe(MAX_HASH_LINES);
  }, 300_000);

  it("throws a clear E_FILE_TOO_LARGE error above the limit", () => {
    const content = oversizedContent();
    expect(() => _lineHashesPure(content)).toThrow("E_FILE_TOO_LARGE");
  }, 300_000);

  it("rejects an oversized file through the store path before minting or touching recency", async () => {
    const content = oversizedContent();
    await expect(lineHashes(content, home.testPath)).rejects.toThrow(
      new RegExp(`\\[E_FILE_TOO_LARGE\\][\\s\\S]*has ${MAX_HASH_LINES + 1} lines`),
    );
    expect(ownersForPath(home.testPath).size).toBe(0);
    expect(lastUsedAtForTests(home.testPath)).toBeUndefined();
  }, 300_000);

  it("does not evict another file's anchors when rejecting an oversized file", async () => {
    const neighbor = `${home.testPath}.neighbor`;
    await lineHashes("neighbor\n", neighbor);
    const owned = ownersForPath(neighbor).size;
    expect(owned).toBeGreaterThan(0);
    const content = oversizedContent();
    await expect(lineHashes(content, home.testPath)).rejects.toThrow("E_FILE_TOO_LARGE");
    expect(ownersForPath(neighbor).size).toBe(owned);
  }, 300_000);

  it("rejects an oversized file in shadow allocation without claiming anchors", async () => {
    const content = oversizedContent();
    await expect(lineHashes(content, home.testPath, undefined, undefined, false, true)).rejects.toThrow("E_FILE_TOO_LARGE");
    expect(ownersForPath(home.testPath).size).toBe(0);
    expect(lastUsedAtForTests(home.testPath)).toBeUndefined();
  }, 300_000);

  it("does not append ownership events for a rejected oversized file", async () => {
    const sessionFile = join(sessionClaimsDir(), "oversized-session.jsonl");
    await mkdir(sessionClaimsDir(), { recursive: true });
    const key = await initRegistry(sessionFile);
    const neighbor = `${home.testPath}.neighbor`;
    await lineHashes("neighbor\n", neighbor);
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    const before = await readFile(sidecar, "utf-8");
    expect(before).toContain(neighbor);
    const content = oversizedContent();
    await expect(lineHashes(content, home.testPath)).rejects.toThrow("E_FILE_TOO_LARGE");
    expect(await readFile(sidecar, "utf-8")).toBe(before);
  }, 300_000);

  it("preserves unique hashes at the boundary through the store path", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join(
      "\n",
    );
    const hashes = await lineHashes(content, home.testPath);
    expect(hashes).toHaveLength(MAX_HASH_LINES);
    expect(new Set(hashes).size).toBe(MAX_HASH_LINES);
  }, 300_000);
});

describe("read tool line cap", () => {
  it("rejects oversized files with E_FILE_TOO_LARGE before hashing", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join(
      "\n",
    );
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      expect(await toolError(() => readTool.execute("r1", { path: "huge.ts" }, undefined, undefined, ctx))).toContain("E_FILE_TOO_LARGE");
    });
  });

  it("reads a file at the limit without hashing errors", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join(
      "\n",
    );
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute(
        "r1",
        { path: "big.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[Showing lines 1-");
    });
  }, 300_000);
});
