import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClassifierName, ProviderName } from "../types/index.js";
import { DEFAULT_CLASSIFIER_THRESHOLDS } from "../classifier/classifier.js";
import type { ProjectRule, ProjectRules } from "../classifier/classifier.js";

// Re-exported so callers can keep importing the rule shape from the module that
// loads it. There is deliberately only one declaration, in classifier.ts.
export type { ProjectRule, ProjectRules };

/** `loadProjectRules` always fills both fields, unlike the on-disk shape. */
export type LoadedProjectRules = Required<ProjectRules>;

export interface AppConfig {
  stateDir: string;
  urls: Record<ProviderName, string>;
  classifier: {
    provider?: ClassifierName;
    openaiModel: string;
    anthropicModel: string;
    existingProjectThreshold: number;
    newProjectThreshold: number;
    /** Ceiling for learned-keyword confidence. See ClassifierThresholds. */
    keywordCeiling: number;
    maxContextChars: number;
  };
  discovery: {
    defaultMaxChats: number;
    knownChatStopCount: number;
    /** Pause between conversations. Both sites throttle history access. */
    delayBetweenChatsMs: number;
  };
  browser: {
    channel: string;
    slowMo: number;
  };
}

const defaults: AppConfig = {
  stateDir: ".state",
  urls: { chatgpt: "https://chatgpt.com/", claude: "https://claude.ai/" },
  classifier: {
    openaiModel: "gpt-4o-mini",
    anthropicModel: "claude-haiku-4-5",
    existingProjectThreshold: DEFAULT_CLASSIFIER_THRESHOLDS.existingProject,
    newProjectThreshold: DEFAULT_CLASSIFIER_THRESHOLDS.newProject,
    keywordCeiling: DEFAULT_CLASSIFIER_THRESHOLDS.keywordCeiling,
    maxContextChars: 12_000,
  },
  discovery: { defaultMaxChats: 20, knownChatStopCount: 8, delayBetweenChatsMs: 1_200 },
  browser: { channel: "chrome", slowMo: 50 },
};

function mergeConfig(input: Partial<AppConfig>): AppConfig {
  return {
    ...defaults,
    ...input,
    urls: { ...defaults.urls, ...input.urls },
    classifier: { ...defaults.classifier, ...input.classifier },
    discovery: { ...defaults.discovery, ...input.discovery },
    browser: { ...defaults.browser, ...input.browser },
  };
}

function loadEnvFile(path = resolve(".env")): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key && process.env[key] === undefined) {
      process.env[key] = rawValue!.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
    }
  }
}

/**
 * A malformed config used to surface as a bare `SyntaxError` naming neither the
 * file nor the setting, which is a miserable thing to debug by hand.
 */
function readJsonFile<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validates the settings whose bad values fail *silently* rather than loudly.
 *
 * A threshold that arrives as a string or null makes every `confidence < threshold`
 * comparison false, so instead of refusing a doubtful move the organizer accepts
 * every one of them, at any confidence, and reports nothing unusual. That is the
 * worst possible failure for this tool, so it is worth a hard error at startup.
 */
function validateConfig(config: AppConfig, path: string): AppConfig {
  const where = existsSync(path) ? path : "config defaults";
  const ratios: Array<[string, number]> = [
    ["classifier.existingProjectThreshold", config.classifier.existingProjectThreshold],
    ["classifier.newProjectThreshold", config.classifier.newProjectThreshold],
    ["classifier.keywordCeiling", config.classifier.keywordCeiling],
  ];
  for (const [key, value] of ratios) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${where}: "${key}" must be a number between 0 and 1, got ${JSON.stringify(value)}`);
    }
  }
  const delay = config.discovery.delayBetweenChatsMs;
  if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0) {
    throw new Error(`${where}: "discovery.delayBetweenChatsMs" must be a number >= 0, got ${JSON.stringify(delay)}`);
  }
  return config;
}

export function loadConfig(): AppConfig {
  loadEnvFile();
  const path = resolve("config/config.json");
  const file = existsSync(path) ? readJsonFile<Partial<AppConfig>>(path) : {};
  return validateConfig(mergeConfig(file), path);
}

export function loadProjectRules(): LoadedProjectRules {
  const path = resolve("config/project-rules.json");
  if (!existsSync(path)) return { aliases: {}, rules: [] };
  const parsed = readJsonFile<Partial<ProjectRules>>(path);
  const rules = parsed.rules ?? [];
  if (!Array.isArray(rules)) throw new Error(`${path}: "rules" must be an array`);
  // A rule without a string[] `contains` reaches the matcher and throws there,
  // pointing at the classifier rather than at the file the user just edited.
  rules.forEach((rule: ProjectRule, index: number) => {
    if (!rule || typeof rule !== "object" || !Array.isArray(rule.contains) || !rule.contains.every((term) => typeof term === "string")) {
      throw new Error(`${path}: rules[${index}] needs a "contains" array of strings`);
    }
  });
  return { aliases: parsed.aliases ?? {}, rules };
}

export function defaultClassifier(provider: ProviderName, configured?: ClassifierName): ClassifierName {
  if (configured === "none") return "none";
  if (configured === "openai") return process.env.OPENAI_API_KEY ? "openai" : "none";
  if (configured === "anthropic") return process.env.ANTHROPIC_API_KEY ? "anthropic" : "none";
  if (provider === "chatgpt") {
    if (process.env.OPENAI_API_KEY) return "openai";
    if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  } else {
    if (process.env.ANTHROPIC_API_KEY) return "anthropic";
    if (process.env.OPENAI_API_KEY) return "openai";
  }
  return "none";
}
