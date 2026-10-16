import { describe, expect, it } from "vitest";
import register from "../../index";
import { makeFakePiRegistry } from "../support/fixtures";

describe("extension registration", () => {
  it("registers the read and replace tools", () => {
    const toolNames: string[] = [];
    const eventNames: string[] = [];
    const commandNames: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      registerCommand(name: string) {
        commandNames.push(name);
      },
      on(name: string) {
        eventNames.push(name);
      },
    } as any;

    register(pi);

    expect(toolNames.sort()).toEqual(["copy", "grep", "insert", "move", "read", "replace", "replace_match", "undo_last_change"]);

    expect(commandNames.sort()).toEqual(["clear-anchors", "hashline-config"]);
    expect(eventNames.sort()).toEqual(["before_agent_start", "message_end", "model_select", "session_shutdown", "session_start", "tool_call", "tool_result", "turn_end"]);
  });
});

describe("tool prompt loading", () => {
  it("loads the replace prompt, snippet, and guidelines", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("replace");
    expect(tool.description).toContain("Replace a range of lines");
    expect(tool.promptSnippet).toContain("Replace lines by anchor");
    expect(tool.promptGuidelines.some((guideline: string) => guideline.includes("remove_from"))).toBe(true);
  });
});
