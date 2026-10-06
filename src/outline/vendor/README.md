# Vendored tree-sitter parsers

These files are copied from [pi-codebase-reader](https://github.com/HanzCEO/pi-codebase-reader) 0.8.0, licensed under Apache-2.0 (see `LICENSE`), with these modifications:

- `parsers/manager.ts` loads every grammar from `../wasm/` instead of resolving WASM files from npm grammar packages.
- `parsers/manager.ts` no longer supports Smali: the published `tree-sitter-smali` package ships no WASM, so `parsers/smali.ts` is not vendored.
- `parsers/manager.ts` recurses into the bodies of exported classes, interfaces, and enums. Upstream looked for the body on the `export_statement` node, which dropped every member of an exported declaration.
- `parsers/manager.ts` extracts Markdown with the upstream regex parser instead of a tree-sitter grammar; the `markdown` entry in its grammar registry supplies only the display label, and no Markdown WASM is shipped.
- `parsers/manager.ts` extracts anonymous default exports (`export default function`/`class`), function expressions, top-level variable declarators, and nested `describe`/`test`/`it` calls, so entry-point, config, data, and test files outline instead of falling back to a preview.
- `parsers/manager.ts` adds PHP support: `parsers/php.ts` outlines classes, interfaces, traits, enums, methods, properties, constants, top-level functions, and assigned closures.
- `parsers/manager.ts` adds Blade support: `parsers/blade.ts` outlines `@section`/`@push`/`@once`/`@php` blocks, named directives such as `@extends` and `@include`, and `<x-…>`/`<livewire:…>` components.

The `wasm/` grammars come from the MIT-licensed `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `tree-sitter-rust`, `tree-sitter-solidity`, and `tree-sitter-java` packages, plus pi-codebase-reader's vendored Sass and SCSS grammars, the VS Code WebAssembly build of `tree-sitter-php`, and `tree-sitter-blade` built from v0.12.3; see `wasm/LICENSES.md` for the per-grammar copyright notices. Comments in these files are upstream prose and are exempt from this repository's no-comments rule.

## Rebuilding the Blade grammar

`tree-sitter-blade.wasm` is built from tag `v0.12.3` of [tree-sitter-blade](https://github.com/EmranMR/tree-sitter-blade) with `tree-sitter-cli` 0.25.6. Run `npx -y tree-sitter-cli@0.25.6 build --wasm` in the grammar checkout with `emcc` on `PATH`, or dispatch the `build-blade-wasm` workflow and copy its artifact into `wasm/`.
