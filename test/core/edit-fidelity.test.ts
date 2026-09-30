import { describe, expect, it } from "vitest";
import { fidelityHints, isFidelitySensitiveChar } from "../../src/edit-fidelity";
import type { DiffSpan } from "../../src/replace-diff";

const ZWSP = "\u200b";
const NBSP = "\u00a0";
const WORD_JOINER = "\u2060";
const NB_HYPHEN = "\u2011";
const NNBSP = "\u202f";

function replaceSpan(start: number, end: number, replacementCount: number): DiffSpan {
  return { start, end, replacementCount };
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

  it("flags a dropped zero-width space", () => {
    const old = `x\n\t{ID: "checkout-5", Feature: "legacy${ZWSP}Checkout", Retries: 3},\ny\n`;
    const result = `x\n\t{ID: "checkout-5", Feature: "stableCheckout", Retries: 3},\ny\n`;
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1)]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[H_UNICODE_LOST]");
    expect(hints[0]).toContain("U+200B (zero-width space)");
    expect(hints[0]).toContain("copy the character from the served row");
  });

  it("stays silent when the zero-width space is preserved", () => {
    const old = `a\nlegacy${ZWSP}Checkout\n`;
    const result = `a\nstable${ZWSP}Checkout\n`;
    expect(fidelityHints(old, result, [replaceSpan(1, 1, 1)])).toEqual([]);
  });

  it("flags a dropped no-break space when other text also changed", () => {
    const hints = fidelityHints(`legacy${NBSP}Checkout\n`, "stableCheckout\n", [replaceSpan(0, 0, 1)]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("U+00A0 (no-break space)");
  });

  it("flags dropped smart quotes and look-alike dashes when other text also changed", () => {
    const quotes = fidelityHints(`say \u201chi\u201d now\n`, 'say "hi" later\n', [replaceSpan(0, 0, 1)]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toContain("U+201C");
    expect(quotes[0]).toContain("U+201D");
    const dash = fidelityHints(`A\u2212B = C\n`, "A-B == C\n", [replaceSpan(0, 0, 1)]);
    expect(dash).toHaveLength(1);
    expect(dash[0]).toContain("U+2212");
  });

  it("stays silent when the only change is a deliberate look-alike fix", () => {
    expect(fidelityHints(`A${WORD_JOINER}B\n`, "AB\n", [replaceSpan(0, 0, 1)])).toEqual([]);
    expect(fidelityHints(`A${NBSP}B\n`, "A B\n", [replaceSpan(0, 0, 1)])).toEqual([]);
    expect(fidelityHints(`A${NB_HYPHEN}B\n`, "A-B\n", [replaceSpan(0, 0, 1)])).toEqual([]);
    expect(fidelityHints("say \u201chi\u201d\n", 'say "hi"\n', [replaceSpan(0, 0, 1)])).toEqual([]);
  });

  it("caps the listed characters and reports the rest", () => {
    const old = `x${ZWSP}y${NBSP}z${WORD_JOINER}w${NB_HYPHEN}v\n`;
    const result = "Xyzwv\n";
    const hints = fidelityHints(old, result, [replaceSpan(0, 0, 1)]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("(+1 more)");
    expect(hints[0]).not.toContain("U+2060");
  });

  it("ignores deletion-only and insertion-only spans", () => {
    expect(fidelityHints(`a\nb${ZWSP}c\n`, "a\n", [replaceSpan(1, 1, 0)])).toEqual([]);
    expect(fidelityHints("a\n", `a${ZWSP}\nb\n`, [{ start: 1, end: 0, replacementCount: 2 }])).toEqual([]);
  });

  it("maps later spans through the earlier replacement offset", () => {
    const old = `keep\na${ZWSP}b\nmid\nc${ZWSP}d\ntail\n`;
    const result = "keep\nAB\nmid\nCD\ntail\n";
    const hints = fidelityHints(old, result, [replaceSpan(1, 1, 1), replaceSpan(3, 3, 1)]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("U+200B");
    expect(hints[0]).not.toContain("more");
  });

  it("reports the removed zero-width space once across multiple spans", () => {
    const old = `xlegacy${ZWSP}Checkout\nylegacy${ZWSP}Checkout\n`;
    const result = "xstableCheckout\nystableCheckout\n";
    const hints = fidelityHints(old, result, [replaceSpan(0, 0, 1), { start: 1, end: 1, replacementCount: 1 }]);
    expect(hints).toHaveLength(1);
    expect(hints[0].match(/U\+200B/g)).toHaveLength(1);
  });
});
