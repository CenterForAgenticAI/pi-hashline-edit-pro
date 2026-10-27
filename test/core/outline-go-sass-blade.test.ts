import { describe, expect, it } from "vitest";
import { buildFileOutline } from "../../src/outline";
import { parseSourceFile } from "../../src/outline/vendor/parsers/index.js";

function hashesFor(content: string): string[] {
	return content.trimEnd().split("\n").map((_, index) => `h${String(index + 1).padStart(4, "0")}`);
}

describe("Go outline", () => {
	it("anchors grouped declarations on their opener and lists every spec", async () => {
		const content = [
			"package main", "const (", "  A = iota", "  B", ")",
			"var (", "  x = 1", "  y = 2", ")",
			"type (", "  A1 int", "  B1 string", ")", "",
		].join("\n");
		const { symbols } = await parseSourceFile("a.go", content);
		for (const [index, startLine, endLine, names] of [
			[0, 2, 5, ["A", "B"]],
			[1, 6, 9, ["x", "y"]],
			[2, 10, 13, ["A1", "B1"]],
		] as const) {
			expect(symbols[index]).toMatchObject({ startLine, endLine, children: names.map((name, offset) => ({ name, startLine: startLine + offset + 1 })) });
		}
		const outline = await buildFileOutline({ displayPath: "a.go", content, hashes: hashesFor(content) });
		for (const [line, opener] of [[2, "const ("], [6, "var ("], [10, "type ("]] as const) {
			expect(outline.text).toContain(`h${String(line).padStart(4, "0")}│${opener}\n[limit 4]`);
		}
	});

	it("keeps one-spec groups distinct from ungrouped declarations", async () => {
		const content = [
			"package main", "const (", "  A = 1", ")", "var (", "  x = 2", ")",
			"type (", "  Alias int", ")", "const B = 3", "var y = 4", "type Named int", "",
		].join("\n");
		const { symbols } = await parseSourceFile("a.go", content);
		expect(symbols.slice(0, 3)).toMatchObject([
			{ startLine: 2, endLine: 4, children: [{ name: "A", startLine: 3 }] },
			{ startLine: 5, endLine: 7, children: [{ name: "x", startLine: 6 }] },
			{ startLine: 8, endLine: 10, children: [{ name: "Alias", startLine: 9 }] },
		]);
		expect(symbols.slice(3).map((symbol) => symbol.startLine)).toEqual([11, 12, 13]);
	});

	it("lists interface methods and embedded struct fields", async () => {
		const content = [
			"package main", "type Reader interface {", "  Read(p []byte) (n int, err error)", "  Close() error", "}",
			"type T[K comparable, V any] struct {", "  m map[K]V", "  // comment", "  Embedded", "}", "",
		].join("\n");
		const { symbols } = await parseSourceFile("a.go", content);
		expect(symbols[0]).toMatchObject({ name: "Reader", startLine: 2, endLine: 5, children: [
			{ name: "Read", startLine: 3 }, { name: "Close", startLine: 4 },
		] });
		expect(symbols[1]).toMatchObject({ name: "T", startLine: 6, endLine: 10, children: [
			{ name: "m", startLine: 7 }, { name: "Embedded", startLine: 9 },
		] });
		const outline = await buildFileOutline({ displayPath: "a.go", content, hashes: hashesFor(content) });
		expect(outline.rows.map((row) => row.line)).toEqual([2, 3, 4, 6, 7, 9]);
	});
	it("lists embedded interface types alongside method specs", async () => {
		const content = "package main\ntype ReadCloser interface {\n  Reader\n  Close() error\n}\n";
		const { symbols } = await parseSourceFile("a.go", content);
		expect(symbols[0]?.children).toMatchObject([
			{ name: "Reader", startLine: 3 }, { name: "Close", startLine: 4 },
		]);
	});
});

describe("Sass outline", () => {
	it("ends each span on its last owned non-blank line, not the next sibling", async () => {
		const content = [
			"$c: red", "", "=mixin-a($x)", "  color: $x", "", ".nav", "  ul", "    margin: 0",
			"  li", "    display: inline", "    &:hover", "      color: $c", "", "@media screen", "  .nav", "    display: none", "",
		].join("\n");
		const { symbols } = await parseSourceFile("a.sass", content);
		expect(symbols).toMatchObject([
			{ startLine: 1, endLine: 1 },
			{ startLine: 3, endLine: 4 },
			{ startLine: 6, endLine: 12, children: [
				{ startLine: 7, endLine: 8 },
				{ startLine: 9, endLine: 12, children: [{ startLine: 11, endLine: 12 }] },
			] },
			{ startLine: 14, endLine: 16, children: [{ startLine: 15, endLine: 16 }] },
		]);
		const outline = await buildFileOutline({ displayPath: "a.sass", content, hashes: hashesFor(content) });
		expect(outline.text).toContain("h0003│=mixin-a($x)\n[limit 2]");
		expect(outline.text).toContain("h0006│.nav\n[limit 7]");
		expect(outline.text).toContain("h0007│  ul\n[limit 2]");
		expect(outline.text).not.toContain("h0001│$c: red\n[limit");
	});
});

describe("Blade outline", () => {
	it("anchors nested block directives and keeps include as a leaf", async () => {
		const content = [
			"@extends('layouts.app')", "", "@section('title', 'Page')", "", "@section('content')",
			"  <div>", "    @if($user)", "      <p>{{ $user->name }}</p>", "    @endif",
			"    @foreach($items as $item)", "      @include('partials.item', ['item' => $item])", "    @endforeach",
			"    @component('alert')", "      @slot('title') Hi @endslot", "    @endcomponent",
			"  </div>", "@endsection", "", "@push('scripts')", "  <script>function x(){}</script>", "@endpush", "",
		].join("\n");
		const { symbols } = await parseSourceFile("a.blade.php", content);
		expect(symbols).toMatchObject([
			{ type: "extends", startLine: 1 }, { type: "section", startLine: 3, endLine: 3 },
			{ type: "section", startLine: 5, endLine: 17, children: [
				{ type: "if", startLine: 7, endLine: 9 },
				{ type: "foreach", startLine: 10, endLine: 12, children: [{ type: "include", startLine: 11, endLine: 11 }] },
				{ type: "component", startLine: 13, endLine: 15, children: [{ type: "slot", startLine: 14, endLine: 14 }] },
			] },
			{ type: "stack", startLine: 19, endLine: 21 },
		]);
		const outline = await buildFileOutline({ displayPath: "a.blade.php", content, hashes: hashesFor(content) });
		expect(outline.rows.map((row) => row.line)).toEqual([1, 3, 5, 7, 10, 11, 13, 14, 19]);
		for (const [line, directive, limit] of [[7, "@if($user)", 3], [10, "@foreach($items as $item)", 3], [13, "@component('alert')", 3], [19, "@push('scripts')", 3]] as const) {
			expect(outline.text).toContain(`h${String(line).padStart(4, "0")}│    ${directive}\n[limit ${limit}]`.replace("│    @push", "│@push"));
		}
	});
});
