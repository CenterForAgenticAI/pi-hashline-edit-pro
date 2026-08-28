import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  openError: null as Error | null,
  busyOnce: null as Error | null,
  persistentBusy: false,
  runCalls: 0,
  quickCheckCalls: 0,
  quickCheckResults: [] as string[],
  quickCheckError: null as Error | null,
  rename: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => { await state.mkdirGate; }),
  mkdirGate: null as Promise<void> | null,
  chmodError: null as Error | null,
  chmod: vi.fn(async (path: string) => {
    if (state.chmodError && path.endsWith("hash-store.sqlite")) throw state.chmodError;
  }),
  closeCalls: 0,
  readFile: vi.fn(async () => {
    const err = new Error("no such file") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }),
}));

function busyError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  }) as Error;
}

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor() {
      if (state.openError) throw state.openError;
    }
    get isOpen() {
      return true;
    }
    exec() {}
    prepare(sql: string) {
      if (sql.includes("SELECT value FROM meta WHERE key = 'version'")) {
        return { get: () => ({ value: "4" }) };
      }
      if (sql.includes("PRAGMA quick_check")) {
        return {
          get: () => {
            state.quickCheckCalls++;
            if (state.quickCheckError) throw state.quickCheckError;
            return { quick_check: state.quickCheckResults.shift() ?? "ok" };
          },
        };
      }
      return {
        get: () => undefined,
        all: () => [],
        run: () => {
          state.runCalls++;
          if (state.busyOnce) {
            const err = state.busyOnce;
            if (!state.persistentBusy) state.busyOnce = null;
            throw err;
          }
        },
      };
    }
    close() { state.closeCalls++; }
  },
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    rename: state.rename,
    mkdir: state.mkdir,
    chmod: state.chmod,
    readFile: state.readFile,
  };
});

let tmpHome: string;

beforeAll(async () => {
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "hash-store-open-errors-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  const { initHasher } = await import("../../src/hashline/hasher");
  await initHasher();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  state.openError = null;
  state.chmodError = null;
  state.closeCalls = 0;
  state.mkdirGate = null;
  state.busyOnce = null;
  state.persistentBusy = false;
  state.runCalls = 0;
  state.quickCheckCalls = 0;
  state.quickCheckResults.length = 0;
  state.quickCheckError = null;
  vi.clearAllMocks();
});

describe("hash store open error handling", () => {
  it("does not quarantine the store on a busy open error", async () => {
    state.openError = busyError("database is locked");
    const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store");
    await shutdownHashStore();
    await expect(loadHashStore()).rejects.toThrow(/locked/);
    expect(state.rename).not.toHaveBeenCalled();
  });

  it("does not quarantine the store on a permission open error", async () => {
    state.openError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    }) as Error;
    const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store");
    await shutdownHashStore();
    await expect(loadHashStore()).rejects.toThrow(/permission denied/);
    expect(state.rename).not.toHaveBeenCalled();
  });

  it("closes a database when setup fails after opening", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    state.closeCalls = 0;
    state.chmodError = Object.assign(new Error("permission denied after open"), {
      code: "EACCES",
    });

    await expect(hashStore.loadHashStore()).rejects.toThrow("permission denied after open");

    expect(state.closeCalls).toBe(1);
    expect(hashStore.getHashStoreDiagnostics().phase).toBe("closed");
  });

  it("does not publish a connection that finishes opening after shutdown", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();

    let releaseMkdir!: () => void;
    state.mkdirGate = new Promise<void>((resolve) => {
      releaseMkdir = resolve;
    });
    const loading = hashStore.loadHashStore();
    await vi.waitFor(() => expect(state.mkdir).toHaveBeenCalled());

    const closing = hashStore.shutdownHashStore();
    releaseMkdir();
    try {
      await expect(loading).rejects.toThrow("Hash store closed while opening");
      await closing;
      expect(() => hashStore.withStore(() => {})).toThrow(hashStore.STORE_NOT_OPEN_MESSAGE);
    } finally {
      await loading.catch(() => undefined);
      await hashStore.shutdownHashStore();
    }
  });

  it("runs the full health check once per process and store path", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    const priorHome = process.env.HOME;
    process.env.HOME = join(tmpHome, "health-check-once");
    try {
      await hashStore.loadHashStore();
      await hashStore.shutdownHashStore();
      await hashStore.loadHashStore();
      expect(state.quickCheckCalls).toBe(1);
    } finally {
      await hashStore.shutdownHashStore();
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("propagates non-corruption quick_check errors and retries immediately", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    const priorHome = process.env.HOME;
    process.env.HOME = join(tmpHome, "health-check-error");
    const quickCheckError = new Error("quick check unavailable");
    state.quickCheckError = quickCheckError;
    try {
      await expect(hashStore.loadHashStore()).rejects.toBe(quickCheckError);
      expect(state.rename).not.toHaveBeenCalled();
      state.quickCheckError = null;
      await expect(hashStore.loadHashStore()).resolves.toBeDefined();
      expect(state.quickCheckCalls).toBe(2);
    } finally {
      await hashStore.shutdownHashStore();
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("rebuilds and rechecks when the full health check reports corruption", async () => {
    const hashStore = await import("../../src/hash-store");
    await hashStore.shutdownHashStore();
    const priorHome = process.env.HOME;
    process.env.HOME = join(tmpHome, "health-check-rebuild");
    state.quickCheckResults.push("database disk image is malformed", "ok");
    try {
      await expect(hashStore.loadHashStore()).resolves.toBeDefined();
      expect(state.quickCheckCalls).toBe(2);
      expect(state.rename).toHaveBeenCalledWith(
        expect.stringMatching(/hash-store\.sqlite$/),
        expect.stringMatching(/\.corrupt-/),
      );
    } finally {
      await hashStore.shutdownHashStore();
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("quarantines and rebuilds on a NOTADB open error", async () => {
    state.openError = Object.assign(new Error("file is not a database"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 26,
    }) as Error;
    const { loadHashStore, shutdownHashStore } = await import("../../src/hash-store");
    await shutdownHashStore();
    await expect(loadHashStore()).rejects.toThrow(/not a database/);
    expect(state.rename).toHaveBeenCalledWith(
      expect.stringMatching(/hash-store\.sqlite$/),
      expect.stringMatching(/\.corrupt-/),
    );
  });

  it("retries a transient busy error on statement execution", async () => {
    const { loadHashStore, shutdownHashStore, upsertSnapshot } = await import("../../src/hash-store");
    await shutdownHashStore();
    const store = await loadHashStore();
    state.busyOnce = busyError("database is locked");
    expect(() => {
      upsertSnapshot(store, "/p.ts", "checksum", 1, ["AAA"]);
    }).not.toThrow();
    expect(state.runCalls).toBeGreaterThan(1);
  });

  it("propagates a persistent busy error after exhausting retries", async () => {
    const { loadHashStore, shutdownHashStore, upsertSnapshot } = await import("../../src/hash-store");
    await shutdownHashStore();
    const store = await loadHashStore();
    state.busyOnce = busyError("database is locked");
    state.persistentBusy = true;
    const callsBefore = state.runCalls;
    expect(() => {
      upsertSnapshot(store, "/p.ts", "checksum", 1, ["AAA"]);
    }).toThrow(/locked/);
    expect(state.runCalls - callsBefore).toBe(4);
  });
});

describe("isCorruptionError", () => {
  it("classifies NOTADB, CORRUPT, and FORMAT errcodes as corruption", async () => {
    const { isCorruptionError } = await import("../../src/hash-store");
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 26 }))).toBe(true);
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 11 }))).toBe(true);
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 24 }))).toBe(true);
  });

  it("classifies busy, locked, and permission errors as non-corruption", async () => {
    const { isCorruptionError } = await import("../../src/hash-store");
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 5 }))).toBe(false);
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 6 }))).toBe(false);
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 14 }))).toBe(false);
    expect(isCorruptionError(Object.assign(new Error("EACCES"), { code: "EACCES" }))).toBe(false);
  });

  it("matches corruption by message text", async () => {
    const { isCorruptionError } = await import("../../src/hash-store");
    expect(isCorruptionError(new Error("database disk image is malformed"))).toBe(true);
    expect(isCorruptionError(new Error("file is not a database"))).toBe(true);
    expect(isCorruptionError(new Error("database is locked"))).toBe(false);
  });
});
