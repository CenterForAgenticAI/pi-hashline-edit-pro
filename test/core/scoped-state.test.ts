import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir, configPath, hashStorePath, legacyHashStorePath, sessionClaimsDir } from "../../src/paths";
import { getSnapshot, getUndoEntry, loadHashStore, persistSnapshot, shutdownHashStore, upsertUndo } from "../../src/hash-store";
import { allocateAnchor, initRegistry, ownersForPath, resetRegistryForTests } from "../../src/anchor-registry";
import { readConfig, updateConfig } from "../../src/config";
import { getWritableTempRoot } from "../support/fixtures";

let home: string;

beforeEach(async () => {
  shutdownHashStore();
  resetRegistryForTests();
  home = await mkdtemp(join(await getWritableTempRoot(), "scoped-state-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  vi.stubEnv("PI_HASHLINE_DIR", undefined);
});

afterEach(async () => {
  shutdownHashStore();
  resetRegistryForTests();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("scoped state", () => {
  it("keeps config, snapshots, undo and registry independent across store and registry restarts", async () => {
    const target = join(home, "file.ts");
    const session = join(home, "session.jsonl");
    const scopes = [join(home, "a"), join(home, "b")];
    const anchors = new Map<string, string>();
    await writeFile(session, "");
    for (const scope of [...scopes, ...scopes]) {
      shutdownHashStore();
      resetRegistryForTests();
      vi.stubEnv("PI_HASHLINE_DIR", scope);
      const store = await loadHashStore();
      await initRegistry(session);
      const undo = { content: scope, bom: "", ending: "\n", hashes: ["ATIm"], resultContent: "new" };
      if (!anchors.has(scope)) {
        expect(store.stmts.allPaths()).toEqual([]);
        expect(getUndoEntry(store, target)).toBeUndefined();
        expect(ownersForPath(target).size).toBe(0);
        expect((await readConfig()).autoRead).toBe(true);
        await updateConfig((config) => { config.autoRead = scope !== scopes[0]; });
        persistSnapshot(store, target, "same content", [scope === scopes[0] ? "ATIm" : "BeSR"]);
        upsertUndo(store, target, undo);
        anchors.set(scope, allocateAnchor(target, scope));
      }
      expect(getSnapshot(store, target, "same content")).toEqual([scope === scopes[0] ? "ATIm" : "BeSR"]);
      expect(getUndoEntry(store, target)).toEqual(undo);
      expect(ownersForPath(target)).toEqual(new Map([[anchors.get(scope), scope]]));
      expect((await readConfig()).autoRead).toBe(scope !== scopes[0]);
      for (const suffix of ["", "-wal", "-shm"]) {
        expect((await stat(`${hashStorePath()}${suffix}`)).isFile()).toBe(true);
      }
      expect((await readdir(sessionClaimsDir())).some((name) => name.endsWith(".registry.jsonl"))).toBe(true);
      expect(await readFile(configPath(), "utf-8")).toContain('"autoRead"');
    }
    await expect(stat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not import shared legacy history or config, while standalone legacy migration still works", async () => {
    const shared = configDir();
    const legacyPath = legacyHashStorePath();
    const target = join(home, "legacy.ts");
    const legacy = JSON.stringify({ snapshots: { [target]: { content: "old", hashes: ["ATIm"] } } });
    await mkdir(shared, { recursive: true });
    await writeFile(legacyPath, legacy);
    await writeFile(configPath(), JSON.stringify({ autoRead: false }));

    vi.stubEnv("PI_HASHLINE_DIR", join(home, "isolated"));
    const isolated = await loadHashStore();
    expect(isolated.stmts.allPaths()).toEqual([]);
    expect(getSnapshot(isolated, target, "old")).toBeUndefined();
    expect((await readConfig()).autoRead).toBe(true);
    expect(await readFile(legacyPath, "utf-8")).toBe(legacy);
    await expect(stat(`${legacyPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(shared)).toEqual(expect.arrayContaining(["config.json", "hash-store.json"]));

    shutdownHashStore();
    vi.stubEnv("PI_HASHLINE_DIR", undefined);
    const standalone = await loadHashStore();
    expect(getSnapshot(standalone, target, "old")).toEqual(["ATIm"]);
    expect((await readConfig()).autoRead).toBe(false);
    expect(await readFile(`${legacyPath}.bak`, "utf-8")).toBe(legacy);
    await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
