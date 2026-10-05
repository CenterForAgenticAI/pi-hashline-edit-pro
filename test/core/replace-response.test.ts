import { describe, expect, it } from "vitest";
import { applyPatch } from "diff";
import { buildNoop, buildChanged } from "../../src/replace-response";
import { lineHashes } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("buildNoop", () => {
  it("returns noop result with classification", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("No changes made to test.txt");
    expect(result.details.patch).toBe("");
    expect(result.details.classification).toBe("noop");
    expect(result.details.metrics!.edits_attempted).toBe(1);
  });

  it("includes noop edit details when provided", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: { loc: "ABC", currentContent: "old" },
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("Replacement for ABC");
    expect(result.content[0].text).toContain("ABC");
  });

  it("includes warnings when provided", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, addedLines: 0, removedLines: 0 },
      warnings: ["Warning 1"],
    });
    expect(result.details.metrics!.warnings).toBe(1);
    expect(result.content[0].text).toContain("Warnings:");
    expect(result.content[0].text).toContain("Warning 1");
  });

  it("splits hint notices from warnings and does not count them as warnings", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, addedLines: 0, removedLines: 0 },
      warnings: ["[H_LITERAL_ESCAPE] hint", "[W_BAD_REF] warn"],
    });
    expect(result.details.hints).toEqual(["[H_LITERAL_ESCAPE] hint"]);
    expect(result.details.warnings).toEqual(["[W_BAD_REF] warn"]);
    expect(result.details.metrics!.warnings).toBe(1);
    expect(result.content[0].text).toContain("Hints:");
    expect(result.content[0].text).toContain("[H_LITERAL_ESCAPE] hint");
    expect(result.content[0].text).toContain("Warnings:");
  });

  it("clips long currentContent in noop details", () => {
    const result = buildNoop({
      path: "test.txt",
      noopEdit: { loc: "ABC", currentContent: "old\n".repeat(300) },
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, addedLines: 0, removedLines: 0 },
      warnings: undefined,
    });
    expect(result.content[0].text).toContain("Replacement for ABC");
    expect(result.content[0].text).not.toContain("old\n".repeat(300));
    expect(result.content[0].text).toContain("...");
  });
});

describe("buildChanged", () => {
  it("returns applied result with diff and metrics", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
    });
    expect(output.content[0].text).toContain("Successfully replaced in test.txt");
    expect(output.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    expect(output.details.metrics!.classification).toBe("applied");
    expect(output.details.metrics!.edits_attempted).toBe(1);
    expect(output.details.metrics!.changed_lines).toEqual({ first: 2, last: 2 });
  });

  it("includes a standard unified patch that round-trips", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
    });
    const patch = output.details.patch!;
    expect(patch).toContain("--- test.txt");
    expect(patch).toContain("+++ test.txt");
    expect(patch).toContain("@@");
    expect(patch).toContain("-bbb");
    expect(patch).toContain("+BBB");
    expect(applyPatch(original, patch)).toBe(result);
  });

  it("includes warnings when provided", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: ["Example warning (leading)"],
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
    });
    expect(output.content[0].text).toContain("Warnings:");
    expect(output.content[0].text).toContain("Example warning (leading)");
  });

  it("shows empty file message when result is empty", async () => {
    const original = "aaa\nbbb\n";
    const result = "";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 1, lastChangedLine: 2, addedLines: 0, removedLines: 2 },
    });
    expect(output.content[0].text).toBe(`File is empty. Use replace on ${resultHashes[0]}│ to insert content.`);
  });

  it("computes added_lines and removed_lines from editMeta", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nBBB\nCCC\nDDD\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 4, addedLines: 3, removedLines: 2 },
    });
    expect(output.details.metrics!.added_lines).toBe(3);
    expect(output.details.metrics!.removed_lines).toBe(2);
    expect(output.content[0].text).toContain("Added 3 line(s), removed 2 line(s).");
  });

  it("handles no changed lines gracefully", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nbbb\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 1, firstChangedLine: undefined, lastChangedLine: undefined, addedLines: 0, removedLines: 0 },
    });
    expect(output.details.metrics!.added_lines).toBe(0);
    expect(output.details.metrics!.removed_lines).toBe(0);
  });

  it("shows exactly one context line above and below the change in the diff", async () => {
    const original = "aaa\nbbb\nccc\nddd\neee\n";
    const result = "aaa\nbbb\nCCC\nddd\neee\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 3, lastChangedLine: 3, addedLines: 1, removedLines: 1 },
    });
    const diff = output.details.diff!;
    expect(diff).toContain("│bbb");
    expect(diff).toContain("│CCC");
    expect(diff).toContain("│ddd");
    expect(diff).not.toContain("│aaa");
    expect(diff).not.toContain("│eee");
  });

  it("honors an explicit diff context line count", async () => {
    const original = "aaa\nbbb\nccc\nddd\neee\n";
    const result = "aaa\nbbb\nCCC\nddd\neee\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const base = {
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 3, lastChangedLine: 3, addedLines: 1, removedLines: 1 },
    };
    const bare = buildChanged(base, "replaced", 0);
    expect(bare.details.diff!).toContain("│CCC");
    expect(bare.details.diff!).not.toContain("│bbb");
    expect(bare.details.diff!).not.toContain("│ddd");
    const wide = buildChanged(base, "replaced", 2);
    expect(wide.details.diff!).toContain("│aaa");
    expect(wide.details.diff!).toContain("│bbb");
    expect(wide.details.diff!).toContain("│ddd");
    expect(wide.details.diff!).toContain("│eee");
  });

  it("appends the new anchors to a literal-escape hint", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nstable\\u200bCheckout\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: [String.raw`[H_LITERAL_ESCAPE] text: "\u200b" written as literal text`],
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 2, addedLines: 1, removedLines: 1 },
      spans: [{ start: 1, end: 1, replacementCount: 1 }],
    });
    expect(output.details.hints).toHaveLength(1);
    const hint = output.details.hints![0]!;
    expect(hint).toContain(`${resultHashes[1]}│ col 7`);
    expect(hint).toContain("resend with U+200B if unintended.");
  });

  it("replaces the anchor list with the recovery when many rows carry the literal escape", async () => {
    const original = "aaa\nbbb\nccc\n";
    const result = "aaa\nrow-0 stable\\u200bCheckout\nrow-1 stable\\u200bCheckout\nrow-2 stable\\u200bCheckout\nrow-3 stable\\u200bCheckout\nccc\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: [String.raw`[H_LITERAL_ESCAPE] text: "\u200b" written as literal text`],
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, addedLines: 4, removedLines: 1 },
      spans: [{ start: 1, end: 1, replacementCount: 4 }],
    });
    const hint = output.details.hints![0]!;
    expect(hint).toContain("undo_last_change");
    expect(hint).toContain("on 4 rows");
    expect(hint).not.toContain(" at col ");
    expect(hint).toContain("resend with U+200B if unintended.");
    expect(hint).not.toContain("resending with a single");
  });

  it("skips indent hints for copied and moved results", async () => {
    const original = "head\n  const sharedValue = compute(input);\ntail\n";
    const result = "head\n  const sharedValue = compute(input);\nconst sharedValue = compute(input);\ntail\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const base = {
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: undefined,
      snapshotId: "snap1",
      editMeta: { editsAttempted: 1, noopEditsCount: 0, firstChangedLine: 3, lastChangedLine: 3, addedLines: 1, removedLines: 0 },
      spans: [{ start: 2, end: 2, replacementCount: 2, carry: 1 }],
    };
    const replaced = buildChanged(base);
    expect(replaced.details.hints?.some((hint) => hint.includes("[H_INDENT_MISMATCH]"))).toBe(true);
    const copied = buildChanged(base, "copied");
    expect(copied.details.hints?.some((hint) => hint.includes("[H_INDENT_MISMATCH]")) ?? false).toBe(false);
  });

  it("attributes literal-escape rows across multiple spans", async () => {
    const original = "a\nb\nc\nd\n";
    const result = "a\nB1\nB2\\u200b\nc\nD\\u200b\n";
    const originalHashes = await lineHashes(original, home.testPath);
    const resultHashes = await lineHashes(result, home.testPath);
    const output = buildChanged({
      path: "test.txt",
      originalNormalized: original,
      originalHashes,
      result,
      resultHashes,
      warnings: [String.raw`[H_LITERAL_ESCAPE] text: "\u200b" written as literal text`],
      snapshotId: "snap1",
      editMeta: { editsAttempted: 2, noopEditsCount: 0, firstChangedLine: 2, lastChangedLine: 5, addedLines: 3, removedLines: 2 },
      spans: [{ start: 1, end: 1, replacementCount: 2 }, { start: 3, end: 3, replacementCount: 1 }],
    });
    const hint = output.details.hints![0]!;
    expect(hint).toContain(`${resultHashes[2]}│ col 3`);
    expect(hint).toContain(`${resultHashes[4]}│ col 2`);
  });
});
