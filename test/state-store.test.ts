import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, chatKey } from "../src/state/state-store.js";
import type { ProcessedChat } from "../src/types/index.js";

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "organizero-state-"));
  store = new StateStore(dir, "chatgpt");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const chat = (overrides: Partial<ProcessedChat> & { key: string }): ProcessedChat => ({
  title: overrides.key,
  provider: "chatgpt",
  processedAt: "2026-01-01T00:00:00.000Z",
  classificationConfidence: 0.9,
  status: "moved",
  ...overrides,
});

describe("StateStore", () => {
  it("reads back empty collections before anything is written", async () => {
    assert.deepEqual(await store.loadProjects(), { updatedAt: "", projects: [] });
    assert.deepEqual(await store.loadChats(), { updatedAt: "", chats: [] });
    assert.deepEqual(await store.loadProjectIndex(), { projects: {} });
  });

  it("keeps each provider's state in its own directory", async () => {
    await store.upsertChat(chat({ key: "a" }));
    const other = new StateStore(dir, "claude");
    assert.equal((await other.loadChats()).chats.length, 0, "claude must not see chatgpt's records");
  });

  it("upserts by key rather than appending a duplicate", async () => {
    await store.upsertChat(chat({ key: "a", status: "unverified" }));
    await store.upsertChat(chat({ key: "a", status: "moved" }));
    await store.upsertChat(chat({ key: "b" }));
    const { chats } = await store.loadChats();
    assert.equal(chats.length, 2);
    assert.equal(chats.find((item) => item.key === "a")?.status, "moved");
  });

  // State holds conversation titles and links, so it must not be world-readable
  // on a shared machine.
  it("writes state files with owner-only permissions", async function () {
    if (process.platform === "win32") return; // POSIX modes are not meaningful here
    await store.upsertChat(chat({ key: "a" }));
    const mode = statSync(join(dir, "data", "chatgpt", "chats.json")).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("leaves no temporary files behind after an atomic write", async () => {
    await store.upsertChat(chat({ key: "a" }));
    await store.saveProjects([{ name: "Elden Ring" }]);
    const files = readdirSync(join(dir, "data", "chatgpt"));
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "a .tmp file means rename() did not run");
  });

  it("writes valid, re-readable JSON", async () => {
    await store.saveProjects([{ name: "Elden Ring" }]);
    const raw = readFileSync(join(dir, "data", "chatgpt", "projects.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.ok(raw.endsWith("\n"), "a trailing newline keeps the file diffable");
  });

  it("explains which state file it could not read", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "data", "chatgpt"), { recursive: true });
    writeFileSync(join(dir, "data", "chatgpt", "chats.json"), "{ truncated", "utf8");
    await assert.rejects(() => store.loadChats(), /chats\.json/);
  });

  it("appends one NDJSON line per action, each with a timestamp", async () => {
    await store.recordAction({ type: "moved", chatKey: "a" });
    await store.recordAction({ type: "error", chatKey: "b" });
    const lines = readFileSync(join(dir, "data", "chatgpt", "actions.ndjson"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(typeof JSON.parse(line).at === "string");
    assert.equal(JSON.parse(lines[1]!).type, "error");
  });

  it("counts records by status", async () => {
    await store.saveProjects([{ name: "Elden Ring" }]);
    await store.upsertChat(chat({ key: "a", status: "moved" }));
    await store.upsertChat(chat({ key: "b", status: "moved" }));
    await store.upsertChat(chat({ key: "c", status: "needs-review" }));
    assert.deepEqual(await store.summary(), {
      projects: 1,
      chats: 3,
      byStatus: { moved: 2, "needs-review": 1 },
    });
  });
});

describe("chatKey", () => {
  it("prefers the id, then the url, then the title", () => {
    assert.equal(chatKey("chatgpt", { id: "ID", url: "u", title: "t" }), "chatgpt:id");
    assert.equal(chatKey("chatgpt", { url: "URL", title: "t" }), "chatgpt:url");
    assert.equal(chatKey("chatgpt", { title: "  Title  " }), "chatgpt:title");
  });

  it("namespaces by provider, so the same id on both sites stays distinct", () => {
    assert.notEqual(chatKey("chatgpt", { id: "x", title: "t" }), chatKey("claude", { id: "x", title: "t" }));
  });
});
