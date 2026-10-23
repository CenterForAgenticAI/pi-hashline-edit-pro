import { beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  deleteUndo,
  getUndoEntry,
  loadHashStore,
  pruneExpiredUndo,
  shutdownHashStore,
  upsertUndo,
  type UndoRecord,
} from "../../src/hash-store";
import { hashStorePath } from "../../src/paths";
import { useTestHome } from "../support/fixtures";

useTestHome();

const DAY_MS = 24 * 60 * 60 * 1000;

function undoEntry(content: string): UndoRecord {
  return { content, bom: "", ending: "\n", hashes: ["atimx"], resultContent: `${content}!` };
}

function ageRecords(ages: Array<[path: string, updatedAt: number]>): void {
  const db = new DatabaseSync(hashStorePath(), { defensive: false } as never);
  try {
    const stmt = db.prepare("UPDATE undo SET updated_at = ? WHERE path = ?");
    for (const [path, updatedAt] of ages) stmt.run(updatedAt, path);
  } finally {
    db.close();
  }
}

async function clearUndoTable(): Promise<void> {
  await loadHashStore();
  const db = new DatabaseSync(hashStorePath(), { defensive: false } as never);
  try {
    db.exec("DELETE FROM undo");
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  await clearUndoTable();
});

describe("pruneExpiredUndo", () => {
  it("removes records older than the retention window and keeps fresh ones", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/old.ts", undoEntry("old"));
    upsertUndo(store, "/fresh.ts", undoEntry("fresh"));
    const now = Date.now();
    ageRecords([["/old.ts", now - 40 * DAY_MS]]);

    expect(pruneExpiredUndo(store, 30, now)).toEqual(["/old.ts"]);
    expect(getUndoEntry(store, "/old.ts")).toBeUndefined();
    expect(getUndoEntry(store, "/fresh.ts")).toBeDefined();
  });

  it("keeps records exactly at the cutoff and removes older ones", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/edge.ts", undoEntry("edge"));
    upsertUndo(store, "/past.ts", undoEntry("past"));
    const now = Date.now();
    ageRecords([
      ["/edge.ts", now - 30 * DAY_MS],
      ["/past.ts", now - 30 * DAY_MS - 1],
    ]);

    expect(pruneExpiredUndo(store, 30, now)).toEqual(["/past.ts"]);
    expect(getUndoEntry(store, "/edge.ts")).toBeDefined();
    expect(getUndoEntry(store, "/past.ts")).toBeUndefined();
  });

  it("keeps every record when retention is disabled or invalid", async () => {
    const store = await loadHashStore();
    upsertUndo(store, "/keep.ts", undoEntry("keep"));
    ageRecords([["/keep.ts", 0]]);

    expect(pruneExpiredUndo(store, 0)).toEqual([]);
    expect(pruneExpiredUndo(store, -1)).toEqual([]);
    expect(pruneExpiredUndo(store, Number.NaN)).toEqual([]);
    expect(getUndoEntry(store, "/keep.ts")).toBeDefined();
  });

  it("returns no paths when the table has nothing to delete", async () => {
    const store = await loadHashStore();
    expect(pruneExpiredUndo(store, 30)).toEqual([]);
  });
});

describe("secure_delete", () => {
  it("overwrites deleted undo content on disk", async () => {
    const store = await loadHashStore();
    const marker = `hashline-secret-${"9f2c".repeat(8)}`;
    upsertUndo(store, "/secret.ts", undoEntry(marker));
    deleteUndo(store, "/secret.ts");
    shutdownHashStore();

    const needle = Buffer.from(marker, "utf-8");
    const storePath = hashStorePath();
    const files = [storePath, `${storePath}-wal`, `${storePath}-shm`];
    for (const file of files) {
      try {
        expect((await readFile(file)).includes(needle), file).toBe(false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  });
});
