import { beforeAll, describe, expect, it } from "vitest";
import { genDiff, disambiguateDuplicateAnchors, spansFromHashes } from "../../src/replace-diff";
import { initHasher } from "../../src/hashline";

beforeAll(async () => {
  await initHasher();
});

function anchoredRows(diff: string, prefix: "+" | "-" | " "): string[] {
  return diff.split("\n").filter((line) => line.startsWith(prefix) && line.includes("│") && !line.startsWith(`${prefix}    │`));
}

function rowAnchor(row: string): string {
  const match = /^[+ -]([a-z]{5})│/.exec(row);
  return match ? match[1]! : "(blank)";
}

describe("genDiff with true spans", () => {
  it("stamps - rows with true removed anchors when duplicates neighbor the edit", () => {
    const oldContent = "alpha one\n  }\nbeta two\n  }\ngamma three\n  }\ndelta four";
    const newContent = "alpha one\n  }\nbeta two\nREPLACED\n  }\ndelta four";
    const oldHashes = ["aaaaz", "bbbbz", "ccccz", "ddddz", "eeeey", "ffffx", "ggggx"];
    const newHashes = ["aaaaz", "bbbbz", "ccccz", "hhhhx", "ffffx", "ggggx"];
    const spans = [{ start: 3, end: 4, replacementCount: 1 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    const removed = anchoredRows(diff, "-").map(rowAnchor);
    expect(removed).toContain("ddddz");
    expect(removed).toContain("eeeey");
    const live = new Set([...anchoredRows(diff, "+").map(rowAnchor), ...anchoredRows(diff, " ").map(rowAnchor)]);
    expect(removed.filter((anchor) => live.has(anchor))).toEqual([]);
    expect(diff.split("\n").find((line) => line.startsWith("-") && line.includes("ffffx"))).toBeUndefined();
  });

  it("renders insertion spans as context plus added rows without removing the anchor line", () => {
    const oldContent = "alpha\nX\nbeta";
    const newContent = "alpha\nX\nNEW\nbeta";
    const oldHashes = ["aaaaz", "bbbbz", "ccccz"];
    const newHashes = ["aaaaz", "bbbbz", "hhhhx", "ccccz"];
    const spans = [{ start: 1, end: 1, replacementCount: 2 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain(" bbbbz│X");
    expect(diff).toContain("+hhhhx│NEW");
    expect(diff.split("\n").find((line) => line.startsWith("-"))).toBeUndefined();
  });

  it("keeps the carried anchor on the context row when a duplicate lands before it", () => {
    const oldContent = "a\nb\nc";
    const newContent = "a\nb\nb\nc";
    const oldHashes = ["aaaaz", "bbbbz", "ccccz"];
    const newHashes = ["aaaaz", "ddddz", "bbbbz", "ccccz"];
    const spans = [{ start: 1, end: 1, replacementCount: 2, carry: 1 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("+ddddz│b");
    expect(diff).toContain(" bbbbz│b");
    expect(diff).not.toContain("+bbbbz│b");
  });

  it("renders multi-span batches with true attribution per hunk", () => {
    const oldContent = "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
    const newContent = "l0\nR1\nl2\nl3\nl4\nl5\nl6\nR2\nl8";
    const oldHashes = ["aaaaz", "bbbbz", "ccccz", "ddddz", "eeeey", "ffffx", "ggggx", "hhhhx", "iiiix"];
    const newHashes = ["aaaaz", "jjjjx", "ccccz", "ddddz", "eeeey", "ffffx", "ggggx", "kkkkx", "iiiix"];
    const spans = [
      { start: 1, end: 1, replacementCount: 1 },
      { start: 7, end: 7, replacementCount: 1 },
    ];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("-bbbbz│l1");
    expect(diff).toContain("+jjjjx│R1");
    expect(diff).toContain("-hhhhx│l7");
    expect(diff).toContain("+kkkkx│R2");
    expect(diff).toContain(" ...");
  });

  it("falls back to content diff when spans are absent or invalid", () => {
    const oldContent = "alpha\nbeta\ngamma";
    const newContent = "alpha\nBETA\ngamma";
    const fallback = genDiff(oldContent, newContent, 1);
    expect(fallback.diff).toContain("BETA");
    const invalid = genDiff(oldContent, newContent, 1, ["hhhhx"], ["aaaaz", "bbbbz", "ccccz"], undefined, [{ start: 99, end: 100, replacementCount: 1 }]);
    expect(invalid.diff).toContain("BETA");
    const overlapping = genDiff(oldContent, newContent, 1, ["aaaaz", "hhhhx", "ccccz"], ["aaaaz", "bbbbz", "ccccz"], undefined, [
      { start: 0, end: 1, replacementCount: 1 },
      { start: 1, end: 2, replacementCount: 1 },
    ]);
    expect(overlapping.diff).toContain("BETA");
  });

  it("blanks stale - rows that duplicate a live anchor as a safety net", () => {
    const dup = "-ddddz│  }\n+hhhhx│REPLACED\n-ffffx│  }\n ffffx│  }";
    const fixed = disambiguateDuplicateAnchors(dup);
    expect(fixed).toContain("-     │  }");
    expect(fixed).toContain(" ffffx│  }");
    expect(fixed).not.toMatch(/^-ffffx│/m);
  });

  it("derives batch spans from anchor sequences without content pairing", () => {
    const oldHashes = ["aaaaz", "bbbbz", "ccccz", "ddddz", "eeeey"];
    const newHashes = ["aaaaz", "hhhhx", "ccccz", "ddddz", "kkkkx", "eeeey"];
    const spans = spansFromHashes(oldHashes, newHashes);
    expect(spans).toEqual([
      { start: 1, end: 1, replacementCount: 1 },
      { start: 4, end: 3, replacementCount: 1 },
    ]);
  });

  it("keeps unchanged interior lines of a span as context rows", () => {
    const oldContent = "l0\nold a\nkeep\nkeep too\nold b\nl5";
    const newContent = "l0\nnew a\nkeep\nkeep too\nnew b\nl5";
    const oldHashes = ["aaaaz", "bbbbz", "ccccz", "ddddz", "eeeey", "ffffx"];
    const newHashes = ["aaaaz", "ggggx", "ccccz", "ddddz", "hhhhx", "ffffx"];
    const spans = [{ start: 1, end: 4, replacementCount: 4 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("-bbbbz│old a");
    expect(diff).toContain("+ggggx│new a");
    expect(diff).toContain(" ccccz│keep");
    expect(diff).toContain(" ddddz│keep too");
    expect(diff).toContain("-eeeey│old b");
    expect(diff).toContain("+hhhhx│new b");
    expect(diff).not.toMatch(/^[-+]ccccz│/m);
    expect(diff).not.toMatch(/^[-+]ddddz│/m);
  });

  it("treats a shifted unchanged run inside a span as context", () => {
    const oldContent = "A\nB\nC\nD";
    const newContent = "A\nC\nD";
    const oldHashes = ["aaaaz", "bbbbz", "ccccz", "ddddz"];
    const newHashes = ["aaaaz", "ccccz", "ddddz"];
    const spans = [{ start: 1, end: 3, replacementCount: 2 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("-bbbbz│B");
    expect(diff).toContain(" ccccz│C");
    expect(diff).not.toMatch(/^[-+]ccccz│/m);
    expect(diff).not.toMatch(/^[-+]ddddz│/m);
  });

  it("keeps a line whose hash survived but whose text changed as a change row", () => {
    const oldContent = "same\nhidden tail A";
    const newContent = "same\nhidden tail B";
    const oldHashes = ["aaaaz", "bbbbz"];
    const newHashes = ["aaaaz", "bbbbz"];
    const spans = [{ start: 1, end: 1, replacementCount: 1 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("+bbbbz│hidden tail B");
    expect(diff).not.toContain(" bbbbz│hidden tail B");
  });

  it("falls back when the span list is empty", () => {
    const oldContent = "alpha\nbeta\ngamma";
    const newContent = "alpha\nBETA\ngamma";
    const oldHashes = ["aaaaz", "bbbbz", "ccccz"];
    const newHashes = ["aaaaz", "ddddz", "ccccz"];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, { unlimited: true }, []);
    expect(diff).toContain("-bbbbz│beta");
    expect(diff).toContain("+ddddz│BETA");
  });

  it("splits a wide alternating span without exhausting the call stack", () => {
    const count = 260000;
    const oldLines = new Array<string>(count);
    const newLines = new Array<string>(count);
    const oldHashes = new Array<string>(count);
    const newHashes = new Array<string>(count);
    for (let index = 0; index < count; index++) {
      const even = index % 2 === 0;
      oldLines[index] = `l${index}`;
      newLines[index] = even ? `l${index}` : `l${index}!`;
      oldHashes[index] = `A${index}`;
      newHashes[index] = even ? `A${index}` : `B${index}`;
    }
    const spans = [{ start: 0, end: count - 1, replacementCount: count }];
    const { diff } = genDiff(oldLines.join("\n"), newLines.join("\n"), 1, newHashes, oldHashes, { maxBytes: 4096, maxLineBytes: 4096 }, spans);
    expect(diff).toContain("[diff truncated at");
  });
});
