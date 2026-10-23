import { describe, expect, it } from "vitest";
import anchorData from "../../src/hashline/anchor-table.json";
import { ANCHOR_COUNT, HASH_LEN } from "../../src/hashline/alphabet";

const TABLE: string = anchorData.anchors;

describe("anchor table", () => {
  it("has the frozen size", () => {
    expect(TABLE.length).toBe(1353139 * 5);
    expect(ANCHOR_COUNT).toBe(1353139);
    expect(HASH_LEN).toBe(5);
  });

  it("contains only unique 5-letter lowercase anchors in sorted order", () => {
    const anchors = TABLE.match(/[a-z]{5}/g) ?? [];
    expect(anchors).toHaveLength(ANCHOR_COUNT);
    expect(new Set(anchors).size).toBe(ANCHOR_COUNT);
    expect(anchors.every((a, i) => i === 0 || anchors[i - 1]! < a)).toBe(true);
  });

  it("is lowercase letters only", () => {
    expect(TABLE).toMatch(/^[a-z]+$/);
  });

  it("spreads anchors across leading letters and prefixes", () => {
    const anchors = TABLE.match(/[a-z]{5}/g) ?? [];
    expect(new Set(anchors.map((anchor) => anchor[0])).size).toBe(26);
    expect(new Set(anchors.map((anchor) => anchor.slice(0, 2))).size).toBeGreaterThanOrEqual(500);
    expect(new Set(anchors.map((anchor) => anchor.slice(0, 4))).size).toBeGreaterThanOrEqual(100_000);
  });
});
