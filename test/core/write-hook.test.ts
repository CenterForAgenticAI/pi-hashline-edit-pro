import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { initHasher } from "../../src/hashline";
import { findServedHashEcho, servedHashEchoDenial, registerWriteHook } from "../../src/write-hook";
import { initRegistry, adoptAnchors } from "../../src/anchor-registry";
import { getWritableTempRoot, withTempDir } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});


describe("write-hook findServedHashEcho", () => {
  it("returns undefined when served set is empty", () => {
    expect(findServedHashEcho("atimx│hello\n", new Set())).toBeUndefined();
  });
  it("returns undefined when no line matches served hash", () => {
    expect(findServedHashEcho("atimx│hello\n", new Set(["xY9"]))).toBeUndefined();
  });
  it("returns first matching line and hash", () => {
    const served = new Set(["atimx", "ioorx"]);
    const content = "zzz\nioorx│second\nhasux│third\n";
    const result = findServedHashEcho(content, served);
    expect(result).toEqual({ line: 2, hash: "ioorx" });
  });
  it("matches a hash at the start of a row, not inside content", () => {
    const served = new Set(["atimx"]);
    expect(findServedHashEcho(" xx atimx│hello\n", served)).toBeUndefined();
    expect(findServedHashEcho("atimx│hello\n", served)).toEqual({ line: 1, hash: "atimx" });
  });
  it("handles empty content", () => {
    expect(findServedHashEcho("", new Set(["atimx"]))).toBeUndefined();
  });
  it("matches copied diff-preview rows", () => {
    const served = new Set(["atimx"]);
    expect(findServedHashEcho("+atimx│hello\n", served)).toEqual({ line: 1, hash: "atimx" });
    expect(findServedHashEcho(" atimx│hello\n", served)).toEqual({ line: 1, hash: "atimx" });
    expect(findServedHashEcho("-atimx│hello\n", served)).toEqual({ line: 1, hash: "atimx" });
  });
  it("matches numbered grep rows", () => {
    const served = new Set(["ioorx"]);
    expect(findServedHashEcho("12 │ ioorx│second\n", served)).toEqual({ line: 1, hash: "ioorx" });
    expect(findServedHashEcho("  3 │ ioorx│second\n", served)).toEqual({ line: 1, hash: "ioorx" });
    expect(findServedHashEcho("12:│ ioorx│second\n", served)).toEqual({ line: 1, hash: "ioorx" });
    expect(findServedHashEcho("  3-│ ioorx│second\n", served)).toEqual({ line: 1, hash: "ioorx" });
  });
  it("ignores padded deletion rows without a hash", () => {
    expect(findServedHashEcho("-     │hello\n", new Set(["atimx"]))).toBeUndefined();
  });
});

describe("write-hook servedHashEchoDenial", () => {
  it("returns undefined when no served record exists", async () => {
    await withTempDir("pi-hashline-writehook-test-", async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-no-served-"));
      try {
        const result = await servedHashEchoDenial("test.txt", "atimx│hello\n", dir);
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("returns undefined when served exists but content has no echo", async () => {
    await withTempDir("pi-hashline-writehook-test-", async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-no-echo-"));
      try {
        const filePath = join(dir, "test.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        await initRegistry(join(dir, "session.jsonl"));
        adoptAnchors(filePath, new Map([["atimx", "atimx"]]));
        const result = await servedHashEchoDenial("test.txt", "clean content\n", dir);
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("returns denial string when content contains served hash", async () => {
    await withTempDir("pi-hashline-writehook-test-", async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-echo-"));
      try {
        const filePath = join(dir, "test.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        await initRegistry(join(dir, "session.jsonl"));
        adoptAnchors(filePath, new Map([["atimx", "atimx"]]));
        const result = await servedHashEchoDenial("test.txt", "atimx│copied\n", dir);
        expect(result).toContain("[E_WRITE_HASH_ECHO]");
        expect(result).toContain("atimx│");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("throws when signal is aborted before resolve", async () => {
    await withTempDir("pi-hashline-writehook-test-", async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-abort-"));
      try {
        const controller = new AbortController();
        controller.abort();
        await expect(servedHashEchoDenial("test.txt", "atimx│hello\n", dir, controller.signal)).rejects.toThrow("Operation aborted");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("returns undefined when file has empty served set", async () => {
    await withTempDir("pi-hashline-writehook-test-", async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-empty-set-"));
      try {
        const filePath = join(dir, "empty.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        await initRegistry(join(dir, "session.jsonl"));
        adoptAnchors(filePath, new Map());
        const result = await servedHashEchoDenial("empty.txt", "atimx│hello\n", dir);
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("write-hook registerWriteHook", () => {
  function makePi() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    return {
      pi: {
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
          handlers.set(event, handler);
        },
      } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      handlers,
    };
  }
  it("registers tool_call handler", () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    expect(handlers.has("tool_call")).toBe(true);
  });
  it("ignores non-write tool calls", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    const result = await handler({ toolName: "read", input: { path: "a.txt", content: "hello" } }, { cwd: "/tmp", signal: undefined });
    expect(result).toBeUndefined();
  });
  it("ignores write with non-string path or content", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    expect(await handler({ toolName: "write", input: { path: 123, content: "hello" } }, { cwd: "/tmp", signal: undefined })).toBeUndefined();
    expect(await handler({ toolName: "write", input: { path: "a.txt", content: 123 } }, { cwd: "/tmp", signal: undefined })).toBeUndefined();
    expect(await handler({ toolName: "write", input: null }, { cwd: "/tmp", signal: undefined })).toBeUndefined();
  });
  it("blocks write when echo is detected", async () => {
    await withTempDir("pi-hashline-writehook-test-", async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-block-"));
      try {
        const filePath = join(dir, "blocked.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        await initRegistry(join(dir, "session.jsonl"));
        adoptAnchors(filePath, new Map([["atimx", "atimx"]]));
        const { pi, handlers } = makePi();
        registerWriteHook(pi);
        const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
        const result = await handler({ toolName: "write", input: { path: "blocked.txt", content: "atimx│echo\n" } }, { cwd: dir, signal: undefined });
        expect(result).toEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("[E_WRITE_HASH_ECHO]") }));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("allows write when no echo", async () => {
    await withTempDir("pi-hashline-writehook-test-", async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-allow-"));
      try {
        const filePath = join(dir, "allowed.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        await initRegistry(join(dir, "session.jsonl"));
        adoptAnchors(filePath, new Map([["atimx", "atimx"]]));
        const { pi, handlers } = makePi();
        registerWriteHook(pi);
        const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
        const result = await handler({ toolName: "write", input: { path: "allowed.txt", content: "clean\n" } }, { cwd: dir, signal: undefined });
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("ignores write input with a file_path", async () => {
    await withTempDir("pi-hashline-writehook-test-", async () => {
      const dir = await mkdtemp(join(await getWritableTempRoot(), "writehook-alias-"));
      try {
        const filePath = join(dir, "alias.txt");
        await writeFile(filePath, "hello\n", "utf-8");
        await initRegistry(join(dir, "session.jsonl"));
        adoptAnchors(filePath, new Map([["atimx", "atimx"]]));
        const { pi, handlers } = makePi();
        registerWriteHook(pi);
        const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
        const result = await handler({ toolName: "write", input: { file_path: "alias.txt", content: "atimx│echo\n" } }, { cwd: dir, signal: undefined });
        expect(result).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  it("swallows store failures and allows write", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    const result = await handler({ toolName: "write", input: { path: "missing.txt", content: "atimx│hello\n" } }, { cwd: "/nonexistent_xyz", signal: undefined });
    expect(result).toBeUndefined();
  });
  it("rethrows abort errors", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    const controller = new AbortController();
    controller.abort();
    await expect(handler({ toolName: "write", input: { path: "a.txt", content: "hello" } }, { cwd: "/tmp", signal: controller.signal })).rejects.toThrow("Operation aborted");
  });
  it("ignores a stale tool_call context", async () => {
    const { pi, handlers } = makePi();
    registerWriteHook(pi);
    const handler = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<unknown>;
    const staleCtx = {
      cwd: "/tmp",
      get sessionManager(): never {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    };
    await expect(handler({ toolName: "write", input: { path: "a.txt", content: "clean\n" } }, staleCtx)).resolves.toBeUndefined();
  });
});
