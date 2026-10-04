import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("applyEdit - recovery scenarios", () => {
  it("autocorrects reversed range (start > end)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[3]!,
      remove_to: hashes[1]!, text: ["X"] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nX\ne");
  });

  it("rejects stale anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!,
        remove_to: hashes[1]!, text: ["X", "Y"] },
      ), undefined, ["STALE", "STALE", "STALE", "STALE", "STALE"])
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("shows current context around the resolved anchor when only one anchor of a range is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleStart = "PyBY";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: staleStart,
        remove_to: hashes[2]!, text: ["X"] },
      ), undefined, hashes);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
    expect(caught!.message).toMatch(/Current context around resolved anchor/);
    expect(caught!.message).toContain(` 3: ${hashes[2]}│c`);
  });

  it("shows context anchored on the start when only the end is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleEnd = "PyBY";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: hashes[0]!,
        remove_to: staleEnd, text: ["X"] },
      ), undefined, hashes);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Current context around resolved anchor/);
    expect(caught!.message).toContain(` 1: ${hashes[0]}│a`);
  });

  it("omits context when both anchors are stale", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: "PyBY",
        remove_to: "YYY", text: ["X"] },
      ), undefined, hashes);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toMatch(/Current context around resolved anchor/);
  });

  it("rejects unknown fields in edit items", () => {
    const edit = { remove_from: "PyBY", remove_to: "PyBY", text: ["x"], extra: true } as any;
    expect(() => resEdit(edit)).toThrow(/unknown or unsupported fields/);
  });

  it("rejects missing text", () => {
    const edit = { remove_from: "PyBY",
    remove_to: "PyBY" } as any;
    expect(() => resEdit(edit)).toThrow(/requires a "text" array/);
  });

  it("rejects null text", () => {
    const edit = { remove_from: "PyBY",
    remove_to: "PyBY", text: null } as any;
    expect(() => resEdit(edit)).toThrow(/must be an array of strings/);
  });

  it("accepts a single string text", () => {
    const edit = { remove_from: "PyBY",
    remove_to: "PyBY", text: "hello" } as const;
    expect(resEdit(edit).content_lines).toEqual(["hello"]);
  });

  it("accepts array text", () => {
    const edit = { remove_from: "PyBY",
    remove_to: "PyBY", text: ["hello", "world", ""] } as any;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["hello", "world", ""]);
  });

  it("rejects malformed hash_bounds", () => {
    const edit = { remove_from: "not-valid",
    remove_to: "not-valid", text: ["x"] };
    expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
  });

  it("strips bare hash prefix in content_lines", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[2]!, text: [`${hashes[1]!}│b`, `X`] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nb\nX\nd\ne");
    expect(result.warnings?.[0]).toMatch(/Stripped "anchor│" prefix/);
  });

  it("strips diff preview rows in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, text: [`+${hashes[1]!}│B`] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nB\nc");
    expect(result.warnings?.[0]).toMatch(/Stripped diff-preview marker/);
  });

  it("warns on unicode escape sequences in content", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, text: ["\\uDDDD"] },
    ), undefined, hashes);
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("\\uDDDD");
  });

  it("handles tab characters in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, text: ["\t\treplaced"] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nb\n\t\treplaced");
  });

  it("preserves literal tab in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, text: ["\t\treplaced"] },
    ), undefined, hashes);
    expect(result.content).toContain("\t\treplaced");
  });

  it("detects noop when content unchanged", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, text: ["b"] },
    ), undefined, hashes);
    expect(result.noopEdit).toBeDefined();
  });

  it("detects noop for range", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[2]!, text: ["b", "c"] },
    ), undefined, hashes);
    expect(result.noopEdit).toBeDefined();
  });

  it("handles single-line file", async () => {
    const content = "hello";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[0]!, text: ["world"] },
    ), undefined, hashes);
    expect(result.content).toBe("world");
  });

  it("handles append to last line", async () => {
    const content = "a\nb";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[1]!,
      remove_to: hashes[1]!, text: ["b", "c"] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nb\nc");
  });

  it("handles delete of first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[0]!, text: [] },
    ), undefined, hashes);
    expect(result.content).toBe("b\nc");
  });

  it("handles delete of last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[2]!,
      remove_to: hashes[2]!, text: [] },
    ), undefined, hashes);
    expect(result.content).toBe("a\nb");
  });

  it("handles replace of entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: hashes[0]!,
      remove_to: hashes[2]!, text: ["x", "y"] },
    ), undefined, hashes);
    expect(result.content).toBe("x\ny");
  });
});
