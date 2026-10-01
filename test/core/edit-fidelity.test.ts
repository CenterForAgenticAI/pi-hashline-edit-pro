import { describe, expect, it } from "vitest";
import { fidelityHints, isFidelitySensitiveChar } from "../../src/edit-fidelity";
import type { DiffSpan } from "../../src/replace-diff";

const ZWSP = "\u200b";
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
  });

  it("leaves plain text and regular punctuation alone", () => {
    expect(isFidelitySensitiveChar("a")).toBe(false);
    expect(isFidelitySensitiveChar(" ")).toBe(false);
    expect(isFidelitySensitiveChar("-")).toBe(false);
    expect(isFidelitySensitiveChar(",")).toBe(false);
    expect(isFidelitySensitiveChar("é")).toBe(false);
  });
});

describe("fidelityHints", () => {
  it("returns nothing without spans", () => {
    expect(fidelityHints("a\n", "b\n", undefined)).toEqual([]);
    expect(fidelityHints("a\n", "b\n", [])).toEqual([]);
  });

  it("flags a dropped zero-width space and renders the row and column", () => {
    const old = `x\n\t{ID: "checkout-5", Feature: "legacy${ZWSP}Checkout", Retries: 3},\ny\n`;
    const result = `x\n\t{ID: "checkout-5", Feature: "stableCheckout", Retries: 3},\ny\n`;
    const row = `\t{ID: "checkout-5", Feature: "legacy${ZWSP}Checkout", Retries: 3},`;
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_LOST]");
    expect(hints[0]).toContain(`Bbbb│${row}`);
    expect(hints[0]).toContain(`└ U+200B at col ${row.indexOf(ZWSP) + 1}`);
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
    expect(hints[0]).toContain(`Aaaa│legacy${NBSP}Checkout`);
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

  it("flags an omitted joiner in an inserted block and renders the nearby row", () => {
    const old = `head\n- status: done${WORD_JOINER}\ntail\n`;
    const result = `head\n- status: done${WORD_JOINER}\n- status: new\ntail\n`;
    const row = `- status: done${WORD_JOINER}`;
    const hints = fidelityHints(old, result, [insertSpan(1, 2, 0)], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(`Bbbb│${row}`);
    expect(hints[0]).toContain(`└ U+2060 at col ${row.indexOf(WORD_JOINER) + 1}`);
    expect(hints[0].split("\n")[0]).toContain("U+2060");
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
    expect(hints[0]).toContain("Bbbb│a");
    expect(hints[0]).toContain("U+200B");
  });

  it("reports the removed zero-width space once across multiple spans", () => {
    const old = `xlegacy${ZWSP}Checkout\nylegacy${ZWSP}Checkout\n`;
    const result = "xstableCheckout\nystableCheckout\n";
    const hints = fidelityHints(old, result, [replaceSpan(0, 0, 1), { start: 1, end: 1, replacementCount: 1 }], ANCHORS);
    expect(hints).toHaveLength(1);
    expect(hints[0].match(/U\+200B/g)).toHaveLength(2);
  });
});
