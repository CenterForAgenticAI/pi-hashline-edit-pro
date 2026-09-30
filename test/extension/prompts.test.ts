import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { loadGuide, loadP } from "../../src/prompts";
import { withReadPrompts, withReplacePrompts, withReplaceWithinPrompts, withInsertPrompts, withTransferPrompts, withUndoPrompts, withGrepPrompts, DEFAULT_EDIT_FLAGS } from "../../src/edit-common";
import { regRead } from "../../src/read";
import { makeFakePiRegistry } from "../support/fixtures";

const replaceBase = {
  description: loadP("../prompts/replace.md"),
  snippet: loadP("../prompts/replace-snippet.md"),
  guidelines: loadGuide("../prompts/replace-guidelines.md"),
};

const insertBase = {
  description: loadP("../prompts/insert.md"),
  snippet: loadP("../prompts/insert-snippet.md"),
  guidelines: loadGuide("../prompts/insert-guidelines.md"),
};

const readBase = {
  description: loadP("../prompts/read.md"),
  snippet: loadP("../prompts/read-snippet.md"),
  guidelines: loadGuide("../prompts/read-guidelines.md"),
};

const undoBase = {
  description: loadP("../prompts/undo-last-change.md"),
  snippet: loadP("../prompts/undo-last-change-snippet.md"),
  guidelines: loadGuide("../prompts/undo-last-change-guidelines.md"),
};

const withinBase = {
  description: loadP("../prompts/replace-within.md"),
  snippet: loadP("../prompts/replace-within-snippet.md"),
  guidelines: loadGuide("../prompts/replace-within-guidelines.md"),
};

const grepBase = {
  description: loadP("../prompts/grep.md"),
  snippet: loadP("../prompts/grep-snippet.md"),
};

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const replacePrompt = readFileSync(
  new URL("../../prompts/replace.md", import.meta.url),
  "utf-8",
);

describe("prompts/replace.md (model-facing contract)", () => {
  it("declares the tool purpose", () => {
    expect(replacePrompt).toMatch(/Replace a range of lines \(or a single line\) in a text file.*anchors/);
  });
});

const readPrompt = readFileSync(
  new URL("../../prompts/read.md", import.meta.url),
  "utf-8",
);

describe("prompts/read.md (model-facing contract)", () => {
  it("declares the HASH|content output format", () => {
    expect(readPrompt).toMatch(/anchor│content/);
    expect(readPrompt).toMatch(/4-character/);
  });

  it("specifies the letters-only anchor alphabet", () => {
    expect(readPrompt).toMatch(/4-character/);
    expect(readPrompt).toContain("letters only");
  });

  it("documents pagination support", () => {
    expect(readPrompt).toContain("offset/limit");
  });

  it("documents file-kind handling", () => {
    expect(readPrompt).toMatch(/Images/);
    expect(readPrompt).toMatch(/binary/i);
    expect(readPrompt).toMatch(/directory/);
  });
});

describe("prompt guidelines", () => {
  it("replace-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../prompts/replace-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("remove_from");
    expect(content).toContain("remove_to");
    expect(content).toContain("replacement_lines");
    expect(content).not.toContain("hash_bounds");
    expect(content).not.toContain("new_content");
    expect(content).not.toContain("{{");
  });

  it("loadGuide returns an array of guidelines", () => {
    const guidelines = loadGuide("../prompts/replace-guidelines.md");
    expect(Array.isArray(guidelines)).toBe(true);
    expect(guidelines.length).toBeGreaterThan(0);
  });

  it("read-guidelines.md keeps the re-read note inline", () => {
    const content = readFileSync(
      new URL("../../prompts/read-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("call again after an edit");
    expect(content).not.toContain("{{AUTO_READ_NOTE}}");
  });
  it("undo-last-change-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../prompts/undo-last-change-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).not.toContain("{{");
  });
});

describe("read tool guidelines", () => {
  it("always includes the re-read note for fresh anchors after edits", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi);
    const tool = getTool("read");
    const guidelines = tool.promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("call again after an edit"))).toBe(true);
  });
});

describe("prompt file packaging", () => {
  it("every loadP/loadGuide reference resolves to a prompt file shipped in the package", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("prompts");
    expect(pkg.files).toContain("src");

    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    let refs = 0;
    for (const file of collectTsFiles(srcDir)) {
      const content = readFileSync(file, "utf-8");
      for (const match of content.matchAll(/load(?:P|Guide)\("((?:\.\.\/)+prompts\/[^"]+)"\)/g)) {
        refs++;
        const promptPath = match[1]!;
        expect(existsSync(resolve(dirname(file), promptPath))).toBe(true);
      }
    }
    expect(refs).toBeGreaterThan(0);
  });
});

describe("edit prompt flag variants", () => {
  it("withReplacePrompts adds the require-path contract", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, requirePath: true });
    expect(result.description).toContain("Also give `path` matching the file the anchors were served for");
    expect(result.snippet).toContain("; include `path` (required)");
  });

  it("withReplacePrompts adds the strict-input notice", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, strictInput: true });
    expect(result.description).toContain("Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.");
  });

  it("withReplacePrompts drops the diff-follow hint and example when auto-read is off", () => {
    const on = withReplacePrompts(replaceBase, DEFAULT_EDIT_FLAGS);
    expect(on.description).toContain("Example: read served");
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(result.description).not.toContain("Example: read served");
    expect(result.description).not.toContain("Anchor follow-up edits on the `+anchor│`");
    expect(result.guidelines.some((g) => g.includes("post-edit diff"))).toBe(false);
  });

  it("withReplacePrompts drops the replace_within cross-reference when the tool is off", () => {
    const on = withReplacePrompts(replaceBase, DEFAULT_EDIT_FLAGS);
    expect(on.description).toContain("use `replace_within` instead");
    const off = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, replaceWithinEnabled: false });
    expect(off.description).not.toContain("replace_within");
    expect(off.description).toContain("Replace a range of lines");
  });

  it("withReplacePrompts rewrites the batch diff wording when auto-read is off", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(result.description).toContain("combined result");
    expect(result.description).not.toContain("combined diff");
  });

  it("withInsertPrompts rewrites the batch diff wording when auto-read is off", () => {
    const on = withInsertPrompts(insertBase, DEFAULT_EDIT_FLAGS);
    expect(on.description).toContain("combined diff");
    const off = withInsertPrompts(insertBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(off.description).toContain("combined result");
    expect(off.description).not.toContain("combined diff");
  });

  it("withUndoPrompts keeps diff detail when auto-read is on and neutralizes when off", () => {
    const on = withUndoPrompts(undoBase, DEFAULT_EDIT_FLAGS);
    expect(on.guidelines.some((g) => g.includes("bad diff"))).toBe(true);
    const off = withUndoPrompts(undoBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(off.guidelines.some((g) => g.includes("bad diff"))).toBe(false);
    expect(off.guidelines.some((g) => g.includes("bad edit"))).toBe(true);
  });

  it("withUndoPrompts drops disabled tools from its operation lists", () => {
    const off = withUndoPrompts(undoBase, { ...DEFAULT_EDIT_FLAGS, replaceWithinEnabled: false, copyMoveEnabled: false });
    expect(off.description).not.toContain("copy");
    expect(off.description).not.toContain("replace_within");
    expect(off.description).not.toContain("or move");
    expect(off.description).toContain("replace or insert");
    expect(off.snippet).not.toContain("copy");
    expect(off.snippet).not.toContain("replace_within");
    expect(off.guidelines.some((g) => g.includes("replace_within"))).toBe(false);
    expect(off.guidelines.some((g) => g.includes("cross-file `move`"))).toBe(false);
  });

  it("withUndoPrompts keeps the full operation list when both toggles are on", () => {
    const on = withUndoPrompts(undoBase, DEFAULT_EDIT_FLAGS);
    expect(on.description).toContain("replace, replace_within, insert, copy, or move");
    expect(on.snippet).toContain("`replace`, `replace_within`, `insert`, `copy`, or `move`");
    expect(on.guidelines.some((g) => g.includes("cross-file `move`"))).toBe(true);
  });

  it("withInsertPrompts adds the require-path and strict-input notices", () => {
    const result = withInsertPrompts(insertBase, { ...DEFAULT_EDIT_FLAGS, requirePath: true, strictInput: true });
    expect(result.description).toContain("Also give `path` matching the file the anchor was served for");
    expect(result.snippet).toContain("; include `path` (required)");
    expect(result.description).toContain("Strict-input mode is on");
  });

  it("withReplaceWithinPrompts adds the require-path and strict-input notices", () => {
    const result = withReplaceWithinPrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, requirePath: true, strictInput: true });
    expect(result.description).toContain("Also give `path` matching the file the anchors were served for");
    expect(result.description).toContain("Strict-input mode is on");
  });

  it("withReplaceWithinPrompts drops the copy/move mention when Copy/move is off", () => {
    const on = withReplaceWithinPrompts(withinBase, DEFAULT_EDIT_FLAGS);
    expect(on.guidelines.some((g) => g.includes("like `copy` and `move`"))).toBe(true);
    const off = withReplaceWithinPrompts(withinBase, { ...DEFAULT_EDIT_FLAGS, copyMoveEnabled: false });
    expect(off.guidelines.some((g) => g.includes("`copy`"))).toBe(false);
    expect(off.guidelines.some((g) => g.includes("commits on its own"))).toBe(true);
  });

  it("withGrepPrompts drops copy and move when Copy/move is off", () => {
    const on = withGrepPrompts(grepBase, DEFAULT_EDIT_FLAGS);
    expect(on.description).toContain("replace, insert, copy, or move");
    const off = withGrepPrompts(grepBase, { ...DEFAULT_EDIT_FLAGS, copyMoveEnabled: false });
    expect(off.description).not.toContain("copy");
    expect(off.description).not.toContain("or move");
    expect(off.description).toContain("replace or insert");
  });

  it("withReadPrompts drops the auto-read-all guideline when auto-read-all is off", () => {
    const result = withReadPrompts(readBase, DEFAULT_EDIT_FLAGS);
    expect(result.description).toBe(readBase.description);
    expect(result.snippet).toBe(readBase.snippet);
    expect(result.guidelines).toEqual(readBase.guidelines.filter((g) => !g.includes("E_AUTO_READ_ALL")));
  });

  it("withReadPrompts keeps the auto-read-all guideline and drops the re-read note when auto-read-all is on", () => {
    const result = withReadPrompts(readBase, { ...DEFAULT_EDIT_FLAGS, autoReadAllActive: true });
    expect(result.guidelines.some((g) => g === "`read`: `E_AUTO_READ_ALL` on an attached file means its content is still exactly as it was when attached at the start of this session.")).toBe(true);
    expect(result.guidelines.some((g) => g.includes("call again after an edit"))).toBe(false);
  });

  it("withReadPrompts rewrites the re-read note when auto-read is off", () => {
    const result = withReadPrompts(readBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(result.guidelines.some((g) => g === "`read`: call again after an edit when you need anchors you lack.")).toBe(true);
  });

  it("withTransferPrompts keeps the anchor-only contract by default", () => {
    const base = {
      description: loadP("../prompts/copy.md"),
      snippet: loadP("../prompts/copy-snippet.md"),
      guidelines: loadGuide("../prompts/copy-guidelines.md"),
    };
    const result = withTransferPrompts(base, DEFAULT_EDIT_FLAGS);
    expect(result.description).toContain("Path resolution is anchor-only; do not pass `path`.");
  });

  it("withTransferPrompts adds the require-path and strict-input notices", () => {
    const base = {
      description: loadP("../prompts/move.md"),
      snippet: loadP("../prompts/move-snippet.md"),
      guidelines: loadGuide("../prompts/move-guidelines.md"),
    };
    const result = withTransferPrompts(base, { ...DEFAULT_EDIT_FLAGS, requirePath: true, strictInput: true });
    expect(result.description).toContain("Also give `path` matching the source or destination file the anchors were served for");
    expect(result.snippet).toContain("; include `path` (required)");
    expect(result.description).toContain("Strict-input mode is on");
  });
});
