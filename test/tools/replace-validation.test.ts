import { describe, expect, it } from "vitest";
import { assertReq, buildToolDef } from "../../src/replace";
import { useTestHome, toolError } from "../support/fixtures";

useTestHome();

describe("assertReq", () => {
	it("throws for non-record input", () => {
		expect(() => assertReq("string")).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(null)).toThrow("[E_BAD_SHAPE]");
		expect(() => assertReq(42)).toThrow("[E_BAD_SHAPE]");
	});

	it("throws for unknown fields", () => {
		expect(() => assertReq({ remove_from: "atimx", remove_to: "besrx", text: ["new"], unknown: "field" }))
			.toThrow("[E_BAD_SHAPE]");
	});

	it("points replace_match fields at replace_match", () => {
		expect(() => assertReq({ match: "a", replacement: "b" }))
			.toThrow(/call replace_match with "replace_from", "replace_to", "match", and "replacement"/);
		expect(() => assertReq({ remove_from: "atimx", remove_to: "besrx", text: "new", match: "a", replacement: "b" }))
			.toThrow(/call replace_match with "replace_from", "replace_to", "match", and "replacement"/);
	});

  it("allows an optional path hint for require-path mode", () => {
    expect(() => assertReq({ path: "test.txt", remove_from: "atimx", remove_to: "besrx", text: "new" }))
      .not.toThrow();
  });

	it("throws for a passed file_path", () => {
		expect(() => assertReq({ file_path: "test.txt", remove_from: "atimx", remove_to: "besrx", text: ["new"] }))
			.toThrow("[E_BAD_SHAPE]");
	});

  it("throws when text present but no remove_from/remove_to", () => {
    expect(() => assertReq({ text: ["a"] }))
      .toThrow(/remove_from/);
  });

  it("throws when remove_from/remove_to present but no text", () => {
    expect(() => assertReq({ remove_from: "atimx", remove_to: "besrx" }))
      .toThrow(/text/);
  });

  it("throws when neither edit field is present", () => {
    expect(() => assertReq({}))
      .toThrow(/remove_from/);
  });

  it("accepts the top-level edit shape", () => {
    expect(() => assertReq({
      remove_from: "atimx", remove_to: "besrx",
      text: "new",
    })).not.toThrow();
  });

  it("throws for a NUL byte in text", () => {
    const nul = String.fromCharCode(0);
    expect(() => assertReq({ remove_from: "atimx", remove_to: "besrx", text: `a${nul}b` }))
      .toThrow(/NUL byte/);
  });

	it("throws for request without edits", () => {
		expect(() => assertReq({})).toThrow("[E_BAD_SHAPE]");
	});
});

describe("anchor validation order", () => {
	it("rejects malformed anchors before any file I/O", async () => {
		const tool = buildToolDef();
		expect(await toolError(() => tool.execute(
			"e1",
			{
				remove_from: "abc", remove_to: "abc",
				text: ["x"],
			},
			undefined,
			undefined,
			{ cwd: "/tmp" } as any,
		))).toMatch(/^\[E_BAD_REF\]/);
	});
});

describe("prepareArguments normalization", () => {
	it("passes through non-record input unchanged", () => {
		const tool = buildToolDef();
		expect(tool.prepareArguments!(null)).toBe(null);
		expect(tool.prepareArguments!("raw")).toBe("raw");
	});

	it("points a replace_match-shaped request missing text at replace_match", () => {
		const tool = buildToolDef();
		expect(() => tool.prepareArguments!({ remove_from: "atimx", remove_to: "besrx", match: "a", replacement: "b" }))
			.toThrow(/call replace_match with "replace_from", "replace_to", "match", and "replacement"/);
	});

	it("converts a legacy lines array into the exact text", () => {
		const tool = buildToolDef();
		const prepared = tool.prepareArguments!({
			remove_from: "atimx", remove_to: "besrx",
			text: ["line1", "line2"],
		}) as Record<string, unknown>;
		expect(prepared.text).toEqual("line1\nline2");
	});
});
