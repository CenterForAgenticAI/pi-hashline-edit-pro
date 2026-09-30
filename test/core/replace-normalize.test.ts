import { describe, expect, it } from "vitest";
import { normReq } from "../../src/payload-contract";

describe("normReq", () => {
	it("returns non-record input as-is", () => {
		expect(normReq("string")).toBe("string");
		expect(normReq(null)).toBe(null);
		expect(normReq(42)).toBe(42);
		expect(normReq(undefined)).toBe(undefined);
	});

	it("returns object input unchanged when no normalization needed", () => {
		const input = {
			remove_from: "ATIm", remove_to: "ATIm",
			replacement_lines: "new",
		};
		const result = normReq(input);
		expect(result).toEqual(input);
	});

	it("normalizes file_path to path", () => {
		const input = { file_path: "test.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("test.txt");
		expect(result.file_path).toBeUndefined();
	});

	it("does not overwrite existing path with file_path", () => {
		const input = { path: "original.txt", file_path: "alias.txt", remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("original.txt");
	});

	it("ignores file_path when path is already a string", () => {
		const input = {
			path: "src/main.ts",
			file_path: "other.ts",
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.file_path).toBe("other.ts");
	});

	it("preserves other fields", () => {
		const input = { remove_from: "ATIm", remove_to: "BeSR", replacement_lines: ["new"], custom: "value" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});

	it("does not mutate the original input", () => {
		const input = {
			file_path: "src/main.ts",
			remove_from: "ATIm", remove_to: "BeSR",
			replacement_lines: ["x"],
		};
		const originalFilePath = input.file_path;
		const originalNewContent = input.replacement_lines;
		normReq(input);
		expect(input.file_path).toBe(originalFilePath);
		expect(input.replacement_lines).toBe(originalNewContent);
	});
});

describe("normReq - top-level shape", () => {
	it("keeps remove_from/remove_to and replacement_lines at top level", () => {
		const input = {
			remove_from: "ATIm", remove_to: "BeSR",
			replacement_lines: ["new line"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.remove_from).toEqual("ATIm");
		expect(result.remove_to).toEqual("BeSR");
		expect(result.replacement_lines).toEqual("new line");
	});

	it("handles flat format with file_path alias", () => {
		const input = {
			file_path: "src/main.ts",
			remove_from: "ATIm", remove_to: "BeSR",
			replacement_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBe("src/main.ts");
		expect(result.remove_from).toEqual("ATIm");
		expect(result.remove_to).toEqual("BeSR");
	});

	it("normalizes replace_from and replace_to to remove_from and remove_to", () => {
		const input = {
			replace_from: "ATIm", replace_to: "BeSR",
			replacement_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.remove_from).toEqual("ATIm");
		expect(result.remove_to).toEqual("BeSR");
		expect(result.replace_from).toBeUndefined();
		expect(result.replace_to).toBeUndefined();
	});

	it("does not mutate the original flat-format input", () => {
		const input = {
			remove_from: "ATIm", remove_to: "BeSR",
			replacement_lines: ["new"],
		};
		const origFrom = input.remove_from;
		const origTo = input.remove_to;
		const origNc = input.replacement_lines;
		normReq(input);
		expect(input.remove_from).toBe(origFrom);
		expect(input.remove_to).toBe(origTo);
		expect(input.replacement_lines).toBe(origNc);
	});

	it("normalizes from and to to remove_from and remove_to", () => {
		const input = {
			from: "ATIm", to: "BeSR",
			replacement_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.remove_from).toEqual("ATIm");
		expect(result.remove_to).toEqual("BeSR");
		expect(result.from).toBeUndefined();
		expect(result.to).toBeUndefined();
	});

	it("does not overwrite existing anchors with from and to", () => {
		const input = {
			remove_from: "ATIm", remove_to: "BeSR",
			from: "Other", to: "Else",
			replacement_lines: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.remove_from).toEqual("ATIm");
		expect(result.remove_to).toEqual("BeSR");
		expect(result.from).toEqual("Other");
		expect(result.to).toEqual("Else");
	});

	it("does not mutate the original from/to input", () => {
		const input = { from: "ATIm", to: "BeSR", replacement_lines: ["new"] };
		normReq(input);
		expect(input.from).toBe("ATIm");
		expect(input.to).toBe("BeSR");
	});
});

describe("normReq - line fields", () => {
	const glmMapPayload = '["    \\"pi-hashline-edit-pro\\": \\"^4.3.5\\","].map(s => s)';
	const glmSlicePayload = '["    \\"@cortexkit/aft\\": \\"^0.57.0\\",", "    \\"@cortexkit/aft-pi\\": \\"^0.57.0\\","].slice(0, 3)';
	const glmMalformedPayload = '["    \\"pi-hashline-edit-pro\\": \\"^4.3.5\\",""]';

	it("keeps a JSON-array-shaped string literal", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: glmMapPayload }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe(glmMapPayload);
	});

	it("keeps a multi-line JSON-array-shaped string literal", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: glmSlicePayload }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe(glmSlicePayload);
	});

	it("keeps a malformed JSON-array-shaped string literal", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: glmMalformedPayload }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe(glmMalformedPayload);
	});

	it("keeps a string payload with its line endings", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: "line1\nline2" }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe("line1\nline2");
	});

	it("keeps a stringified empty array literal", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: "[]" }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe("[]");
	});

	it("converts a legacy lines array into the exact text", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: ["a", "b"] }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe("a\nb");
	});

	it("keeps a trailing blank line when converting a legacy array", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: ["a", ""] }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe("a\n\n");
	});

	it("converts an empty legacy array into a deletion", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: [] }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe("");
	});

	it("still unwraps a legacy stringified array element", () => {
		const result = normReq({ remove_from: "ATIm", remove_to: "ATIm", replacement_lines: [glmMapPayload] }) as Record<string, unknown>;
		expect(result.replacement_lines).toBe('    "pi-hashline-edit-pro": "^4.3.5",');
	});

	it("normalizes the insert lines field the same way", () => {
		const result = normReq({ anchor: "ATIm", direction: "after", lines: ["a", "b"] }) as Record<string, unknown>;
		expect(result.lines).toBe("a\nb");
	});
});
