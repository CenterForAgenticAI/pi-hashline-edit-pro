import { afterEach, describe, expect, it, vi } from "vitest";
import {
	countNewlines,
	joinSeparators,
	separatorsForSpans,
	splitWithEndings,
	applyEndingOverrides,
	applySpanEndings,
	endingsForRange,
	splitSeparators,
	type EndingSpan,
} from "../../src/line-endings";
import { parseSeparators } from "../../src/hash-store/validation";
import type { LineEnding } from "../../src/normalize";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("splitSeparators", () => {
	it("returns each terminator in file order", () => {
		expect(splitSeparators("a\nb\r\nc\rd")).toEqual(["\n", "\r\n", "\r"]);
	});

	it("returns an empty list for content without separators", () => {
		expect(splitSeparators("single")).toEqual([]);
		expect(splitSeparators("")).toEqual([]);
	});

	it("keeps trailing terminators", () => {
		expect(splitSeparators("a\n")).toEqual(["\n"]);
		expect(splitSeparators("a\r\n")).toEqual(["\r\n"]);
		expect(splitSeparators("a\r")).toEqual(["\r"]);
	});
});

describe("joinSeparators", () => {
	it("restores the raw bytes from normalized content", () => {
		const raw = "// Keep this comment unchanged.\nold\r\nline\n";
		const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		expect(joinSeparators(normalized, splitSeparators(raw))).toBe(raw);
	});

	it("falls back to LF when a separator is missing", () => {
		expect(joinSeparators("a\nb", [])).toBe("a\nb");
	});

	it("round-trips uniform CRLF and bare CR files", () => {
		expect(joinSeparators("a\nb\n", splitSeparators("a\r\nb\r\n"))).toBe("a\r\nb\r\n");
		expect(joinSeparators("a\nb", splitSeparators("a\rb"))).toBe("a\rb");
	});
});

describe("countNewlines", () => {
	it("counts only LF characters", () => {
		expect(countNewlines("")).toBe(0);
		expect(countNewlines("a\r\nb\nc")).toBe(2);
	});
});

describe("separatorsForSpans", () => {
	const mixed = (): ReturnType<typeof splitSeparators> => splitSeparators("A\r\nB\nC\r\n");

	it("keeps untouched terminators and the replaced line's terminator", () => {
		const span: EndingSpan = { start: 1, end: 1, replacementCount: 1 };
		expect(separatorsForSpans(mixed(), 3, [span], "A\nX\nC\n", "\n")).toEqual(["\r\n", "\n", "\r\n"]);
	});

	it("clones the last removed terminator for extra replacement lines", () => {
		const span: EndingSpan = { start: 1, end: 1, replacementCount: 3 };
		expect(separatorsForSpans(mixed(), 3, [span], "A\nX\nY\nZ\nC\n", "\n")).toEqual(["\r\n", "\n", "\n", "\n", "\r\n"]);
	});

	it("fills a created trailing blank line with the neighbouring terminator", () => {
		const span: EndingSpan = { start: 1, end: 1, replacementCount: 1 };
		expect(separatorsForSpans(["\n"], 2, [span], "aaa\n\n", "\n")).toEqual(["\n", "\n"]);
	});

	it("drops the preceding terminator when the last line is deleted at EOF without a newline", () => {
		const span: EndingSpan = { start: 1, end: 1, replacementCount: 0 };
		expect(separatorsForSpans(["\n"], 2, [span], "A", "\n")).toEqual([]);
	});

	it("preserves a missing final terminator for an EOF replacement", () => {
		const span: EndingSpan = { start: 1, end: 1, replacementCount: 1 };
		expect(separatorsForSpans(["\n"], 2, [span], "A\nX", "\n")).toEqual(["\n"]);
	});

	it("handles a pure insert span after a line", () => {
		const span: EndingSpan = { start: 2, end: 1, replacementCount: 1 };
		expect(separatorsForSpans(["\r\n", "\n"], 3, [span], "A\nB\nX\nC", "\n")).toEqual(["\r\n", "\n", "\n"]);
	});

	it("applies multiple disjoint spans", () => {
		const spans: EndingSpan[] = [
			{ start: 0, end: 0, replacementCount: 1 },
			{ start: 2, end: 2, replacementCount: 1 },
		];
		expect(separatorsForSpans(["\n", "\r\n", "\n"], 3, spans, "X\nB\nY\n", "\n")).toEqual(["\n", "\r\n", "\n"]);
	});

	it("uses the fallback when the base has no terminator to inherit", () => {
		const span: EndingSpan = { start: 0, end: 0, replacementCount: 2 };
		expect(separatorsForSpans([], 1, [span], "first\nsecond", "\r\n")).toEqual(["\r\n"]);
	});
});

describe("parseSeparators", () => {
	it("accepts absent and empty values", () => {
		expect(parseSeparators(undefined)).toEqual({ ok: true });
		expect(parseSeparators(null)).toEqual({ ok: true });
		expect(parseSeparators("")).toEqual({ ok: true });
	});

	it("accepts valid terminator lists", () => {
		expect(parseSeparators(JSON.stringify(["\n", "\r\n", "\r"]))).toEqual({ ok: true, value: ["\n", "\r\n", "\r"] });
	});

	it("rejects non-string values and invalid JSON", () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(parseSeparators(42).ok).toBe(false);
		expect(parseSeparators("not json").ok).toBe(false);
	});

	it("rejects JSON that is not a terminator list", () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(parseSeparators(JSON.stringify([1, 2])).ok).toBe(false);
		expect(parseSeparators(JSON.stringify(["X"])).ok).toBe(false);
	});
});

describe("splitWithEndings", () => {
	it("records each separator type", () => {
		expect(splitWithEndings("a\r\nb\rc\nd")).toEqual({ lines: ["a", "b", "c", "d"], endings: ["\r\n", "\r", "\n", undefined] });
	});

	it("adds a trailing empty line for a trailing break", () => {
		expect(splitWithEndings("a\n")).toEqual({ lines: ["a", ""], endings: ["\n", undefined] });
		expect(splitWithEndings("")).toEqual({ lines: [""], endings: [undefined] });
	});
});

describe("endingsForRange", () => {
	it("maps 1-based line numbers and reports a missing EOF terminator", () => {
		expect(endingsForRange(["\n", "\r\n", "\r"], 2, 4)).toEqual(["\r\n", "\r", undefined]);
	});
});

describe("applyEndingOverrides", () => {
	it("overrides only defined entries inside the separator list", () => {
		const separators: LineEnding[] = ["\n", "\n", "\n"];
		applyEndingOverrides(separators, 1, [undefined, "\r\n", undefined, "\r"]);
		expect(separators).toEqual(["\n", "\n", "\r\n"]);
	});

	it("ignores an undefined override list", () => {
		const separators: LineEnding[] = ["\n"];
		applyEndingOverrides(separators, 0, undefined);
		expect(separators).toEqual(["\n"]);
	});
});

describe("applySpanEndings", () => {
	it("offsets each span by earlier replacements", () => {
		const separators: LineEnding[] = ["\n", "\n", "\n", "\n", "\n"];
		applySpanEndings(separators, [
			{ start: 0, end: 0, replacementCount: 2, endings: [undefined, "\r\n"] },
			{ start: 3, end: 3, replacementCount: 1, endings: ["\r"] },
		]);
		expect(separators).toEqual(["\n", "\r\n", "\n", "\n", "\r"]);
	});
});
