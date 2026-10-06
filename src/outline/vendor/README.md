# Vendored tree-sitter parsers

These files are copied from [pi-codebase-reader](https://github.com/HanzCEO/pi-codebase-reader) 0.8.0, licensed under Apache-2.0 (see `LICENSE`), with these modifications:

- `parsers/manager.ts` loads every grammar from `../wasm/` instead of resolving WASM files from npm grammar packages.
- `parsers/manager.ts` no longer supports Smali: the published `tree-sitter-smali` package ships no WASM, so `parsers/smali.ts` is not vendored.
- `parsers/manager.ts` recurses into the bodies of exported classes, interfaces, and enums. Upstream looked for the body on the `export_statement` node, which dropped every member of an exported declaration.
- `parsers/manager.ts` extracts Markdown with the upstream regex parser instead of a tree-sitter grammar; the `markdown` entry in its grammar registry supplies only the display label, and no Markdown WASM is shipped.
- `parsers/manager.ts` extracts anonymous default exports (`export default function`/`class`), function expressions, top-level variable declarators, and nested `describe`/`test`/`it` calls, so entry-point, config, data, and test files outline instead of falling back to a preview.

The `wasm/` grammars come from the MIT-licensed `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `tree-sitter-rust`, `tree-sitter-solidity`, and `tree-sitter-java` packages, plus pi-codebase-reader's vendored Sass and SCSS grammars; see `wasm/LICENSES.md` for the per-grammar copyright notices. Comments in these files are upstream prose and are exempt from this repository's no-comments rule.
