import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { configDir, configPath, hashStorePath, hashStoreDir, legacyHashStorePath, sessionClaimsDir } from "../../src/paths";
import { withHome } from "../support/fixtures";

beforeEach(() => vi.stubEnv("PI_HASHLINE_DIR", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("configDir", () => {
  it("returns the config directory under home when XDG_CONFIG_HOME is unset", () => {
    const restore = withHome(undefined);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(configDir()).toBe(join(homedir(), ".config", "pi-hashline-edit-pro"));
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      restore();
    }
  });

  it.skipIf(process.platform === "win32")("uses XDG_CONFIG_HOME when set", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    try {
      expect(configDir()).toBe(join("/custom/xdg", "pi-hashline-edit-pro"));
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it("ignores an empty XDG_CONFIG_HOME", () => {
    const restore = withHome(undefined);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "";
    try {
      expect(configDir()).toBe(join(homedir(), ".config", "pi-hashline-edit-pro"));
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      restore();
    }
  });
});

describe("PI_HASHLINE_DIR", () => {
  it("overrides every state path without changing HOME or XDG_CONFIG_HOME", () => {
    const dir = resolve(".tmp", "hashline-scope");
    const home = process.env.HOME;
    const xdg = process.env.XDG_CONFIG_HOME;
    vi.stubEnv("PI_HASHLINE_DIR", dir);
    expect(configDir()).toBe(dir);
    expect(configPath()).toBe(join(dir, "config.json"));
    expect(hashStorePath()).toBe(join(dir, "hash-store.sqlite"));
    expect(hashStoreDir()).toBe(dir);
    expect(legacyHashStorePath()).toBe(join(dir, "hash-store.json"));
    expect(sessionClaimsDir()).toBe(join(dir, "sessions"));
    expect(process.env.HOME).toBe(home);
    expect(process.env.XDG_CONFIG_HOME).toBe(xdg);
  });

  it.each([undefined, ""])("preserves fallback with PI_HASHLINE_DIR=%s", (value) => {
    const expected = configDir();
    vi.stubEnv("PI_HASHLINE_DIR", value);
    expect(configDir()).toBe(expected);
  });

  it.each(["relative", "./relative", "~/state", " "])("rejects nonempty relative directory %s", (value) => {
    vi.stubEnv("PI_HASHLINE_DIR", value);
    for (const path of [configDir, configPath, hashStorePath, hashStoreDir, legacyHashStorePath, sessionClaimsDir]) {
      expect(path).toThrow("[E_CONFIG] PI_HASHLINE_DIR must be an absolute path");
    }
  });
});

describe("configPath", () => {
  it("returns the config file path", () => {
    const path = configPath();
    expect(path).toBe(join(configDir(), "config.json"));
  });
});

describe("hashStorePath", () => {
  it("returns the hash store file path", () => {
    const path = hashStorePath();
    expect(path).toBe(join(configDir(), "hash-store.sqlite"));
  });
});

describe("hashStoreDir", () => {
  it("returns the directory of the hash store path", () => {
    const dir = hashStoreDir();
    expect(dir).toBe(dirname(hashStorePath()));
  });
});
