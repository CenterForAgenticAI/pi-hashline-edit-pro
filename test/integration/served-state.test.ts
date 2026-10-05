import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { shutdownHashStore } from "../../src/hash-store";
import { ownersForPath, initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { withTempFile, setupIntegrationTest, getText, extractHash, makePiStub, toolError } from "../support/fixtures";
import { toCwd } from "../../src/paths";
import { resolveTarget } from "../../src/fs-write";

async function servedFor(cwd: string, name: string): Promise<Map<string, string> | undefined> {
  return ownersForPath(await resolveTarget(toCwd(name, cwd)));
}

function feedbackRows(message: string): string[] {
  return message.split("\n").filter((line) => /^[A-Za-z]{4}│/.test(line));
}

beforeEach(async () => {
  await initRegistry(undefined);
});

afterEach(() => {
  resetRegistryForTests();
});

describe("served-state range verification", () => {
  it("rejects an interior modification with valid boundaries, returning the current range with fresh anchors", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");

      const message = await toolError(() => editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: dHash, text: ["a", "x", "d"] },
        undefined,
        undefined,
        ctx,
      ));
      expect(message).toMatch(/E_RANGE_STALE/);
      expect(message).toContain("Current range with fresh anchors");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nd\n");
      const rows = feedbackRows(message);
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatch(/│a$/);
      expect(rows[1]).toMatch(/│B$/);
      expect(rows[3]).toMatch(/│d$/);
    });
  });

  it("retries successfully after a range-stale rejection without an intervening read", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");

      const feedback = await toolError(() => editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: dHash, text: ["a", "x", "d"] },
        undefined,
        undefined,
        ctx,
      ));
      const rows = feedbackRows(feedback);
      const freshA = extractHash(rows[0]!);
      const freshD = extractHash(rows[rows.length - 1]!);

      const retry = await editTool.execute(
        "e2",
        { remove_from: freshA, remove_to: freshD, text: ["a", "x", "d"] },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nx\nd\n");
    });
  });

  it("serves the context rows in E_STALE_ANCHOR feedback so a copied context hash edits immediately", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "A\nb\nC\nd\n", "utf-8");

      const staleError = await toolError(() => editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: dHash, text: ["x"] },
        undefined,
        undefined,
        ctx,
      ));
      expect(staleError).toMatch(/E_STALE_ANCHOR/);
      expect(staleError).toContain("Current context around resolved anchor");

      const contextRow = staleError.split("\n").find((l: string) => /^  +[0-9]+: [A-Za-z]{4}│C$/.test(l));
      expect(contextRow).toBeDefined();
      const contextHash = contextRow!.match(/([A-Za-z]{4})│/)![1]!;

      const served = await servedFor(cwd, "sample.ts");
      expect(served!.has(contextHash)).toBe(true);

      const retry = await editTool.execute(
        "e2",
        { remove_from: contextHash, remove_to: contextHash, text: ["c"] },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\n");
    });
  });

  it("tolerates an out-of-range external modification", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│c"))!);

      await writeFile(path, "A\nb\nc\nd\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { remove_from: bHash, remove_to: cHash, text: ["x"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nx\nd\n");
    });
  });

  it("accepts an interior change-then-revert round-trip", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const dHash = extractHash(lines.find((l: string) => l.includes("│d"))!);

      await writeFile(path, "a\nB\nc\nd\n", "utf-8");
      await writeFile(path, "a\nb\nc\nd\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: dHash, text: ["a", "x", "d"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nx\nd\n");
    });
  });

  it("rejects when interior lines were never served (disjoint read windows)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = await readTool.execute("r1", { path: "sample.ts", offset: 1, limit: 2 }, undefined, undefined, ctx);
      const r2 = await readTool.execute("r2", { path: "sample.ts", offset: 5, limit: 2 }, undefined, undefined, ctx);
      const aHash = extractHash(getText(r1).split("\n").find((l: string) => l.includes("│a"))!);
      const fHash = extractHash(getText(r2).split("\n").find((l: string) => l.includes("│f"))!);

      const message = await toolError(() => editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: fHash, text: ["x"] },
        undefined,
        undefined,
        ctx,
      ));
      expect(message).toMatch(/E_RANGE_STALE/);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\ne\nf\n");
      const rows = feedbackRows(message);
      expect(rows).toHaveLength(6);
      expect(rows[2]).toMatch(/│c$/);
      expect(rows[3]).toMatch(/│d$/);
    });
  });

  it("deletes a range whose interior lines were never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const first = await readTool.execute("r1", { path: "sample.ts", offset: 1, limit: 1 }, undefined, undefined, ctx);
      const last = await readTool.execute("r2", { path: "sample.ts", offset: 4, limit: 1 }, undefined, undefined, ctx);
      const aHash = extractHash(getText(first));
      const dHash = extractHash(getText(last));

      const result = await editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: dHash, text: [] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("e\n");
    });
  });

  it("rejects a deletion whose boundary line was never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const first = await readTool.execute("r1", { path: "sample.ts", offset: 1, limit: 1 }, undefined, undefined, ctx);
      const aHash = extractHash(getText(first));
      const abs = await resolveTarget(toCwd("sample.ts", cwd));
      const hashes = await lineHashes("a\nb\nc\nd\ne\n", abs);

      expect(await toolError(() => editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: hashes[3]!, text: [] },
        undefined,
        undefined,
        ctx,
      ))).toMatch(/E_RANGE_STALE/);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\ne\n");
    });
  });

  it("rejects when interior lines were never served (anchors from disjoint diff hunks)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const head = await readTool.execute("r1", { path: "sample.ts", limit: 3 }, undefined, undefined, ctx);
      const headLines = getText(head).split("\n");
      const aHash = extractHash(headLines.find((l: string) => l.includes("│a"))!);
      const first = await editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: aHash, text: ["A"] },
        undefined,
        undefined,
        ctx,
      );
      expect(first.content[0].text).toContain("Successfully replaced");

      const tail = await readTool.execute("r2", { path: "sample.ts", offset: 10, limit: 1 }, undefined, undefined, ctx);
      const jHash = extractHash(getText(tail).split("\n").find((l: string) => l.includes("│j"))!);
      const second = await editTool.execute(
        "e2",
        { remove_from: jHash, remove_to: jHash, text: ["J"] },
        undefined,
        undefined,
        ctx,
      );
      expect(second.content[0].text).toContain("Successfully replaced");

      const firstDiff = (first.details as { diff?: string } | undefined)?.diff ?? "";
      const aHashAfter = extractHash(firstDiff.split("\n").find((l: string) => l.startsWith("+") && l.includes("│A"))!).replace(/^[+ ]/, "");
      const secondDiff = (second.details as { diff?: string } | undefined)?.diff ?? "";
      const jHashAfter = extractHash(secondDiff.split("\n").find((l: string) => l.startsWith("+") && l.includes("│J"))!).replace(/^[+ ]/, "");
      expect(await toolError(() => editTool.execute(
        "e3",
        { remove_from: aHashAfter, remove_to: jHashAfter, text: ["X"] },
        undefined,
        undefined,
        ctx,
      ))).toMatch(/E_RANGE_STALE/);
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n");
    });
  });

  it("applies within a served window while other lines were never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = await readTool.execute("r1", { path: "sample.ts", offset: 1, limit: 2 }, undefined, undefined, ctx);
      const lines = getText(r1).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);

      const result = await editTool.execute(
        "e1",
        { remove_from: aHash, remove_to: bHash, text: ["x"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("x\nc\nd\ne\nf\n");
    });
  });

  it("applies without verification when the file was never served", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("a\nb\nc\n", await resolveTarget(toCwd("sample.ts", cwd)));

      const result = await editTool.execute(
        "e1",
        { remove_from: hashes[0]!, remove_to: hashes[0]!, text: ["A"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\n");
    });
  });

  it("records served state from read output", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const served = await servedFor(cwd, "sample.ts");
      expect(served).toBeDefined();
      for (const line of lines) {
        const hash = extractHash(line);
        if (/^[A-Za-z]{4}$/.test(hash)) expect(served!.has(hash)).toBe(true);
      }
    });
  });

  it("records served state from the post-edit diff rows", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);

      const result = await editTool.execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, text: ["B"] },
        undefined,
        undefined,
        ctx,
      );
      const diff = (result.details as { diff?: string } | undefined)?.diff ?? "";
      const served = await servedFor(cwd, "sample.ts");
      expect(served).toBeDefined();
      for (const row of diff.split("\n")) {
        const match = row.match(/^[+ ]([A-Za-z]{4})│/);
        if (match) expect(served!.has(match[1]!)).toBe(true);
      }
    });
  });

  it("re-edits with original anchors after an undo (undo diff rows are served)", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool, getTool } = setupIntegrationTest(cwd);
      const undo = getTool("undo_last_change");
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│b"))!);

      const edited = await editTool.execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, text: ["B"] },
        undefined,
        undefined,
        ctx,
      );
      expect(edited.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nd\n");

      const undone = await undo.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(undone.content[0].text).toContain("Undone last change");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\n");

      const retry = await editTool.execute(
        "e2",
        { remove_from: bHash, remove_to: bHash, text: ["B"] },
        undefined,
        undefined,
        ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nd\n");
    });
  });

  it("clears served state on write and re-serves via the auto-read block", async () => {
    await withTempFile("sample.ts", "a\nb\nc\n", async ({ cwd }) => {
      const { default: register } = await import("../../index");
      const { pi, handlers, tools } = makePiStub();
      register(pi);
      await handlers.get("session_start")!({}, { cwd, ui: { notify() {} } });
      const ctx = { cwd, ui: { notify() {} } };
      const readResult = await tools.get("read")!.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const aHash = extractHash(lines.find((l: string) => l.includes("│a"))!);

      const { writeFile: writeFileFs } = await import("fs/promises");
      await writeFileFs(`${cwd}/sample.ts`, "x\ny\nz\n", "utf-8");

      const writeEvent = {
        toolName: "write",
        isError: false,
        input: { path: "sample.ts" },
        content: [{ type: "text", text: "File written." }],
      };
      const result = await handlers.get("tool_result")!(writeEvent, { cwd });
      expect(result).toBeDefined();

      const servedAfterWrite = await servedFor(cwd, "sample.ts");
      expect(servedAfterWrite).toBeDefined();
      expect(servedAfterWrite!.has(aHash)).toBe(false);
      const servedText = (result as { content: Array<{ type: string; text: string }> }).content[1].text;
      for (const row of servedText.split("\n")) {
        const match = row.match(/^([A-Za-z]{4})│/);
        if (match) expect(servedAfterWrite!.has(match[1]!)).toBe(true);
      }
      shutdownHashStore();
    });
  });

  it("rejects a re-edit with a pre-edit anchor after an external revert, then accepts the retry", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const bHash = extractHash(getText(readResult).split("\n").find((l: string) => l.includes("│b"))!);

      await editTool.execute(
        "e1",
        { remove_from: bHash, remove_to: bHash, text: ["B"] },
        undefined, undefined, ctx,
      );
      await writeFile(path, "a\nb\nc\nd\n", "utf-8");

      const message = await toolError(() => editTool.execute(
        "e2",
        { remove_from: bHash, remove_to: bHash, text: ["B2"] },
        undefined, undefined, ctx,
      ));
      expect(message).toMatch(/E_STALE_ANCHOR/);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\n");

      const reread = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const freshB = extractHash(getText(reread).split("\n").find((l: string) => l.includes("│b"))!);
      expect(freshB).not.toBe(bHash);

      const retry = await editTool.execute(
        "e3",
        { remove_from: freshB, remove_to: freshB, text: ["B2"] },
        undefined, undefined, ctx,
      );
      expect(retry.content[0].text).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("a\nB2\nc\nd\n");
    });
  });
});
