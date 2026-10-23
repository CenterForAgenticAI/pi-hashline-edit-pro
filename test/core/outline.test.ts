import { describe, expect, it } from "vitest";
import {
	buildFileOutline,
	loadOutlineParser,
	renderPreviewOutline,
	renderSymbolOutline,
	type OutlineSymbol,
} from "../../src/outline";

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
			lines: ["", "export class App {", "  run(speed: number) {", "    return speed;", "  }"],
			symbols,
		});
		expect(result.text).toContain("=== src/app.ts (TypeScript) — 5 lines ===");
		expect(result.text).toContain("bbbbz│class App (1 children) [limit 4]");
		expect(result.text).toContain("ccccz│  method run (speed: number) [limit 2]");
		expect(result.servedHashes).toEqual(["bbbbz", "ccccz"]);
		expect(result.truncated).toBe(false);
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
		const result = renderSymbolOutline({ displayPath: "a.ts", totalLines: 3, hashes: HASHES, lines: ["class outer {", "  inner()", "}"], symbols: [parent], maxDepth: 0 });
		expect(result.text).toContain("(1 nested items)");
		expect(result.servedHashes).toEqual(["aaaaz"]);
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
		expect(parser?.languageFor("app/UserController.php")).toBe("php");
		expect(parser?.languageFor("resources/views/home.blade.php")).toBe("blade");
		expect(parser?.languageFor("artisan")).toBe("php");
		expect(parser?.languageFor("notes.txt")).toBeNull();
	});

	it("outlines a TypeScript file with anchors", async () => {
		const content = ["export class App {", "  run(speed: number) {", "    return speed;", "  }", "}", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "app.ts", content, hashes: HASHES });
		expect(result.text).toContain("(TypeScript)");
		expect(result.text).toContain("aaaaz│class App (1 children) [limit 5]");
		expect(result.text).toContain("bbbbz│  method run (speed: number) [limit 3]");
		expect(result.servedHashes).toEqual(["aaaaz", "bbbbz"]);
	});

	it("outlines exported declarations", async () => {
		const result = await buildFileOutline({ displayPath: "app.ts", content: "export function run() {\n  return 1;\n}\n", hashes: ["aaaaz", "bbbbz"] });
		expect(result.text).toContain("aaaaz│function run () [limit 3]");
	});

	it("outlines anonymous default exports", async () => {
		const content = ["export default function (pi) {", "  return pi;", "}", "export default class {", "  run() {}", "}", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "entry.ts", content, hashes: HASHES });
		expect(result.text).toContain("aaaaz│function default (pi) [limit 3]");
		expect(result.text).toContain("ddddz│class default (1 children) [limit 3]");
		expect(result.text).toContain("eeeey│  run() {}");
	});

	it("shows single-line symbols as their content without a limit marker", async () => {
		const content = ["const value = 1;", "export function run() {", "  return value;", "}", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "app.ts", content, hashes: anchorsFor(content) });
		expect(result.text).toContain("aaaaz│const value = 1;");
		expect(result.text).not.toContain("[limit 1]");
		expect(result.text).toContain("baaax│function run () [limit 3]");
	});

	it("outlines function expressions and variable declarators", async () => {
		const content = ["const config = defineConfig({", "  run() {},", "});", "const handler = function () {", "  return 1;", "};", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "config.ts", content, hashes: HASHES });
		expect(result.text).toContain("aaaaz│variable config [limit 3]");
		expect(result.text).toContain("ddddz│function handler () [limit 3]");
	});

	it("outlines an arrow default export", async () => {
		const result = await buildFileOutline({ displayPath: "hook.ts", content: "export default () => {\n  return 1;\n};\n", hashes: HASHES });
		expect(result.text).toContain("aaaaz│arrow_function default () [limit 3]");
	});

	it("outlines test calls", async () => {
		const content = ['describe("math", () => {', '  it("adds", () => {', "    expect(1 + 1).toBe(2);", "  });", '  test("subtracts", () => {});', "});", ""].join("\n");
		const result = await buildFileOutline({ displayPath: "math.test.ts", content, hashes: HASHES });
		expect(result.text).toContain("aaaaz│describe math (2 children) [limit 6]");
		expect(result.text).toContain("bbbbz│  it adds [limit 3]");
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
		expect(result.text).toContain("gaaax│class UserController abstract extends Base implements Repository (3 children) [limit 11]");
		expect(result.text).toContain("jaaax│    protected string $name;");
		expect(result.text).toContain("kaaax│    public const VERSION = '1.0';");
		expect(result.text).toContain("maaax│  method index public (): array [limit 4]");
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
		expect(result.text).toContain("caaax│interface Repository extends Countable, Iterator (1 children) [limit 4]");
		expect(result.text).toContain("eaaax│    public function all(): array;");
		expect(result.text).toContain("haaax│trait Logs (1 children) [limit 4]");
		expect(result.text).toContain("jaaax│    public function log(string $message): void {}");
		expect(result.text).toContain("maaax│enum Suit : string implements HasColor (2 children) [limit 5]");
		expect(result.text).toContain("oaaax│    case Hearts = 'H';");
		expect(result.text).toContain("paaax│    public function color(): string { return 'red'; }");
		expect(result.text).toContain("saaax│const TOP = 1;");
		expect(result.text).toContain("taaax│$closure = static function (int $x): int { return $x; };");
		expect(result.text).toContain("uaaax│$arrow = static fn (): string => 'x';");
		expect(result.servedHashes).toEqual(["caaax", "eaaax", "haaax", "jaaax", "maaax", "oaaax", "paaax", "saaax", "taaax", "uaaax"]);
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
		expect(result.text).toContain("caaax│section content (4 children) [limit 8]");
		expect(result.text).toContain('eaaax│    <x-alert type="warning" :message="$warning" />');
		expect(result.text).toContain("faaax│    @livewire('user-table')");
		expect(result.text).toContain('gaaax│    <livewire:user-table :users="$users" />');
		expect(result.text).toContain("haaax│    @include('partials.footer')");
		expect(result.text).toContain("laaax│stack scripts [limit 3]");
		expect(result.text).toContain("paaax│php [limit 3]");
		expect(result.text).toContain("taaax│component x-slot:header [limit 3]");
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
		expect(result.text).toContain("caaax│test users can register (1 children) [limit 4]");
		expect(result.text).toContain("eaaax│    test('nested', function () {});");
		expect(result.text).toContain("haaax│it lists users [limit 3]");
		expect(result.text).toContain("laaax│describe math (1 children) [limit 3]");
		expect(result.text).toContain("maaax│    test('adds', function () {});");
		expect(result.text).toContain("paaax│test('grouped', function () {})->group('slow');");
		expect(result.servedHashes).toEqual(["caaax", "eaaax", "haaax", "laaax", "maaax", "paaax"]);
	});
});
