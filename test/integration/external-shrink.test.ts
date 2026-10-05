import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import {
  withTempFile,
  setupIntegrationTest,
  getText,
  extractHash,
  toolError,
} from "../support/fixtures";

describe("served state across an external shrink", () => {
  it("re-reads after an external shrink and edits cleanly", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nb\nd\ne\nb\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      await writeFile(path, "b\nd\ne\nb\nf\n", "utf-8");

      const r2 = getText(
        await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      const dHash = extractHash(r2.split("\n").find((l: string) => l.includes("│d"))!);
      const eHash = extractHash(r2.split("\n").find((l: string) => l.includes("│e"))!);

      const result = await editTool.execute(
        "e1",
        {
          remove_from: dHash,
          remove_to: eHash,
          text: [],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("b\nb\nf\n");
    });
  });

  it("rejects a pre-shrink anchor for a line removed by the shrink", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nb\nd\ne\nb\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = getText(
        await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      const aHash = extractHash(r1.split("\n").find((l: string) => l.includes("│a"))!);

      await writeFile(path, "b\nd\ne\nb\nf\n", "utf-8");

      expect(await toolError(() => editTool.execute(
        "e1",
        {
          remove_from: aHash,
          remove_to: aHash,
          text: ["x"],
        },
        undefined,
        undefined,
        ctx,
      ))).toMatch(/E_STALE_ANCHOR/);
      expect(await readFile(path, "utf-8")).toBe("b\nd\ne\nb\nf\n");
    });
  });
});
