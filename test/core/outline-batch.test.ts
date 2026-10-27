import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileOutline } from "../../src/outline";
import { setAutoReadAllIgnore } from "../../src/config";
import { readNormFile } from "../../src/file-reader";
import { DEFAULT_EDIT_FLAGS } from "../../src/edit-common";
import { regOutline } from "../../src/outline-tool";
import { getText, makeFakePiRegistry, setupIntegrationTest, toolError, withTempDir } from "../support/fixtures";

async function source(dir: string, name: string, text = "export const value = 1;\n") {
	await mkdir(join(dir, name, ".."), { recursive: true });
	await writeFile(join(dir, name), text);
}

function withRepo(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
	return withTempDir(prefix, async (dir) => {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		await run(dir);
	});
}

function codemodeTool() {
	const { pi, getTool } = makeFakePiRegistry();
	regOutline(pi, { ...DEFAULT_EDIT_FLAGS, codemode: true });
	return getTool("outline");
}

describe("batch outline", () => {
	it("recurses directories in sorted order, skipping unsupported and built-in excluded files", async () => {
		await withRepo("outline-batch-", async (dir) => {
			await source(dir, "src/z.ts");
			await source(dir, "src/deep/a.ts");
			await source(dir, "src/node_modules/ignored.ts");
			await source(dir, "src/readme.txt", "not source\n");
			const tool = codemodeTool();
			const result = await tool.execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			const structured = result.structuredContent;
			expect(structured.files.map((file: { path: string }) => file.path)).toEqual(["src/deep/a.ts", "src/z.ts"]);
			expect(getText(result)).toMatch(/^=== src\/deep\/a.ts[\s\S]*\n\n=== src\/z.ts/);
			expect(structured.files[0].lines[0].anchor).toMatch(/^[a-z]{5}$/);
		});
	});

	it("matches ** and ? globs relative to cwd and honors git and custom ignores", async () => {
		await withRepo("outline-glob-", async (dir) => {
			await source(dir, ".gitignore", "src/ignored/\n");
			await source(dir, "src/a1.ts");
			await source(dir, "src/deep/b1.ts");
			await source(dir, "src/ignored/c1.ts");
			await source(dir, "src/deep/skip.test.ts");
			await setAutoReadAllIgnore(["*.test.ts", "src/a1.ts"]);
			const tool = codemodeTool();
			const result = await tool.execute("o1", { path: "src/**/*?.ts", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(result.structuredContent.files.map((file: { path: string }) => file.path)).toEqual(["src/deep/b1.ts"]);
		});
	});

	it("gives every file a share of the row cap so one large file does not hide the rest", async () => {
		await withRepo("outline-share-", async (dir) => {
			await source(dir, "src/a.ts", Array.from({ length: 399 }, (_, i) => `export const item${i} = ${i};`).join("\n") + "\n");
			await source(dir, "src/b.ts", "export const first = 1;\nexport const second = 2;\n");
			await source(dir, "src/c.ts");
			const result = await codemodeTool().execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			const structured = result.structuredContent;
			expect(structured.files.map((file: { lines: unknown[] }) => file.lines.length)).toEqual([134, 2, 1]);
			expect(structured.files[0].truncated).toBe(true);
			expect(structured.truncated).toBe(true);
			expect(getText(result)).toContain("=== src/c.ts");
			expect(getText(result)).not.toContain("more files not outlined");
		});
	});

	it("shares the row cap and reports remaining files in a narrowing footer", async () => {
		await withRepo("outline-cap-", async (dir) => {
			const body = Array.from({ length: 30 }, (_, i) => `export const item${i} = ${i};`).join("\n") + "\n";
			for (let i = 0; i < 30; i++) await source(dir, `src/f${String(i).padStart(2, "0")}.ts`, body);
			const result = await codemodeTool().execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			const structured = result.structuredContent;
			expect(structured.files).toHaveLength(20);
			expect(structured.files.reduce((sum: number, file: { lines: unknown[] }) => sum + file.lines.length, 0)).toBe(400);
			expect(getText(result)).toContain("... (10 more files not outlined; narrow path, lower depth, or outline one file.)");
			expect(getText(result)).not.toContain("=== src/f20.ts");
		});
	});

	it("serves anchors for edits in multiple files", async () => {
		await withRepo("outline-edit-", async (dir) => {
			await source(dir, "src/a.ts");
			await source(dir, "src/b.ts", "export const other = 2;\n");
			const { ctx, getTool } = setupIntegrationTest(dir);
			const result = await getTool("outline").execute("o1", { path: "src" }, undefined, undefined, ctx);
			const anchor = getText(result).match(/=== src\/b.ts[^\n]*\n([a-z]{5})│export const other/)?.[1];
			expect(anchor).toBeDefined();
			await getTool("replace").execute("e1", { remove_from: anchor, remove_to: anchor, text: "export const other = 3;" }, undefined, undefined, ctx);
			expect(await readFile(join(dir, "src/b.ts"), "utf-8")).toBe("export const other = 3;\n");
		});
	});

	it("skips a binary source file with a notice instead of failing the whole call", async () => {
		await withRepo("outline-binary-", async (dir) => {
			await source(dir, "src/a.ts");
			await mkdir(join(dir, "src"), { recursive: true });
			await writeFile(join(dir, "src/bin.ts"), Buffer.from([0x41, 0x00, 0x42]));
			const result = await codemodeTool().execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(result.structuredContent.files.map((file: { path: string }) => file.path)).toEqual(["src/a.ts"]);
			expect(result.structuredContent.truncated).toBe(false);
			expect(getText(result)).toContain("[Skipped src/bin.ts: [E_NOT_TEXT]");
			expect(getText(result)).not.toContain("more files not outlined");
		});
	});

	it("skips a file that git lists but the working tree no longer has", async () => {
		await withRepo("outline-gone-", async (dir) => {
			await source(dir, "src/a.ts");
			await source(dir, "src/gone.ts");
			execFileSync("git", ["add", "."], { cwd: dir });
			await rm(join(dir, "src/gone.ts"));
			const result = await codemodeTool().execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(result.structuredContent.files.map((file: { path: string }) => file.path)).toEqual(["src/a.ts"]);
			expect(getText(result)).not.toContain("gone.ts");
		});
	});

	it("checks built-in exclusions against the cwd-relative path, whatever folder is named", async () => {
		await withRepo("outline-exclude-", async (dir) => {
			await source(dir, "src/vendor/lib.ts");
			await source(dir, "src/node_modules/pkg.ts");
			await source(dir, "resources/views/vendor/mail.blade.php", "@section('x')\n@endsection\n");
			const tool = codemodeTool();
			expect(await toolError(() => tool.execute("o1", { path: "src/vendor" }, undefined, undefined, { cwd: dir } as never))).toContain("[E_NOT_FOUND]");
			expect(await toolError(() => tool.execute("o2", { path: "src/node_modules/*.ts" }, undefined, undefined, { cwd: dir } as never))).toContain("[E_NOT_FOUND]");
			const views = await tool.execute("o3", { path: "resources/views", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(views.structuredContent.files.map((file: { path: string }) => file.path)).toEqual(["resources/views/vendor/mail.blade.php"]);
		});
	});

	it("respects git ignores even when every file in the named folder is ignored", async () => {
		await withRepo("outline-ignored-", async (dir) => {
			await source(dir, ".gitignore", "secrets/\n");
			await source(dir, "secrets/config.ts", "export const token = 'x';\n");
			expect(await toolError(() => codemodeTool().execute("o1", { path: "secrets" }, undefined, undefined, { cwd: dir } as never))).toContain("[E_NOT_FOUND]");
		});
	});

	it("treats brackets and braces as a glob unless the path exists, and rejects an invalid glob", async () => {
		await withRepo("outline-brackets-", async (dir) => {
			await source(dir, "src/a.ts");
			await source(dir, "src/b.tsx");
			await source(dir, "app/[id].ts", "export const page = 1;\n");
			const tool = codemodeTool();
			const braces = await tool.execute("o1", { path: "src/{a.ts,b.tsx}", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(braces.structuredContent.files.map((file: { path: string }) => file.path)).toEqual(["src/a.ts", "src/b.tsx"]);
			const literal = await tool.execute("o2", { path: "app/[id].ts", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(literal.structuredContent).toHaveProperty("lines");
			expect(await toolError(() => tool.execute("o3", { path: "src/[z-a].ts" }, undefined, undefined, { cwd: dir } as never))).toContain("[E_BAD_SHAPE] Invalid glob");
		});
	});

	it("keeps the rows that fit when one file reaches the byte budget, and bounds skip notices", async () => {
		await withRepo("outline-bytes-", async (dir) => {
			const wide = Array.from({ length: 400 }, (_, i) => `export const item${i} = ${i};`.padEnd(130, " ")).join("\n") + "\n";
			await source(dir, "src/a.ts", wide);
			const result = await codemodeTool().execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(result.structuredContent.files).toHaveLength(1);
			expect(result.structuredContent.files[0].lines.length).toBeGreaterThan(300);
			expect(Buffer.byteLength(getText(result), "utf-8")).toBeLessThanOrEqual(50 * 1024);
			for (let i = 0; i < 600; i++) await writeFile(join(dir, `src/bin${String(i).padStart(3, "0")}.ts`), Buffer.from([0x41, 0x00]));
			const skipped = await codemodeTool().execute("o2", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(Buffer.byteLength(getText(skipped), "utf-8")).toBeLessThanOrEqual(50 * 1024);
			expect(getText(skipped)).toMatch(/\[Skipped \d+ more unreadable files\.\]/);
			expect(skipped.structuredContent.complete).toBe(false);
		});
	});

	it("does not start with a blank line when every matched file is skipped", async () => {
		await withRepo("outline-allskip-", async (dir) => {
			await mkdir(join(dir, "src"), { recursive: true });
			await writeFile(join(dir, "src/bin.ts"), Buffer.from([0x41, 0x00, 0x42]));
			const result = await codemodeTool().execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(getText(result).startsWith("[Skipped src/bin.ts:")).toBe(true);
			expect(result.structuredContent.complete).toBe(false);
		});
	});

	it("keeps a file's UTF-8 rewrite note when the file fills the byte budget", async () => {
		await withRepo("outline-latin1-", async (dir) => {
			await mkdir(join(dir, "src"), { recursive: true });
			const wide = Array.from({ length: 400 }, (_, i) => `export const item${i} = ${i}; // caf\xe9`.padEnd(130, " ")).join("\n") + "\n";
			await writeFile(join(dir, "src/a.ts"), Buffer.from(wide, "latin1"));
			const result = await codemodeTool().execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(result.structuredContent.files[0].lines.length).toBeGreaterThan(300);
			expect(result.structuredContent.notices).toContain("[src/a.ts: Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]");
			expect(Buffer.byteLength(getText(result), "utf-8")).toBeLessThanOrEqual(50 * 1024);
		});
	});

	it("walks the folder outside a git work tree, with cwd-relative paths and exclusions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "outline-walk-"));
		try {
			await source(dir, "src/a.ts");
			await source(dir, "src/vendor/lib.ts");
			const result = await codemodeTool().execute("o1", { path: "src", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(result.structuredContent.files.map((file: { path: string }) => file.path)).toEqual(["src/a.ts"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns a no-match error instead of an empty outline", async () => {
		await withRepo("outline-empty-", async (dir) => {
			await source(dir, "src/notes.txt", "notes\n");
			const tool = codemodeTool();
			expect(await toolError(() => tool.execute("o1", { path: "src" }, undefined, undefined, { cwd: dir } as never))).toContain("[E_NOT_FOUND] No supported source files match: src");
		});
	});

	it("preserves the single-file text and structured shape", async () => {
		await withRepo("outline-single-", async (dir) => {
			await source(dir, "src/a.ts");
			const { normalized, fileHashes } = await readNormFile("src/a.ts", dir);
			const expected = await buildFileOutline({ displayPath: "src/a.ts", content: normalized, hashes: fileHashes, maxDepth: 2 });
			const result = await codemodeTool().execute("o1", { path: "src/a.ts", anchors: true }, undefined, undefined, { cwd: dir } as never);
			expect(getText(result)).toBe(expected.text);
			expect(result.structuredContent.text).toBe(expected.text);
			expect(result.structuredContent).toHaveProperty("lines");
			expect(result.structuredContent).not.toHaveProperty("files");
		});
	});
});
