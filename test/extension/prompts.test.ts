import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { loadGuide, loadP } from "../../src/prompts";
import { withReadPrompts, withReplacePrompts, withReplaceMatchPrompts, withInsertPrompts, withTransferPrompts, withUndoPrompts, withGrepPrompts, DEFAULT_EDIT_FLAGS } from "../../src/edit-common";
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
  description: loadP("../prompts/replace-match.md"),
  snippet: loadP("../prompts/replace-match-snippet.md"),
  guidelines: loadGuide("../prompts/replace-match-guidelines.md"),
};

const grepBase = {
  description: loadP("../prompts/grep.md"),
  snippet: loadP("../prompts/grep-snippet.md"),
  guidelines: loadGuide("../prompts/grep-guidelines.md"),
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
    expect(content).toContain("text");
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

  it("puts the enabled edit-tool preference line first", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi);
    const guidelines = getTool("read").promptGuidelines as string[];
    expect(guidelines[0]).toBe("Prefer the hashline tools for anything that touches files: `read`, `replace`, `replace_match`, `insert`, `copy`, `move`, or `undo_last_change`.");
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
    const copyMoveSource = readFileSync(resolve(srcDir, "copy-move.ts"), "utf-8");
    for (const kind of ["copy", "move"]) {
      for (const suffix of [".md", "-snippet.md", "-guidelines.md"]) {
        expect(copyMoveSource).toContain("../prompts/${kind}" + suffix);
        expect(existsSync(resolve(srcDir, "..", "prompts", `${kind}${suffix}`))).toBe(true);
      }
    }
  });
});

describe("edit prompt flag variants", () => {
  it("withReplacePrompts adds the require-path contract", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, requirePath: true });
    expect(result.guidelines.some((g) => g.includes("pass `path` matching the file the anchors were served for"))).toBe(true);
    expect(result.snippet).not.toContain("include `path` (required)");
  });

  it("withReplacePrompts adds the strict-input notice", () => {
    const result = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, strictInput: true });
    expect(result.guidelines.some((g) => g.includes("strict-input mode is on; auto-fixable slips are rejected"))).toBe(true);
  });

  it("withReplacePrompts lists only the enabled edit tools in its preference guideline", () => {
    const all = withReplacePrompts(replaceBase, DEFAULT_EDIT_FLAGS);
    expect(all.guidelines[0]).toBe("Prefer the hashline tools for anything that touches files: `read`, `replace`, `replace_match`, `insert`, `copy`, `move`, or `undo_last_change`.");
    const noWithin = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, replaceMatchEnabled: false });
    expect(noWithin.guidelines[0]).not.toContain("replace_match");
    const noTransfer = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, copyMoveEnabled: false });
    expect(noTransfer.guidelines[0]).not.toContain("`copy`");
    expect(noTransfer.guidelines[0]).not.toContain("`move`");
    expect(noTransfer.guidelines[0]).toContain("`replace_match`");
  });

  it("adds the diff-row guideline only when auto-read is on", () => {
    const on = withReplacePrompts(replaceBase, DEFAULT_EDIT_FLAGS);
    expect(on.guidelines.some((g) => g.includes("rows are dead anchors"))).toBe(true);
    const off = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(off.guidelines.some((g) => g.includes("rows are dead anchors"))).toBe(false);
  });

  it("withReplacePrompts drops the replace_match cross-reference when the tool is off", () => {
    const on = withReplacePrompts(replaceBase, DEFAULT_EDIT_FLAGS);
    expect(on.description).toContain("use `replace_match` instead");
    const off = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, replaceMatchEnabled: false });
    expect(off.description).not.toContain("replace_match");
    expect(off.description).toContain("Replace a range of lines");
  });

  it("moves the batch wording into a shared guideline and uses the result wording when auto-read is off", () => {
    const on = withReplacePrompts(replaceBase, DEFAULT_EDIT_FLAGS);
    expect(on.guidelines.some((g) => g.includes("combined diff"))).toBe(true);
    const off = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(off.guidelines.some((g) => g.includes("combined result"))).toBe(true);
    expect(off.guidelines.some((g) => g.includes("combined diff"))).toBe(false);
  });

  it("moves the insert batch wording into the shared edit guideline when auto-read is off", () => {
    const on = withInsertPrompts(insertBase, DEFAULT_EDIT_FLAGS);
    expect(on.guidelines.some((g) => g.includes("combined diff"))).toBe(true);
    expect(on.description).not.toContain("combined");
    const off = withInsertPrompts(insertBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(off.guidelines.some((g) => g.includes("combined result"))).toBe(true);
  });

  it("withUndoPrompts keeps diff detail when auto-read is on and neutralizes when off", () => {
    const on = withUndoPrompts(undoBase, DEFAULT_EDIT_FLAGS);
    expect(on.guidelines.some((g) => g.includes("bad diff"))).toBe(true);
    const off = withUndoPrompts(undoBase, { ...DEFAULT_EDIT_FLAGS, autoRead: false });
    expect(off.guidelines.some((g) => g.includes("bad diff"))).toBe(false);
    expect(off.guidelines.some((g) => g.includes("bad edit"))).toBe(true);
  });

  it("withUndoPrompts drops disabled tools from its operation lists", () => {
    const off = withUndoPrompts(undoBase, { ...DEFAULT_EDIT_FLAGS, replaceMatchEnabled: false, copyMoveEnabled: false });
    expect(off.description).not.toContain("copy");
    expect(off.description).not.toContain("replace_match");
    expect(off.description).not.toContain("or move");
    expect(off.description).toContain("replace or insert");
    expect(off.snippet).not.toContain("copy");
    expect(off.snippet).not.toContain("replace_match");
    expect(off.guidelines.some((g) => g.includes("replace_match"))).toBe(false);
    expect(off.guidelines.some((g) => g.includes("cross-file `move`"))).toBe(false);
  });

  it("withUndoPrompts keeps the full operation list when both toggles are on", () => {
    const on = withUndoPrompts(undoBase, DEFAULT_EDIT_FLAGS);
    expect(on.description).toContain("replace, replace_match, insert, copy, or move");
    expect(on.snippet).toContain("`replace`, `replace_match`, `insert`, `copy`, or `move`");
    expect(on.guidelines.some((g) => g.includes("cross-file `move`"))).toBe(true);
  });

  it("withInsertPrompts adds the require-path and strict-input notices", () => {
    const result = withInsertPrompts(insertBase, { ...DEFAULT_EDIT_FLAGS, requirePath: true, strictInput: true });
    expect(result.guidelines.some((g) => g.includes("pass `path` matching the file the anchors were served for"))).toBe(true);
    expect(result.snippet).not.toContain("include `path` (required)");
    expect(result.guidelines.some((g) => g.includes("strict-input mode is on"))).toBe(true);
  });

  it("withReplaceMatchPrompts adds the require-path and strict-input notices", () => {
    const result = withReplaceMatchPrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, requirePath: true, strictInput: true });
    expect(result.guidelines.some((g) => g.includes("pass `path` matching the file the anchors were served for"))).toBe(true);
    expect(result.guidelines.some((g) => g.includes("strict-input mode is on"))).toBe(true);
  });

  it("withReplaceMatchPrompts keeps its own guideline first and names only enabled tools", () => {
    const on = withReplaceMatchPrompts(withinBase, DEFAULT_EDIT_FLAGS);
    const off = withReplaceMatchPrompts(withinBase, { ...DEFAULT_EDIT_FLAGS, copyMoveEnabled: false });
    expect(on.guidelines[0]).toBe(withinBase.guidelines[0]);
    expect(off.guidelines[0]).toBe(withinBase.guidelines[0]);
    expect(off.guidelines.some((g) => g.includes("`copy`") || g.includes("`move`"))).toBe(false);
  });

  it("names every tool a shared edit guideline applies to", () => {
    const result = withReplacePrompts(replaceBase, DEFAULT_EDIT_FLAGS);
    const shared = result.guidelines.join("\n");
    expect(shared).toContain("`replace`/`replace_match`/`insert`/`copy`/`move`: same-file calls in one message are grouped into one batch");
    expect(shared).toContain("`replace`/`replace_match`/`insert`/`copy`/`move`: path resolution is anchor-only");
    expect(shared).toContain("`replace`/`replace_match`/`insert`: JSON decoding happens once");
    expect(shared).toContain("`replace`/`replace_match`/`insert`/`copy`/`move`/`undo_last_change`: in the post-edit diff, `-anchor│` rows are dead anchors");
    const transfer = withTransferPrompts({
      description: loadP("../prompts/copy.md"),
      snippet: loadP("../prompts/copy-snippet.md"),
      guidelines: loadGuide("../prompts/copy-guidelines.md"),
    }, DEFAULT_EDIT_FLAGS);
    expect(transfer.guidelines.some((g) => g.includes("JSON decoding"))).toBe(false);
  });

  it("keeps tool descriptions free of examples and moves the fragment guidance into the replace_match guideline", () => {
    for (const file of ["replace.md", "replace-match.md", "insert.md", "copy.md", "move.md", "read.md", "grep.md", "undo-last-change.md"]) {
      expect(loadP(`../prompts/${file}`)).not.toContain("Example:");
    }
    expect(loadGuide("../prompts/replace-match-guidelines.md").some((g) => g.includes("fragment of the line"))).toBe(true);
  });

  it("withGrepPrompts drops copy and move when Copy/move is off", () => {
    const on = withGrepPrompts(grepBase, DEFAULT_EDIT_FLAGS);
    expect(on.description).toContain("replace, insert, copy, or move");
    const off = withGrepPrompts(grepBase, { ...DEFAULT_EDIT_FLAGS, copyMoveEnabled: false });
    expect(off.description).not.toContain("copy");
    expect(off.description).not.toContain("or move");
    expect(off.description).toContain("replace or insert");
  });

  it("withGrepPrompts keeps the anchor-first search guideline", () => {
    const result = withGrepPrompts(grepBase, DEFAULT_EDIT_FLAGS);
    expect(result.guidelines.some((guideline) => guideline.includes("prefer it over shell"))).toBe(true);
  });

  it("withReadPrompts lists only the enabled edit tools in its first guideline", () => {
    const all = withReadPrompts(readBase, DEFAULT_EDIT_FLAGS);
    expect(all.guidelines[0]).toBe("Prefer the hashline tools for anything that touches files: `read`, `replace`, `replace_match`, `insert`, `copy`, `move`, or `undo_last_change`.");
    const noWithin = withReadPrompts(readBase, { ...DEFAULT_EDIT_FLAGS, replaceMatchEnabled: false });
    expect(noWithin.guidelines[0]).not.toContain("replace_match");
    const noTransfer = withReadPrompts(readBase, { ...DEFAULT_EDIT_FLAGS, copyMoveEnabled: false });
    expect(noTransfer.guidelines[0]).not.toContain("`copy`");
    expect(noTransfer.guidelines[0]).not.toContain("`move`");
    expect(noTransfer.guidelines[0]).toContain("`replace_match`");
  });

  it("withReadPrompts prepends the preference line and keeps the read guidelines when auto-read-all is off", () => {
    const result = withReadPrompts(readBase, DEFAULT_EDIT_FLAGS);
    expect(result.description).toBe(readBase.description);
    expect(result.snippet).toBe(readBase.snippet);
    expect(result.guidelines[0]).toContain("Prefer the hashline tools for anything that touches files:");
    expect(result.guidelines.slice(1)).toEqual(readBase.guidelines);
  });

  it("withReadPrompts drops the re-read note when auto-read-all is on", () => {
    const result = withReadPrompts(readBase, { ...DEFAULT_EDIT_FLAGS, autoReadAllActive: true });
    expect(result.guidelines.some((g) => g.includes("call again after an edit"))).toBe(false);
    expect(result.guidelines[0]).toContain("Prefer the hashline tools for anything that touches files:");
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
    expect(result.guidelines.some((g) => g.includes("path resolution is anchor-only; do not pass `path`."))).toBe(true);
  });

  it("withTransferPrompts adds the require-path and strict-input notices", () => {
    const base = {
      description: loadP("../prompts/move.md"),
      snippet: loadP("../prompts/move-snippet.md"),
      guidelines: loadGuide("../prompts/move-guidelines.md"),
    };
    const result = withTransferPrompts(base, { ...DEFAULT_EDIT_FLAGS, requirePath: true, strictInput: true });
    expect(result.guidelines.some((g) => g.includes("pass `path` matching the file the anchors were served for"))).toBe(true);
    expect(result.guidelines.some((g) => g.includes("strict-input mode is on"))).toBe(true);
    expect(result.snippet).not.toContain("include `path` (required)");
  });
});

describe("codemode prompt variants", () => {
  it("adds the script batch wording and result contract only when codemode is active", () => {
    const off = withReplacePrompts(replaceBase, DEFAULT_EDIT_FLAGS);
    const on = withReplacePrompts(replaceBase, { ...DEFAULT_EDIT_FLAGS, codemode: true });
    expect(off.guidelines.some((g) => g.includes("Script calls apply immediately"))).toBe(false);
    expect(off.guidelines.some((g) => g.includes("failures resolve to"))).toBe(false);
    expect(on.guidelines.some((g) => g.includes("Script calls apply immediately in order"))).toBe(true);
    expect(on.guidelines.some((g) => g.includes("failures resolve to"))).toBe(true);
    expect(on.guidelines.some((g) => g.includes("same-file calls in one message are grouped into one batch"))).toBe(true);
  });

  it("adds the result contract to read, grep, and undo only when codemode is active", () => {
    const pairs: Array<[typeof withReadPrompts, typeof readBase]> = [
      [withReadPrompts, readBase],
      [withGrepPrompts, grepBase],
      [withUndoPrompts, undoBase],
    ];
    for (const [build, base] of pairs) {
      expect(build(base, DEFAULT_EDIT_FLAGS).guidelines.some((g) => g.includes("failures resolve to"))).toBe(false);
      expect(build(base, { ...DEFAULT_EDIT_FLAGS, codemode: true }).guidelines.some((g) => g.includes("failures resolve to"))).toBe(true);
    }
  });

  it("adds the script transfer and undo notes only when codemode is active", () => {
    const transferBase = {
      description: loadP("../prompts/copy.md"),
      snippet: loadP("../prompts/copy-snippet.md"),
      guidelines: loadGuide("../prompts/copy-guidelines.md"),
    };
    const transferOff = withTransferPrompts(transferBase, DEFAULT_EDIT_FLAGS);
    const transferOn = withTransferPrompts(transferBase, { ...DEFAULT_EDIT_FLAGS, codemode: true });
    expect(transferOff.guidelines.some((g) => g.includes("never joins a batch"))).toBe(false);
    expect(transferOn.guidelines.some((g) => g.includes("never joins a batch"))).toBe(true);
    const undoOff = withUndoPrompts(undoBase, DEFAULT_EDIT_FLAGS);
    const undoOn = withUndoPrompts(undoBase, { ...DEFAULT_EDIT_FLAGS, codemode: true });
    expect(undoOff.guidelines.some((g) => g.includes("takes the undo slot"))).toBe(false);
    expect(undoOn.guidelines.some((g) => g.includes("takes the undo slot"))).toBe(true);
    expect(undoOff.guidelines.some((g) => g.includes("one slot per file"))).toBe(true);
  });
});
