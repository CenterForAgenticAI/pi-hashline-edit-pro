import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import { Compile } from "typebox/compile";
import register from "../../index";
import { withTempFile, withTempDir, setupIntegrationTest, getText, anchorFor, makePiStub, makeFakePiRegistry } from "../support/fixtures";
import { regRead } from "../../src/read";
import { DEFAULT_EDIT_FLAGS } from "../../src/edit-common";

type Structured = {
	ok: boolean;
	kind: string;
	path?: string;
	mimeType?: string;
	text?: string;
	lines?: Array<{ line: number; text: string; anchor: string; rendered: string }>;
	totalLines?: number;
	startLine?: number;
	nextOffset?: number | null;
	truncated?: boolean;
	blockedByLongLine?: boolean;
	hadUtf8DecodeErrors?: boolean;
	type?: string;
	data?: string;
	note?: string;
	notices?: string[];
	verb?: string;
	classification?: string;
	diff?: string;
	firstChangedLine?: number | null;
	anchors?: Array<{ line: number; text: string; anchor: string; rendered: string }>;
	anchorsOmitted?: boolean;
	matches?: number;
	files?: number;
	results?: Array<{ path: string; matchLines: number[]; lines: Array<{ line: number; text: string; anchor: string; rendered: string }>; hadUtf8DecodeErrors: boolean }>;
	error?: { code: string; message: string };
};

function structured(result: { structuredContent?: unknown }): Structured {
	return result.structuredContent as Structured;
}

describe("structuredContent for read and replace", () => {
	it("declares outputSchema on all eight tools", () => {
		const { getTool } = setupIntegrationTest("/tmp");
		for (const name of ["read", "replace", "replace_match", "insert", "copy", "move", "grep", "undo_last_change"]) {
			expect(getTool(name).outputSchema).toBeDefined();
		}
	});

	it("read returns anchored lines, pagination data, and flags", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { readTool, ctx } = setupIntegrationTest(cwd);
			const result = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.ok).toBe(true);
			expect(sc.kind).toBe("read");
			expect(sc.path).toBe("sample.ts");
			expect(sc.totalLines).toBe(3);
			expect(sc.startLine).toBe(1);
			expect(sc.nextOffset).toBeNull();
			expect(sc.truncated).toBe(false);
			expect(sc.blockedByLongLine).toBe(false);
			expect(sc.hadUtf8DecodeErrors).toBe(false);
			expect(sc.lines).toHaveLength(3);
			expect(sc.lines!.map((line) => line.text)).toEqual(["alpha", "beta", "gamma"]);
			expect(sc.lines!.map((line) => line.line)).toEqual([1, 2, 3]);
			for (const line of sc.lines!) {
				expect(line.anchor).toMatch(/^[A-Za-z]{4}$/);
				expect(line.rendered).toBe(`${line.anchor}│${line.text}`);
				expect(getText(result)).toContain(line.rendered);
			}
		});
	});

	it("read reports the paged window in structured form", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { readTool, ctx } = setupIntegrationTest(cwd);
			const result = await readTool.execute("r1", { path: "sample.ts", offset: 2, limit: 1 }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.startLine).toBe(2);
			expect(sc.nextOffset).toBe(3);
			expect(sc.lines).toHaveLength(1);
			expect(sc.lines![0]!.line).toBe(2);
			expect(sc.lines![0]!.text).toBe("beta");
		});
	});

	it("read returns raw file text and anchors separately", async () => {
		const jsonl = '{"index":0}\n{"index":1}\n{"index":2}\n';
		await withTempFile("odyssey.jsonl", jsonl, async ({ cwd }) => {
			const { readTool, ctx } = setupIntegrationTest(cwd);
			const result = await readTool.execute("r1", { path: "odyssey.jsonl", limit: 2 }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.text).toBe('{"index":0}\n{"index":1}');
			expect(sc.text).not.toContain("│");
			expect(sc.text).not.toContain("Showing lines");
			expect(sc.notices).toEqual([]);
			expect(sc.lines!.map((line) => line.text)).toEqual(['{"index":0}', '{"index":1}']);
			const rows = sc.text!.split("\n").map((line) => JSON.parse(line));
			expect(rows).toEqual([{ index: 0 }, { index: 1 }]);
			expect(getText(result)).toContain("Showing lines 1-2 of 3");
		});
	});

	it("read marks an oversized line while keeping its anchor editable", async () => {
		const long = "X".repeat(60_000);
		await withTempFile("min.js", `a\n${long}\nb\n`, async ({ cwd }) => {
			const { readTool, ctx } = setupIntegrationTest(cwd);
			const result = await readTool.execute("r1", { path: "min.js" }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.blockedByLongLine).toBe(true);
			const marker = sc.lines!.find((line) => line.line === 2)!;
			expect(marker.text).toContain("content not shown");
			expect(marker.text).not.toContain(long);
			expect(marker.anchor).toMatch(/^[A-Za-z]{4}$/);
			expect(getText(result)).toContain(marker.rendered);
		});
	});

	it("read returns a structured error for a missing file", async () => {
		await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
			const { readTool, ctx } = setupIntegrationTest(cwd);
			const result = await readTool.execute("r1", { path: "missing.ts" }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(result.isError).toBe(true);
			expect(sc.ok).toBe(false);
			expect(sc.kind).toBe("error");
			expect(sc.error!.code).toBe("E_NOT_FOUND");
			expect(sc.error!.message).toContain("[E_NOT_FOUND]");
		});
	});

	it("read returns image content with an image structured result", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		await withTempFile("pixel.png", "", async ({ cwd }) => {
			await writeFile(join(cwd, "pixel.png"), png);
			const { readTool, ctx } = setupIntegrationTest(cwd);
			const result = await readTool.execute("r1", { path: "pixel.png" }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.type).toBe("image");
			expect(sc.mimeType).toBe("image/png");
			expect(typeof sc.data).toBe("string");
			expect(sc.data).not.toBe("");
			expect(typeof sc.note).toBe("string");
			expect(result.content.length).toBeGreaterThan(0);
		});
	});

describe("read codemode contract", () => {
	it("resolves to the raw text by default and to the anchored object with anchors: true", async () => {
		const newline = String.fromCharCode(10);
		const jsonl = `{"index":0}${newline}{"index":1}${newline}`;
		const raw = `{"index":0}${newline}{"index":1}`;
		await withTempFile("codemode.jsonl", jsonl, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			regRead(pi, { ...DEFAULT_EDIT_FLAGS, codemode: true });
			expect(Object.keys(getTool("read").parameters.properties)).toContain("anchors");
			const readTool = getTool("read");
			const ctx = { cwd } as any;
			const plain = await readTool.execute("r1", { path: "codemode.jsonl" }, undefined, undefined, ctx);
			expect(plain.structuredContent).toBe(raw);
			const anchored = await readTool.execute("r2", { path: "codemode.jsonl", anchors: true }, undefined, undefined, ctx);
			const sc = structured(anchored);
			expect(sc.ok).toBe(true);
			expect(sc.text).toBe(raw);
			expect(sc.lines).toHaveLength(2);
		});
	});
});

	it("replace returns applied structured content with live anchors", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { readTool, editTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const beta = anchorFor(text, "beta");
			const result = await editTool.execute("e1", { remove_from: beta, remove_to: beta, text: ["BETA"] }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.ok).toBe(true);
			expect(sc.kind).toBe("edit");
			expect(sc.verb).toBe("replaced");
			expect(sc.classification).toBe("applied");
			expect(sc.firstChangedLine).toBe(2);
			expect(sc.anchorsOmitted).toBe(false);
			expect(sc.diff).toContain("│BETA");
			const live = sc.anchors!.find((line) => line.text === "BETA")!;
			expect(live.line).toBe(2);
			expect(live.anchor).not.toBe(beta);
			expect(live.rendered).toBe(`${live.anchor}│BETA`);
			expect(sc.anchors!.some((line) => line.text === "alpha")).toBe(true);
		});
	});

	it("replace returns noop structured content without anchors", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { readTool, editTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const beta = anchorFor(text, "beta");
			const result = await editTool.execute("e1", { remove_from: beta, remove_to: beta, text: ["beta"] }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.ok).toBe(true);
			expect(sc.classification).toBe("noop");
			expect(sc.diff).toBe("");
			expect(sc.anchors).toEqual([]);
			expect(sc.anchorsOmitted).toBe(false);
			expect(sc.firstChangedLine).toBeNull();
		});
	});

	it("replace returns a structured stale-anchor error", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
			const { editTool, ctx } = setupIntegrationTest(cwd);
			const result = await editTool.execute("e1", { remove_from: "ZZZZ", remove_to: "ZZZZ", text: ["x"] }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(result.isError).toBe(true);
			expect(sc.ok).toBe(false);
			expect(sc.error!.code).toBe("E_STALE_ANCHOR");
		});
	});

	it("replace returns a structured range-stale error with the current rows", async () => {
		await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
			const { readTool, editTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const a = anchorFor(text, "a");
			const d = anchorFor(text, "d");
			await writeFile(path, "a\nB\nc\nd\n", "utf-8");
			const result = await editTool.execute("e1", { remove_from: a, remove_to: d, text: ["a", "x", "d"] }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(result.isError).toBe(true);
			expect(sc.error!.code).toBe("E_RANGE_STALE");
			expect(sc.error!.message).toContain("Current range with fresh anchors");
			expect(sc.error!.message).toContain("│B");
		});
	});

	it("insert returns applied structured content", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
			const { readTool, getTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const alpha = anchorFor(text, "alpha");
			const result = await getTool("insert").execute("i1", { anchor: alpha, direction: "after", text: ["mid"] }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.ok).toBe(true);
			expect(sc.kind).toBe("edit");
			expect(sc.verb).toBe("inserted");
			expect(sc.classification).toBe("applied");
			expect(sc.anchors!.some((line) => line.text === "mid")).toBe(true);
		});
	});

	it("replace_match returns applied structured content and a structured not-found error", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
			const { readTool, getTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const beta = anchorFor(text, "beta");
			const missing = await getTool("replace_match").execute("m1", { replace_from: beta, replace_to: beta, old_string: "missing", new_string: "x" }, undefined, undefined, ctx);
			const missingSc = structured(missing);
			expect(missing.isError).toBe(true);
			expect(missingSc.error!.code).toBe("E_SUBSTRING_NOT_FOUND");
			expect(missingSc.error!.message).toContain("Current rows");
			const applied = await getTool("replace_match").execute("m2", { replace_from: beta, replace_to: beta, old_string: "beta", new_string: "BETA" }, undefined, undefined, ctx);
			const appliedSc = structured(applied);
			expect(appliedSc.verb).toBe("replaced");
			expect(appliedSc.classification).toBe("applied");
		});
	});

	it("copy returns structured content", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { readTool, getTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const beta = anchorFor(text, "beta");
			const gamma = anchorFor(text, "gamma");
			const copied = await getTool("copy").execute("c1", { source_from: beta, source_to: beta, direction: "after", anchor: gamma }, undefined, undefined, ctx);
			const sc = structured(copied);
			expect(sc.ok).toBe(true);
			expect(sc.verb).toBe("copied");
			expect(sc.anchors!.some((line) => line.text === "beta")).toBe(true);
		});
	});

	it("move returns structured content", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { readTool, getTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const beta = anchorFor(text, "beta");
			const gamma = anchorFor(text, "gamma");
			const moved = await getTool("move").execute("v1", { source_from: beta, source_to: beta, direction: "after", anchor: gamma }, undefined, undefined, ctx);
			const sc = structured(moved);
			expect(sc.ok).toBe(true);
			expect(sc.verb).toBe("moved");
			expect(sc.anchors!.some((line) => line.text === "beta")).toBe(true);
		});
	});

	it("cross-file move returns structured content with destination anchors", async () => {
		await withTempDir("structured-cross-", async (dir) => {
			await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
			await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
			const { readTool, getTool, ctx } = setupIntegrationTest(dir);
			const aText = getText(await readTool.execute("ra", { path: "a.ts" }, undefined, undefined, ctx));
			const bText = getText(await readTool.execute("rb", { path: "b.ts" }, undefined, undefined, ctx));
			const beta = anchorFor(aText, "beta");
			const one = anchorFor(bText, "one");
			const result = await getTool("move").execute("m1", { source_from: beta, source_to: beta, direction: "after", anchor: one }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.ok).toBe(true);
			expect(sc.verb).toBe("moved");
			expect(sc.path).toBe("b.ts");
			expect(sc.anchors!.some((line) => line.text === "beta")).toBe(true);
		});
	});

	it("grep returns structured results and a structured error", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
			const { getTool, ctx } = setupIntegrationTest(cwd);
			const result = await getTool("grep").execute("g1", { pattern: "alpha", path: "sample.ts", context: 1 }, undefined, undefined, ctx);
			const sc = structured(result);
			expect(sc.ok).toBe(true);
			expect(sc.kind).toBe("grep");
			expect(sc.matches).toBe(1);
			expect(sc.files).toBe(1);
			expect(sc.truncated).toBe(false);
			expect(sc.results).toHaveLength(1);
			const file = sc.results![0]!;
			expect(file.path).toBe("sample.ts");
			expect(file.matchLines).toEqual([1]);
			expect(file.hadUtf8DecodeErrors).toBe(false);
			expect(file.lines.map((line) => line.text)).toEqual(["alpha", "beta"]);
			for (const line of file.lines) {
				expect(line.rendered).toBe(`${line.anchor}│${line.text}`);
			}
			const unsupported = await getTool("grep").execute("g2", { pattern: "(\\w)\\1", path: "sample.ts" }, undefined, undefined, ctx);
			expect(structured(unsupported).error!.code).toBe("E_GREP_FAILED");
		});
	});

	it("undo returns structured content and a structured no-history error", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
			const { readTool, editTool, getTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const beta = anchorFor(text, "beta");
			await editTool.execute("e1", { remove_from: beta, remove_to: beta, text: ["BETA"] }, undefined, undefined, ctx);
			const undone = await getTool("undo_last_change").execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
			const sc = structured(undone);
			expect(sc.ok).toBe(true);
			expect(sc.kind).toBe("edit");
			expect(sc.verb).toBe("undone");
			expect(sc.anchors!.some((line) => line.text === "beta")).toBe(true);
			const again = await getTool("undo_last_change").execute("u2", { path: "sample.ts" }, undefined, undefined, ctx);
			expect(again.isError).toBe(true);
			expect(structured(again).ok).toBe(false);
			expect(structured(again).error!.message).toContain("No undo history");
			expect(structured(again).error!.code).toBe("E_UNDO_NONE");
		});
	});

	it("undo returns a structured E_UNDO_STALE error after an external change", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
			const { readTool, editTool, getTool, ctx } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const beta = anchorFor(text, "beta");
			await editTool.execute("e1", { remove_from: beta, remove_to: beta, text: ["BETA"] }, undefined, undefined, ctx);
			await writeFile(path, "alpha\nBETA!\n", "utf-8");
			const result = await getTool("undo_last_change").execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
			expect(result.isError).toBe(true);
			expect(structured(result).error!.code).toBe("E_UNDO_STALE");
		});
	});

	it("every tool result matches its declared outputSchema", async () => {
		await withTempDir("structured-schema-", async (dir) => {
			await writeFile(join(dir, "sample.ts"), "alpha\nbeta\ngamma\n", "utf-8");
			await writeFile(join(dir, "pixel.png"), Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			));
			const { readTool, getTool, ctx } = setupIntegrationTest(dir);
			const text = getText(await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx));
			const alpha = anchorFor(text, "alpha");
			const beta = anchorFor(text, "beta");
			const gamma = anchorFor(text, "gamma");
			const cases: Array<[string, unknown, string]> = [
				["read", { path: "sample.ts" }, "s-read"],
				["read", { path: "pixel.png" }, "s-image"],
				["read", { path: "missing.ts" }, "s-read-error"],
				["insert", { anchor: alpha, direction: "after", text: "mid" }, "s-insert"],
				["copy", { source_from: beta, source_to: beta, anchor: gamma, direction: "after" }, "s-copy"],
				["move", { source_from: beta, source_to: beta, anchor: gamma, direction: "after" }, "s-move"],
				["replace", { remove_from: alpha, remove_to: alpha, text: "ALPHA" }, "s-replace"],
				["replace", { remove_from: "ZZZZ", remove_to: "ZZZZ", text: "x" }, "s-replace-error"],
				["grep", { pattern: "ALPHA", path: "sample.ts" }, "s-grep"],
				["grep", { pattern: "(\\w)\\1", path: "sample.ts" }, "s-grep-error"],
				["undo_last_change", { path: "sample.ts" }, "s-undo"],
			];
			for (const [name, args, id] of cases) {
				const tool = getTool(name);
				const result = await tool.execute(id, args, undefined, undefined, ctx);
				const validator = Compile(tool.outputSchema!);
				const errors = validator.Errors(result.structuredContent);
				expect(validator.Check(result.structuredContent), `${name} (${id}): ${JSON.stringify(errors)}`).toBe(true);
			}
		});
	});

	it("tool_result handler keeps structuredContent when it rewrites content", async () => {
		const { pi, handlers } = makePiStub();
		register(pi);
		const handler = handlers.get("tool_result")!;
		const diff = " alpha\n-   │beta\n+BET│BETA";
		const result = await handler(
			{
				toolName: "replace",
				isError: false,
				input: { remove_from: "abc", remove_to: "abc", text: ["BETA"] },
				content: [{ type: "text", text: "Successfully replaced in sample.ts." }],
				details: { diff, metrics: { classification: "applied" } },
				structuredContent: { ok: true, kind: "edit", text: "Successfully replaced in sample.ts." },
			},
			{ cwd: "/tmp" },
		);
		const returned = result as { content: Array<{ text: string }>; structuredContent?: Structured };
		expect(returned.content[0]!.text).toBe(diff);
		expect(returned.structuredContent!.kind).toBe("edit");
		expect(returned.structuredContent!.text).toBe(diff);
	});
});
