import { mkdirSync } from "node:fs";
import type { HashStore } from "../../src/hash-store";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  statErrors: new Map<string, Error>(),
  statPaths: [] as string[],
  statGate: null as Promise<void> | null,
}));

function statError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code }) as Error;
}

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(async (path: string) => {
      state.statPaths.push(path);
      await state.statGate;
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
  const { initHasher } = await import("../../src/hashline/hasher");
  await initHasher();
});

afterAll(async () => {
  const { shutdownHashStore } = await import("../../src/hash-store");
  await shutdownHashStore();
  vi.unstubAllEnvs();
  await rm(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  state.statErrors.clear();
  state.statPaths.length = 0;
  state.statGate = null;
});

async function putSnapshot(store: HashStore, path: string, content: string, hashes: string[]): Promise<void> {
  const { upsertSnapshot } = await import("../../src/hash-store");
  const { contentChecksum } = await import("../../src/hashline/hasher");
  const { splitLines } = await import("../../src/utils");
  upsertSnapshot(store, path, contentChecksum(content), splitLines(content).length, hashes);
}

describe("hash-store - pruneMissing error handling", () => {
  it("keeps the snapshot and served record when stat fails with EACCES", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    const { recordServed, getServed } = await import("../../src/served");
    await shutdownHashStore();
    const store = await loadHashStore();
    const locked = join(tmpHome, "locked.ts");
    await putSnapshot(store, locked, "locked\n", ["AAA"]);
    recordServed(store, locked, ["AAA"]);

    state.statErrors.set(locked, statError("EACCES", "permission denied"));
    await pruneMissing(store);

    expect(getSnapshot(store, locked, "locked\n")).toEqual(["AAA"]);
    expect(getServed(store, locked)).toEqual(new Set(["AAA"]));
  });

  it("does not stat paths retained only for undo", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, upsertUndo } = await import("../../src/hash-store");
    await shutdownHashStore();
    const store = await loadHashStore();
    const undoOnly = join(tmpHome, "undo-only.ts");
    upsertUndo(store, undoOnly, {
      content: "before",
      bom: "",
      ending: "\n",
      hashes: ["UND"],
      resultContent: "after",
    });

    await pruneMissing(store);

    expect(state.statPaths).not.toContain(undoOnly);
  });

  it("invalidates publication immediately but waits for startup maintenance before closing", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    const store = await hashStore.loadHashStore();
    const missing = join(tmpHome, "maintenance-missing.ts");
    await putSnapshot(store, missing, "gone\n", ["MNT"]);

    let releaseStat!: () => void;
    state.statGate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    const maintenance = hashStore.runHashStoreStartupMaintenance(store);
    await vi.waitFor(() => expect(state.statPaths).toContain(missing));
    const closesBeforeShutdown = hashStore.getHashStoreDiagnostics().closes;
    const closing = hashStore.shutdownHashStore();

    try {
      expect(hashStore.getHashStoreDiagnostics()).toMatchObject({ phase: "closing", closes: closesBeforeShutdown });
      expect(() => hashStore.withStore(() => {})).toThrow(hashStore.STORE_NOT_OPEN_MESSAGE);
      await Promise.resolve();
      expect(hashStore.getHashStoreDiagnostics().closes).toBe(closesBeforeShutdown);
      releaseStat();
      await maintenance;
      await closing;
      expect(hashStore.getHashStoreDiagnostics().phase).toBe("closed");
      expect(hashStore.getHashStoreDiagnostics().closes).toBe(closesBeforeShutdown + 1);
    } finally {
      releaseStat();
      await Promise.allSettled([maintenance, closing]);
      await hashStore.shutdownHashStore();
    }
  });

  it("rejects a same-path load settled after shutdown request", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    await hashStore.loadHashStore();

    const pendingLoad = hashStore.loadHashStore();
    const closing = hashStore.shutdownHashStore();

    try {
      await expect(pendingLoad).rejects.toThrow("Hash store closed while opening");
      await closing;
      expect(hashStore.getHashStoreDiagnostics().phase).toBe("closed");
    } finally {
      await Promise.allSettled([pendingLoad, closing]);
      await hashStore.shutdownHashStore();
    }
  });

  it("rejects a same-path load called during shutdown and permits a post-shutdown load", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    await hashStore.loadHashStore();
    const opensBeforeShutdown = hashStore.getHashStoreDiagnostics().opens;

    const closing = hashStore.shutdownHashStore();
    const duringShutdown = hashStore.loadHashStore();

    try {
      expect(hashStore.getHashStoreDiagnostics().phase).toBe("closing");
      await expect(duringShutdown).rejects.toThrow("Hash store closed while opening");
      await closing;
      expect(hashStore.getHashStoreDiagnostics()).toMatchObject({ phase: "closed", opens: opensBeforeShutdown });
      expect(() => hashStore.withStore(() => {})).toThrow(hashStore.STORE_NOT_OPEN_MESSAGE);

      await expect(hashStore.loadHashStore()).resolves.toBeDefined();
      expect(hashStore.getHashStoreDiagnostics().opens).toBe(opensBeforeShutdown + 1);
    } finally {
      await Promise.allSettled([duringShutdown, closing]);
      await hashStore.shutdownHashStore();
    }
  });

  it("rejects a load queued before shutdown after maintenance drains", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    const priorHome = process.env.HOME;
    process.env.HOME = join(tmpHome, "queued-load");
    const store = await hashStore.loadHashStore();
    const missing = join(tmpHome, "queued-load-missing.ts");
    await putSnapshot(store, missing, "gone\n", ["QUE"]);

    let releaseStat!: () => void;
    state.statGate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    const maintenance = hashStore.runHashStoreStartupMaintenance(store);
    await vi.waitFor(() => expect(state.statPaths).toContain(missing));
    const queuedLoad = hashStore.loadHashStore();
    let queuedSettled = false;
    void queuedLoad.then(
      () => { queuedSettled = true; },
      () => { queuedSettled = true; },
    );
    const closing = hashStore.shutdownHashStore();

    try {
      expect(hashStore.getHashStoreDiagnostics().phase).toBe("closing");
      await Promise.resolve();
      expect(queuedSettled).toBe(false);
      releaseStat();
      await maintenance;
      await closing;
      await expect(queuedLoad).rejects.toThrow("Hash store closed while opening");
    } finally {
      releaseStat();
      await Promise.allSettled([maintenance, closing, queuedLoad]);
      await hashStore.shutdownHashStore();
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("finishes maintenance before switching to another store path", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    const priorHome = process.env.HOME;
    const oldHome = join(tmpHome, "path-switch-old");
    const newHome = join(tmpHome, "path-switch-new");
    process.env.HOME = oldHome;
    const store = await hashStore.loadHashStore();
    const missing = join(oldHome, "missing.ts");
    await putSnapshot(store, missing, "gone\n", ["OLD"]);

    let releaseStat!: () => void;
    state.statGate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    const maintenance = hashStore.runHashStoreStartupMaintenance(store);
    await vi.waitFor(() => expect(state.statPaths).toContain(missing));

    process.env.HOME = newHome;
    const nextLoad = hashStore.loadHashStore();
    let nextSettled = false;
    void nextLoad.then(
      () => { nextSettled = true; },
      () => { nextSettled = true; },
    );

    try {
      await Promise.resolve();
      expect(hashStore.getHashStoreDiagnostics()).toMatchObject({
        phase: "open",
        activePath: expect.stringContaining("path-switch-old"),
      });
      expect(nextSettled).toBe(false);
      expect(() => hashStore.withStore(() => {})).not.toThrow();

      releaseStat();
      await maintenance;
      await nextLoad;
      expect(hashStore.getHashStoreDiagnostics()).toMatchObject({
        phase: "open",
        activePath: expect.stringContaining("path-switch-new"),
      });
    } finally {
      releaseStat();
      await Promise.allSettled([maintenance, nextLoad]);
      await hashStore.shutdownHashStore();
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("keeps the snapshot when stat fails with ELOOP", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    await shutdownHashStore();
    const store = await loadHashStore();
    const loop = join(tmpHome, "loop.ts");
    await putSnapshot(store, loop, "loop\n", ["BBB"]);

    state.statErrors.set(loop, statError("ELOOP", "too many symbolic links"));
    await pruneMissing(store);

    expect(getSnapshot(store, loop, "loop\n")).toEqual(["BBB"]);
  });

  it("still prunes paths that stat reports as ENOENT", async () => {
    const { loadHashStore, shutdownHashStore, pruneMissing, getSnapshot } = await import("../../src/hash-store");
    await shutdownHashStore();
    const store = await loadHashStore();
    const gone = join(tmpHome, "gone.ts");
    await putSnapshot(store, gone, "gone\n", ["CCC"]);

    state.statErrors.set(gone, statError("ENOENT", "no such file"));
    await pruneMissing(store);

    expect(getSnapshot(store, gone, "gone\n")).toBeUndefined();
  });
});
