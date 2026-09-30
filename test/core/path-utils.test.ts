import { describe, expect, it } from "vitest";
import * as os from "os";
import { resolve } from "path";
import { toCwd, toDisplayPath } from "../../src/paths";
import { withHome } from "../support/fixtures";

describe("toCwd", () => {
  const cwd = "/home/user/project";

  it("resolves a relative path against cwd", () => {
    expect(toCwd("src/main.ts", cwd)).toBe(
      resolve(cwd, "src/main.ts"),
    );
  });

  it("returns absolute paths unchanged", () => {
    expect(toCwd("/etc/hosts", cwd)).toBe("/etc/hosts");
  });

  it("expands ~ to home directory", () => {
    const restore = withHome(undefined);
    try {
      expect(toCwd("~/file.txt", cwd)).toBe(
        os.homedir() + "/file.txt",
      );
    } finally {
      restore();
    }
  });
  it("expands bare ~ to home directory", () => {
    const restore = withHome(undefined);
    try {
      expect(toCwd("~", cwd)).toBe(os.homedir());
    } finally {
      restore();
    }
  });
  it("preserves a leading @ in relative paths", () => {
    expect(toCwd("@src/main.ts", cwd)).toBe(
      resolve(cwd, "@src/main.ts"),
    );
  });

  it("preserves unicode spaces in file names", () => {
    expect(toCwd("src/my\u00A0file.ts", cwd)).toBe(
      resolve(cwd, "src/my\u00A0file.ts"),
    );
  });

  it("does not treat @~ as home-directory expansion", () => {
    expect(toCwd("@~/notes.md", cwd)).toBe(
      resolve(cwd, "@~/notes.md"),
    );
  });
});

describe("toDisplayPath", () => {
  const cwd = "/home/user/project";

  it("returns a relative path inside the working directory", () => {
    expect(toDisplayPath(cwd, "/home/user/project/src/main.ts")).toBe("src/main.ts");
  });

  it("keeps a relative path that does not climb to the root", () => {
    expect(toDisplayPath(cwd, "/home/user/other/main.ts")).toBe("../other/main.ts");
  });

  it("uses the absolute path when the relative path climbs to the root", () => {
    expect(toDisplayPath(cwd, "/tmp/main.ts")).toBe("/tmp/main.ts");
  });

  it("prefers the provided fallback when the relative path climbs to the root", () => {
    expect(toDisplayPath(cwd, "/tmp/main.ts", "/fallback/main.ts")).toBe("/fallback/main.ts");
  });

  it("keeps a relative path when the working directory is the root", () => {
    expect(toDisplayPath("/", "/tmp/main.ts")).toBe("tmp/main.ts");
  });
});
