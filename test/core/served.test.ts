import { describe, expect, it } from "vitest";
import { servedHashesFromDiff } from "../../src/served";

describe("servedHashesFromDiff", () => {
  it("extracts anchors from context and added rows", () => {
    const diff = [" aaaaa│kept", "-bbbbb│removed", "+ccccc│added", "not a row", " ddddd│kept2"].join("\n");
    expect(servedHashesFromDiff(diff)).toEqual(["aaaaa", "ccccc", "ddddd"]);
  });

  it("ignores removed rows and non-row lines", () => {
    expect(servedHashesFromDiff("-bbbbb│removed\nplain\n+++header")).toEqual([]);
  });

  it("returns empty for a diff without rows", () => {
    expect(servedHashesFromDiff("no rows here")).toEqual([]);
    expect(servedHashesFromDiff("")).toEqual([]);
  });
});
