import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Verifier } from "../src/verifier.js";
import { StateStore } from "../src/state/state-store.js";
import type { ConversationProvider } from "../src/providers/provider.js";
import type { ChatSummary, ProcessedChat, ProjectReading } from "../src/types/index.js";

/**
 * A provider that answers `getCurrentProject` from a script, and records what it
 * was asked. Everything else throws: a verification pass that reaches any other
 * operation is doing something it should not.
 */
function stubProvider(answers: Record<string, ProjectReading>): ConversationProvider & { asked: Array<{ title: string; expected?: string }> } {
  const asked: Array<{ title: string; expected?: string }> = [];
  const unreachable = (name: string) => () => {
    throw new Error(`the verifier must not call ${name}`);
  };
  return {
    asked,
    provider: "chatgpt",
    open: async () => undefined,
    isAuthenticated: async () => true,
    waitForAuthentication: async () => undefined,
    async getCurrentProject(chat: ChatSummary, expected?: string): Promise<ProjectReading> {
      asked.push({ title: chat.title, expected });
      return answers[chat.title] ?? { read: "none" };
    },
    listProjects: unreachable("listProjects") as never,
    listChats: unreachable("listChats") as never,
    openChat: unreachable("openChat") as never,
    readChatContext: unreachable("readChatContext") as never,
    createProject: unreachable("createProject") as never,
    addChatToProject: unreachable("addChatToProject") as never,
    captureDiagnostics: async () => "none",
    inspect: async () => undefined,
    close: async () => undefined,
  };
}

const chat = (title: string, project: string): ProcessedChat => ({
  key: `chatgpt:${title}`,
  id: title,
  title,
  project,
  provider: "chatgpt",
  processedAt: "2026-01-01T00:00:00.000Z",
  classificationConfidence: 0.9,
  status: "moved",
});

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "organizero-verify-"));
  store = new StateStore(dir, "chatgpt");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const statusOf = async (key: string): Promise<ProcessedChat | undefined> =>
  (await store.loadChats()).chats.find((item) => item.key === key);

const run = (provider: ConversationProvider, over: Partial<Parameters<Verifier["run"]>[0]> = {}) =>
  new Verifier(provider, store).run({
    dryRun: false,
    rebuildProfiles: false,
    maxChats: Number.POSITIVE_INFINITY,
    ...over,
  });

describe("Verifier", () => {
  it("confirms a record whose project matches", async () => {
    await store.upsertChat(chat("a", "Research"));
    const stats = await run(stubProvider({ a: { read: "ok", project: { name: "Research" } } }));
    assert.equal(stats.confirmed, 1);
    assert.equal((await statusOf("chatgpt:a"))?.status, "moved");
  });

  it("downgrades a record the site says is in no project", async () => {
    await store.upsertChat(chat("a", "Research"));
    const stats = await run(stubProvider({ a: { read: "none" } }));
    assert.equal(stats.missing, 1);
    const after = await statusOf("chatgpt:a");
    assert.equal(after?.status, "unverified");
    assert.match(after?.error ?? "", /no project/);
  });

  it("downgrades a record found in a different project", async () => {
    await store.upsertChat(chat("a", "Research"));
    const stats = await run(stubProvider({ a: { read: "ok", project: { name: "Cooking" } } }));
    assert.equal(stats.mismatched, 1);
    assert.match((await statusOf("chatgpt:a"))?.error ?? "", /Cooking/);
  });

  /**
   * The whole point of the tri-state read. An unhydrated sidebar used to be
   * reported as "in no project", and a single bad pass rewrote hundreds of
   * good records — the exact failure this command exists to detect, caused by
   * the command itself.
   */
  it("never downgrades a record it could not read", async () => {
    await store.upsertChat(chat("a", "Research"));
    const stats = await run(stubProvider({ a: { read: "unreadable", reason: "sidebar not hydrated" } }));
    assert.equal(stats.unreadable, 1);
    assert.equal(stats.missing, 0, "an unreadable page is not evidence of absence");
    const after = await statusOf("chatgpt:a");
    assert.equal(after?.status, "moved", "the record must survive untouched");
    assert.equal(after?.error, undefined);
  });

  it("mixes the three outcomes in one pass without cross-contamination", async () => {
    await store.upsertChat(chat("ok", "Research"));
    await store.upsertChat(chat("gone", "Research"));
    await store.upsertChat(chat("blind", "Research"));
    const stats = await run(stubProvider({
      ok: { read: "ok", project: { name: "Research" } },
      gone: { read: "none" },
      blind: { read: "unreadable", reason: "no main element" },
    }));
    assert.deepEqual(
      { c: stats.confirmed, m: stats.missing, u: stats.unreadable, e: stats.errors },
      { c: 1, m: 1, u: 1, e: 0 },
    );
    assert.equal((await statusOf("chatgpt:ok"))?.status, "moved");
    assert.equal((await statusOf("chatgpt:gone"))?.status, "unverified");
    assert.equal((await statusOf("chatgpt:blind"))?.status, "moved");
  });

  it("passes the recorded project as the expectation, so a scoped URL can confirm it", async () => {
    await store.upsertChat(chat("a", "Research"));
    const provider = stubProvider({ a: { read: "ok", project: { name: "Research" } } });
    await run(provider);
    assert.deepEqual(provider.asked, [{ title: "a", expected: "Research" }]);
  });

  it("changes nothing on a dry run", async () => {
    await store.upsertChat(chat("a", "Research"));
    const stats = await run(stubProvider({ a: { read: "none" } }), { dryRun: true });
    assert.equal(stats.missing, 1);
    assert.equal((await statusOf("chatgpt:a"))?.status, "moved");
  });

  it("records an error without downgrading when the read throws", async () => {
    await store.upsertChat(chat("a", "Research"));
    const provider = stubProvider({});
    provider.getCurrentProject = async () => {
      throw new Error("navigation timeout");
    };
    const stats = await run(provider);
    assert.equal(stats.errors, 1);
    assert.equal((await statusOf("chatgpt:a"))?.status, "moved", "a thrown read is not a verdict either");
  });

  it("only verifies records that claim to be organized", async () => {
    await store.upsertChat(chat("a", "Research"));
    await store.upsertChat({ ...chat("b", "Research"), status: "needs-review" });
    const provider = stubProvider({ a: { read: "ok", project: { name: "Research" } } });
    const stats = await run(provider);
    assert.equal(stats.checked, 1);
    assert.deepEqual(provider.asked.map((item) => item.title), ["a"]);
  });
});

describe("Verifier --rebuild-profiles", () => {
  const indexWith = (projects: Record<string, string[]>) => ({
    projects: Object.fromEntries(
      Object.entries(projects).map(([name, keywords]) => [
        name,
        { name, description: "", keywords, aliases: [], exampleChatIds: ["stale-id"] },
      ]),
    ),
  });

  it("leaves a project this pass never examined completely untouched", async () => {
    await store.saveProjectIndex(indexWith({ Research: ["research", "papers"], Cooking: ["cooking", "recipes"] }));
    await store.upsertChat(chat("a", "Research"));
    await run(stubProvider({ a: { read: "ok", project: { name: "Research" } } }), { rebuildProfiles: true });

    const after = await store.loadProjectIndex();
    assert.deepEqual(
      after.projects.Cooking,
      { name: "Cooking", description: "", keywords: ["cooking", "recipes"], aliases: [], exampleChatIds: ["stale-id"] },
      "verifying a slice of the state must not wipe the profiles it never looked at",
    );
  });

  it("still resets a project that was examined and confirmed nothing", async () => {
    await store.saveProjectIndex(indexWith({ Research: ["research", "papers"] }));
    await store.upsertChat(chat("a", "Research"));
    await run(stubProvider({ a: { read: "none" } }), { rebuildProfiles: true });

    const after = await store.loadProjectIndex();
    assert.deepEqual(after.projects.Research?.exampleChatIds, [], "a stale example id keeps re-asserting a wrong project");
    assert.deepEqual(after.projects.Research?.keywords, ["Research"]);
  });

  it("quarantines a project whose conversation threw", async () => {
    await store.saveProjectIndex(indexWith({ Research: ["research", "papers"] }));
    await store.upsertChat(chat("a", "Research"));
    const provider = stubProvider({});
    provider.getCurrentProject = async () => {
      throw new Error("navigation timeout");
    };
    await run(provider, { rebuildProfiles: true });

    const after = await store.loadProjectIndex();
    assert.deepEqual(after.projects.Research?.keywords, ["research", "papers"], "an errored pass must not rebuild that profile");
    assert.deepEqual(after.projects.Research?.exampleChatIds, ["stale-id"]);
  });

  it("matches the index key to the live project name case-insensitively", async () => {
    await store.saveProjectIndex(indexWith({ "My  Project": ["old"] }));
    await store.upsertChat(chat("a", "My  Project"));
    await run(stubProvider({ a: { read: "ok", project: { name: "My Project" } } }), { rebuildProfiles: true });

    const after = await store.loadProjectIndex();
    assert.deepEqual(after.projects["My  Project"]?.exampleChatIds, ["a"], "a spacing difference must not wipe the profile");
  });
});
