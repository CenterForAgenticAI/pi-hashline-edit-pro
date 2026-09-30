import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import register from "../../index";
import { buildTransferEdit, buildTransferToolDef, transferPreview } from "../../src/copy-move";
import { lineHashes } from "../../src/hashline";
import { resolveTarget } from "../../src/fs-write";
import type { NormFile } from "../../src/file-reader";
import {
  anchorFor,
  getText,
  makeFakePiRegistry,
  makePiStub,
  setupIntegrationTest,
  useTestHome,
  withTempDir,
  withTempFile,
} from "../support/fixtures";

useTestHome();

function fakeTheme() {
  return { fg: (_name: string, text: string) => text, bold: (text: string) => text };
}

function renderContext(cwd: string) {
  return {
    executionStarted: false,
    argsComplete: false,
    expanded: false,
    cwd,
    lastComponent: undefined,
    invalidate: () => undefined,
    state: {},
  };
}

describe("copy and move registration", () => {
  it("registers both tools with the transfer schema", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const copy = getTool("copy");
    const move = getTool("move");
    expect(copy.name).toBe("copy");
    expect(move.name).toBe("move");
    const schema = copy.parameters as { type?: string; properties?: Record<string, unknown>; additionalProperties?: boolean };
    expect(schema.type).toBe("object");
    expect(schema.properties?.source_from).toBeDefined();
    expect(schema.properties?.source_to).toBeDefined();
    expect(schema.properties?.insert_after).toBeDefined();
    expect(schema.additionalProperties).toBe(true);
  });

  it("adds path to the schema when require-path mode is on", () => {
    const tool = buildTransferToolDef("copy", { requirePath: true, strictInput: false, autoRead: true, autoReadAllActive: false, replaceWithinEnabled: true, copyMoveEnabled: true });
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties?.path).toBeDefined();
  });
});

describe("copy", () => {
  it("copies a range after an anchor and leaves the source anchors live", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const delta = anchorFor(text, "delta");

      const result = await getTool("copy").execute(
        "c1",
        { source_from: beta, source_to: gamma, insert_after: delta },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully copied in sample.txt");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\ndelta\nbeta\ngamma\n");
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(diff).toContain("│beta");
      expect(diff).toContain("│gamma");

      const applied = await getTool("replace").execute(
        "e1",
        { remove_from: beta, remove_to: beta, replacement_lines: ["BETA"] },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(applied)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\ndelta\nbeta\ngamma\n");
    });
  });

  it("duplicates a single line when insert_after is source_to", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      await getTool("copy").execute("c1", { source_from: beta, source_to: beta, insert_after: beta }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nbeta\ngamma\n");
    });
  });

  it("copies a block above itself when insert_after precedes the source", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const gamma = anchorFor(text, "gamma");
      const delta = anchorFor(text, "delta");
      await getTool("copy").execute("c1", { source_from: gamma, source_to: delta, insert_after: alpha }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\ndelta\nbeta\ngamma\ndelta\n");
    });
  });

  it("rejects insert_after strictly inside the source range", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      await expect(
        getTool("copy").execute("c1", { source_from: beta, source_to: gamma, insert_after: beta }, undefined, undefined, ctx),
      ).rejects.toThrow("[E_BAD_SHAPE]");
    });
  });

  it("undoes a copy in one step", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const gamma = anchorFor(text, "gamma");
      const beta = anchorFor(text, "beta");
      await getTool("copy").execute("c1", { source_from: beta, source_to: beta, insert_after: gamma }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\nbeta\n");
      const undone = await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });
});

describe("move", () => {
  it("moves a line down past a later anchor", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const delta = anchorFor(text, "delta");
      const result = await getTool("move").execute("m1", { source_from: beta, source_to: beta, insert_after: delta }, undefined, undefined, ctx);
      expect(getText(result)).toContain("Successfully moved in sample.txt");
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\ndelta\nbeta\n");
    });
  });

  it("moves a line up before an earlier anchor", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const delta = anchorFor(text, "delta");
      await getTool("move").execute("m1", { source_from: delta, source_to: delta, insert_after: alpha }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ndelta\nbeta\ngamma\n");
    });
  });

  it("accepts a reversed range and still moves the block", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const gamma = anchorFor(text, "gamma");
      const alpha = anchorFor(text, "alpha");
      const delta = anchorFor(text, "delta");
      await getTool("move").execute("m1", { source_from: gamma, source_to: alpha, insert_after: delta }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("delta\nalpha\nbeta\ngamma\n");
    });
  });

  it("reports noop when a block is moved to where it already sits", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const result = await getTool("move").execute("m1", { source_from: gamma, source_to: gamma, insert_after: beta }, undefined, undefined, ctx);
      expect(getText(result)).toContain("No changes made");
      expect(result.details.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\ndelta\n");
    });
  });

  it("undoes a move in one step", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const delta = anchorFor(text, "delta");
      await getTool("move").execute("m1", { source_from: beta, source_to: beta, insert_after: delta }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\ngamma\ndelta\nbeta\n");
      const undone = await getTool("undo_last_change").execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(undone.isError).toBeFalsy();
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\ndelta\n");
    });
  });

  it("preserves CRLF line endings", async () => {
    await withTempFile("crlf.txt", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "crlf.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      await getTool("move").execute("m1", { source_from: beta, source_to: beta, insert_after: gamma }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("alpha\r\ngamma\r\nbeta\r\n");
    });
  });
});

describe("copy and move validation", () => {
  it("requires all three anchors", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      await expect(getTool("copy").execute("c1", { source_from: "Hasu" }, undefined, undefined, ctx)).rejects.toThrow("[E_BAD_SHAPE]");
      await expect(
        getTool("move").execute("m1", { source_from: "Hasu", source_to: "Hasu", insert_after: "Hasu", extra: true }, undefined, undefined, ctx),
      ).rejects.toThrow(/unknown or unsupported fields/);
    });
  });

  it("rejects copy and move on an empty file", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "empty.txt" }, undefined, undefined, ctx));
      const anchor = text.split("\n")[0]!.split("│")[0]!;
      await expect(
        getTool("copy").execute("c1", { source_from: anchor, source_to: anchor, insert_after: anchor }, undefined, undefined, ctx),
      ).rejects.toThrow("[E_BAD_SHAPE] The file is empty");
      await expect(
        getTool("move").execute("m1", { source_from: anchor, source_to: anchor, insert_after: anchor }, undefined, undefined, ctx),
      ).rejects.toThrow("[E_BAD_SHAPE] The file is empty");
    });
  });

  it("copies lines from one file into another", async () => {
    await withTempDir("transfer-cross-copy-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      const result = await getTool("copy").execute("c1", { source_from: beta, source_to: beta, insert_after: one }, undefined, undefined, ctx);
      expect(getText(result)).toContain("Successfully copied in b.ts");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\ntwo\n");
      const diff = (result.details as { diff?: string }).diff ?? "";
      expect(diff).toContain("│beta");
    });
  });

  it("copies lines into an empty file", async () => {
    await withTempDir("transfer-empty-dest-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(aText, "alpha");
      const beta = anchorFor(aText, "beta");
      const emptyAnchor = bText.split("\n")[0]!.split("│")[0]!;
      await getTool("copy").execute("c1", { source_from: alpha, source_to: beta, insert_after: emptyAnchor }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("moves lines from one file into another and records one undo per file", async () => {
    await withTempDir("transfer-cross-move-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const two = anchorFor(bText, "two");
      const result = await getTool("move").execute("m1", { source_from: beta, source_to: beta, insert_after: two }, undefined, undefined, ctx);
      expect(getText(result)).toContain("Successfully moved 1 line(s) from a.ts to b.ts");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\ngamma\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\nbeta\n");

      await getTool("undo_last_change").execute("u1", { path: "b.ts" }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\ntwo\n");
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\ngamma\n");
      await getTool("undo_last_change").execute("u2", { path: "a.ts" }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("moves every line out of the source file", async () => {
    await withTempDir("transfer-empty-source-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "keep\n", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(aText, "alpha");
      const beta = anchorFor(aText, "beta");
      const keep = anchorFor(bText, "keep");
      await getTool("move").execute("m1", { source_from: alpha, source_to: beta, insert_after: keep }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("keep\nalpha\nbeta\n");
    });
  });

  it("verifies source and destination anchors against their own files", async () => {
    await withTempDir("transfer-cross-stale-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(aText, "alpha");
      const one = anchorFor(bText, "one");
      await expect(
        getTool("copy").execute("c1", { source_from: alpha, source_to: "PyBY", insert_after: one }, undefined, undefined, ctx),
      ).rejects.toThrow("[E_STALE_ANCHOR]");
    });
  });

  it("rejects a stale anchor", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      await expect(
        getTool("move").execute("m1", { source_from: "PyBY", source_to: "PyBY", insert_after: "PyBY" }, undefined, undefined, ctx),
      ).rejects.toThrow("[E_STALE_ANCHOR]");
    });
  });

  it("strips pasted anchor prefixes with a warning outside strict mode", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const result = await getTool("copy").execute(
        "c1",
        { source_from: `${beta}│beta`, source_to: beta, insert_after: gamma },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("[W_BAD_REF]");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\nbeta\n");
    });
  });

  it("rejects auto-fixable prefixes in strict-input mode", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      await mkdir(join(cwd, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(
        join(cwd, ".config", "pi-hashline-edit-pro", "config.json"),
        JSON.stringify({ autoRead: true, strictInput: true }),
        "utf-8",
      );
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      await expect(
        getTool("copy").execute("c1", { source_from: `${beta}│beta`, source_to: beta, insert_after: gamma }, undefined, undefined, ctx),
      ).rejects.toThrow("[E_BAD_SHAPE] Strict-input mode");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("refuses a path in anchor-only mode and requires it in require-path mode", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      await expect(
        getTool("copy").execute("c1", { path: "sample.txt", source_from: beta, source_to: beta, insert_after: gamma }, undefined, undefined, ctx),
      ).rejects.toThrow(/unsupported fields: path/);

      await mkdir(join(cwd, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(
        join(cwd, ".config", "pi-hashline-edit-pro", "config.json"),
        JSON.stringify({ autoRead: true, requirePath: true }),
        "utf-8",
      );
      await expect(
        getTool("copy").execute("c2", { source_from: beta, source_to: beta, insert_after: gamma }, undefined, undefined, ctx),
      ).rejects.toThrow(/requires a non-empty "path"/);
      await getTool("copy").execute(
        "c3",
        { path: "sample.txt", source_from: beta, source_to: beta, insert_after: gamma },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\nbeta\n");
    });
  });
});

describe("served-range verification", () => {
  it("rejects a copy whose source lines were never served", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt", limit: 2 }, undefined, undefined, ctx);
      const abs = await resolveTarget(join(cwd, "sample.txt"));
      const hashes = await lineHashes("a\nb\nc\nd\n", abs);
      await expect(
        getTool("copy").execute("c1", { source_from: hashes[2]!, source_to: hashes[3]!, insert_after: hashes[0]! }, undefined, undefined, ctx),
      ).rejects.toThrow("[E_RANGE_STALE]");
    });
  });

  it("rejects a copy whose insert_after line was never served", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt", limit: 2 }, undefined, undefined, ctx);
      const abs = await resolveTarget(join(cwd, "sample.txt"));
      const hashes = await lineHashes("a\nb\nc\nd\n", abs);
      await expect(
        getTool("copy").execute("c1", { source_from: hashes[0]!, source_to: hashes[0]!, insert_after: hashes[3]! }, undefined, undefined, ctx),
      ).rejects.toThrow("[E_RANGE_STALE]");
    });
  });

  it("moves across lines that were never served", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\nf\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.txt", offset: 1, limit: 2 }, undefined, undefined, ctx);
      await readTool.execute("r2", { path: "sample.txt", offset: 5, limit: 2 }, undefined, undefined, ctx);
      const abs = await resolveTarget(join(cwd, "sample.txt"));
      const hashes = await lineHashes("a\nb\nc\nd\ne\nf\n", abs);
      await getTool("move").execute("m1", { source_from: hashes[0]!, source_to: hashes[1]!, insert_after: hashes[4]! }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("c\nd\ne\na\nb\nf\n");
    });
  });

  it("keeps the no-served-record path working when callers pass no served map", async () => {
    await withTempDir("transfer-unserved-", async (dir) => {
      const abs = await resolveTarget(join(dir, "synthetic.txt"));
      const content = "a\nb\nc\n";
      const hashes = await lineHashes(content, abs);
      const preload: NormFile = {
        absolutePath: abs,
        normalized: content,
        bom: "",
        originalEnding: "\n",
        endingSeparators: ["\n", "\n"],
        fileHashes: hashes,
        hadUtf8DecodeErrors: false,
        identity: { dev: 0, ino: 0 },
      };
      const plan = buildTransferEdit({
        kind: "move",
        refs: { sourceFrom: { hash: hashes[0]! }, sourceTo: { hash: hashes[0]! }, insertAfter: { hash: hashes[2]! } },
        preload,
        displayPath: "synthetic.txt",
        served: undefined,
      });
      expect(plan.servedOverride).toBeUndefined();
      expect(plan.editParams.replacement_lines).toEqual(["b", "c", "a"]);
    });
  });
});

describe("copy and move previews", () => {
  it("computes a preview diff and surfaces invalid anchors as errors", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const beta = anchorFor(text, "beta");
      const gamma = anchorFor(text, "gamma");
      const preview = await transferPreview("copy", { source_from: beta, source_to: beta, insert_after: gamma }, cwd);
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("beta");

      const failure = await transferPreview("move", { source_from: "!!!!", source_to: "!!!!", insert_after: "!!!!" }, cwd);
      expect(failure).toHaveProperty("error");
    });
  });

  it("rethrows an aborted preview", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alpha = anchorFor(text, "alpha");
      const beta = anchorFor(text, "beta");
      const controller = new AbortController();
      controller.abort();
      await expect(transferPreview("copy", { source_from: alpha, source_to: alpha, insert_after: beta }, cwd, controller.signal)).rejects.toThrow(
        "Operation aborted",
      );
    });
  });

  it("handles incomplete renderCall args without computing a preview", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("copy");
      const theme = fakeTheme();
      expect(tool.renderCall("nope", theme, renderContext(cwd))).toBeDefined();
      expect(tool.renderCall({ source_from: 42 }, theme, renderContext(cwd))).toBeDefined();
      expect(tool.renderCall({ source_from: "Hasu", source_to: "Hasu", insert_after: "Hasu" }, theme, renderContext(cwd))).toBeDefined();
    });
  });
});

describe("auto-read after copy and move", () => {
  it("replaces the copy result with the post-edit diff", async () => {
    const { pi, handlers } = makePiStub();
    register(pi);
    const handler = handlers.get("tool_result")!;
    const diff = " alpha\n+Qwer│beta";
    const result = (await handler(
      {
        toolName: "copy",
        isError: false,
        input: { path: "sample.txt" },
        details: { diff, metrics: { classification: "applied" } },
        content: [{ type: "text", text: "Successfully copied in sample.txt." }],
      },
      { cwd: "/tmp" },
    )) as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toBe(diff);
  });

  it("shows the combined two-file diff for a cross-file move", async () => {
    await withTempDir("transfer-auto-read-move-", async (dir) => {
      await writeFile(join(dir, "src.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      await writeFile(join(dir, "dst.ts"), "one\ntwo\n", "utf-8");
      const { handlers, getTool, ctx } = setupIntegrationTest(dir);
      const srcText = getText(await getTool("read").execute("r1", { path: "src.ts" }, undefined, undefined, ctx));
      const dstText = getText(await getTool("read").execute("r2", { path: "dst.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(srcText, "beta");
      const two = anchorFor(dstText, "two");
      const moved = await getTool("move").execute("m1", { source_from: beta, source_to: beta, insert_after: two }, undefined, undefined, ctx);
      const handler = handlers.get("tool_result")!;
      const transformed = (await handler(
        {
          type: "tool_result",
          toolName: "move",
          toolCallId: "m1",
          input: { source_from: beta, source_to: beta, insert_after: two },
          content: moved.content,
          details: moved.details,
          isError: false,
        },
        ctx,
      )) as { content: Array<{ type: string; text: string }> } | undefined;
      expect(transformed).toBeDefined();
      const text = transformed!.content[0]!.text;
      expect(text.startsWith("--- src.ts ---")).toBe(true);
      expect(text).toContain("--- dst.ts ---");
      expect(text).toContain("│beta");
      expect(text).not.toContain("Successfully moved");
    });
  });
});

describe("cross-file previews and require-path", () => {
  it("previews a cross-file copy and a cross-file move", async () => {
    await withTempDir("transfer-cross-preview-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      const copyPreview = await transferPreview("copy", { source_from: beta, source_to: beta, insert_after: one }, dir);
      expect(copyPreview).toHaveProperty("diff");
      expect((copyPreview as { diff: string }).diff).toContain("beta");
      const movePreview = await transferPreview("move", { source_from: beta, source_to: beta, insert_after: one }, dir);
      expect(movePreview).toHaveProperty("diff");
      const diff = (movePreview as { diff: string }).diff;
      expect(diff).toContain("--- a.ts ---");
      expect(diff).toContain("--- b.ts ---");
    });
  });

  it("requires a path matching the source or destination in require-path mode", async () => {
    await withTempDir("transfer-cross-path-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      await mkdir(join(dir, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(
        join(dir, ".config", "pi-hashline-edit-pro", "config.json"),
        JSON.stringify({ autoRead: true, requirePath: true }),
        "utf-8",
      );
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(aText, "alpha");
      const one = anchorFor(bText, "one");
      await expect(
        getTool("copy").execute("c1", { path: "missing.ts", source_from: alpha, source_to: alpha, insert_after: one }, undefined, undefined, ctx),
      ).rejects.toThrow(/does not match the source file/);
      await getTool("copy").execute("c2", { path: "a.ts", source_from: alpha, source_to: alpha, insert_after: one }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nalpha\ntwo\n");
    });
  });

  it("moves lines into an empty destination file", async () => {
    await withTempDir("transfer-move-empty-dest-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const alpha = anchorFor(aText, "alpha");
      const beta = anchorFor(aText, "beta");
      const emptyAnchor = bText.split("\n")[0]!.split("│")[0]!;
      await getTool("move").execute("m1", { source_from: alpha, source_to: beta, insert_after: emptyAnchor }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("alpha\nbeta\n");
    });
  });
});

describe("source line endings", () => {
  it("copies a CRLF line into an LF file with its source ending", async () => {
    await withTempDir("transfer-endings-copy-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\r\nbeta\r\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      await getTool("copy").execute("c1", { source_from: beta, source_to: beta, insert_after: one }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\r\nbeta\r\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\r\ntwo\n");
    });
  });

  it("keeps LF endings when copying into a CRLF file", async () => {
    await withTempDir("transfer-endings-lf-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\r\ntwo\r\n", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      await getTool("copy").execute("c1", { source_from: beta, source_to: beta, insert_after: one }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\r\nbeta\ntwo\r\n");
    });
  });

  it("moves a CRLF line into an LF file with its source ending", async () => {
    await withTempDir("transfer-endings-move-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\r\nbeta\r\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      await getTool("move").execute("m1", { source_from: beta, source_to: beta, insert_after: one }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("alpha\r\n");
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\r\ntwo\n");
    });
  });

  it("falls back to the destination ending when the source line has no terminator", async () => {
    await withTempDir("transfer-endings-eof-", async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\r\nbeta", "utf-8");
      await writeFile(join(dir, "b.ts"), "one\ntwo\n", "utf-8");
      const { ctx, readTool, getTool } = setupIntegrationTest(dir);
      const aText = getText(await readTool.execute("r1", { path: "a.ts" }, undefined, undefined, ctx));
      const bText = getText(await readTool.execute("r2", { path: "b.ts" }, undefined, undefined, ctx));
      const beta = anchorFor(aText, "beta");
      const one = anchorFor(bText, "one");
      await getTool("copy").execute("c1", { source_from: beta, source_to: beta, insert_after: one }, undefined, undefined, ctx);
      expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("one\nbeta\ntwo\n");
    });
  });

  it("keeps each source ending when copying inside a mixed-ending file", async () => {
    await withTempFile("mixed-copy.ts", "a\r\nb\nc\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, getTool } = setupIntegrationTest(cwd);
      const text = getText(await readTool.execute("r1", { path: "mixed-copy.ts" }, undefined, undefined, ctx));
      const a = anchorFor(text, "a");
      const b = anchorFor(text, "b");
      await getTool("copy").execute("c1", { source_from: a, source_to: a, insert_after: b }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("a\r\nb\na\r\nc\r\n");
    });
  });
});
