import { describe, expect, it } from "vitest";
import {
	buildFileOutline,
	loadOutlineParser,
	renderPreviewOutline,
	renderSymbolOutline,
	type OutlineSymbol,
} from "../../src/outline";
import { parseFileImports, parseSourceFile } from "../../src/outline/vendor/parsers/index.js";

const HASHES = ["aaaaz", "bbbbz", "ccccz", "ddddz", "eeeey"];

const ANCHOR_BY_LETTER: Record<string, string> = {
	A: "aaaaz", B: "baaax", C: "caaax", D: "daaax", E: "eaaax", F: "faaax",
	G: "gaaax", H: "haaax", I: "iaaax", J: "jaaax", K: "kaaax", L: "laaax",
	M: "maaax", N: "naaax", O: "oaaax", P: "paaax", Q: "qaaax", R: "raaax",
	S: "saaax", T: "taaax", U: "uaaax", V: "vaaax", W: "waaax", X: "xaaax",
	Y: "yaaax", Z: "zaaax",
};

function anchorsFor(content: string): string[] {
	const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	return lines.map((_, index) => ANCHOR_BY_LETTER[String.fromCharCode(65 + index)]!);
}

describe("renderSymbolOutline", () => {
	it("renders nested symbols as anchored rows with their real first line", () => {
		const symbols: OutlineSymbol[] = [
			{
				name: "App",
				type: "class",
				startLine: 2,
				endLine: 5,
				children: [{ name: "run", type: "method", startLine: 3, endLine: 4 }],
			},
		];
		const result = renderSymbolOutline({
			displayPath: "src/app.ts",
			languageName: "TypeScript",
			totalLines: 5,
			hashes: HASHES,
			lines: ["", "export class App {", "  run(speed: number) {", "    return speed;", "  }"],
			symbols,
		});
		expect(result.text).toContain("=== src/app.ts (TypeScript) — 5 lines ===");
		expect(result.text).toContain("bbbbz│export class App {");
		expect(result.text).toContain("ccccz│  run(speed: number) {");
		expect(result.text).toContain("[limit 4]");
		expect(result.text).toContain("[limit 2]");
		expect(result.text).not.toContain("(1 children)");
		expect(result.servedHashes).toEqual(["bbbbz", "ccccz"]);
		expect(result.truncated).toBe(false);
		expect(result.complete).toBe(true);
	});

	it("caps rows and reports the remainder", () => {
		const symbols: OutlineSymbol[] = Array.from({ length: 5 }, (_, index) => ({
			name: `fn${index}`,
			type: "function",
			startLine: index + 1,
			endLine: index + 1,
		}));
		const result = renderSymbolOutline({ displayPath: "a.ts", totalLines: 5, hashes: HASHES, lines: ["fn0", "fn1", "fn2", "fn3", "fn4"], symbols, maxRows: 2 });
		expect(result.rows).toHaveLength(2);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("... (3 more symbols); read from the last shown anchor to continue.");
		expect(result.complete).toBe(false);
	});

	it("does not count depth-hidden symbols as remaining on truncation", () => {
		const symbols: OutlineSymbol[] = [
			{ name: "A", type: "class", startLine: 1, endLine: 3, children: [{ name: "m", type: "method", startLine: 2, endLine: 2 }] },
			{ name: "B", type: "class", startLine: 4, endLine: 5, children: [{ name: "n", type: "method", startLine: 5, endLine: 5 }] },
		];
		const result = renderSymbolOutline({
			displayPath: "a.ts",
			totalLines: 5,
			hashes: HASHES,
			lines: ["class A {", "  m()", "}", "class B {", "  n()"],
			symbols,
			maxDepth: 0,
			maxRows: 1,
		});
		expect(result.text).toContain("... (1 more symbol)");
		expect(result.text).not.toContain("3 more symbols");
		expect(result.text).toContain("[1 nested]");
	});

	it("does not report zero remaining symbols when the byte budget drops a span hint", () => {
		const result = renderSymbolOutline({
			displayPath: "a.ts",
			totalLines: 2,
			hashes: HASHES,
			lines: ["fn0", "  body"],
			symbols: [{ name: "fn0", type: "function", startLine: 1, endLine: 2 }],
			maxBytes: 40,
		});
		expect(result.truncated).toBe(true);
		expect(result.text).not.toContain("0 more symbols");
		expect(result.text).toContain("outline truncated by the byte budget");
	});

	it("does not point at a last shown anchor when the byte budget stops before the first row", () => {
		const result = renderSymbolOutline({
			displayPath: "a.ts",
			totalLines: 2,
			hashes: HASHES,
			lines: ["fn0", "  body"],
			symbols: [{ name: "fn0", type: "function", startLine: 1, endLine: 2 }],
			maxBytes: 30,
		});
		expect(result.rows).toHaveLength(0);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("before the first row");
		expect(result.text).not.toContain("last shown anchor");
	});

	it("names the row cap when it stops before the first row", () => {
		const result = renderSymbolOutline({
			displayPath: "a.ts",
			totalLines: 2,
			hashes: HASHES,
			lines: ["fn0", "  body"],
			symbols: [{ name: "fn0", type: "function", startLine: 1, endLine: 2 }],
			maxRows: 0,
		});
		expect(result.rows).toHaveLength(0);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("row cap before the first row");
	});

	it("hints nested items beyond the depth cap", () => {
		const parent: OutlineSymbol = {
			name: "outer",
			type: "class",
			startLine: 1,
			endLine: 3,
			children: [{ name: "inner", type: "function", startLine: 2, endLine: 2 }],
		};
		const result = renderSymbolOutline({ displayPath: "a.ts", totalLines: 3, hashes: HASHES, lines: ["class outer {", "  inner()", "}"], symbols: [parent], maxDepth: 0 });
		expect(result.text).toContain("aaaaz│class outer {");
		expect(result.text).toContain("[1 nested]");
		expect(result.servedHashes).toEqual(["aaaaz"]);
		expect(result.truncated).toBe(false);
		expect(result.complete).toBe(true);
	});

	it("skips symbols whose start line is outside the hash range", () => {
		const result = renderSymbolOutline({
			displayPath: "a.ts",
			totalLines: 5,
			hashes: HASHES,
			lines: [],
			symbols: [{ name: "gone", type: "function", startLine: 99, endLine: 99 }],
		});
		expect(result.rows).toHaveLength(0);
		expect(result.servedHashes).toEqual([]);
	});

	it("collapses symbols that start on the same line into one row", () => {
		const result = renderSymbolOutline({
			displayPath: "a.java",
			totalLines: 3,
			hashes: HASHES,
			lines: ["class A {", "  int a = 1, b = 2;", "}"],
			symbols: [
				{ name: "a", type: "field", startLine: 2, endLine: 2 },
				{ name: "b", type: "field", startLine: 2, endLine: 2 },
			],
		});
		expect(result.text.split("bbbbz│")).toHaveLength(2);
		expect(result.servedHashes).toEqual(["bbbbz"]);
	});

	it("keeps descendants of a symbol that shares a start line", () => {
		const symbols: OutlineSymbol[] = [
			{
				name: "A",
				type: "class",
				startLine: 1,
				endLine: 3,
				children: [
					{
						name: "B",
						type: "class",
						startLine: 1,
						endLine: 3,
						children: [{ name: "m", type: "method", startLine: 2, endLine: 2 }],
					},
				],
			},
		];
		const result = renderSymbolOutline({
			displayPath: "A.java",
			totalLines: 3,
			hashes: HASHES,
			lines: ["class A { class B {", "  void m() {}", "} }"],
			symbols,
		});
		expect(result.rows.map((row) => row.line)).toEqual([1, 2]);
		expect(result.text).toContain("bbbbz│  void m() {}");
		expect(result.complete).toBe(true);
	});

	it("marks children of a collapsed same-line symbol that depth hides", () => {
		const result = renderSymbolOutline({
			displayPath: "A.java",
			totalLines: 3,
			hashes: HASHES,
			lines: ["class A {} class B {", "  void m() {}", "}"],
			symbols: [
				{ name: "A", type: "class", startLine: 1, endLine: 1 },
				{ name: "B", type: "class", startLine: 1, endLine: 2, children: [{ name: "m", type: "method", startLine: 2, endLine: 2 }] },
			],
			maxDepth: 0,
		});
		expect(result.rows.map((row) => row.line)).toEqual([1]);
		expect(result.text).toContain("[1 nested]");
		expect(result.complete).toBe(true);
	});

	it("is not complete when a symbol line has no anchor", () => {
		const result = renderSymbolOutline({
			displayPath: "a.ts",
			totalLines: 2,
			hashes: ["aaaaz"],
			lines: ["first", "second"],
			symbols: [{ name: "second", type: "variable", startLine: 2, endLine: 2 }],
		});
		expect(result.rows).toHaveLength(0);
		expect(result.complete).toBe(false);
	});

	it("counts descendants of a collapsed symbol as remaining", () => {
		const symbols: OutlineSymbol[] = [
			{
				name: "A",
				type: "class",
				startLine: 1,
				endLine: 3,
				children: [
					{
						name: "B",
						type: "class",
						startLine: 1,
						endLine: 3,
						children: [{ name: "m", type: "method", startLine: 2, endLine: 2 }],
					},
				],
			},
		];
		const result = renderSymbolOutline({
			displayPath: "A.java",
			totalLines: 3,
			hashes: HASHES,
			lines: ["class A { class B {", "  void m() {}", "} }"],
			symbols,
			maxRows: 1,
		});
		expect(result.rows.map((row) => row.line)).toEqual([1]);
		expect(result.text).toContain("... (1 more symbol)");
	});

	it("does not serve a row whose line is too long to show whole", () => {
		const long = "const value = '" + "a".repeat(260) + "';";
		const result = renderSymbolOutline({
			displayPath: "a.ts",
			totalLines: 1,
			hashes: ["aaaaz"],
			lines: [long],
			symbols: [{ name: "value", type: "variable", startLine: 1, endLine: 1 }],
		});
		expect(result.rows[0]?.text.endsWith("...")).toBe(true);
		expect(result.rows[0]?.text.length).toBe(203);
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
		expect(result.complete).toBe(false);
	});

	it("keeps every line when head and tail cover the file", () => {
		for (const count of [21, 25, 30]) {
			const lines = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
			const hashes = lines.map((_, index) => `H${String(index).padStart(3, "0")}`);
			const result = renderPreviewOutline({ displayPath: "notes.txt", lines, hashes });
			expect(result.rows).toHaveLength(count);
			expect(result.text).not.toContain("more lines");
			expect(result.rows.at(-1)?.text).toBe(`line ${count}`);
			expect(result.complete).toBe(true);
		}
	});

	it("shows the ellipsis only when the head and tail leave a gap", () => {
		const lines = Array.from({ length: 31 }, (_, index) => `line ${index + 1}`);
		const hashes = lines.map((_, index) => `H${String(index).padStart(3, "0")}`);
		const result = renderPreviewOutline({ displayPath: "notes.txt", lines, hashes });
		expect(result.rows).toHaveLength(30);
		expect(result.text).toContain("... (1 more line)");
		expect(result.rows.at(-1)?.text).toBe("line 31");
		expect(result.complete).toBe(false);
	});

	it("does not serve a clipped preview row", () => {
		const long = `const value = '${"a".repeat(260)}';`;
		const result = renderPreviewOutline({ displayPath: "long.ts", lines: [long, "short"], hashes: ["aaaaz", "bbbbz"] });
		expect(result.rows).toHaveLength(2);
		expect(result.servedHashes).toEqual(["bbbbz"]);
		expect(result.truncated).toBe(false);
		expect(result.complete).toBe(false);
	});

	it("reports the unshown tail once when the byte budget cuts it", () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1} ` + "y".repeat(50));
		const hashes = lines.map((_, index) => `H${String(index).padStart(3, "0")}`);
		const result = renderPreviewOutline({ displayPath: "x.txt", lines, hashes, maxBytes: 1400 });
		expect(result.rows).toHaveLength(20);
		expect(result.truncated).toBe(true);
		expect(result.complete).toBe(false);
		expect(result.text.split("\n").filter((line) => line.includes("more lines"))).toEqual(["... (20 more lines)"]);
	});

	it("reports the unshown count once when the byte budget cuts part of the tail", () => {
		const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
		const hashes = lines.map((_, index) => `H${String(index).padStart(3, "0")}`);
		const result = renderPreviewOutline({ displayPath: "x.txt", lines, hashes, headLines: 2, tailLines: 2, maxBytes: 100 });
		expect(result.rows).toHaveLength(3);
		expect(result.truncated).toBe(true);
		expect(result.complete).toBe(false);
		expect(result.text.split("\n").filter((line) => line.includes("more line"))).toEqual(["... (7 more lines)"]);
	});

	it("is not complete when a line has no anchor", () => {
		const result = renderPreviewOutline({ displayPath: "x.ts", lines: ["a", "b"], hashes: ["aaaaz"] });
		expect(result.rows).toHaveLength(1);
		expect(result.servedHashes).toEqual(["aaaaz"]);
		expect(result.complete).toBe(false);
	});

	it("honors the byte budget for the empty-file row", () => {
		const result = renderPreviewOutline({ displayPath: "empty.txt", lines: [], hashes: ["aaaaz"], maxBytes: 45 });
		expect(result.rows).toHaveLength(1);
		expect(result.servedHashes).toEqual(["aaaaz"]);
		expect(result.truncated).toBe(true);
		expect(result.complete).toBe(false);
		expect(result.text).not.toContain("File is empty");
		expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(45);
	});
});

describe("buildFileOutline", () => {
	it("loads the tree-sitter parsers", async () => {
		const parser = await loadOutlineParser();
		expect(parser).toBeDefined();
		expect(parser?.languageFor("src/app.ts")).toBe("typescript");
		expect(parser?.languageFor("app/UserController.php")).toBe("php");
		expect(parser?.languageFor("resources/views/home.blade.php")).toBe("blade");
		expect(parser?.languageFor("artisan")).toBe("php");
		expect(parser?.languageFor("notes.txt")).toBeNull();
	});

	it("outlines a TypeScript file with anchors", async () => {
		const content = ["export class App {", "  run(speed: number) {", "    return speed;", "  }", "}", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "app.ts", content, hashes: HASHES });
		expect(result.text).toContain("(TypeScript)");
		expect(result.text).toContain("aaaaz│export class App {");
		expect(result.text).toContain("[limit 5]");
		expect(result.text).toContain("bbbbz│  run(speed: number) {");
		expect(result.text).toContain("[limit 3]");
		expect(result.servedHashes).toEqual(["aaaaz", "bbbbz"]);
	});

	it("outlines exported declarations", async () => {
		const result = await buildFileOutline({ displayPath: "app.ts", content: "export function run() {\n  return 1;\n}\n", hashes: ["aaaaz", "bbbbz"] });
		expect(result.text).toContain("aaaaz│export function run() {");
		expect(result.text).toContain("[limit 3]");
	});

	it("outlines anonymous default exports", async () => {
		const content = ["export default function (pi) {", "  return pi;", "}", "export default class {", "  run() {}", "}", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "entry.ts", content, hashes: HASHES });
		expect(result.text).toContain("aaaaz│export default function (pi) {");
		expect(result.text).toContain("ddddz│export default class {");
		expect(result.text).toContain("eeeey│  run() {}");
	});

	it("marks every multi-line symbol with its span", async () => {
		const content = ["const value = 1;", "export function run() {", "  return value;", "}", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "app.ts", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("aaaaz│const value = 1;");
		expect(result.text).not.toContain("[limit 1]");
		expect(result.text).toContain("baaax│export function run() {");
		expect(result.text).toContain("[limit 3]");
	});

	it("outlines function expressions and variable declarators", async () => {
		const content = ["const config = defineConfig({", "  run() {},", "});", "const handler = function () {", "  return 1;", "};", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "config.ts", content, hashes: HASHES });
		expect(result.text).toContain("aaaaz│const config = defineConfig({");
		expect(result.text).toContain("[limit 3]");
		expect(result.text).toContain("ddddz│const handler = function () {");
	});

	it("outlines an arrow default export", async () => {
		const result = await buildFileOutline({ displayPath: "hook.ts", content: "export default () => {\n  return 1;\n};\n", hashes: HASHES });
		expect(result.text).toContain("aaaaz│export default () => {");
		expect(result.text).toContain("[limit 3]");
	});

	it("outlines test calls", async () => {
		const content = ['describe("math", () => {', '  it("adds", () => {', "    expect(1 + 1).toBe(2);", "  });", '  test("subtracts", () => {});', "});", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "math.test.ts", content, hashes: HASHES });
		expect(result.text).toContain('aaaaz│describe("math", () => {');
		expect(result.text).toContain("[limit 6]");
		expect(result.text).toContain('bbbbz│  it("adds", () => {');
		expect(result.text).toContain('eeeey│  test("subtracts", () => {});');
	});

	it("falls back to a preview for unsupported files", async () => {
		const result = await buildFileOutline({ displayPath: "notes.txt", content: "alpha\nbeta\n", hashes: ["aaaaz", "bbbbz"] });
		expect(result.text).toContain("=== notes.txt — 2 lines ===");
		expect(result.text).toContain("aaaaz│alpha");
		expect(result.text).toContain("bbbbz│beta");
	});

	it("serves the empty-line anchor for an empty file", async () => {
		const result = await buildFileOutline({ displayPath: "empty.txt", content: "", hashes: ["aaaaz"] });
		expect(result.text).toContain("=== empty.txt — 0 lines ===");
		expect(result.text).toContain("aaaaz│");
		expect(result.text).toContain("File is empty. Use replace to insert content.");
		expect(result.servedHashes).toEqual(["aaaaz"]);
		expect(result.rows).toHaveLength(1);
	});

	it("outlines a PHP class with its members", async () => {
		const content = [
			"<?php",
			"",
			"namespace App\\Http\\Controllers;",
			"",
			"use App\\Models\\User;",
			"",
			"abstract class UserController extends Base implements Repository",
			"{",
			"    use Logs;",
			"    protected string $name;",
			"    public const VERSION = '1.0';",
			"",
			"    public function index(): array",
			"    {",
			"        return [];",
			"    }",
			"}",
			"",
		].join("\n");
		const result = await buildFileOutline({ displayPath: "app/UserController.php", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("=== app/UserController.php (PHP) — 17 lines ===");
		expect(result.text).toContain("gaaax│abstract class UserController extends Base implements Repository");
		expect(result.text).toContain("[limit 11]");
		expect(result.text).toContain("jaaax│    protected string $name;");
		expect(result.text).toContain("kaaax│    public const VERSION = '1.0';");
		expect(result.text).toContain("maaax│    public function index(): array");
		expect(result.text).toContain("[limit 4]");
		expect(result.servedHashes).toEqual(["gaaax", "jaaax", "kaaax", "maaax"]);
	});

	it("outlines PHP interfaces, traits, enums, and functions", async () => {
		const content = [
			"<?php",
			"",
			"interface Repository extends Countable, Iterator",
			"{",
			"    public function all(): array;",
			"}",
			"",
			"trait Logs",
			"{",
			"    public function log(string $message): void {}",
			"}",
			"",
			"enum Suit: string implements HasColor",
			"{",
			"    case Hearts = 'H';",
			"    public function color(): string { return 'red'; }",
			"}",
			"",
			"const TOP = 1;",
			"$closure = static function (int $x): int { return $x; };",
			"$arrow = static fn (): string => 'x';",
			"",
		].join("\n");
		const result = await buildFileOutline({ displayPath: "app/Domain.php", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("caaax│interface Repository extends Countable, Iterator");
		expect(result.text).toContain("eaaax│    public function all(): array;");
		expect(result.text).toContain("haaax│trait Logs");
		expect(result.text).toContain("jaaax│    public function log(string $message): void {}");
		expect(result.text).toContain("maaax│enum Suit: string implements HasColor");
		expect(result.text).toContain("oaaax│    case Hearts = 'H';");
		expect(result.text).toContain("paaax│    public function color(): string { return 'red'; }");
		expect(result.text).toContain("saaax│const TOP = 1;");
		expect(result.text).toContain("taaax│$closure = static function (int $x): int { return $x; };");
		expect(result.text).toContain("uaaax│$arrow = static fn (): string => 'x';");
		expect(result.servedHashes).toEqual(["caaax", "eaaax", "haaax", "jaaax", "maaax", "oaaax", "paaax", "saaax", "taaax", "uaaax"]);
	});

	it("anchors PHP members on their declaration line, not on their attributes", async () => {
		const content = [
			"<?php",
			"#[Attribute]",
			"final class A",
			"{",
			"    #[Test]",
			"    public function t(): void {}",
			"}",
			"",
		].join("\n");
		const result = await buildFileOutline({ displayPath: "a.php", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("caaax│final class A");
		expect(result.text).toContain("faaax│    public function t(): void {}");
		expect(result.text).not.toContain("#[Test]");
	});

	it("anchors wrapped PHP properties and constants on their declaration start", async () => {
		const content = [
			"<?php",
			"class A",
			"{",
			"    #[Attr]",
			"    public string",
			"        $name = 'x';",
			"    #[Attr]",
			"    public const",
			"        VERSION = '1.0';",
			"}",
			"",
		].join("\n");
		const result = await buildFileOutline({ displayPath: "a.php", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("eaaax│    public string");
		expect(result.text).toContain("[limit 2]");
		expect(result.text).toContain("haaax│    public const");
		expect(result.text).not.toContain("│        $name");
		expect(result.text).not.toContain("│        VERSION");
	});

	it("outlines Java types, annotated members, fields, and enum constants", async () => {
		const content = [
			"package demo;",
			"",
			"public class ReachRegionGatewayTest {",
			"",
			"    @Test",
			'    @DisplayName("reaches region")',
			"    void reachRegionIsReachable() {",
			"        assertTrue(true);",
			"    }",
			"",
			"    @Override",
			"    public String toString() {",
			'        return "x";',
			"    }",
			"",
			"    private static final int LIMIT = 3, OTHER = 4;",
			"    enum Suit { HEARTS }",
			"    public ReachRegionGatewayTest() {",
			"    }",
			"}",
			"",
		].join("\n");
		const result = await buildFileOutline({ displayPath: "ReachRegionGatewayTest.java", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("caaax│public class ReachRegionGatewayTest {");
		expect(result.text).toContain("gaaax│    void reachRegionIsReachable() {");
		expect(result.text).toContain("laaax│    public String toString() {");
		expect(result.text).toContain("paaax│    private static final int LIMIT = 3, OTHER = 4;");
		expect(result.text).toContain("qaaax│    enum Suit { HEARTS }");
		expect(result.text).toContain("raaax│    public ReachRegionGatewayTest() {");
		expect(result.text).not.toContain("@Test");
		expect(result.text).not.toContain("<unknown>");
		expect(result.text.split("paaax│")).toHaveLength(2);
	});

	it("outlines a record compact constructor", async () => {
		const content = [
			"record Point(int x, int y) {",
			"  Point {",
			"    if (x < 0) throw new IllegalArgumentException();",
			"  }",
			"  static Point of(int x) { return new Point(x, x); }",
			"}",
			"",
		].join("\n");
		const result = await buildFileOutline({ displayPath: "Point.java", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("aaaaz│record Point(int x, int y) {");
		expect(result.text).toContain("baaax│  Point {");
		expect(result.text).toContain("eaaax│  static Point of(int x) { return new Point(x, x); }");
	});

	it("outlines a Blade template with directives and components", async () => {
		const content = [
			"@extends('layouts.app')",
			"",
			"@section('content')",
			'<div class="container">',
			'    <x-alert type="warning" :message="$warning" />',
			"    @livewire('user-table')",
			'    <livewire:user-table :users="$users" />',
			"    @include('partials.footer')",
			"</div>",
			"@endsection",
			"",
			"@push('scripts')",
			'    <script src="/js/app.js"></script>',
			"@endpush",
			"",
			"@php",
			"    $total = $users->count();",
			"@endphp",
			"",
			"<x-slot:header>",
			"    <h1>Header</h1>",
			"</x-slot:header>",
			"",
		].join("\n");
		const result = await buildFileOutline({ displayPath: "resources/views/home.blade.php", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("=== resources/views/home.blade.php (Blade) — 22 lines ===");
		expect(result.text).toContain("aaaaz│@extends('layouts.app')");
		expect(result.text).toContain("caaax│@section('content')");
		expect(result.text).toContain("[limit 8]");
		expect(result.text).toContain('eaaax│    <x-alert type="warning" :message="$warning" />');
		expect(result.text).toContain("faaax│    @livewire('user-table')");
		expect(result.text).toContain('gaaax│    <livewire:user-table :users="$users" />');
		expect(result.text).toContain("haaax│    @include('partials.footer')");
		expect(result.text).toContain("laaax│@push('scripts')");
		expect(result.text).toContain("paaax│@php");
		expect(result.text).toContain("taaax│<x-slot:header>");
		expect(result.servedHashes).toEqual(["aaaaz", "caaax", "eaaax", "faaax", "gaaax", "haaax", "laaax", "paaax", "taaax"]);
	});

	it("previews a Blade template without structural directives", async () => {
		const content = ['<div class="wrap">', "    {{-- hidden --}}", "    <p>text</p>", "</div>", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "resources/views/plain.blade.php", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("=== resources/views/plain.blade.php — 4 lines ===");
		expect(result.text).not.toContain("(Blade)");
		expect(result.rows).toHaveLength(4);
	});

	it("outlines Pest tests with nested and chained calls", async () => {
		const content = [
			"<?php",
			"",
			"test('users can register', function () {",
			"    $response = $this->post('/register');",
			"    test('nested', function () {});",
			"});",
			"",
			"it('lists users', function () {",
			"    expect(true)->toBeTrue();",
			"});",
			"",
			"describe('math', function () {",
			"    test('adds', function () {});",
			"});",
			"",
			"test('grouped', function () {})->group('slow');",
			"",
		].join("\n");
		const result = await buildFileOutline({ displayPath: "tests/Feature/UserTest.php", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("caaax│test('users can register', function () {");
		expect(result.text).toContain("[limit 4]");
		expect(result.text).toContain("eaaax│    test('nested', function () {});");
		expect(result.text).toContain("haaax│it('lists users', function () {");
		expect(result.text).toContain("laaax│describe('math', function () {");
		expect(result.text).toContain("maaax│    test('adds', function () {});");
		expect(result.text).toContain("paaax│test('grouped', function () {})->group('slow');");
		expect(result.servedHashes).toEqual(["caaax", "eaaax", "haaax", "laaax", "maaax", "paaax"]);
	});

	it("anchors a wrapped Java member on its declaration start", async () => {
		const content = ["class A {", "  @Deprecated", "  public void", "  wrapped() {}", "}", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "A.java", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("caaax│  public void");
		expect(result.text).toContain("[limit 2]");
		expect(result.text).not.toContain("│  wrapped() {}");
	});
});

describe("symbol extraction", () => {
	it("keeps names, types, and declaration starts for annotated Java members", async () => {
		const content = [
			"class A {",
			"  @Deprecated",
			"  public void",
			"  wrapped() {}",
			"  @Deprecated public int sameLine;",
			"  private java.util.Map<String,",
			"  Integer> wrappedField;",
			"}",
			"",
		].join("\n");
		const parsed = await parseSourceFile("A.java", content);
		const type = parsed.symbols[0]!;
		expect(type).toMatchObject({ name: "A", type: "class", startLine: 1 });
		expect(type.children).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "wrapped", type: "method", startLine: 3 }),
			expect.objectContaining({ name: "sameLine", type: "field", startLine: 5 }),
			expect.objectContaining({ name: "wrappedField", type: "field", startLine: 6 }),
		]));
	});

	it("keeps the record name for a compact constructor", async () => {
		const content = [
			"record Point(int x, int y) {",
			"  Point {",
			"    if (x < 0) throw new IllegalArgumentException();",
			"  }",
			"}",
			"",
		].join("\n");
		const parsed = await parseSourceFile("Point.java", content);
		const type = parsed.symbols[0]!;
		expect(type.children).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "Point", type: "constructor", startLine: 2 }),
		]));
	});

	it("keeps names, types, and declaration starts for attributed PHP members", async () => {
		const content = [
			"<?php",
			"#[Attr]",
			"final",
			"class A {",
			"  #[Test]",
			"  public function",
			"  wrapped(): void {}",
			"  #[Test]",
			"  public function sameLine(): void {}",
			"}",
			"",
		].join("\n");
		const parsed = await parseSourceFile("A.php", content);
		const type = parsed.symbols[0]!;
		expect(type).toMatchObject({ name: "A", type: "class", startLine: 3 });
		expect(type.children).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "wrapped", type: "method", startLine: 6 }),
			expect.objectContaining({ name: "sameLine", type: "method", startLine: 9 }),
		]));
	});
});

describe("parseFileImports", () => {
	it("classifies Java static and wildcard imports", async () => {
		const source = [
			"package demo;",
			"",
			"import java.util.List;",
			"import java.util.*;",
			"import static java.util.Map.entry;",
			"import static java.util.Map.*;",
			"",
			"class A {}",
			"",
		].join("\n");
		await expect(parseFileImports("java", source)).resolves.toEqual([
			{ source: "java.util.List", names: ["List"], lineNumber: 3 },
			{ source: "java.util.*", names: [], lineNumber: 4 },
			{ source: "static java.util.Map.entry", names: ["entry"], lineNumber: 5 },
			{ source: "static java.util.Map.*", names: [], lineNumber: 6 },
		]);
	});

	it("classifies an import whose comment separates import and static", async () => {
		const source = ["import /* note */ static java.util.Map.entry;", "class A {}", ""].join("\n");
		await expect(parseFileImports("java", source)).resolves.toEqual([
			{ source: "static java.util.Map.entry", names: ["entry"], lineNumber: 1 },
		]);
	});
});
