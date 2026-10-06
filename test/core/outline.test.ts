import { describe, expect, it } from "vitest";
import {
	buildFileOutline,
	loadOutlineParser,
	renderPreviewOutline,
	renderSymbolOutline,
	type OutlineSymbol,
} from "../../src/outline";

const HASHES = ["Aaaa", "Bbbb", "Cccc", "Dddd", "Eeee"];

describe("renderSymbolOutline", () => {
	it("renders nested symbols as anchored rows", () => {
		const symbols: OutlineSymbol[] = [
			{
				name: "App",
				type: "class",
				startLine: 2,
				endLine: 5,
				children: [{ name: "run", type: "method", startLine: 3, endLine: 4, detail: "(speed: number)" }],
			},
		];
		const result = renderSymbolOutline({
			displayPath: "src/app.ts",
			languageName: "TypeScript",
			totalLines: 5,
			hashes: HASHES,
			symbols,
		});
		expect(result.text).toContain("=== src/app.ts (TypeScript) — 5 lines ===");
		expect(result.text).toContain("Bbbb│class App (1 children) [2:5]");
		expect(result.text).toContain("Cccc│  method run (speed: number) [3:4]");
		expect(result.servedHashes).toEqual(["Bbbb", "Cccc"]);
		expect(result.truncated).toBe(false);
	});

	it("caps rows and reports the remainder", () => {
		const symbols: OutlineSymbol[] = Array.from({ length: 5 }, (_, index) => ({
			name: `fn${index}`,
			type: "function",
			startLine: index + 1,
			endLine: index + 1,
		}));
		const result = renderSymbolOutline({ displayPath: "a.ts", totalLines: 5, hashes: HASHES, symbols, maxRows: 2 });
		expect(result.rows).toHaveLength(2);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("... (3 more symbols)");
	});

	it("hints nested items beyond the depth cap", () => {
		const parent: OutlineSymbol = {
			name: "outer",
			type: "class",
			startLine: 1,
			endLine: 3,
			children: [{ name: "inner", type: "function", startLine: 2, endLine: 2 }],
		};
		const result = renderSymbolOutline({ displayPath: "a.ts", totalLines: 3, hashes: HASHES, symbols: [parent], maxDepth: 0 });
		expect(result.text).toContain("(1 nested items)");
		expect(result.servedHashes).toEqual(["Aaaa"]);
	});

	it("skips symbols whose start line is outside the hash range", () => {
		const result = renderSymbolOutline({
			displayPath: "a.ts",
			totalLines: 5,
			hashes: HASHES,
			symbols: [{ name: "gone", type: "function", startLine: 99, endLine: 99 }],
		});
		expect(result.rows).toHaveLength(0);
		expect(result.servedHashes).toEqual([]);
	});
});

describe("renderPreviewOutline", () => {
	it("shows head and tail rows with an ellipsis", () => {
		const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
		const hashes = lines.map((_, index) => `H${String(index).padStart(3, "0")}`);
		const result = renderPreviewOutline({ displayPath: "notes.txt", lines, hashes, headLines: 2, tailLines: 2 });
		expect(result.text).toContain("=== notes.txt — 30 lines ===");
		expect(result.text).toContain("H000│line 1");
		expect(result.text).toContain("H001│line 2");
		expect(result.text).toContain("... (26 more lines)");
		expect(result.text).toContain("H028│line 29");
		expect(result.text).toContain("H029│line 30");
		expect(result.rows).toHaveLength(4);
	});

	it("keeps every line when head and tail cover the file", () => {
		for (const count of [21, 25, 30]) {
			const lines = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
			const hashes = lines.map((_, index) => `H${String(index).padStart(3, "0")}`);
			const result = renderPreviewOutline({ displayPath: "notes.txt", lines, hashes });
			expect(result.rows).toHaveLength(count);
			expect(result.text).not.toContain("more lines");
			expect(result.rows.at(-1)?.text).toBe(`line ${count}`);
		}
	});

	it("shows the ellipsis only when the head and tail leave a gap", () => {
		const lines = Array.from({ length: 31 }, (_, index) => `line ${index + 1}`);
		const hashes = lines.map((_, index) => `H${String(index).padStart(3, "0")}`);
		const result = renderPreviewOutline({ displayPath: "notes.txt", lines, hashes });
		expect(result.rows).toHaveLength(30);
		expect(result.text).toContain("... (1 more lines)");
		expect(result.rows.at(-1)?.text).toBe("line 31");
	});
});

describe("buildFileOutline", () => {
	it("loads the tree-sitter parsers", async () => {
		const parser = await loadOutlineParser();
		expect(parser).toBeDefined();
		expect(parser?.languageFor("src/app.ts")).toBe("typescript");
		expect(parser?.languageFor("notes.txt")).toBeNull();
	});

	it("outlines a TypeScript file with anchors", async () => {
		const content = ["export class App {", "  run(speed: number) {", "    return speed;", "  }", "}", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "app.ts", content, hashes: HASHES });
		expect(result.text).toContain("(TypeScript)");
		expect(result.text).toContain("Aaaa│class App (1 children) [1:5]");
		expect(result.text).toContain("Bbbb│  method run (speed: number) [2:4]");
		expect(result.servedHashes).toEqual(["Aaaa", "Bbbb"]);
	});

	it("outlines exported declarations", async () => {
		const result = await buildFileOutline({ displayPath: "app.ts", content: "export function run() {\n  return 1;\n}\n", hashes: ["Aaaa", "Bbbb"] });
		expect(result.text).toContain("Aaaa│function run () [1:3]");
	});

	it("falls back to a preview for unsupported files", async () => {
		const result = await buildFileOutline({ displayPath: "notes.txt", content: "alpha\nbeta\n", hashes: ["Aaaa", "Bbbb"] });
		expect(result.text).toContain("=== notes.txt — 2 lines ===");
		expect(result.text).toContain("Aaaa│alpha");
		expect(result.text).toContain("Bbbb│beta");
	});

	it("serves the empty-line anchor for an empty file", async () => {
		const result = await buildFileOutline({ displayPath: "empty.txt", content: "", hashes: ["Aaaa"] });
		expect(result.text).toContain("=== empty.txt — 0 lines ===");
		expect(result.text).toContain("Aaaa│");
		expect(result.text).toContain("File is empty. Use replace to insert content.");
		expect(result.servedHashes).toEqual(["Aaaa"]);
		expect(result.rows).toHaveLength(1);
	});
});
