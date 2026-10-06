# Vendored tree-sitter parsers

These files are copied from [pi-codebase-reader](https://github.com/HanzCEO/pi-codebase-reader) 0.8.0, licensed under Apache-2.0 (see `LICENSE`), with these modifications:

- `parsers/manager.ts` loads every grammar from `../wasm/` instead of resolving WASM files from npm grammar packages.
- `parsers/manager.ts` no longer supports Smali: the published `tree-sitter-smali` package ships no WASM, so `parsers/smali.ts` is not vendored.
- `parsers/manager.ts` recurses into the bodies of exported classes, interfaces, and enums. Upstream looked for the body on the `export_statement` node, which dropped every member of an exported declaration.

The `wasm/` grammars come from the MIT-licensed `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `tree-sitter-rust`, `tree-sitter-solidity`, and `tree-sitter-java` packages, plus pi-codebase-reader's vendored Sass and SCSS grammars.
