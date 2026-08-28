import type { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";

type HashStoreModule = typeof import("../../src/hash-store");

const PROCESS_EVENTS = ["exit", "SIGINT", "SIGTERM"] as const;
const processEmitter: EventEmitter = process;
const BALLAST_BYTES = 32 * 1024 * 1024;
const READ_ALLOWANCE_BYTES = 16 * 1024 * 1024;

function createBallast(storePath: string): void {
  const db = new DatabaseSync(storePath);
  try {
    db.exec("CREATE TABLE ballast (payload BLOB NOT NULL)");
    db.prepare("INSERT INTO ballast(payload) VALUES (zeroblob(?))").run(BALLAST_BYTES);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

async function processReadChars(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  const io = await readFile("/proc/self/io", "utf8");
  const match = io.match(/^rchar:\s+(\d+)$/m);
  return match ? Number(match[1]) : undefined;
}

function listenerCounts(): Record<(typeof PROCESS_EVENTS)[number], number> {
  return Object.fromEntries(
    PROCESS_EVENTS.map((event) => [event, processEmitter.listenerCount(event)]),
  ) as Record<(typeof PROCESS_EVENTS)[number], number>;
}

async function storeFdCount(storePath: string): Promise<number> {
  if (process.platform !== "linux") return 0;
  let count = 0;
  for (const entry of await readdir("/proc/self/fd")) {
    let target: string;
    try {
      target = await readlink(`/proc/self/fd/${entry}`);
    } catch {
      continue;
    }
    if (target === storePath || target.startsWith(`${storePath}-`)) count++;
  }
  return count;
}

describe("hash-store Jiti lifecycle", () => {
  it("rebinds eight generations without retaining handles or repeating full-store work", async () => {
    const tempRoot = resolve(".tmp");
    await mkdir(tempRoot, { recursive: true });
    const home = await mkdtemp(join(tempRoot, "hash-store-jiti-"));
    const storePath = join(home, ".config", "pi-hashline-edit-pro", "hash-store.sqlite");
    const priorHome = process.env.HOME;
    const priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = "";
    await mkdir(dirname(storePath), { recursive: true });
    createBallast(storePath);
    const readCharsBefore = await processReadChars();

    const baselineListeners = listenerCounts();
    const baselineFds = await storeFdCount(storePath);
    const generations: HashStoreModule[] = [];
    let maintenanceBefore: ReturnType<HashStoreModule["getHashStoreDiagnostics"]> | undefined;

    try {
      for (let generation = 0; generation < 8; generation++) {
        const jiti = createJiti(`${import.meta.url}?generation=${generation}`, {
          fsCache: false,
          moduleCache: false,
        });
        const hashStore = await jiti.import<HashStoreModule>(resolve("src/hash-store.ts"));
        generations.push(hashStore);
        maintenanceBefore ??= hashStore.getHashStoreDiagnostics();

        const store = await hashStore.loadHashStore();
        expect(await storeFdCount(storePath)).toBeGreaterThan(baselineFds);
        await hashStore.runHashStoreStartupMaintenance(store);
        expect(hashStore.getHashStoreDiagnostics()).toMatchObject({ phase: "open", opens: 1, closes: 0 });

        await hashStore.shutdownHashStore();

        expect(hashStore.getHashStoreDiagnostics()).toMatchObject({ phase: "closed", opens: 1, closes: 1 });
        expect(await storeFdCount(storePath)).toBe(baselineFds);
        expect(listenerCounts()).toEqual(baselineListeners);
      }

      const after = generations.at(-1)!.getHashStoreDiagnostics();
      expect(after.fullHealthChecks - maintenanceBefore!.fullHealthChecks).toBe(1);
      expect(after.pruneRuns - maintenanceBefore!.pruneRuns).toBe(1);
      const readCharsAfter = await processReadChars();
      if (readCharsBefore !== undefined && readCharsAfter !== undefined) {
        expect(readCharsAfter - readCharsBefore).toBeLessThanOrEqual(BALLAST_BYTES + READ_ALLOWANCE_BYTES);
      }
    } finally {
      await Promise.allSettled(generations.map((generation) => generation.shutdownHashStore()));
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
      await rm(home, { recursive: true, force: true });
    }
  });
});
