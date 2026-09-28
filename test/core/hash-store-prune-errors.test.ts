import { mkdirSync } from "node:fs";
import type { HashStore } from "../../src/hash-store";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  statErrors: new Map<string, Error>(),
}));

function statError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code }) as Error;
}

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(async (path: string) => {
      const err = state.statErrors.get(path);
      if (err) throw err;
      return actual.stat(path);
    }),
  };
});

let tmpHome: string;

beforeAll(async () => {
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "hash-store-prune-errors-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  vi.stubEnv("PI_HASHLINE_DIR", "");
  const { initHasher } = await import("../../src/hashline/hasher");
  await initHasher();
});

afterAll(async () => {
  const { shutdownHashStore } = await import("../../src/hash-store");
  shutdownHashStore();
  vi.unstubAllEnvs();
  await rm(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  state.statErrors.clear();
});

afterEach(() => vi.restoreAllMocks());

async function putSnapshot(store: HashStore, path: string, content: string, hashes: string[]): Promise<void> {
  const { upsertSnapshot } = await import("../../src/hash-store");
  const { contentChecksum } = await import("../../src/hashline/hasher");
  const { splitLines } = await import("../../src/utils");
  upsertSnapshot(store, path, contentChecksum(content), splitLines(content).length, hashes);
}

describe("hash-store - pruneMissing error handling", () => {
  it.each(["EACCES", "EPERM"])("keeps snapshots and undo without logging when stat fails with %s", async (code) => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot, upsertUndo, getUndoEntry } = await import("../../src/hash-store");
    shutdownHashStore();
    const store = await loadHashStore();
    const locked = join(tmpHome, "locked.ts");
    await putSnapshot(store, locked, "locked\n", ["ATIm"]);
    const undo = { content: "old", bom: "", ending: "\n", hashes: ["ATIm"], resultContent: "locked\n" };
    upsertUndo(store, locked, undo);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    state.statErrors.set(locked, statError(code, "permission denied"));
    expect(await pruneMissing(store)).not.toContain(locked);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    shutdownHashStore();
    const reopened = await loadHashStore();
    expect(getSnapshot(reopened, locked, "locked\n")).toEqual(["ATIm"]);
    expect(getUndoEntry(reopened, locked)).toEqual(undo);
  });

  it("keeps the snapshot when stat fails with ELOOP", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    shutdownHashStore();
    const store = await loadHashStore();
    const loop = join(tmpHome, "loop.ts");
    await putSnapshot(store, loop, "loop\n", ["BeSR"]);

    const error = statError("ELOOP", "too many symbolic links");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    state.statErrors.set(loop, error);
    await pruneMissing(store);

    expect(errors).toHaveBeenCalledWith("Failed to stat hash store path:", loop, error);
    shutdownHashStore();
    expect(getSnapshot(await loadHashStore(), loop, "loop\n")).toEqual(["BeSR"]);
  });

  it("still prunes paths that stat reports as ENOENT", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    shutdownHashStore();
    const store = await loadHashStore();
    const gone = join(tmpHome, "gone.ts");
    await putSnapshot(store, gone, "gone\n", ["DAfo"]);

    state.statErrors.set(gone, statError("ENOENT", "no such file"));
    await pruneMissing(store);

    expect(getSnapshot(store, gone, "gone\n")).toBeUndefined();
  });

  it("still prunes paths that stat reports as ENOTDIR", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    shutdownHashStore();
    const store = await loadHashStore();
    const blocked = join(tmpHome, "blocked.ts");
    await putSnapshot(store, blocked, "blocked\n", ["EdgA"]);

    state.statErrors.set(blocked, statError("ENOTDIR", "not a directory"));
    await pruneMissing(store);

    expect(getSnapshot(store, blocked, "blocked\n")).toBeUndefined();
  });
});
