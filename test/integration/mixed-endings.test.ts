import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import {
	anchorFor,
	assistantMessage,
	getText,
	setupIntegrationTest,
	toolCall,
	withTempFile,
} from "../support/fixtures";

describe("mixed line endings", () => {
	it("preserves CRLF inside an LF file through replace", async () => {
		await withTempFile("sample.txt", "// Keep this comment unchanged.\nold\r\nline\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
			const oldAnchor = anchorFor(text, "old");
			const result = await editTool.execute(
				"e1",
				{ remove_from: oldAnchor, remove_to: oldAnchor, replacement_lines: ["new"] },
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Successfully replaced");
			expect(await readFile(path, "utf-8")).toBe("// Keep this comment unchanged.\nnew\r\nline\n");
		});
	});

	it("preserves CRLF inside an LF file through insert", async () => {
		await withTempFile("sample.txt", "one\r\ntwo\nthree\r\n", async ({ cwd, path }) => {
			const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
			const two = anchorFor(text, "two");
			await getTool("insert").execute(
				"i1",
				{ anchor: two, direction: "after", lines: ["mid-a", "mid-b"] },
				undefined,
				undefined,
				ctx,
			);
			expect(await readFile(path, "utf-8")).toBe("one\r\ntwo\nmid-a\nmid-b\nthree\r\n");
		});
	});

	it("preserves mixed endings through a same-message batch", async () => {
		await withTempFile("sample.txt", "AAA\r\nBBB\nCCC\r\nDDD\r\n", async ({ cwd, path }) => {
			const { ctx, readTool, getTool, handlers } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
			const b = anchorFor(text, "BBB");
			const d = anchorFor(text, "DDD");
			const bArgs = { remove_from: b, remove_to: b, replacement_lines: ["B2"] };
			const dArgs = { remove_from: d, remove_to: d, replacement_lines: [] };
			await handlers.get("message_end")!(
				{
					type: "message_end",
					message: assistantMessage([toolCall("x1", "replace", bArgs), toolCall("x2", "replace", dArgs)]),
				},
				ctx,
			);
			const replace = getTool("replace");
			const first = await replace.execute("x1", bArgs, undefined, undefined, ctx);
			expect(first.content[0].text).toBe("In batch 1");
			await replace.execute("x2", dArgs, undefined, undefined, ctx);
			expect(await readFile(path, "utf-8")).toBe("AAA\r\nB2\nCCC\r\n");
			await handlers.get("turn_end")!(
				{
					type: "turn_end",
					turnIndex: 0,
					message: assistantMessage([toolCall("x1", "replace", bArgs), toolCall("x2", "replace", dArgs)]),
					toolResults: [{ toolCallId: "x1" }, { toolCallId: "x2" }],
				},
				ctx,
			);
			await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
			expect(await readFile(path, "utf-8")).toBe("AAA\r\nBBB\nCCC\r\nDDD\r\n");
		});
	});

	it("restores mixed endings through undo", async () => {
		await withTempFile("sample.txt", "old\r\nkeep\n", async ({ cwd, path }) => {
			const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
			const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
			const old = anchorFor(text, "old");
			await getTool("replace").execute(
				"e1",
				{ remove_from: old, remove_to: old, replacement_lines: ["new"] },
				undefined,
				undefined,
				ctx,
			);
			expect(await readFile(path, "utf-8")).toBe("new\r\nkeep\n");
			await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
			expect(await readFile(path, "utf-8")).toBe("old\r\nkeep\n");
		});
	});
});
