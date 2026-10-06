import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractHash, getText, setupIntegrationTest, toolError, withTempFile } from "../support/fixtures";

const TS_CONTENT = "export class App {\n  run(): number {\n    return 1;\n  }\n}\n";

describe("read tool - outline mode", () => {
	it("returns an anchored structural outline", async () => {
		await withTempFile("app.ts", TS_CONTENT, async ({ cwd }) => {
			const { ctx, readTool } = setupIntegrationTest(cwd);
			const result = getText(await readTool.execute("r1", { path: "app.ts", outline: true }, undefined, undefined, ctx));
			expect(result).toContain("=== app.ts (TypeScript) — 5 lines ===");
			expect(result).toMatch(/[A-Za-z]{4}│class App \(1 children\)/);
			expect(result).toMatch(/[A-Za-z]{4}│ {2}method run/);
			expect(result).not.toContain("return 1");
		});
	});

	it("serves the outline anchors for immediate reads and edits", async () => {
		await withTempFile("app.ts", TS_CONTENT, async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const outline = getText(await readTool.execute("r1", { path: "app.ts", outline: true }, undefined, undefined, ctx));
			const methodRow = outline.split("\n").find((line) => line.includes("method run"))!;
			const anchor = extractHash(methodRow);
			const window = getText(await readTool.execute("r2", { path: "app.ts", anchor, before: 0, after: 2 }, undefined, undefined, ctx));
			expect(window).toContain("run(): number {");
			const edit = await editTool.execute("e1", { remove_from: anchor, remove_to: anchor, text: "  run(): string {" }, undefined, undefined, ctx);
			expect(getText(edit)).toContain("Successfully replaced");
			expect(await readFile(path, "utf-8")).toContain("run(): string {");
		});
	});

	it("falls back to a preview for unsupported files", async () => {
		await withTempFile("notes.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { ctx, readTool } = setupIntegrationTest(cwd);
			const result = getText(await readTool.execute("r1", { path: "notes.txt", outline: true }, undefined, undefined, ctx));
			expect(result).toContain("=== notes.txt — 2 lines ===");
			expect(result).toContain("alpha");
		});
	});

	it("rejects outline combined with other addressing", async () => {
		await withTempFile("app.ts", TS_CONTENT, async ({ cwd }) => {
			const { ctx, readTool } = setupIntegrationTest(cwd);
			expect(await toolError(() => readTool.execute("r1", { path: "app.ts", outline: true, offset: 1 }, undefined, undefined, ctx))).toContain("[E_BAD_SHAPE]");
		});
	});

	it("keeps the empty-file behavior in outline mode", async () => {
		await withTempFile("empty.ts", "", async ({ cwd }) => {
			const { ctx, readTool } = setupIntegrationTest(cwd);
			const result = getText(await readTool.execute("r1", { path: "empty.ts", outline: true }, undefined, undefined, ctx));
			expect(result).toContain("File is empty. Use replace to insert content.");
		});
	});
});
