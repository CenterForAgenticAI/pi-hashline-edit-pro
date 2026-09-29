import { describe, expect, it } from "vitest";
import { ANCHOR_COUNT, anchorAt } from "../../src/hashline/alphabet";
import {
  foldRegistryEvents,
  formatAnchorReclaimNotice,
  mintAnchor,
  reclaimAnchorSpace,
  resetRegistryForTests,
  takeReclaimedPaths,
} from "../../src/anchor-registry";
import { ANCHOR_RECLAIM_WARNING_CODE, MAX_RECLAIMED_PATHS_REPORTED } from "../../src/constants";

type Entry = { path: string; checksum: string };

interface SaturatingOwned {
  readonly size: number;
  has(anchor: string): boolean;
  get(anchor: string): Entry | undefined;
  set(anchor: string, entry: Entry): unknown;
  delete(anchor: string): boolean;
  clear(): void;
  keys(): Iterable<string>;
  values(): Iterable<Entry>;
  entries(): Iterable<[string, Entry]>;
  [Symbol.iterator](): IterableIterator<[string, Entry]>;
}

function saturatedState(entries: Array<{ path: string; anchors: string[]; usedAt: number }>) {
  const owned = new Map<string, Entry>();
  for (const entry of entries) {
    for (const anchor of entry.anchors) owned.set(anchor, { path: entry.path, checksum: `ck:${anchor}` });
  }
  const released = new Set<string>();
  const ownedView: SaturatingOwned = {
    get size() {
      return ANCHOR_COUNT;
    },
    has: (anchor) => !released.has(anchor),
    get: (anchor) => owned.get(anchor),
    set: (anchor, entry) => {
      owned.set(anchor, entry);
      released.delete(anchor);
      return ownedView;
    },
    delete: (anchor) => {
      released.add(anchor);
      return owned.delete(anchor);
    },
    clear: () => {
      for (const anchor of owned.keys()) released.add(anchor);
      owned.clear();
    },
    keys: () => owned.keys(),
    values: () => owned.values(),
    entries: () => owned.entries(),
    [Symbol.iterator]: () => owned.entries(),
  };
  const served = new Map<string, Map<string, string>>();
  const lastUsedAt = new Map<string, number>();
  for (const entry of entries) {
    served.set(entry.path, new Map(entry.anchors.map((anchor) => [anchor, `ck:${anchor}`])));
    lastUsedAt.set(entry.path, entry.usedAt);
  }
  return {
    owned: ownedView,
    served,
    everMinted: new Set<string>(),
    probe: 0,
    allocatedChecksum: new Map<string, string>(),
    lastUsedAt,
    usageClock: 1000,
    reclaimed: [] as string[],
    shadow: false,
  };
}

describe("reclaimAnchorSpace", () => {
  it("evicts the least recently used file and clears its served record", () => {
    const state = saturatedState([
      { path: "/old.ts", anchors: [anchorAt(0), anchorAt(1)], usedAt: 1 },
      { path: "/new.ts", anchors: [anchorAt(2)], usedAt: 5 },
      { path: "/active.ts", anchors: [anchorAt(3)], usedAt: 9 },
    ]);
    const result = reclaimAnchorSpace(state as never, "/active.ts");
    expect(result).toBe("/old.ts");
    expect(state.reclaimed).toEqual(["/old.ts"]);
    expect(state.served.has("/old.ts")).toBe(false);
    expect(state.lastUsedAt.has("/old.ts")).toBe(false);
    expect(state.owned.get(anchorAt(0))).toBeUndefined();
    expect(state.owned.get(anchorAt(1))).toBeUndefined();
    expect(state.owned.get(anchorAt(3))).toBeDefined();
    expect(state.served.has("/new.ts")).toBe(true);
  });

  it("continues with the next least recently used file", () => {
    const state = saturatedState([
      { path: "/old.ts", anchors: [anchorAt(0)], usedAt: 1 },
      { path: "/mid.ts", anchors: [anchorAt(1)], usedAt: 3 },
      { path: "/active.ts", anchors: [anchorAt(2)], usedAt: 9 },
    ]);
    const stateArg = state as never;
    expect(reclaimAnchorSpace(stateArg, "/active.ts")).toBe("/old.ts");
    expect(reclaimAnchorSpace(stateArg, "/active.ts")).toBe("/mid.ts");
    expect(state.reclaimed).toEqual(["/old.ts", "/mid.ts"]);
  });

  it("never evicts the protected path or a shadow state", () => {
    const only = saturatedState([{ path: "/active.ts", anchors: [anchorAt(0)], usedAt: 1 }]);
    expect(reclaimAnchorSpace(only as never, "/active.ts")).toBeUndefined();
    expect(only.reclaimed).toEqual([]);

    const shadow = { ...saturatedState([{ path: "/old.ts", anchors: [anchorAt(1)], usedAt: 1 }]), shadow: true };
    expect(reclaimAnchorSpace(shadow as never)).toBeUndefined();
    expect(shadow.owned.get(anchorAt(1))).toBeDefined();
  });

  it("treats a missing timestamp as the oldest entry", () => {
    const state = saturatedState([
      { path: "/timed.ts", anchors: [anchorAt(0)], usedAt: 10 },
      { path: "/untimed.ts", anchors: [anchorAt(1)], usedAt: 10 },
    ]);
    state.lastUsedAt.delete("/untimed.ts");
    expect(reclaimAnchorSpace(state as never)).toBe("/untimed.ts");
  });
});

describe("mintAnchor reclamation", () => {
  it("mints from the reclaimed file when the pool is saturated", () => {
    const state = saturatedState([
      { path: "/old.ts", anchors: [anchorAt(0), anchorAt(1)], usedAt: 1 },
      { path: "/active.ts", anchors: [anchorAt(2)], usedAt: 9 },
    ]);
    const anchor = mintAnchor(state as never, "/active.ts");
    expect([anchorAt(0), anchorAt(1)]).toContain(anchor);
    expect(state.reclaimed).toEqual(["/old.ts"]);
    expect(state.served.has("/old.ts")).toBe(false);
    expect(state.owned.get(anchorAt(2))).toBeDefined();
  }, 15000);
});

describe("foldRegistryEvents recency", () => {
  it("restores recency from the allocation order in the registry log", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"]] },
      { kind: "allocate", path: "/b.ts", rows: [[anchorAt(1), "ck"]] },
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(2), "ck"]] },
    ]);
    expect(state.lastUsedAt.get("/a.ts")!).toBeGreaterThan(state.lastUsedAt.get("/b.ts")!);
  });

  it("drops recency for paths whose anchors were freed", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"]] },
      { kind: "free", path: "/a.ts" },
    ]);
    expect(state.lastUsedAt.has("/a.ts")).toBe(false);
  });

  it("keeps recency while an anchor of the path survives a partial free", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"], [anchorAt(1), "ck"]] },
      { kind: "free", path: "/a.ts", anchors: [anchorAt(0)] },
    ]);
    expect(state.owned.has(anchorAt(0))).toBe(false);
    expect(state.owned.has(anchorAt(1))).toBe(true);
    expect(state.lastUsedAt.has("/a.ts")).toBe(true);
  });

  it("drops recency when the free event names every anchor of the path", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"]] },
      { kind: "free", path: "/a.ts", anchors: [anchorAt(0)] },
    ]);
    expect(state.lastUsedAt.has("/a.ts")).toBe(false);
  });

  it("clears recency on a clear event", () => {
    const state = foldRegistryEvents([
      { kind: "allocate", path: "/a.ts", rows: [[anchorAt(0), "ck"]] },
      { kind: "clear" },
    ]);
    expect(state.lastUsedAt.size).toBe(0);
  });
});

describe("formatAnchorReclaimNotice", () => {
  it("names the reclaimed files and caps the list", () => {
    const paths = Array.from({ length: MAX_RECLAIMED_PATHS_REPORTED + 3 }, (_, index) => `/p/${index}.ts`);
    const notice = formatAnchorReclaimNotice(paths)!;
    expect(notice.startsWith(ANCHOR_RECLAIM_WARNING_CODE)).toBe(true);
    expect(notice).toContain("/p/0.ts");
    expect(notice).toContain("(+3 more)");
    expect(notice).not.toContain(`/p/${MAX_RECLAIMED_PATHS_REPORTED}.ts`);
  });

  it("deduplicates repeated paths and returns undefined for an empty list", () => {
    expect(formatAnchorReclaimNotice([])).toBeUndefined();
    const notice = formatAnchorReclaimNotice(["/p/0.ts", "/p/0.ts"])!;
    expect(notice).not.toContain("more");
    expect(notice.split("/p/0.ts")).toHaveLength(2);
  });
});

describe("takeReclaimedPaths", () => {
  it("returns an empty list without an active session", () => {
    resetRegistryForTests();
    expect(takeReclaimedPaths()).toEqual([]);
  });
});
