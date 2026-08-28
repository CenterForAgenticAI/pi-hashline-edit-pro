import { describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HashStoreLifecycle, runStoreMaintenanceOnce } from "../../src/hash-store/lifecycle";
import {
  getHashStoreDiagnostics,
  loadHashStore,
  runHashStoreStartupMaintenance,
  shutdownHashStore,
} from "../../src/hash-store";
import { withTempDir } from "../support/fixtures";

const PROCESS_EVENTS = ["exit", "SIGINT", "SIGTERM"] as const;
const processEmitter: EventEmitter = process;

type ProcessEvent = (typeof PROCESS_EVENTS)[number];
type ProcessListener = (...args: any[]) => void;

function captureProcessListeners(): Map<ProcessEvent, Set<ProcessListener>> {
  return new Map(
    PROCESS_EVENTS.map((event) => [event, new Set(processEmitter.listeners(event) as ProcessListener[])]),
  );
}

function removeAddedProcessListeners(before: Map<ProcessEvent, Set<ProcessListener>>): void {
  for (const event of PROCESS_EVENTS) {
    const prior = before.get(event)!;
    for (const listener of processEmitter.listeners(event) as ProcessListener[]) {
      if (!prior.has(listener)) processEmitter.removeListener(event, listener);
    }
  }
}

describe("hash-store lifecycle", () => {
  it("does not add process exit or signal listeners when the store opens", async () => {
    const before = captureProcessListeners();
    try {
      await withTempDir("hash-store-listeners-", async () => {
        await loadHashStore();
        for (const event of PROCESS_EVENTS) {
          expect(processEmitter.listenerCount(event), event).toBe(before.get(event)!.size);
        }
      });
    } finally {
      removeAddedProcessListeners(before);
    }
  });

  it("uses a canonical store path for lifecycle and maintenance keys", async () => {
    await shutdownHashStore();
    await mkdir(".tmp", { recursive: true });
    const relativeConfig = await mkdtemp(join(".tmp", "hash-store-canonical-"));
    const priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = relativeConfig;
    try {
      await loadHashStore();
      expect(getHashStoreDiagnostics().activePath).toBe(
        resolve(relativeConfig, "pi-hashline-edit-pro", "hash-store.sqlite"),
      );
    } finally {
      await shutdownHashStore();
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
      await rm(relativeConfig, { recursive: true, force: true });
    }
  });

  it("runs startup pruning once per process and store path", async () => {
    await withTempDir("hash-store-prune-once-", async () => {
      const before = getHashStoreDiagnostics().pruneRuns;
      const first = await loadHashStore();
      await runHashStoreStartupMaintenance(first);
      await shutdownHashStore();

      const second = await loadHashStore();
      await runHashStoreStartupMaintenance(second);

      expect(getHashStoreDiagnostics().pruneRuns - before).toBe(1);
    });
  });

  it("shares one physical store across concurrent and sequential public loads", async () => {
    await withTempDir("hash-store-public-loads-", async () => {
      await shutdownHashStore();
      const before = getHashStoreDiagnostics();
      const concurrent = await Promise.all(Array.from({ length: 100 }, () => loadHashStore()));
      const sequential = [];
      for (let index = 0; index < 100; index++) sequential.push(await loadHashStore());
      const afterLoad = getHashStoreDiagnostics();

      expect(afterLoad.opens - before.opens).toBe(1);
      expect([...concurrent, ...sequential].every((store) => store === concurrent[0])).toBe(true);

      await shutdownHashStore();
      expect(getHashStoreDiagnostics().closes - before.closes).toBe(1);
    });
  });

  it("shares one physical open across concurrent callers", async () => {
    const value = {};
    const close = vi.fn();
    const open = vi.fn(async () => ({ value, close }));
    const lifecycle = new HashStoreLifecycle(open);

    const stores = await Promise.all(Array.from({ length: 100 }, () => lifecycle.load("/store.sqlite")));

    expect(open).toHaveBeenCalledTimes(1);
    expect(stores.every((store) => store === value)).toBe(true);
    await lifecycle.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle.diagnostics()).toMatchObject({ phase: "closed", opens: 1, closes: 1 });
  });

  it("shares asynchronous shutdown and clears state after a close failure", async () => {
    const closeError = new Error("close failed");
    const close = vi.fn(() => { throw closeError; });
    const lifecycle = new HashStoreLifecycle(async () => ({ value: {}, close }));
    await lifecycle.load("/store.sqlite");

    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();

    expect(second).toBe(first);
    expect(lifecycle.diagnostics().phase).toBe("closing");
    await expect(first).rejects.toBe(closeError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle.diagnostics().phase).toBe("closed");
  });

  it("reports a close failure from an invalidated open", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const closeError = new Error("late close failed");
    const lifecycle = new HashStoreLifecycle(async () => {
      await openGate;
      return { value: {}, close: () => { throw closeError; } };
    });

    const loading = lifecycle.load("/store.sqlite");
    const closing = lifecycle.shutdown();
    const loadingResult = expect(loading).rejects.toBe(closeError);
    const closingResult = expect(closing).rejects.toBe(closeError);
    releaseOpen();

    await Promise.all([loadingResult, closingResult]);
    expect(lifecycle.diagnostics().phase).toBe("closed");
  });

  it("shares one in-progress maintenance run and remembers its success", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(() => gate);
    const path = `/maintenance-single-flight-${process.pid}-${Date.now()}`;

    const first = runStoreMaintenanceOnce("prune", path, task);
    const second = runStoreMaintenanceOnce("prune", path, task);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    await runStoreMaintenanceOnce("prune", path, task);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it("retries maintenance after a failed attempt", async () => {
    const path = `/maintenance-retry-${process.pid}-${Date.now()}`;
    const task = vi.fn()
      .mockRejectedValueOnce(new Error("maintenance failed"))
      .mockResolvedValue(undefined);

    await runStoreMaintenanceOnce("health", path, task).catch(async (error: unknown) => {
      expect(error).toEqual(expect.objectContaining({ message: "maintenance failed" }));
      await runStoreMaintenanceOnce("health", path, task);
    });

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("keeps successful maintenance state across module re-evaluation", async () => {
    const path = `/maintenance-reload-${process.pid}-${Date.now()}`;
    const firstTask = vi.fn();
    await runStoreMaintenanceOnce("health", path, firstTask);

    vi.resetModules();
    const reloaded = await import("../../src/hash-store/lifecycle");
    const secondTask = vi.fn();
    await reloaded.runStoreMaintenanceOnce("health", path, secondTask);

    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(secondTask).not.toHaveBeenCalled();
  });
});
