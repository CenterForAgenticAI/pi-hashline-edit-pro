import { describe, expect, it } from "vitest";
import { ANCHOR_TOOL_NAMES, modelDisabled, modelLabels } from "../../src/model-gate";

const codex = { provider: "openai", id: "gpt-5.1-codex", api: "openai-codex-responses" };

describe("ANCHOR_TOOL_NAMES", () => {
  it("lists read and the seven anchored edit tools", () => {
    expect(ANCHOR_TOOL_NAMES).toEqual(["read", "replace", "replace_match", "insert", "copy", "move", "anchor_grep", "undo_last_change"]);
  });
});

describe("modelLabels", () => {
  it("builds the bare id, provider/id, and api labels", () => {
    expect(modelLabels(codex)).toEqual(["gpt-5.1-codex", "openai/gpt-5.1-codex", "openai-codex-responses"]);
  });

  it("skips empty parts", () => {
    expect(modelLabels({})).toEqual([]);
    expect(modelLabels({ id: "", provider: "openai", api: "" })).toEqual([]);
    expect(modelLabels({ id: "solo" })).toEqual(["solo"]);
    expect(modelLabels({ provider: "openai", api: "openai-responses" })).toEqual(["openai-responses"]);
  });
});

describe("modelDisabled", () => {
  it("returns false without a model or without globs", () => {
    expect(modelDisabled(undefined, ["openai/*"])).toBe(false);
    expect(modelDisabled(codex, [])).toBe(false);
    expect(modelDisabled({}, ["*"])).toBe(false);
  });

  it("matches provider/id globs", () => {
    expect(modelDisabled(codex, ["openai/*"])).toBe(true);
    expect(modelDisabled(codex, ["openai/gpt-5*"])).toBe(true);
    expect(modelDisabled(codex, ["anthropic/*"])).toBe(false);
    expect(modelDisabled(codex, ["openai"])).toBe(false);
  });

  it("matches bare id globs", () => {
    expect(modelDisabled(codex, ["gpt-5.1-codex"])).toBe(true);
    expect(modelDisabled(codex, ["*gpt*"])).toBe(true);
    expect(modelDisabled(codex, ["gpt-5.1-code?"])).toBe(true);
    expect(modelDisabled(codex, ["gpt-5.1-code??"])).toBe(false);
    expect(modelDisabled(codex, ["claude-*"])).toBe(false);
  });

  it("matches api globs", () => {
    expect(modelDisabled(codex, ["openai-codex-*"])).toBe(true);
    expect(modelDisabled(codex, ["openai-responses"])).toBe(false);
  });

  it("is case-insensitive and treats regex characters literally", () => {
    expect(modelDisabled(codex, ["OPENAI/*"])).toBe(true);
    expect(modelDisabled({ id: "a.b" }, ["a.b"])).toBe(true);
    expect(modelDisabled({ id: "axb" }, ["a.b"])).toBe(false);
    expect(modelDisabled({ id: "gpt+5" }, ["gpt+5"])).toBe(true);
    expect(modelDisabled({ id: "gpt5" }, ["gpt+5"])).toBe(false);
  });

  it("matches when any glob in the list matches", () => {
    expect(modelDisabled(codex, ["anthropic/*", "*gpt*"])).toBe(true);
    expect(modelDisabled(codex, ["anthropic/*", "google/*"])).toBe(false);
  });

  it("reuses compiled globs across many calls", () => {
    for (let index = 0; index < 100; index++) {
      expect(modelDisabled(codex, [`*gpt${"*".repeat(index)}*`])).toBe(true);
    }
    expect(modelDisabled(codex, ["*gpt*"])).toBe(true);
    expect(modelDisabled(codex, ["*claude*"])).toBe(false);
  });
});
