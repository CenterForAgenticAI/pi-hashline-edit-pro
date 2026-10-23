import { describe, expect, it } from "vitest";
import { parseText, parseTextWithSeparators, parseHashRef } from "../../src/hashline";

describe("parseHashRef", () => {
	it("parses a hash anchor without # prefix", () => {
		const ref = parseHashRef("atimx");
		expect(ref).toEqual({ hash: "atimx" });
	});

	it("strips surrounding quotes from an anchor", () => {
		expect(parseHashRef('"atimx"')).toEqual({ hash: "atimx" });
		expect(parseHashRef("'atimx'")).toEqual({ hash: "atimx" });
	});

	it("rejects trailing content after the anchor", () => {
		expect(() => parseHashRef("atimx:const x = 1;")).toThrow(
			/Expected a 5-character anchor/,
		);
	});

	it("rejects a full anchor│content line copied into remove_from/remove_to", () => {
		expect(() => parseHashRef("atimx│const x = 1;")).toThrow(
			/use only the 5-character anchor, drop everything from "│" onward/,
		);
	});

	it("lowercases a case variant and warns", () => {
		const warnings: string[] = [];
		expect(parseHashRef("ATIMX", warnings, "anchor")).toEqual({ hash: "atimx" });
		expect(warnings[0]).toContain("[W_ANCHOR_CASE]");
	});
	it("rejects leading >>> markers (strict mode: no marker stripping)", () => {
		expect(() => parseHashRef(">>> atimx")).toThrow(/E_BAD_REF/);
	});

	it("rejects + and - diff markers (strict mode: anchor only)", () => {
		expect(() => parseHashRef("+atimx")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-atimx")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-#atimx")).toThrow(/E_BAD_REF/);
	});

	it("rejects - and _ anywhere in the anchor (not in the alphabet)", () => {
		expect(() => parseHashRef("-qkaa")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-_-_x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("----x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("Has_u")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("Has-x")).toThrow(/E_BAD_REF/);
	});

	it("rejects + as a hash body character (not in alphabet)", () => {
		expect(() => parseHashRef("+qkaa")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#+qka")).toThrow(/E_BAD_REF/);
	});

	it("rejects malformed anchors with E_BAD_REF", () => {
		expect(() => parseHashRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
	});
	it("rejects anchors containing digits because anchors are letters only", () => {
		expect(() => parseHashRef("A1bcd")).toThrow(/^\[E_BAD_REF\]/);
	});

	it("rejects legacy LINE#HASH format", () => {
		expect(() => parseHashRef("5hasux")).toThrow(
			/Use the anchor alone/,
		);
	});

	it("rejects wrong-length anchors", () => {
		expect(() => parseHashRef("Ha")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("HasuXY")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#HasuX")).toThrow(/E_BAD_REF/);
	});

	it("rejects anchors with invalid alphabet", () => {
		expect(() => parseHashRef("!@#$%")).toThrow(/^\[E_BAD_REF\]/);
	});
});

describe("parseText", () => {
	it("rejects null with a clear error", () => {
		expect(() => parseText(null as unknown as string[])).toThrow(/^\[E_BAD_SHAPE\].*must be an array of strings/);
	});

	it("rejects a single string input with clear error (must use array)", () => {
		expect(() => parseText("a\nb" as unknown as string[])).toThrow(
			/must be an array of strings/,
		);
	});

	it("passes an array through as lines", () => {
		expect(parseText(["a", "b"])).toEqual(["a", "b"]);
	});

	it("returns [] for empty array (delete range)", () => {
		expect(parseText([])).toEqual([]);
	});

	it("treats a trailing empty element as an extra blank line", () => {
		expect(parseText(["a", "b", ""])).toEqual(["a", "b", ""]);
	});

	it("represents [\"\"] as one blank line", () => {
		expect(parseText([""])).toEqual([""]);
	});

	it("represents [\"\", \"\"] as two blank lines", () => {
		expect(parseText(["", ""])).toEqual(["", ""]);
	});

	it("splits elements containing embedded newlines", () => {
		expect(parseText(["a\r\nb\rc"])).toEqual(["a", "b", "c"]);
	});

	it("splits plain \n embedded newlines without carriage returns", () => {
		expect(parseText(["a\nb\nc"])).toEqual(["a", "b", "c"]);
	});

	it("preserves '# keep me' comment lines (no autocorrection)", () => {
		expect(parseText(["# keep me"])).toEqual(["# keep me"]);
	});

	it("preserves literal '+' prefixed content (no autocorrection)", () => {
		expect(parseText(["+added"])).toEqual(["+added"]);
	});

	it("passes through diff-preview rows verbatim (marker stripping happens in applyEdit)", () => {
		expect(parseText(["+atimx│foo", "+xYp│bar"])).toEqual(["+atimx│foo", "+xYp│bar"]);
		expect(parseText([" atimx│keep", "-10    old", " xYp│after"])).toEqual([" atimx│keep", "-10    old", " xYp│after"]);
		expect(parseText([" atimx│keep", "-   │old", " xYp│after"])).toEqual([" atimx│keep", "-   │old", " xYp│after"]);
		expect(parseText(["-atimx│old", "- atimx│old"])).toEqual(["-atimx│old", "- atimx│old"]);
	});

	it("passes through numbered deletion rows as literal content", () => {
		expect(parseText(["-10    old"])).toEqual(["-10    old"]);
	});

	it("accepts literal minus-prefixed content that is not a diff row", () => {
		expect(parseText(["-   something", "-abc", "- old style"])).toEqual(["-   something", "-abc", "- old style"]);
	});
});

describe("parseText json-envelope autocorrect", () => {
	it("unwraps a JSON-array-wrapped element from a mis-serialized tool call", () => {
		expect(parseText(['["  "version": "2.8.4","].'])).toEqual(['  "version": "2.8.4",']);
	});

	it("leaves valid JSON array lines alone", () => {
		expect(parseText(['["a", "b"]'])).toEqual(['["a", "b"]']);
	});

	it("leaves valid JSON array lines with a trailing dot alone when they parse", () => {
		expect(parseText(['["a", "b"].'])).toEqual(['["a", "b"].']);
	});

	it("unwraps a single-string wrapper with a trailing dot and decodes escapes", () => {
		expect(parseText(['["tab\\tend"].'])).toEqual(["tab\tend"]);
	});

	it("unwraps a single-string wrapper without escapes", () => {
		expect(parseText(['["hello"].'])).toEqual(["hello"]);
	});
});

describe("parseTextWithSeparators", () => {
	it("records the separator used inside an element", () => {
		expect(parseTextWithSeparators(["a\r\nb"])).toEqual({ lines: ["a", "b"], separators: ["\r\n", undefined] });
		expect(parseTextWithSeparators(["a\rb"])).toEqual({ lines: ["a", "b"], separators: ["\r", undefined] });
		expect(parseTextWithSeparators(["a\nb"])).toEqual({ lines: ["a", "b"], separators: ["\n", undefined] });
	});

	it("marks element boundaries as unspecified", () => {
		expect(parseTextWithSeparators(["a", "b"])).toEqual({ lines: ["a", "b"], separators: [undefined, undefined] });
	});

	it("handles mixed separators and trailing breaks", () => {
		expect(parseTextWithSeparators(["a\r\nb\nc\r"])).toEqual({ lines: ["a", "b", "c"], separators: ["\r\n", "\n", "\r"] });
	});

	it("treats a trailing break as the last line's ending instead of a blank line", () => {
		expect(parseTextWithSeparators(["a\n"])).toEqual({ lines: ["a"], separators: ["\n"] });
		expect(parseTextWithSeparators(["a\r\nb\r\n"])).toEqual({ lines: ["a", "b"], separators: ["\r\n", "\r\n"] });
		expect(parseTextWithSeparators(["\n"])).toEqual({ lines: [""], separators: ["\n"] });
		expect(parseTextWithSeparators(["\n\n"])).toEqual({ lines: ["", ""], separators: ["\n", "\n"] });
	});

	it("keeps an explicit empty element as a blank line", () => {
		expect(parseTextWithSeparators(["a\n", ""])).toEqual({ lines: ["a", ""], separators: ["\n", undefined] });
		expect(parseTextWithSeparators(["a", ""])).toEqual({ lines: ["a", ""], separators: [undefined, undefined] });
	});
});
