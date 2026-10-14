import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../../src/config";
import { withTempDir, makePiStub } from "../support/fixtures";


async function registerExtension(pi: any) {
  const { default: register } = await import("../../index");
  register(pi);
}

describe("session_start lifecycle", () => {
  it("removes the built-in edit tool while keeping grep", async () => {
    await withTempDir("lifecycle-tools-", async (dir) => {
      const { pi, handlers } = makePiStub();
      pi.setActiveTools(["read", "replace", "edit", "grep", "bash"]);
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeDefined();
      await sessionStart!({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect(pi.getActiveTools()).toEqual(["read", "replace", "grep", "bash"]);
    });
  });

  it("notifies when PI_HASHLINE_DEBUG is enabled", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "1");
    try {
      await withTempDir("lifecycle-debug-", async (dir) => {
        const { pi, handlers, notify } = makePiStub();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify } });
        expect(notify).toHaveBeenCalledWith("Hashline Edit mode active", "info");
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stays silent without PI_HASHLINE_DEBUG", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "0");
    try {
      await withTempDir("lifecycle-quiet-", async (dir) => {
        const { pi, handlers, notify } = makePiStub();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify } });
        expect(notify).not.toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("loads auto-read preference from config", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "0");
    try {
      await withTempDir("lifecycle-config-", async (dir) => {
        const { mkdir, writeFile } = await import("fs/promises");
        const { join } = await import("path");
        await mkdir(join(dir, ".config", "pi-hashline-edit-pro"), { recursive: true });
        await writeFile(
          join(dir, ".config", "pi-hashline-edit-pro", "config.json"),
          JSON.stringify({ autoRead: false }),
          "utf-8",
        );
        const { pi, handlers } = makePiStub();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect((await readConfig()).autoRead).toBe(false);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the sidecar of a session whose file does not exist yet", async () => {
    await withTempDir("lifecycle-pending-session-", async (dir) => {
      const { readFile, readdir } = await import("fs/promises");
      const { join } = await import("path");
      const sessionFile = join(dir, "session.jsonl");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const ctx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "pending" } };
      await handlers.get("session_start")!({}, ctx);
      const { allocateAnchor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      await withAnchorSession(ctx, () => allocateAnchor("a.ts", "ck"));
      const sidecars = await readdir(sessionClaimsDir());
      expect(sidecars).toHaveLength(1);
      const lines = (await readFile(join(sessionClaimsDir(), sidecars[0]!), "utf-8")).split("\n");
      expect(JSON.parse(lines[0]!).kind).toBe("session");
      expect(JSON.parse(lines[1]!).kind).toBe("allocate");
    });
  });
  it("adds the codemode contract guideline only when codemode is active", async () => {
    await withTempDir("lifecycle-codemode-prompts-", async (dir) => {
      const withCode = makePiStub(["read", "replace", "insert", "grep", "undo_last_change", "codemode"]);
      await registerExtension(withCode.pi);
      await withCode.handlers.get("session_start")!({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect((withCode.getTool("read").promptGuidelines as string[]).some((g) => g.includes("failures resolve to"))).toBe(true);

      const withoutCode = makePiStub(["read", "replace", "insert", "grep", "undo_last_change"]);
      await registerExtension(withoutCode.pi);
      await withoutCode.handlers.get("session_start")!({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect((withoutCode.getTool("read").promptGuidelines as string[]).some((g) => g.includes("failures resolve to"))).toBe(false);
    });
  });
});

describe("hashline-config command", () => {
  it("is registered alongside clear-anchors", async () => {
    await withTempDir("lifecycle-config-cmd-", async (dir) => {
      const { pi, handlers, commands, notify } = makePiStub();
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start")!;
      await sessionStart({}, { cwd: dir, ui: { notify } });
      expect(commands.has("hashline-config")).toBe(true);
      expect(commands.has("clear-anchors")).toBe(true);
    });
  });

  it("requires interactive mode", async () => {
    await withTempDir("lifecycle-config-tty-", async (dir) => {
      const { pi, handlers, commands, notify } = makePiStub();
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start")!;
      await sessionStart({}, { cwd: dir, ui: { notify } });
      const command = commands.get("hashline-config");
      expect(command).toBeDefined();
      await command!.handler([], { cwd: dir, hasUI: false, ui: { notify } });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
    });
  });
});

describe("session_shutdown lifecycle", () => {
  it("releases the session's anchor registry", async () => {
    await withTempDir("lifecycle-shutdown-", async (dir) => {
      const { rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const sessionFile = join(dir, "session.jsonl");
      await writeFile(sessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const ctx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "shutdown" } };
      await handlers.get("session_start")!({}, ctx);
      const { allocateAnchor, ownerOf, sessionKeyFor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      const anchor = await withAnchorSession(ctx, () => allocateAnchor("a.ts", "ck"));
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(ctx)!}.registry.jsonl`), { force: true });
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
      expect(await withAnchorSession(ctx, () => ownerOf(anchor))).toBeUndefined();
    });
  });

  it("releases the registry without reading a stale shutdown ctx", async () => {
    await withTempDir("lifecycle-stale-shutdown-", async (dir) => {
      const { rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const sessionFile = join(dir, "session.jsonl");
      await writeFile(sessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const ctx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "stale-shutdown" } };
      await handlers.get("session_start")!({}, ctx);
      const { allocateAnchor, ownerOf, sessionKeyFor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      const anchor = await withAnchorSession(ctx, () => allocateAnchor("a.ts", "ck"));
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(ctx)!}.registry.jsonl`), { force: true });
      const staleCtx = {
        cwd: dir,
        get sessionManager(): never {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, staleCtx);
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, staleCtx);
      const releaseFailures = errors.mock.calls.filter(([message]) => typeof message === "string" && message.includes("Failed to release anchor registry session"));
      expect(releaseFailures).toEqual([]);
      errors.mockRestore();
      expect(await withAnchorSession(ctx, () => ownerOf(anchor))).toBeUndefined();
    });
  });

  it("releases each captured key in session order when teardown lags the next start", async () => {
    await withTempDir("lifecycle-delayed-shutdown-", async (dir) => {
      const { rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const firstSessionFile = join(dir, "first.jsonl");
      const secondSessionFile = join(dir, "second.jsonl");
      await writeFile(firstSessionFile, "", "utf-8");
      await writeFile(secondSessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const firstCtx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => firstSessionFile, getSessionId: () => "delayed-first" } };
      const secondCtx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => secondSessionFile, getSessionId: () => "delayed-second" } };
      await handlers.get("session_start")!({}, firstCtx);
      await handlers.get("session_start")!({}, secondCtx);
      const { allocateAnchor, ownerOf, sessionKeyFor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      const firstAnchor = await withAnchorSession(firstCtx, () => allocateAnchor("a.ts", "ck-a"));
      const secondAnchor = await withAnchorSession(secondCtx, () => allocateAnchor("b.ts", "ck-b"));
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(firstCtx)!}.registry.jsonl`), { force: true });
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(secondCtx)!}.registry.jsonl`), { force: true });
      const staleCtx = {
        cwd: dir,
        get sessionManager(): never {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
      };
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, staleCtx);
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, staleCtx);
      expect(await withAnchorSession(firstCtx, () => ownerOf(firstAnchor))).toBeUndefined();
      expect(await withAnchorSession(secondCtx, () => ownerOf(secondAnchor))).toBeUndefined();
    });
  });
  it("releases the session named by a live shutdown ctx instead of the oldest queued session", async () => {
    await withTempDir("lifecycle-exact-shutdown-", async (dir) => {
      const { rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const firstSessionFile = join(dir, "first.jsonl");
      const secondSessionFile = join(dir, "second.jsonl");
      await writeFile(firstSessionFile, "", "utf-8");
      await writeFile(secondSessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const firstCtx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => firstSessionFile, getSessionId: () => "exact-first" } };
      const secondCtx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => secondSessionFile, getSessionId: () => "exact-second" } };
      await handlers.get("session_start")!({}, firstCtx);
      await handlers.get("session_start")!({}, secondCtx);
      const { allocateAnchor, ownerOf, sessionKeyFor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      const firstAnchor = await withAnchorSession(firstCtx, () => allocateAnchor("a.ts", "ck-a"));
      const secondAnchor = await withAnchorSession(secondCtx, () => allocateAnchor("b.ts", "ck-b"));
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(firstCtx)!}.registry.jsonl`), { force: true });
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(secondCtx)!}.registry.jsonl`), { force: true });
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, secondCtx);
      expect(await withAnchorSession(firstCtx, () => ownerOf(firstAnchor))).toBeDefined();
      expect(await withAnchorSession(secondCtx, () => ownerOf(secondAnchor))).toBeUndefined();
    });
  });

  it("releases a disposed queued session when the shutdown ctx is stale", async () => {
    await withTempDir("lifecycle-probe-shutdown-", async (dir) => {
      const { rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const firstSessionFile = join(dir, "first.jsonl");
      const secondSessionFile = join(dir, "second.jsonl");
      await writeFile(firstSessionFile, "", "utf-8");
      await writeFile(secondSessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      let secondDisposed = false;
      const firstCtx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => firstSessionFile, getSessionId: () => "probe-first" } };
      const secondCtx = {
        cwd: dir,
        ui: { notify: vi.fn() },
        get sessionManager() {
          if (secondDisposed) throw new Error("This extension ctx is stale after session replacement or reload.");
          return { getSessionFile: () => secondSessionFile, getSessionId: () => "probe-second" };
        },
      };
      await handlers.get("session_start")!({}, firstCtx);
      await handlers.get("session_start")!({}, secondCtx);
      const { allocateAnchor, ownerOf, sessionKeyFor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      const firstAnchor = await withAnchorSession(firstCtx, () => allocateAnchor("a.ts", "ck-a"));
      const secondAnchor = await withAnchorSession(secondCtx, () => allocateAnchor("b.ts", "ck-b"));
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(firstCtx)!}.registry.jsonl`), { force: true });
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(secondCtx)!}.registry.jsonl`), { force: true });
      secondDisposed = true;
      const staleCtx = {
        cwd: dir,
        get sessionManager(): never {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
      };
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, staleCtx);
      secondDisposed = false;
      expect(await withAnchorSession(firstCtx, () => ownerOf(firstAnchor))).toBeDefined();
      expect(await withAnchorSession(secondCtx, () => ownerOf(secondAnchor))).toBeUndefined();
    });
  });

  it("keeps a keyed session when a keyless session with a live ctx shuts down", async () => {
    await withTempDir("lifecycle-keyless-shutdown-", async (dir) => {
      const { rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const sessionFile = join(dir, "session.jsonl");
      await writeFile(sessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const keyedCtx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "keyed" } };
      const keylessCtx = { cwd: dir, ui: { notify: vi.fn() } };
      await handlers.get("session_start")!({}, keyedCtx);
      await handlers.get("session_start")!({}, keylessCtx);
      const { allocateAnchor, ownerOf, sessionKeyFor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      const anchor = await withAnchorSession(keyedCtx, () => allocateAnchor("a.ts", "ck"));
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(keyedCtx)!}.registry.jsonl`), { force: true });
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, keylessCtx);
      expect(await withAnchorSession(keyedCtx, () => ownerOf(anchor))).toBeDefined();
    });
  });

  it("captures a session lazily and releases it on a stale shutdown", async () => {
    await withTempDir("lifecycle-lazy-capture-", async (dir) => {
      const { rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const sessionFile = join(dir, "session.jsonl");
      await writeFile(sessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      let disposed = false;
      const ctx = {
        cwd: dir,
        ui: { notify: vi.fn() },
        get sessionManager() {
          if (disposed) throw new Error("This extension ctx is stale after session replacement or reload.");
          return { getSessionFile: () => sessionFile, getSessionId: () => "lazy-capture" };
        },
      };
      const { allocateAnchor, ownerOf, sessionKeyFor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      await handlers.get("message_end")!({ type: "message_end", message: { role: "user", content: [] } }, ctx);
      const anchor = await withAnchorSession(ctx, () => allocateAnchor("a.ts", "ck"));
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(ctx)!}.registry.jsonl`), { force: true });
      disposed = true;
      const staleCtx = {
        cwd: dir,
        get sessionManager(): never {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
      };
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, staleCtx);
      disposed = false;
      expect(await withAnchorSession(ctx, () => ownerOf(anchor))).toBeUndefined();
    });
  });
});

describe("stale context resilience", () => {
  it("ignores late events whose context was disposed", async () => {
    await withTempDir("lifecycle-stale-events-", async (dir) => {
      const { writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const sessionFile = join(dir, "session.jsonl");
      await writeFile(sessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const ctx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "stale-events" } };
      await handlers.get("session_start")!({}, ctx);
      const staleCtx = {
        cwd: dir,
        ui: { notify: vi.fn() },
        get sessionManager(): never {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
      };
      await expect(handlers.get("message_end")!({ type: "message_end", message: { role: "user", content: [] } }, staleCtx)).resolves.toBeUndefined();
      await expect(handlers.get("tool_result")!({ toolName: "read", isError: false, content: [], input: {} }, staleCtx)).resolves.toBeUndefined();
      await expect(handlers.get("before_agent_start")!({}, staleCtx)).resolves.toBeUndefined();
    });
  });
});
