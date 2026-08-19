import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClassifierName, ProviderName } from "../types/index.js";

export interface ProjectRule {
  contains: string[];
  project?: string;
  review?: boolean;
}

export interface ProjectRules {
  aliases: Record<string, string>;
  rules: ProjectRule[];
}

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
    existingProjectThreshold: 0.7,
    newProjectThreshold: 0.88,
    keywordCeiling: 0.68,
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

export function loadConfig(): AppConfig {
  loadEnvFile();
  const path = resolve("config/config.json");
  const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>) : {};
  return mergeConfig(file);
}

export function loadProjectRules(): ProjectRules {
  const path = resolve("config/project-rules.json");
  if (!existsSync(path)) return { aliases: {}, rules: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectRules>;
  return { aliases: parsed.aliases ?? {}, rules: parsed.rules ?? [] };
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
