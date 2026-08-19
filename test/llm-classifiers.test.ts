import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AnthropicClassifier, OpenAIClassifier, parseClassification } from "../src/classifier/llm-classifiers.js";
import type { ChatContext, ProjectProfile } from "../src/types/index.js";

const profile = (name: string): ProjectProfile => ({
  name,
  description: "",
  keywords: [],
  aliases: [],
  exampleChatIds: [],
});

const PROJECTS = [profile("Elden Ring"), profile("android-app")];

const chat: ChatContext = {
  id: "c1",
  title: "Beating Malenia",
  excerpts: [{ role: "user", text: "any tips for Malenia" }],
};

/**
 * `parseClassification` is the trust boundary for model output: everything it
 * rejects becomes `needs-review`, and everything it accepts can move a real
 * conversation. It fails closed by returning null, which means a regression here
 * is silent in both directions — hence the coverage.
 */
describe("parseClassification", () => {
  describe("rejects malformed output", () => {
    for (const [label, raw] of [
      ["prose", "I think this belongs in Elden Ring."],
      ["empty string", ""],
      ["a JSON array", '[{"projectName":"Elden Ring","confidence":0.9}]'],
      ["a JSON string", '"Elden Ring"'],
      ["null", "null"],
      ["a missing projectName", '{"confidence":0.9}'],
      ["a non-string projectName", '{"projectName":123,"confidence":0.9}'],
      ["a missing confidence", '{"projectName":"Elden Ring"}'],
      ["a string confidence", '{"projectName":"Elden Ring","confidence":"0.9"}'],
      ["a blank projectName", '{"projectName":"   ","confidence":0.9}'],
    ] as const) {
      it(`returns null for ${label}`, () => {
        assert.equal(parseClassification(raw, PROJECTS), null);
      });
    }
  });

  it("accepts a fenced JSON block, because models keep adding one", () => {
    const result = parseClassification('```json\n{"projectName":"Elden Ring","confidence":0.91}\n```', PROJECTS);
    assert.ok(result);
    assert.equal(result.projectName, "Elden Ring");
    assert.equal(result.existingProject, true);
  });

  it("canonicalises the project name against the local catalog", () => {
    const result = parseClassification('{"projectName":"elden   ring","confidence":0.91}', PROJECTS);
    assert.ok(result);
    assert.equal(result.projectName, "Elden Ring", "the catalog spelling wins over the model's");
  });

  it("ignores the model's existingProject flag and trusts the catalog", () => {
    // A hallucinated `existingProject: true` must not let an unknown project in
    // at the lower existing-project threshold. 0.80 clears `existingProject`
    // (0.70) but not `newProject` (0.88), so the flag is the only thing that
    // could admit it — and it does not.
    const lied = parseClassification('{"projectName":"Brand New","confidence":0.80,"existingProject":true}', PROJECTS);
    assert.equal(lied, null, "an unknown project must face the new-project threshold whatever the model claims");

    // Above the new-project bar it is accepted, but still flagged as new.
    const accepted = parseClassification('{"projectName":"Brand New","confidence":0.90,"existingProject":true}', PROJECTS);
    assert.ok(accepted);
    assert.equal(accepted.existingProject, false, "the catalog decides, not the model");
  });

  it("holds an unknown project to the higher new-project threshold", () => {
    assert.equal(parseClassification('{"projectName":"Brand New","confidence":0.80}', PROJECTS), null);
    const ok = parseClassification('{"projectName":"Brand New","confidence":0.90}', PROJECTS);
    assert.ok(ok);
    assert.equal(ok.existingProject, false);
  });

  it("holds a known project to the lower existing-project threshold", () => {
    assert.equal(parseClassification('{"projectName":"Elden Ring","confidence":0.60}', PROJECTS), null);
    const ok = parseClassification('{"projectName":"Elden Ring","confidence":0.75}', PROJECTS);
    assert.ok(ok);
    assert.equal(ok.existingProject, true);
  });

  it("clamps a confidence the model put out of range", () => {
    const result = parseClassification('{"projectName":"Elden Ring","confidence":42}', PROJECTS);
    assert.ok(result);
    assert.ok(result.confidence <= 1, `expected a clamped confidence, got ${result.confidence}`);
  });

  it("honours custom thresholds", () => {
    const strict = { existingProject: 0.99, newProject: 0.99, keywordCeiling: 0.68 };
    assert.equal(parseClassification('{"projectName":"Elden Ring","confidence":0.95}', PROJECTS, strict), null);
  });
});

describe("LLM classifiers", () => {
  it("OpenAI makes no network call without an API key", async () => {
    const classifier = new OpenAIClassifier({
      model: "gpt-4o-mini",
      fetchImpl: () => assert.fail("must not call the API without a key"),
    });
    assert.equal(await classifier.classify(chat, PROJECTS), null);
  });

  it("Anthropic makes no network call without an API key", async () => {
    const classifier = new AnthropicClassifier({
      model: "claude-haiku-4-5",
      fetchImpl: () => assert.fail("must not call the API without a key"),
    });
    assert.equal(await classifier.classify(chat, PROJECTS), null);
  });

  it("OpenAI sends the key as a bearer token and parses the reply", async () => {
    let seenAuth: string | undefined;
    const classifier = new OpenAIClassifier({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        seenAuth = new Headers(init?.headers).get("authorization") ?? undefined;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"projectName":"Elden Ring","confidence":0.9}' } }] }),
          { status: 200 },
        );
      },
    });
    const result = await classifier.classify(chat, PROJECTS);
    assert.equal(seenAuth, "Bearer test-key");
    assert.ok(result);
    assert.equal(result.projectName, "Elden Ring");
  });

  it("Anthropic throws on a non-OK response rather than silently skipping", async () => {
    const classifier = new AnthropicClassifier({
      apiKey: "test-key",
      model: "claude-haiku-4-5",
      fetchImpl: async () => new Response("nope", { status: 429 }),
    });
    await assert.rejects(() => classifier.classify(chat, PROJECTS), /429/);
  });

  it("Anthropic reads the first text block of the reply", async () => {
    const classifier = new AnthropicClassifier({
      apiKey: "test-key",
      model: "claude-haiku-4-5",
      fetchImpl: async () => new Response(
        JSON.stringify({ content: [{ type: "text", text: '{"projectName":"android-app","confidence":0.93}' }] }),
        { status: 200 },
      ),
    });
    const result = await classifier.classify(chat, PROJECTS);
    assert.ok(result);
    assert.equal(result.projectName, "android-app");
  });
});
