import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { gcRegistrySidecars, resetRegistryForTests } from "../../src/anchor-registry";
import { sessionClaimsDir } from "../../src/paths";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    open: vi.fn(actual.open),
    stat: vi.fn(actual.stat),
    rm: vi.fn(actual.rm),
  };
});

let dir: string;

beforeEach(async () => {
  resetRegistryForTests();
  const root = resolve(".tmp");
  await mkdir(root, { recursive: true });
  dir = await mkdtemp(join(root, "registry-gc-errors-"));
  vi.stubEnv("PI_HASHLINE_DIR", dir);
  await mkdir(sessionClaimsDir());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetRegistryForTests();
  rmSync(dir, { recursive: true, force: true });
});

const operations = ["list", "read", "session-stat", "remove", "temp-stat", "temp-remove"] as const;

async function sidecarFor(operation: typeof operations[number]): Promise<{ path: string; content: string }> {
  const temporary = operation.startsWith("temp-");
  const path = join(sessionClaimsDir(), temporary ? "old.registry.jsonl.compact-test" : "old.registry.jsonl");
  const content = JSON.stringify({ kind: "session", sessionFile: join(dir, "missing-session.jsonl") }) + "\n";
  await writeFile(path, content);
  if (temporary) await utimes(path, new Date(0), new Date(0));
  return { path, content };
}

function failOperation(operation: typeof operations[number], error: Error): void {
  switch (operation) {
    case "list": vi.mocked(readdir).mockRejectedValueOnce(error); break;
    case "read": vi.mocked(open).mockRejectedValueOnce(error); break;
    case "session-stat":
    case "temp-stat": vi.mocked(stat).mockRejectedValueOnce(error); break;
    case "remove":
    case "temp-remove": vi.mocked(rm).mockRejectedValueOnce(error); break;
  }
}

describe.each(["EPERM", "EACCES"])("registry GC with %s", (code) => {
  it.each(operations)("preserves sidecars without logging on %s failure", async (operation) => {
    const { path, content } = await sidecarFor(operation);
    failOperation(operation, Object.assign(new Error("permission denied"), { code }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(gcRegistrySidecars()).resolves.toBeUndefined();
    expect(await readFile(path, "utf-8")).toBe(content);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });
});

describe("registry GC unexpected errors", () => {
  it.each(operations)("keeps %s failures observable", async (operation) => {
    const { path, content } = await sidecarFor(operation);
    const error = Object.assign(new Error("I/O error"), { code: "EIO" });
    failOperation(operation, error);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    if (operation === "remove") {
      await expect(gcRegistrySidecars()).rejects.toBe(error);
    } else {
      await gcRegistrySidecars();
      expect(errors).toHaveBeenCalledWith(expect.any(String), error);
    }
    expect(await readFile(path, "utf-8")).toBe(content);
  });
});
