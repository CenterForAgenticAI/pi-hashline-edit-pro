import { describe, expect, it } from "vitest";
import { normReq, replacementFragment, singleLineMatch } from "../../src/payload-contract";

describe("normReq", () => {
	it("returns non-record input as-is", () => {
		expect(normReq("string")).toBe("string");
		expect(normReq(null)).toBe(null);
		expect(normReq(42)).toBe(42);
		expect(normReq(undefined)).toBe(undefined);
	});

	it("returns object input unchanged when no normalization needed", () => {
		const input = {
			remove_from: "atimx", remove_to: "atimx",
			text: "new",
		};
		const result = normReq(input);
		expect(result).toEqual(input);
	});

	it("leaves file_path untouched", () => {
		const input = { file_path: "test.txt", remove_from: "atimx", remove_to: "besrx", text: ["new"] };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBeUndefined();
		expect(result.file_path).toBe("test.txt");
	});

	it("does not overwrite existing path with file_path", () => {
		const input = { path: "original.txt", file_path: "alias.txt", remove_from: "atimx", remove_to: "besrx", text: ["new"] };
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
		const input = { remove_from: "atimx", remove_to: "besrx", text: ["new"], custom: "value" };
		const result = normReq(input) as Record<string, unknown>;
		expect(result.custom).toBe("value");
	});

	it("does not mutate the original input", () => {
		const input = {
			file_path: "src/main.ts",
			remove_from: "atimx", remove_to: "besrx",
			text: ["x"],
		};
		const originalFilePath = input.file_path;
		const originalNewContent = input.text;
		normReq(input);
		expect(input.file_path).toBe(originalFilePath);
		expect(input.text).toBe(originalNewContent);
	});
});

describe("normReq - top-level shape", () => {
	it("keeps remove_from/remove_to and text at top level", () => {
		const input = {
			remove_from: "atimx", remove_to: "besrx",
			text: ["new line"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.remove_from).toEqual("atimx");
		expect(result.remove_to).toEqual("besrx");
		expect(result.text).toEqual("new line");
	});

	it("leaves file_path untouched in the flat format", () => {
		const input = {
			file_path: "src/main.ts",
			remove_from: "atimx", remove_to: "besrx",
			text: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.path).toBeUndefined();
		expect(result.file_path).toBe("src/main.ts");
		expect(result.remove_from).toEqual("atimx");
		expect(result.remove_to).toEqual("besrx");
	});

	it("leaves replace_from and replace_to untouched", () => {
		const input = {
			replace_from: "atimx", replace_to: "besrx",
			text: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.replace_from).toEqual("atimx");
		expect(result.replace_to).toEqual("besrx");
		expect(result.remove_from).toBeUndefined();
		expect(result.remove_to).toBeUndefined();
	});

	it("does not mutate the original flat-format input", () => {
		const input = {
			remove_from: "atimx", remove_to: "besrx",
			text: ["new"],
		};
		const origFrom = input.remove_from;
		const origTo = input.remove_to;
		const origNc = input.text;
		normReq(input);
		expect(input.remove_from).toBe(origFrom);
		expect(input.remove_to).toBe(origTo);
		expect(input.text).toBe(origNc);
	});

	it("leaves from and to untouched", () => {
		const input = {
			from: "atimx", to: "besrx",
			text: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.from).toEqual("atimx");
		expect(result.to).toEqual("besrx");
		expect(result.remove_from).toBeUndefined();
		expect(result.remove_to).toBeUndefined();
	});

	it("does not overwrite existing anchors with from and to", () => {
		const input = {
			remove_from: "atimx", remove_to: "besrx",
			from: "Other", to: "Else",
			text: ["new"],
		};
		const result = normReq(input) as Record<string, unknown>;
		expect(result.remove_from).toEqual("atimx");
		expect(result.remove_to).toEqual("besrx");
		expect(result.from).toEqual("Other");
		expect(result.to).toEqual("Else");
	});

	it("does not mutate the original from/to input", () => {
		const input = { from: "atimx", to: "besrx", text: ["new"] };
		normReq(input);
		expect(input.from).toBe("atimx");
		expect(input.to).toBe("besrx");
	});
});

describe("normReq - line fields", () => {
	const glmMapPayload = '["    \\"pi-hashline-edit-pro\\": \\"^4.3.5\\","].map(s => s)';
	const glmSlicePayload = '["    \\"@cortexkit/aft\\": \\"^0.57.0\\",", "    \\"@cortexkit/aft-pi\\": \\"^0.57.0\\","].slice(0, 3)';
	const glmMalformedPayload = '["    \\"pi-hashline-edit-pro\\": \\"^4.3.5\\",""]';

	it("keeps a JSON-array-shaped string literal", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: glmMapPayload }) as Record<string, unknown>;
		expect(result.text).toBe(glmMapPayload);
	});

	it("keeps a multi-line JSON-array-shaped string literal", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: glmSlicePayload }) as Record<string, unknown>;
		expect(result.text).toBe(glmSlicePayload);
	});

	it("keeps a malformed JSON-array-shaped string literal", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: glmMalformedPayload }) as Record<string, unknown>;
		expect(result.text).toBe(glmMalformedPayload);
	});

	it("keeps a string payload with its line endings", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: "line1\nline2" }) as Record<string, unknown>;
		expect(result.text).toBe("line1\nline2");
	});

	it("keeps a stringified empty array literal", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: "[]" }) as Record<string, unknown>;
		expect(result.text).toBe("[]");
	});

	it("converts a legacy lines array into the exact text", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: ["a", "b"] }) as Record<string, unknown>;
		expect(result.text).toBe("a\nb");
	});

	it("keeps a trailing blank line when converting a legacy array", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: ["a", ""] }) as Record<string, unknown>;
		expect(result.text).toBe("a\n\n");
	});

	it("converts an empty legacy array into a deletion", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: [] }) as Record<string, unknown>;
		expect(result.text).toBe("");
	});

	it("still unwraps a legacy stringified array element", () => {
		const result = normReq({ remove_from: "atimx", remove_to: "atimx", text: [glmMapPayload] }) as Record<string, unknown>;
		expect(result.text).toBe('    "pi-hashline-edit-pro": "^4.3.5",');
	});

	it("normalizes the insert text field the same way", () => {
		const result = normReq({ anchor: "atimx", direction: "after", text: ["a", "b"] }) as Record<string, unknown>;
		expect(result.text).toBe("a\nb");
	});
});

describe("normReq - anchor aliases", () => {
  it("maps replace_from/replace_to onto remove_from/remove_to for the replace shape", () => {
    const result = normReq({ replace_from: "atimx", replace_to: "besrx", text: "new" }, "remove") as Record<string, unknown>;
    expect(result.remove_from).toBe("atimx");
    expect(result.remove_to).toBe("besrx");
    expect(result.replace_from).toBeUndefined();
    expect(result.replace_to).toBeUndefined();
  });

  it("maps remove_from/remove_to onto replace_from/replace_to for the replace_match shape", () => {
    const result = normReq({ remove_from: "atimx", remove_to: "besrx", match: "a", replacement: "b" }, "replace") as Record<string, unknown>;
    expect(result.replace_from).toBe("atimx");
    expect(result.replace_to).toBe("besrx");
    expect(result.remove_from).toBeUndefined();
    expect(result.remove_to).toBeUndefined();
  });

  it("keeps the canonical field when both spellings are present", () => {
    const result = normReq({ remove_from: "atimx", replace_from: "zzzzx", remove_to: "besrx", replace_to: "YYYY", text: "new" }, "remove") as Record<string, unknown>;
    expect(result.remove_from).toBe("atimx");
    expect(result.remove_to).toBe("besrx");
    expect(result.replace_from).toBeUndefined();
    expect(result.replace_to).toBeUndefined();
  });

  it("leaves both spellings untouched without a pair", () => {
    const result = normReq({ replace_from: "atimx", replace_to: "besrx", text: "new" }) as Record<string, unknown>;
    expect(result.replace_from).toBe("atimx");
    expect(result.replace_to).toBe("besrx");
    expect(result.remove_from).toBeUndefined();
    expect(result.remove_to).toBeUndefined();
  });
});

describe("singleLineMatch", () => {
	it("drops one trailing break and refuses a lone break", () => {
		expect(singleLineMatch("beta\n")).toBe("beta");
		expect(() => singleLineMatch("\n")).toThrow("must be a non-empty string");
	});

	it("counts the line-break column in code points", () => {
		expect(() => singleLineMatch("ab\nc")).toThrow("line break at column 3");
		expect(() => singleLineMatch("a😀b\nc")).toThrow("line break at column 4");
	});
});

describe("replacementFragment", () => {
	it("drops one trailing break and keeps interior breaks", () => {
		expect(replacementFragment("beta\n")).toBe("beta");
		expect(replacementFragment("\n")).toBe("");
		expect(replacementFragment("a\nb")).toBe("a\nb");
		expect(replacementFragment("a\r\nb")).toBe("a\nb");
	});
});
