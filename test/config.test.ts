import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClassifier, loadConfig, loadProjectRules } from "../src/config/config.js";

/**
 * `loadConfig` and `loadProjectRules` resolve their paths from the working
 * directory, so the only honest way to test them is to give them a working
 * directory of their own.
 */
let dir: string;
let previousCwd: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  previousCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "organizero-"));
  mkdirSync(join(dir, "config"));
  process.chdir(dir);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_MODEL", "ANTHROPIC_MODEL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const writeConfig = (value: unknown): void =>
  writeFileSync(join(dir, "config", "config.json"), JSON.stringify(value), "utf8");
const writeRules = (value: unknown): void =>
  writeFileSync(join(dir, "config", "project-rules.json"), JSON.stringify(value), "utf8");

describe("loadConfig", () => {
  it("returns the shipped defaults when no config file exists", () => {
    const config = loadConfig();
    assert.equal(config.classifier.existingProjectThreshold, 0.7);
    assert.equal(config.classifier.newProjectThreshold, 0.88);
    assert.equal(config.classifier.keywordCeiling, 0.68);
    assert.equal(config.stateDir, ".state");
  });

  it("merges a partial config section without dropping its other keys", () => {
    writeConfig({ classifier: { existingProjectThreshold: 0.5 } });
    const config = loadConfig();
    assert.equal(config.classifier.existingProjectThreshold, 0.5);
    assert.equal(config.classifier.newProjectThreshold, 0.88, "untouched keys keep their default");
  });

  it("names the file and the key when the JSON is malformed", () => {
    writeFileSync(join(dir, "config", "config.json"), "{ not json", "utf8");
    assert.throws(() => loadConfig(), /config\.json/);
  });

  // A threshold that is not a number makes every `confidence < threshold`
  // comparison false, so the organizer would move everything at any confidence
  // and report nothing wrong. It has to be a hard error.
  describe("rejects a threshold that would silently disable the guard", () => {
    for (const bad of ["0.7", null, -1, 2, Number.NaN] as const) {
      it(`rejects existingProjectThreshold = ${JSON.stringify(bad)}`, () => {
        writeConfig({ classifier: { existingProjectThreshold: bad } });
        assert.throws(() => loadConfig(), /existingProjectThreshold/);
      });
    }
    it("rejects a non-numeric newProjectThreshold", () => {
      writeConfig({ classifier: { newProjectThreshold: "high" } });
      assert.throws(() => loadConfig(), /newProjectThreshold/);
    });
    it("rejects a non-numeric keywordCeiling", () => {
      writeConfig({ classifier: { keywordCeiling: {} } });
      assert.throws(() => loadConfig(), /keywordCeiling/);
    });
    it("rejects a negative delayBetweenChatsMs", () => {
      writeConfig({ discovery: { delayBetweenChatsMs: -5 } });
      assert.throws(() => loadConfig(), /delayBetweenChatsMs/);
    });
    it("accepts a zero delay, which means no pacing", () => {
      writeConfig({ discovery: { delayBetweenChatsMs: 0 } });
      assert.equal(loadConfig().discovery.delayBetweenChatsMs, 0);
    });
  });

  it("reads .env without overwriting an already-set variable", () => {
    writeFileSync(join(dir, ".env"), 'OPENAI_API_KEY="from-file"\n# comment\nANTHROPIC_API_KEY=plain\n', "utf8");
    process.env.OPENAI_API_KEY = "from-shell";
    loadConfig();
    assert.equal(process.env.OPENAI_API_KEY, "from-shell", "the real environment wins over .env");
    assert.equal(process.env.ANTHROPIC_API_KEY, "plain");
  });
});

describe("loadProjectRules", () => {
  it("returns empty collections when the file is absent", () => {
    assert.deepEqual(loadProjectRules(), { aliases: {}, rules: [] });
  });

  it("fills in a missing aliases or rules key", () => {
    writeRules({ rules: [{ contains: ["godrick"], project: "Elden Ring" }] });
    const loaded = loadProjectRules();
    assert.deepEqual(loaded.aliases, {});
    assert.equal(loaded.rules.length, 1);
  });

  // Without this the bad rule reaches the matcher and throws there, pointing at
  // the classifier rather than at the file the user just edited.
  it("rejects a rule whose contains is not an array of strings", () => {
    writeRules({ rules: [{ contains: "godrick", project: "Elden Ring" }] });
    assert.throws(() => loadProjectRules(), /rules\[0\]/);
  });

  it("rejects a rule with no contains at all", () => {
    writeRules({ rules: [{ project: "Elden Ring" }] });
    assert.throws(() => loadProjectRules(), /rules\[0\]/);
  });

  it("names the file when the JSON is malformed", () => {
    writeFileSync(join(dir, "config", "project-rules.json"), "[[[", "utf8");
    assert.throws(() => loadProjectRules(), /project-rules\.json/);
  });
});

describe("defaultClassifier", () => {
  it("is none when no key is present", () => {
    assert.equal(defaultClassifier("chatgpt"), "none");
    assert.equal(defaultClassifier("claude"), "none");
  });

  it("honours an explicit none even with keys present", () => {
    process.env.OPENAI_API_KEY = "k";
    assert.equal(defaultClassifier("chatgpt", "none"), "none");
  });

  it("falls back to none when the explicitly chosen provider has no key", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    assert.equal(defaultClassifier("chatgpt", "openai"), "none", "it must not silently use the other provider");
  });

  it("uses the explicitly chosen provider when its key is present", () => {
    process.env.OPENAI_API_KEY = "k";
    assert.equal(defaultClassifier("claude", "openai"), "openai");
  });

  // Each site defaults to its own vendor's model, then falls back to the other.
  it("prefers OpenAI for chatgpt and Anthropic for claude", () => {
    process.env.OPENAI_API_KEY = "k";
    process.env.ANTHROPIC_API_KEY = "k";
    assert.equal(defaultClassifier("chatgpt"), "openai");
    assert.equal(defaultClassifier("claude"), "anthropic");
  });

  it("falls back to the other vendor when only its key is set", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    assert.equal(defaultClassifier("chatgpt"), "anthropic");
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "k";
    assert.equal(defaultClassifier("claude"), "openai");
  });
});
