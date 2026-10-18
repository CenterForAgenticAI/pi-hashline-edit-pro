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
  const match = /^[+ -]([A-Za-z]{4})│/.exec(row);
  return match ? match[1]! : "(blank)";
}

describe("genDiff with true spans", () => {
  it("stamps - rows with true removed anchors when duplicates neighbor the edit", () => {
    const oldContent = "alpha one\n  }\nbeta two\n  }\ngamma three\n  }\ndelta four";
    const newContent = "alpha one\n  }\nbeta two\nREPLACED\n  }\ndelta four";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee", "Ffff", "Gggg"];
    const newHashes = ["Aaaa", "Bbbb", "Cccc", "Hhhh", "Ffff", "Gggg"];
    const spans = [{ start: 3, end: 4, replacementCount: 1 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    const removed = anchoredRows(diff, "-").map(rowAnchor);
    expect(removed).toContain("Dddd");
    expect(removed).toContain("Eeee");
    const live = new Set([...anchoredRows(diff, "+").map(rowAnchor), ...anchoredRows(diff, " ").map(rowAnchor)]);
    expect(removed.filter((anchor) => live.has(anchor))).toEqual([]);
    expect(diff.split("\n").find((line) => line.startsWith("-") && line.includes("Ffff"))).toBeUndefined();
  });

  it("renders insertion spans as context plus added rows without removing the anchor line", () => {
    const oldContent = "alpha\nX\nbeta";
    const newContent = "alpha\nX\nNEW\nbeta";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc"];
    const newHashes = ["Aaaa", "Bbbb", "Hhhh", "Cccc"];
    const spans = [{ start: 1, end: 1, replacementCount: 2 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain(" Bbbb│X");
    expect(diff).toContain("+Hhhh│NEW");
    expect(diff.split("\n").find((line) => line.startsWith("-"))).toBeUndefined();
  });

  it("keeps the carried anchor on the context row when a duplicate lands before it", () => {
    const oldContent = "a\nb\nc";
    const newContent = "a\nb\nb\nc";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc"];
    const newHashes = ["Aaaa", "Dddd", "Bbbb", "Cccc"];
    const spans = [{ start: 1, end: 1, replacementCount: 2, carry: 1 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("+Dddd│b");
    expect(diff).toContain(" Bbbb│b");
    expect(diff).not.toContain("+Bbbb│b");
  });

  it("renders multi-span batches with true attribution per hunk", () => {
    const oldContent = "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
    const newContent = "l0\nR1\nl2\nl3\nl4\nl5\nl6\nR2\nl8";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee", "Ffff", "Gggg", "Hhhh", "Iiii"];
    const newHashes = ["Aaaa", "Jjjj", "Cccc", "Dddd", "Eeee", "Ffff", "Gggg", "Kkkk", "Iiii"];
    const spans = [
      { start: 1, end: 1, replacementCount: 1 },
      { start: 7, end: 7, replacementCount: 1 },
    ];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("-Bbbb│l1");
    expect(diff).toContain("+Jjjj│R1");
    expect(diff).toContain("-Hhhh│l7");
    expect(diff).toContain("+Kkkk│R2");
    expect(diff).toContain(" ...");
  });

  it("falls back to content diff when spans are absent or invalid", () => {
    const oldContent = "alpha\nbeta\ngamma";
    const newContent = "alpha\nBETA\ngamma";
    const fallback = genDiff(oldContent, newContent, 1);
    expect(fallback.diff).toContain("BETA");
    const invalid = genDiff(oldContent, newContent, 1, ["Hhhh"], ["Aaaa", "Bbbb", "Cccc"], undefined, [{ start: 99, end: 100, replacementCount: 1 }]);
    expect(invalid.diff).toContain("BETA");
    const overlapping = genDiff(oldContent, newContent, 1, ["Aaaa", "Hhhh", "Cccc"], ["Aaaa", "Bbbb", "Cccc"], undefined, [
      { start: 0, end: 1, replacementCount: 1 },
      { start: 1, end: 2, replacementCount: 1 },
    ]);
    expect(overlapping.diff).toContain("BETA");
  });

  it("blanks stale - rows that duplicate a live anchor as a safety net", () => {
    const dup = "-Dddd│  }\n+Hhhh│REPLACED\n-Ffff│  }\n Ffff│  }";
    const fixed = disambiguateDuplicateAnchors(dup);
    expect(fixed).toContain("-    │  }");
    expect(fixed).toContain(" Ffff│  }");
    expect(fixed).not.toMatch(/^-Ffff│/m);
  });

  it("derives batch spans from anchor sequences without content pairing", () => {
    const oldHashes = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee"];
    const newHashes = ["Aaaa", "Hhhh", "Cccc", "Dddd", "Kkkk", "Eeee"];
    const spans = spansFromHashes(oldHashes, newHashes);
    expect(spans).toEqual([
      { start: 1, end: 1, replacementCount: 1 },
      { start: 4, end: 3, replacementCount: 1 },
    ]);
  });

  it("keeps unchanged interior lines of a span as context rows", () => {
    const oldContent = "l0\nold a\nkeep\nkeep too\nold b\nl5";
    const newContent = "l0\nnew a\nkeep\nkeep too\nnew b\nl5";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee", "Ffff"];
    const newHashes = ["Aaaa", "Gggg", "Cccc", "Dddd", "Hhhh", "Ffff"];
    const spans = [{ start: 1, end: 4, replacementCount: 4 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("-Bbbb│old a");
    expect(diff).toContain("+Gggg│new a");
    expect(diff).toContain(" Cccc│keep");
    expect(diff).toContain(" Dddd│keep too");
    expect(diff).toContain("-Eeee│old b");
    expect(diff).toContain("+Hhhh│new b");
    expect(diff).not.toMatch(/^[-+]Cccc│/m);
    expect(diff).not.toMatch(/^[-+]Dddd│/m);
  });

  it("treats a shifted unchanged run inside a span as context", () => {
    const oldContent = "A\nB\nC\nD";
    const newContent = "A\nC\nD";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc", "Dddd"];
    const newHashes = ["Aaaa", "Cccc", "Dddd"];
    const spans = [{ start: 1, end: 3, replacementCount: 2 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("-Bbbb│B");
    expect(diff).toContain(" Cccc│C");
    expect(diff).not.toMatch(/^[-+]Cccc│/m);
    expect(diff).not.toMatch(/^[-+]Dddd│/m);
  });

  it("keeps a line whose hash survived but whose text changed as a change row", () => {
    const oldContent = "same\nhidden tail A";
    const newContent = "same\nhidden tail B";
    const oldHashes = ["Aaaa", "Bbbb"];
    const newHashes = ["Aaaa", "Bbbb"];
    const spans = [{ start: 1, end: 1, replacementCount: 1 }];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, undefined, spans);
    expect(diff).toContain("+Bbbb│hidden tail B");
    expect(diff).not.toContain(" Bbbb│hidden tail B");
  });

  it("falls back when the span list is empty", () => {
    const oldContent = "alpha\nbeta\ngamma";
    const newContent = "alpha\nBETA\ngamma";
    const oldHashes = ["Aaaa", "Bbbb", "Cccc"];
    const newHashes = ["Aaaa", "Dddd", "Cccc"];
    const { diff } = genDiff(oldContent, newContent, 1, newHashes, oldHashes, { unlimited: true }, []);
    expect(diff).toContain("-Bbbb│beta");
    expect(diff).toContain("+Dddd│BETA");
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
