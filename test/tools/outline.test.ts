import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupIntegrationTest, makeFakePiRegistry, withTempFile, withTempDir, getText, toolError } from "../support/fixtures";
import { ANCHOR_POOL_EXHAUSTED_PREFIX, MAX_BYTES } from "../../src/constants";
import { DEFAULT_EDIT_FLAGS } from "../../src/edit-common";
import { regRead } from "../../src/read";
import { isSkippableOutlineReadError, outlineDepth, regOutline } from "../../src/outline-tool";
import register from "../../index";

const TS_SOURCE = [
	"export const value = 1;",
	"",
	"export class App {",
	"  run(speed: number) {",
	"    return speed;",
	"  }",
	"",
	"}",
	"",
	"export function helper() {",
	"  return value;",
	"}",
	"",
].join("\n");

function firstAnchor(text: string): string {
	return text.match(/^([a-z]{5})│/m)![1]!;
}

describe("outline tool", () => {
	it("outlines a file as real first lines with span hints", async () => {
		await withTempFile("app.ts", TS_SOURCE, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const result = await getTool("outline").execute("o1", { path: "app.ts" }, undefined, undefined, ctx);
			const text = getText(result);
			expect(text).toContain("=== app.ts (TypeScript) — 12 lines ===");
			expect(text).toContain("export class App {");
			expect(text).toContain("  run(speed: number) {");
			expect(text).toContain("export function helper() {");
			expect(text).not.toContain("return speed;");
			expect(text).toMatch(/\[limit \d+\]/);
		});
	});

	it("edits a row's anchor without a read", async () => {
		await withTempFile("app.ts", TS_SOURCE, async ({ cwd, path }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const text = getText(await getTool("outline").execute("o1", { path: "app.ts" }, undefined, undefined, ctx));
			const anchor = text.split("\n").find((line) => line.includes("│export class App {"))!.match(/^([a-z]{5})/)![1]!;
			const edit = await getTool("replace").execute(
				"e1",
				{ remove_from: anchor, remove_to: anchor, text: "export class App extends Base {" },
				undefined,
				undefined,
				ctx,
			);
			expect(edit.content[0]?.text).toContain("Successfully replaced");
			expect(await readFile(path, "utf-8")).toContain("export class App extends Base {");
		});
	});

	it("limits children with depth and marks what it hid", async () => {
		await withTempFile("app.ts", TS_SOURCE, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const text = getText(await getTool("outline").execute("o1", { path: "app.ts", depth: 0 }, undefined, undefined, ctx));
			expect(text).toContain("export class App {");
			expect(text).not.toContain("run(speed");
			expect(text).toContain("[1 nested]");
		});
	});

	it("falls back to a head and tail preview for files without symbols", async () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
		await withTempFile("notes.txt", `${lines.join("\n")}\n`, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const text = getText(await getTool("outline").execute("o1", { path: "notes.txt" }, undefined, undefined, ctx));
			expect(text).toContain("=== notes.txt — 40 lines ===");
			expect(text).toContain("line 1");
			expect(text).toContain("line 40");
			expect(text).not.toContain("line 21");
			expect(text).toContain("more lines");
			expect(text).toContain("[No outline parser for this file type; showing the first and last lines instead of an outline.]");
		});
	});

	it("says when the parser could not read part of a file, and not for an empty file", async () => {
		await withTempDir("outline-notes-", async (dir) => {
			await writeFile(join(dir, "broken.ts"), "export function a() {}\nfunction b( {\n}\nexport const d = 1;\n");
			await writeFile(join(dir, "empty.ts"), "");
			const { ctx, getTool } = setupIntegrationTest(dir);
			const broken = getText(await getTool("outline").execute("o1", { path: "broken.ts" }, undefined, undefined, ctx));
			expect(broken).toContain("export function a() {}");
			expect(broken).toContain("[The parser could not read part of this file; symbols in that part may be missing.]");
			const empty = getText(await getTool("outline").execute("o2", { path: "empty.ts" }, undefined, undefined, ctx));
			expect(empty).toContain("File is empty.");
			expect(empty).not.toContain("No symbols found");
		});
	});

	it("says when a supported file has no symbols", async () => {
		await withTempFile("only.ts", "// nothing to outline\n", async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const text = getText(await getTool("outline").execute("o1", { path: "only.ts" }, undefined, undefined, ctx));
			expect(text).toContain("[No symbols found; showing the first and last lines instead of an outline.]");
		});
	});

	it("serves the empty-line anchor so a follow-up edit can seed content", async () => {
		await withTempFile("empty.txt", "", async ({ cwd, path }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const text = getText(await getTool("outline").execute("o1", { path: "empty.txt" }, undefined, undefined, ctx));
			expect(text).toContain("=== empty.txt — 0 lines ===");
			expect(text).toContain("File is empty. Use replace to insert content.");
			await getTool("replace").execute("e1", { remove_from: firstAnchor(text), remove_to: firstAnchor(text), text: "hello" }, undefined, undefined, ctx);
			expect(await readFile(path, "utf-8")).toBe("hello");
		});
	});

	it("does not serve a row whose line is too long to show whole", async () => {
		const long = "const value = '" + "a".repeat(260) + "';";
		await withTempFile("long.ts", `${long}\n`, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const result = await getTool("outline").execute("o1", { path: "long.ts" }, undefined, undefined, ctx);
			const text = getText(result);
			const structured = (result as { structuredContent?: { lines: unknown[] } }).structuredContent;
			expect(structured?.lines).toEqual([]);
			const row = text.split("\n").find((line) => line.includes("const value ="))!;
			expect(row.endsWith("...")).toBe(true);
			const anchor = row.match(/^([a-z]{5})/)![1]!;
			const stale = await toolError(() => getTool("replace").execute("e1", { remove_from: anchor, remove_to: anchor, text: "const value = 1;" }, undefined, undefined, ctx));
			expect(stale).toMatch(/E_RANGE_STALE/);
			expect(stale).toContain("Line 1 is clipped above and not editable from here; call read()");
			expect(stale).not.toContain("Retry with the fresh anchors above without a read.");
			const retryAnchor = stale.match(/^([a-z]{5})│/m)![1]!;
			expect(await toolError(() => getTool("replace").execute("e2", { remove_from: retryAnchor, remove_to: retryAnchor, text: "const value = 1;" }, undefined, undefined, ctx)))
				.toMatch(/E_RANGE_STALE/);
			expect(await readFile(join(cwd, "long.ts"), "utf8")).toBe(`${long}\n`);
		});
	});

	it("serves the unclipped symbols of an outline and skips a clipped one", async () => {
		const long = `export const value = '${"a".repeat(260)}';`;
		await withTempFile("mixed.ts", `${long}\nexport function helper() {\n  return 1;\n}\n`, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const result = await getTool("outline").execute("o1", { path: "mixed.ts" }, undefined, undefined, ctx) as {
				content: Array<{ text?: string }>;
				structuredContent?: { lines: Array<{ text: string }> };
				details?: { metrics?: { rows: number; truncated: boolean } };
			};
			const text = getText(result);
			expect(text).toContain("│export function helper() {");
			expect(text.split("\n").find((line) => line.includes("export const value"))!.endsWith("...")).toBe(true);
			expect(result.structuredContent?.lines.map((line) => line.text)).toEqual(["export function helper() {"]);
			expect(result.details?.metrics?.rows).toBe(2);
			expect(result.details?.metrics?.truncated).toBe(false);
		});
	});

	it("caps the outline at 400 rows and names the remaining symbols", async () => {
		const source = Array.from({ length: 450 }, (_, index) => `export function f${index}() { return ${index}; }`).join("\n") + "\n";
		await withTempFile("many.ts", source, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const result = await getTool("outline").execute("o1", { path: "many.ts" }, undefined, undefined, ctx) as {
				content: Array<{ text?: string }>;
				structuredContent?: { truncated: boolean; complete: boolean; lines: unknown[] };
				details?: { truncated?: boolean; metrics?: { rows: number; truncated: boolean } };
			};
			const text = getText(result);
			expect(text).toContain("... (50 more symbols); read from the last shown anchor to continue.");
			expect(result.details?.truncated).toBe(true);
			expect(result.details?.metrics).toEqual({ rows: 400, truncated: true });
			expect(result.structuredContent?.truncated).toBe(true);
			expect(result.structuredContent?.complete).toBe(false);
			expect(result.structuredContent?.lines).toHaveLength(400);
		});
	});

	it("returns editable anchors and notices as structured content", async () => {
		await withTempFile("app.ts", TS_SOURCE, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const result = await getTool("outline").execute("o1", { path: "app.ts" }, undefined, undefined, ctx) as {
				structuredContent?: { kind: string; totalLines: number; depth: number; truncated: boolean; complete: boolean; lines: Array<{ line: number; text: string; anchor: string; rendered: string }> };
				details?: { complete?: boolean; metrics?: { rows: number; truncated: boolean } };
			};
			const structured = result.structuredContent!;
			expect(structured.kind).toBe("outline");
			expect(structured.totalLines).toBe(12);
			expect(structured.depth).toBe(2);
			expect(structured.truncated).toBe(false);
			expect(structured.complete).toBe(true);
			expect(result.details?.complete).toBe(true);
			const classRow = structured.lines.find((line) => line.text === "export class App {")!;
			expect(classRow.line).toBe(3);
			expect(classRow.rendered).toBe(`${classRow.anchor}│export class App {`);
			expect(result.details?.metrics?.rows).toBeGreaterThan(0);
		});
	});

	it("reports complete only when the whole file was shown", async () => {
		const long = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
		await withTempFile("notes-long.txt", long, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const result = await getTool("outline").execute("o1", { path: "notes-long.txt" }, undefined, undefined, ctx) as {
				structuredContent?: { complete?: boolean };
				details?: { complete?: boolean };
			};
			expect(result.structuredContent?.complete).toBe(false);
			expect(result.details?.complete).toBe(false);
		});
		await withTempFile("notes-short.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const result = await getTool("outline").execute("o1", { path: "notes-short.txt" }, undefined, undefined, ctx) as {
				structuredContent?: { complete?: boolean };
				details?: { complete?: boolean };
			};
			expect(result.structuredContent?.complete).toBe(true);
			expect(result.details?.complete).toBe(true);
		});
	});

	it("reads a symbol span from its outline anchor", async () => {
		await withTempFile("app.ts", TS_SOURCE, async ({ cwd }) => {
			const { ctx, getTool } = setupIntegrationTest(cwd);
			const outline = getText(await getTool("outline").execute("o1", { path: "app.ts" }, undefined, undefined, ctx));
			const rows = outline.split("\n");
			const rowIndex = rows.findIndex((row) => row.includes("│export class App {"));
			const anchor = rows[rowIndex]!.match(/^([a-z]{5})/)![1]!;
			const span = Number(/\[limit (\d+)\]/.exec(rows[rowIndex + 1] ?? "")![1]);
			const read = getText(await getTool("read").execute("r1", { path: "app.ts", offset: anchor, limit: span }, undefined, undefined, ctx));
			expect(read).toContain("export class App {");
			expect(read).toContain("run(speed: number) {");
			expect(read).not.toContain("export const value = 1;");
		});
	});

	it("rejects bad requests, non-text inputs, and oversized files", async () => {
		await withTempDir("outline-errors-", async (dir) => {
			const { ctx, getTool } = setupIntegrationTest(dir);
			const outlineTool = getTool("outline");
			expect(await toolError(() => outlineTool.execute("o1", { path: "" }, undefined, undefined, ctx))).toContain("[E_BAD_SHAPE]");
			expect(await toolError(() => outlineTool.execute("o1", { path: "a.ts", depth: -1 }, undefined, undefined, ctx))).toContain("[E_BAD_SHAPE]");
			expect(await toolError(() => outlineTool.execute("o1", { path: "a.ts", extra: true }, undefined, undefined, ctx))).toContain("unknown or unsupported fields");
			expect(await toolError(() => outlineTool.execute("o1", { path: "a.ts", anchors: "yes" }, undefined, undefined, ctx))).toContain('"anchors" must be a boolean');
			expect(await toolError(() => outlineTool.execute("o1", { path: "a.ts", anchors: true }, undefined, undefined, ctx))).toContain("only valid in a codemode session");
			await mkdir(join(dir, "sub"), { recursive: true });
			expect(await toolError(() => outlineTool.execute("o1", { path: "sub" }, undefined, undefined, ctx))).toContain("[E_NOT_FOUND] No supported source files match: sub");
			await writeFile(join(dir, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
			expect(await toolError(() => outlineTool.execute("o1", { path: "binary.bin" }, undefined, undefined, ctx))).toContain("[E_NOT_TEXT]");
			const huge = join(dir, "huge.txt");
			await writeFile(huge, "");
			await truncate(huge, MAX_BYTES + 1);
			expect(await toolError(() => outlineTool.execute("o1", { path: "huge.txt" }, undefined, undefined, ctx))).toContain("[E_FILE_TOO_LARGE]");
			expect(await toolError(() => outlineTool.execute("o1", { path: "missing.ts" }, undefined, undefined, ctx))).toContain("[E_NOT_FOUND]");
		});
	});
});

describe("read discovery hint", () => {
	it("points at outline only when the outline tool is enabled", async () => {
		const large = Array.from({ length: 2100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
		await withTempFile("large.txt", large, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			regRead(pi, { ...DEFAULT_EDIT_FLAGS, outlineEnabled: true });
			const ctx = { cwd, ui: { notify() {} } } as never;
			const enabled = getText(await getTool("read").execute("r1", { path: "large.txt" }, undefined, undefined, ctx));
			expect(enabled).toContain("call `outline` on this file");
			regRead(pi, DEFAULT_EDIT_FLAGS);
			const disabled = getText(await getTool("read").execute("r2", { path: "large.txt" }, undefined, undefined, ctx));
			expect(disabled).not.toContain("call `outline` on this file");
		});
	});
});

describe("outline rendering", () => {
	const theme = {
		fg: (color: string, text: string) => `[${color}]${text}`,
		bold: (text: string) => `**${text}**`,
	};

	it("renders the call, the pending state, and the expanded outline", async () => {
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const tool = getTool("outline");
		const call = tool.renderCall({ path: "app.ts" }, theme, { lastComponent: undefined });
		expect((call as { text: string }).text).toContain("app.ts");
		const pending = tool.renderResult({ content: [] }, { isPartial: true }, theme, {});
		expect((pending as { text: string }).text).toContain("Outlining...");
		const failed = tool.renderResult({ content: [{ type: "text", text: "boom" }] }, { isPartial: false }, theme, { isError: true });
		expect((failed as { text: string }).text).toContain("boom");
		const collapsed = tool.renderResult({ content: [{ type: "text", text: "outline text" }] }, { isPartial: false }, theme, { expanded: false });
		expect((collapsed as { text: string }).text).toBe("");
		const expanded = tool.renderResult({ content: [{ type: "text", text: "outline text" }] }, { isPartial: false, expanded: true }, theme, { expanded: false });
		expect((expanded as { text: string }).text).toBe("outline text");
	});

	it("returns the outline text to a codemode script unless anchors are requested", async () => {
		await withTempFile("app.ts", TS_SOURCE, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			regOutline(pi, { ...DEFAULT_EDIT_FLAGS, codemode: true });
			expect((getTool("outline").promptGuidelines as string[]).some((guideline) => guideline.includes("anchors: true"))).toBe(true);
			const ctx = { cwd, ui: { notify() {} } } as never;
			const plain = await getTool("outline").execute("o1", { path: "app.ts" }, undefined, undefined, ctx) as { structuredContent?: unknown };
			expect(typeof plain.structuredContent).toBe("string");
			expect(plain.structuredContent).toContain("export class App {");
			const anchored = await getTool("outline").execute("o2", { path: "app.ts", anchors: true }, undefined, undefined, ctx) as { structuredContent?: { kind?: string } };
			expect(anchored.structuredContent?.kind).toBe("outline");
		});
	});

	it("reports non-UTF-8 bytes in the outline output", async () => {
		await withTempDir("outline-utf8-", async (dir) => {
			await writeFile(join(dir, "legacy.ts"), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x78, 0x20, 0x3d, 0x20, 0x31, 0x3b, 0x0a, 0x80]));
			const { ctx, getTool } = setupIntegrationTest(dir);
			const result = await getTool("outline").execute("o1", { path: "legacy.ts" }, undefined, undefined, ctx);
			const text = getText(result);
			const structured = (result as { structuredContent?: { notices?: string[] } }).structuredContent;
			expect(text).toContain("const x = 1;");
			expect(text).toContain("Non-UTF-8 bytes");
			expect(structured?.notices?.some((notice) => notice.includes("Non-UTF-8"))).toBe(true);
		});
	});
});

describe("outlineDepth", () => {
	it("defaults to two and rejects negative or fractional values", () => {
		expect(outlineDepth(undefined)).toBe(2);
		expect(outlineDepth(0)).toBe(0);
		expect(outlineDepth(5)).toBe(5);
		expect(() => outlineDepth(-1)).toThrow("[E_BAD_SHAPE]");
		expect(() => outlineDepth(1.5)).toThrow("[E_BAD_SHAPE]");
		expect(() => outlineDepth("2")).toThrow("[E_BAD_SHAPE]");
		expect(outlineDepth(10)).toBe(10);
		expect(() => outlineDepth(11)).toThrow("[E_BAD_SHAPE]");
	});
});

describe("outline directory read errors", () => {
	it("skips only file-level failures and rethrows infrastructure errors", () => {
		expect(isSkippableOutlineReadError(new Error("[E_NOT_TEXT] Path is a binary file: a.ts"))).toBe(true);
		expect(isSkippableOutlineReadError(new Error("[E_FILE_TOO_LARGE] a.ts has 2000000 lines"))).toBe(true);
		expect(isSkippableOutlineReadError(new Error("[E_NOT_FOUND] File not found: a.ts"))).toBe(true);
		expect(isSkippableOutlineReadError(new Error("[E_ACCESS] File is not readable: a.ts"))).toBe(true);
		expect(isSkippableOutlineReadError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
		expect(isSkippableOutlineReadError(new Error("[E_STORE_UNAVAILABLE] no sqlite runtime"))).toBe(false);
		expect(isSkippableOutlineReadError(new Error("[E_REGISTRY] the session registry was released"))).toBe(false);
		expect(isSkippableOutlineReadError(new Error(`${ANCHOR_POOL_EXHAUSTED_PREFIX}; use write for very large files.`))).toBe(false);
		expect(isSkippableOutlineReadError(new Error("unexpected parser failure"))).toBe(false);
	});
});
