import { describe, expect, it } from "vitest";
import { fidelityHints, isFidelitySensitiveChar } from "../../src/edit-fidelity";
import type { DiffSpan } from "../../src/replace-diff";

const ZWSP = "\u200b";
const ZWJ = "\u200d";
const NBSP = "\u00a0";
const WORD_JOINER = "\u2060";
const NB_HYPHEN = "\u2011";
const NNBSP = "\u202f";

const ANCHORS = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee", "Ffff", "Gggg", "Hhhh", "Iiii", "Jjjj", "Kkkk", "Llll", "Mmmm", "Nnnn", "Oooo", "Pppp"];

function replaceSpan(start: number, end: number, replacementCount: number): DiffSpan {
  return { start, end, replacementCount };
}

function insertSpan(line: number, replacementCount: number, carry: number): DiffSpan {
  return { start: line, end: line, replacementCount, carry };
}

describe("isFidelitySensitiveChar", () => {
  it("flags invisible and look-alike characters", () => {
    expect(isFidelitySensitiveChar(ZWSP)).toBe(true);
    expect(isFidelitySensitiveChar(WORD_JOINER)).toBe(true);
    expect(isFidelitySensitiveChar(NBSP)).toBe(true);
    expect(isFidelitySensitiveChar(NB_HYPHEN)).toBe(true);
    expect(isFidelitySensitiveChar(NNBSP)).toBe(true);
    expect(isFidelitySensitiveChar("\u201c")).toBe(true);
    expect(isFidelitySensitiveChar("\u2212")).toBe(true);
    expect(isFidelitySensitiveChar("\u3001")).toBe(true);
    expect(isFidelitySensitiveChar("\u3002")).toBe(true);
    expect(isFidelitySensitiveChar("\uff0c")).toBe(true);
    expect(isFidelitySensitiveChar("\uff0e")).toBe(true);
    expect(isFidelitySensitiveChar("\uff1a")).toBe(true);
    expect(isFidelitySensitiveChar("\uff1f")).toBe(true);
    expect(isFidelitySensitiveChar("\uff61")).toBe(true);
    expect(isFidelitySensitiveChar("\uff64")).toBe(true);
  });

  it("covers the fullwidth ASCII punctuation ranges but not letters or digits", () => {
    const ranges: Array<[number, number]> = [[0xff01, 0xff0f], [0xff1a, 0xff20], [0xff3b, 0xff40], [0xff5b, 0xff5e]];
    for (const [start, end] of ranges) {
      for (let code = start; code <= end; code += 1) {
        expect(isFidelitySensitiveChar(String.fromCodePoint(code)), `U+${code.toString(16)}`).toBe(true);
      }
    }
    for (const code of [0xff10, 0xff19, 0xff21, 0xff3a, 0xff41, 0xff5a]) {
      expect(isFidelitySensitiveChar(String.fromCodePoint(code)), `U+${code.toString(16)}`).toBe(false);
    }
  });

  it("leaves plain text and regular punctuation alone", () => {
    expect(isFidelitySensitiveChar("a")).toBe(false);
    expect(isFidelitySensitiveChar(" ")).toBe(false);
    expect(isFidelitySensitiveChar("-")).toBe(false);
    expect(isFidelitySensitiveChar(",")).toBe(false);
    expect(isFidelitySensitiveChar("é")).toBe(false);
    expect(isFidelitySensitiveChar("\uff10")).toBe(false);
    expect(isFidelitySensitiveChar("\uff21")).toBe(false);
  });
});

describe("fidelityHints", () => {
  it("returns nothing without spans", () => {
    expect(fidelityHints("a\n", "b\n", undefined)).toEqual([]);
    expect(fidelityHints("a\n", "b\n", [])).toEqual([]);
  });

  it("flags a dropped zero-width space and names the anchor and column", () => {
    const old = `x\n\t{ID: "checkout-5", Feature: "legacy${ZWSP}Checkout", Retries: 3},\ny\n`;
    const result = `x\n\t{ID: "checkout-5", Feature: "stableCheckout", Retries: 3},\ny\n`;
    const row = `\t{ID: "checkout-5", Feature: "legacy${ZWSP}Checkout", Retries: 3},`;
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_LOST]");
    expect(hints[0]).toContain("; Bbbb│ has it;");
    expect(hints[0]).toContain("resend with U+200B if unintended.");
    expect(hints[0]).toContain(`U+200B missing at col ${row.indexOf(ZWSP) + 1}`);
    expect(hints[0].split("\n")[0]).toContain("U+200B");
  });

  it("stays silent when the zero-width space is preserved", () => {
    const old = `a\nlegacy${ZWSP}Checkout\n`;
    const result = `a\nstable${ZWSP}Checkout\n`;
    expect(fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS)).toEqual([]);
  });

  it("flags a dropped no-break space when other text also changed", () => {
    const hints = fidelityHints(`legacy${NBSP}Checkout\n`, "stableCheckout\n", [replaceSpan(0, 0, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("U+00A0");
    expect(hints[0]).toContain("; Aaaa│ has it;");
  });

  it("flags dropped smart quotes and look-alike dashes when other text also changed", () => {
    const quotes = fidelityHints(`say \u201chi\u201d now\n`, 'say "hi" later\n', [replaceSpan(0, 0, 1)], ANCHORS);
    expect(quotes).toHaveLength(2);
    expect(quotes.join("\n")).toContain("U+201C");
    expect(quotes.join("\n")).toContain("U+201D");
    const dash = fidelityHints(`A\u2212B = C\n`, "A-B == C\n", [replaceSpan(0, 0, 1)], ANCHORS);
    expect(dash).toHaveLength(1);
    expect(dash[0]).toContain("U+2212");
  });

  it("stays silent when the only change is a deliberate look-alike fix", () => {
    expect(fidelityHints(`A${WORD_JOINER}B\n`, "AB\n", [replaceSpan(0, 0, 1)], ANCHORS)).toEqual([]);
    expect(fidelityHints(`A${NBSP}B\n`, "A B\n", [replaceSpan(0, 0, 1)], ANCHORS)).toEqual([]);
    expect(fidelityHints(`A${NB_HYPHEN}B\n`, "A-B\n", [replaceSpan(0, 0, 1)], ANCHORS)).toEqual([]);
    expect(fidelityHints("say \u201chi\u201d\n", 'say "hi"\n', [replaceSpan(0, 0, 1)], ANCHORS)).toEqual([]);
  });

  it("flags an omitted joiner in an inserted block that echoes the nearby row", () => {
    const old = `head\n- status: done${WORD_JOINER}\ntail\n`;
    const result = `head\n- status: done${WORD_JOINER}\n- status: new\ntail\n`;
    const row = `- status: done${WORD_JOINER}`;
    const hints = fidelityHints(old, result, [insertSpan(1, 2, 0)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("; Bbbb│ has it;");
    expect(hints[0]).toContain(`U+2060 missing at col ${row.indexOf(WORD_JOINER) + 1}`);
    expect(hints[0].split("\n")[0]).toContain("U+2060");
  });

  it("flags an ASCII space substituted for a no-break space in an inserted line", () => {
    const old = `head\n// END serializes checkout\u2011payload\u00a00042\ntail\n`;
    const result = `head\ntest("serializes checkout\u2011payload 9004", () => {\n// END serializes checkout\u2011payload\u00a00042\ntail\n`;
    const hints = fidelityHints(old, result, [insertSpan(0, 2, 0)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_SWAPPED]");
    expect(hints[0]).toContain("U+0020 at col 35");
    expect(hints[0]).toContain("where Bbbb│ has U+00A0");
  });

  it("flags an ASCII period substituted for an ideographic full stop in an inserted line", () => {
    const old = `head\nVérifiez le reçu. Проверьте чек. 检查收据。\ntail\n`;
    const result = `head\nVérifiez le reçu. Проверьте чек. 检查收据。\nVérifiez le reçu. Проверьте чек. 检查收据.\ntail\n`;
    const hints = fidelityHints(old, result, [insertSpan(1, 2, 0)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_SWAPPED]");
    expect(hints[0]).toContain("U+002E at col");
    expect(hints[0]).toContain("where Bbbb│ has U+3002");
  });

  it("does not flag hidden characters for inserted lines that do not match the context", () => {
    const old = `head\n    feature: "legacy${ZWSP}Checkout",\ntest("serializes checkout\u2011payload\u00a00002", () => {\ntail\n`;
    const result = `head\n    feature: "legacy${ZWSP}Checkout",\ntest("serializes checkout\u2011payload\u00a00002", () => {\ntail\n  expect(encoded).toContain("feature");\n`;
    expect(fidelityHints(old, result, [insertSpan(3, 2, 0)], ANCHORS)).toEqual([]);
  });

  it("does not treat a punctuation-only shared run as an echoed reference", () => {
    const old = `head\ntest("serializes checkout\u2011payload\u00a09001", () => {\ntail\n`;
    const result = `head\ntest("round-trips migrated checkout samples", () => {\n    { requestId: "request-0", feature: "stableCheckout", retries: 0 },\ntest("serializes checkout\u2011payload\u00a09001", () => {\ntail\n`;
    expect(fidelityHints(old, result, [insertSpan(0, 3, 0)], ANCHORS)).toEqual([]);
  });

  it("flags an unindented inserted line that echoes the anchor line", () => {
    const old = `head\n  - id: checkout-5\ntail\n`;
    const result = `head\n- id: checkout-11\n  - id: checkout-5\ntail\n`;
    const hints = fidelityHints(old, result, [insertSpan(1, 2, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_INDENT_MISMATCH]");
    expect(hints[0]).toContain("new line has 0 leading whitespace characters; Bbbb│ has 2.");
    expect(hints[0]).toContain("Bbbb│ has");
  });

  it("stays silent when the inserted line keeps the anchor line's indentation", () => {
    const old = `head\n  - id: checkout-5\ntail\n`;
    const result = `head\n  - id: checkout-11\n  - id: checkout-5\ntail\n`;
    expect(fidelityHints(old, result, [insertSpan(1, 2, 1)], ANCHORS)).toEqual([]);
  });

  it("flags a replaced line that lost the removed line's leading tab", () => {
    const old = "a\n\t{ID: \"checkout-1\"}\nb\n";
    const result = "a\n{ID: \"checkout-1\"}\nb\n";
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_INDENT_MISMATCH]");
    expect(hints[0]).toContain("new line has 0 leading whitespace characters; Bbbb│ has 1.");
  });

  it("flags an unindented inserted line that echoes a nearby body line", () => {
    const old = `a\n  assert(result).toEqual(expected);\n});\n`;
    const result = `a\n  assert(result).toEqual(expected);\nassert(result).toContain("extra");\n});\n`;
    const hints = fidelityHints(old, result, [insertSpan(2, 2, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_INDENT_MISMATCH]");
    expect(hints[0]).toContain("Bbbb│ has");
  });

  it("does not flag an unindented inserted line when no nearby row shares a long run", () => {
    const old = `a\n  const y = 2;\n});\n`;
    const result = `a\n  const y = 2;\nconst x = 1;\n});\n`;
    expect(fidelityHints(old, result, [insertSpan(2, 2, 1)], ANCHORS)).toEqual([]);
  });

  it("does not flag a match outside the indent reference window", () => {
    const old = `a\n  const sharedRuntimeValue = compute(input);\nfiller one\nfiller two\nfiller three\nfiller four\ntail\n`;
    const result = `a\n  const sharedRuntimeValue = compute(input);\nfiller one\nfiller two\nfiller three\nfiller four\nconst sharedRuntimeValue = compute(input);\ntail\n`;
    expect(fidelityHints(old, result, [insertSpan(6, 2, 1)], ANCHORS)).toEqual([]);
  });

  it("flags an adjacent call line that is missing the reference's indentation", () => {
    const old = `a\n  expect(hints[0]).toContain("x");\ntail\n`;
    const result = `a\n  expect(hints[0]).toContain("x");\nexpect(hints).toHaveLength(1);\ntail\n`;
    const hints = fidelityHints(old, result, [insertSpan(2, 2, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_INDENT_MISMATCH]");
    expect(hints[0]).toContain("new line has 0 leading whitespace characters; Bbbb│ has 2.");
  });

  it("does not flag an adjacent call line with a different callee", () => {
    const old = `a\n  expect(hints[0]).toContain("x");\ntail\n`;
    const result = `a\n  expect(hints[0]).toContain("x");\nverify(hints).toHaveLength(1);\ntail\n`;
    expect(fidelityHints(old, result, [insertSpan(2, 2, 1)], ANCHORS)).toEqual([]);
  });

  it("skips indent hints when the caller disables them", () => {
    const old = `head\n  - id: checkout-5\ntail\n`;
    const result = `head\n- id: checkout-11\n  - id: checkout-5\ntail\n`;
    expect(fidelityHints(old, result, [insertSpan(1, 2, 1)], ANCHORS, { indentHints: false })).toEqual([]);
  });

  it("flags an inserted block that landed against a blank-separated anchor", () => {
    const old = `alpha\n\n## Next\ntail\n`;
    const result = `alpha\n\nbody one\nbody two\n## Next\ntail\n`;
    const hints = fidelityHints(old, result, [insertSpan(2, 3, 2)], ANCHORS, { separatorMoved: true });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_SEPARATOR_MOVED]");
    expect(hints[0]).toContain("blank separator above Cccc│ was displaced; add a blank line before Cccc│ if unintended.");
  });



  it("flags an inserted block that landed after a blank-separated anchor", () => {
    const old = `alpha\n## Next\n\ntail\n`;
    const result = `alpha\n## Next\nbody one\nbody two\n\ntail\n`;
    const hints = fidelityHints(old, result, [insertSpan(1, 3, 0)], ANCHORS, { separatorMoved: true });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_SEPARATOR_MOVED]");
    expect(hints[0]).toContain("blank separator below Bbbb│ was displaced; add a blank line after Bbbb│ if unintended.");
  });

  it("does not flag the separator when the option is off or the payload is one line", () => {
    const old = `alpha\n\n## Next\ntail\n`;
    const result = `alpha\n\nbody\n## Next\ntail\n`;
    expect(fidelityHints(old, result, [insertSpan(2, 2, 1)], ANCHORS)).toEqual([]);
    expect(fidelityHints(old, result, [insertSpan(2, 2, 1)], ANCHORS, { separatorMoved: true })).toEqual([]);
  });

  it("flags a pure deletion that removed the blank separator between two lines", () => {
    const hints = fidelityHints("a\n\n\nb\n", "a\nb\n", [replaceSpan(1, 2, 0)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_SEPARATOR_LOST]");
    expect(hints[0]).toContain("removed 2 blank lines between");
    expect(hints[0]).toContain(`${ANCHORS[0]}│`);
    expect(hints[0]).toContain(`${ANCHORS[3]}│`);
  });

  it("does not flag a deletion that removed content", () => {
    expect(fidelityHints("a\nb\nc\n", "a\n", [replaceSpan(1, 2, 0)], ANCHORS)).toEqual([]);
  });

  it("does not flag a blank deletion whose neighbor line is blank", () => {
    expect(fidelityHints("a\n\n\nb\n", "a\n\nb\n", [replaceSpan(1, 1, 0)], ANCHORS)).toEqual([]);
  });

  it("does not flag a dedented line that shares no long run with the replaced line", () => {
    const old = "a\n  const y = 2;\nb\n";
    const result = "a\nconst x = 1;\nb\n";
    expect(fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS)).toEqual([]);
  });

  it("stays silent when an inserted block keeps the joiner", () => {
    const old = `head\n- status: done${WORD_JOINER}\ntail\n`;
    const result = `head\n- status: done${WORD_JOINER}\n- status: new${WORD_JOINER}\ntail\n`;
    expect(fidelityHints(old, result, [insertSpan(1, 2, 0)], ANCHORS)).toEqual([]);
  });

  it("ignores nearby hidden characters outside the reference window", () => {
    const filler = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
    const old = `legacy${ZWSP}Checkout\n${filler}\nanchor\n`;
    const result = `legacy${ZWSP}Checkout\n${filler}\nanchor\nnew line\n`;
    expect(fidelityHints(old, result, [insertSpan(11, 2, 0)], ANCHORS)).toEqual([]);
  });

  it("caps the number of rendered hints", () => {
    const old = `x${ZWSP}y${NBSP}z${WORD_JOINER}w${NB_HYPHEN}v\n`;
    const result = "Xyzwv\n";
    const hints = fidelityHints(old, result, [replaceSpan(0, 0, 1)], ANCHORS);
    expect(hints).toHaveLength(3);
    expect(hints.join("\n")).toContain("U+200B");
    expect(hints.join("\n")).toContain("U+00A0");
    expect(hints.join("\n")).toContain("U+2060");
    expect(hints.join("\n")).not.toContain("U+2011");
  });

  it("ignores deletion-only and insertion-only spans", () => {
    expect(fidelityHints(`a\nb${ZWSP}c\n`, "a\n", [replaceSpan(1, 1, 0)], ANCHORS)).toEqual([]);
    expect(fidelityHints("a\n", `a${ZWSP}\nb\n`, [{ start: 1, end: 0, replacementCount: 2 }], ANCHORS)).toEqual([]);
  });

  it("maps later spans through the earlier replacement offset", () => {
    const old = `keep\na${ZWSP}b\nmid\nc${ZWSP}d\ntail\n`;
    const result = "keep\nAB\nmid\nCD\ntail\n";
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1), replaceSpan(3, 3, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("; Bbbb│ has it;");
    expect(hints[0]).toContain("U+200B");
  });

  it("reports the removed zero-width space once across multiple spans", () => {
    const old = `xlegacy${ZWSP}Checkout\nylegacy${ZWSP}Checkout\n`;
    const result = "xstableCheckout\nystableCheckout\n";
    const hints = fidelityHints(old, result, [replaceSpan(0, 0, 1), { start: 1, end: 1, replacementCount: 1 }], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0].split("[H_UNICODE_LOST]").length - 1).toBe(1);
  });

  it("flags a swapped invisible character on a replaced line", () => {
    const old = `keep\nlegacy${ZWSP}Checkout\ntail\n`;
    const result = `keep\nlegacy${ZWJ}Checkout\ntail\n`;
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_SWAPPED]");
    expect(hints[0]).toContain("where Bbbb│ has U+200B");
    expect(hints[0]).toContain("resend with U+200B if unintended.");
    expect(hints[0]).toContain("U+200B");
    expect(hints[0]).toContain("U+200D");
  });

  it("names the look-alike substitute when the swapped pairing misses", () => {
    const old = `keep\nlegacy${ZWSP}Checkout\ntail\n`;
    const result = `keep\nstable${WORD_JOINER}Checkout!\ntail\n`;
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_SWAPPED]");
    expect(hints[0]).toContain("U+2060 at col");
    expect(hints[0]).toContain("where Bbbb│ has U+200B");
  });

  it("names U+FFFD as the substitute for a dropped no-break space", () => {
    const old = `keep${NBSP}value!\ntail\n`;
    const result = `keep\uFFFDvalue!\ntail\n`;
    const hints = fidelityHints(old, result, [replaceSpan(0, 0, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_SWAPPED]");
    expect(hints[0]).toContain("U+FFFD at col");
    expect(hints[0]).toContain("where Aaaa│ has U+00A0");
  });

  it("flags the replacement character as fidelity sensitive", () => {
    expect(isFidelitySensitiveChar("\uFFFD")).toBe(true);
  });

  it("flags a swap against a matching line elsewhere in the file", () => {
    const old = `template${ZWSP}entry\nkeep\nother\n`;
    const result = `template${ZWSP}entry\nkeep\ntemplate${WORD_JOINER}entry\n`;
    const hints = fidelityHints(old, result, [replaceSpan(2, 2, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_SWAPPED]");
    expect(hints[0]).toContain("where Aaaa│ has U+200B");
  });

  it("flags fullwidth punctuation used in place of its ASCII counterpart", () => {
    const old = `head\nconst flag = true;\ntail\n`;
    const result = `head\nconst flag ＝ true;\ntail\n`;
    const hints = fidelityHints(old, result, [insertSpan(0, 2, 0)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_SWAPPED]");
    expect(hints[0]).toContain("U+FF1D");
    expect(hints[0]).toContain("U+003D");
    expect(hints[0]).toContain("where Bbbb│ has U+003D");
  });

  it("stays silent when fullwidth punctuation is normalized to ASCII", () => {
    expect(fidelityHints("value ＝ 1\n", "value = 1\n", [replaceSpan(0, 0, 1)], ANCHORS)).toEqual([]);
  });

  it("stays silent when a replaced line keeps its invisible characters", () => {
    const old = `keep\nlegacy${ZWSP}Checkout\ntail\n`;
    const result = `keep\nstable${ZWSP}Checkout\ntail\n`;
    expect(fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS)).toEqual([]);
  });

  it("flags trailing whitespace added to a replaced line", () => {
    const old = "keep\ntarget\ntail\n";
    const result = "keep\ntarget \ntail\n";
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_TRAILING_WHITESPACE]");
    expect(hints[0]).toContain("at col 7");
    expect(hints[0]).toContain("Bbbb│ had 0.");
  });

  it("flags trailing whitespace removed from a replaced line", () => {
    const old = "keep\ntarget  \ntail\n";
    const result = "keep\ntarget\ntail\n";
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_TRAILING_WHITESPACE]");
    expect(hints[0]).toContain("Bbbb│ had 2.");
  });
});
