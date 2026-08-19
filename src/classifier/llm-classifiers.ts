import type { ChatContext, ClassificationResult, ProjectProfile } from "../types/index.js";
import type { ChatClassifier, ClassifierThresholds, ProjectRules } from "./classifier.js";
import { DEFAULT_CLASSIFIER_THRESHOLDS } from "./classifier.js";
import { chatForClassification, clampConfidence, findProject, safeReason } from "./utils.js";
import { DeterministicClassifier } from "./deterministic-classifier.js";

export interface LlmClassifierOptions {
  apiKey?: string;
  model: string;
  thresholds?: Partial<ClassifierThresholds>;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  maxContextChars?: number;
}

export function parseClassification(raw: string, projects: ProjectProfile[], thresholds: ClassifierThresholds = DEFAULT_CLASSIFIER_THRESHOLDS): ClassificationResult | null {
  // Accommodate fenced JSON, but do not try to execute or heuristically parse prose.
  const candidate = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let value: unknown;
  try { value = JSON.parse(candidate); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.projectName !== "string" || typeof record.confidence !== "number") return null;
  const projectName = record.projectName.trim();
  if (!projectName) return null;
  const confidence = clampConfidence(record.confidence);
  const resolved = findProject(projectName, projects);
  const canonicalName = resolved?.name ?? projectName;
  // Trust the local project catalog over the model's boolean. This prevents a
  // hallucinated "existing" flag from weakening the new-project threshold.
  const existing = Boolean(resolved);
  const minimum = existing ? thresholds.existingProject : thresholds.newProject;
  if (confidence < minimum) return null;
  return {
    projectName: canonicalName,
    confidence,
    reason: safeReason(record.reason, "Semantic classifier match."),
    existingProject: existing,
  };
}

function promptFor(chat: ChatContext, projects: ProjectProfile[], maxContextChars = 6_000): string {
  const compact = chatForClassification(chat, maxContextChars);
  const catalog = projects.map((project) => ({ name: project.name, description: project.description, keywords: project.keywords.slice(0, 15), aliases: project.aliases.slice(0, 10) }));
  return [
    "Classify this private conversation into a reusable project.",
    "Choose an existing project whenever there is a reasonable semantic match. Do not create narrow one-off project names.",
    "If no existing project is a reasonable match, propose a short reusable project name only when confidence is at least 0.88; otherwise use projectName \"\" and confidence 0.",
    "Return ONLY one JSON object with exactly these keys: projectName (string), confidence (number 0..1), reason (short string), existingProject (boolean).",
    `Known projects: ${JSON.stringify(catalog)}`,
    `Conversation: ${JSON.stringify(compact)}`,
  ].join("\n");
}

export class OpenAIClassifier implements ChatClassifier {
  private readonly options: Required<Pick<LlmClassifierOptions, "model" | "endpoint">> & LlmClassifierOptions;
  private readonly thresholds: ClassifierThresholds;
  constructor(options: LlmClassifierOptions) {
    this.options = { endpoint: "https://api.openai.com/v1/chat/completions", ...options };
    this.thresholds = { ...DEFAULT_CLASSIFIER_THRESHOLDS, ...options.thresholds };
  }
  async classify(chat: ChatContext, projects: ProjectProfile[]): Promise<ClassificationResult | null> {
    if (!this.options.apiKey) return null;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(this.options.endpoint, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({ model: this.options.model, temperature: 0, max_tokens: 300, response_format: { type: "json_object" }, messages: [{ role: "system", content: "You are a precise conversation project classifier." }, { role: "user", content: promptFor(chat, projects, this.options.maxContextChars) }] }),
    });
    if (!response.ok) throw new Error(`OpenAI classifier HTTP ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content;
    return typeof raw === "string" ? parseClassification(raw, projects, this.thresholds) : null;
  }
}

export class AnthropicClassifier implements ChatClassifier {
  private readonly options: Required<Pick<LlmClassifierOptions, "model" | "endpoint">> & LlmClassifierOptions;
  private readonly thresholds: ClassifierThresholds;
  constructor(options: LlmClassifierOptions) {
    this.options = { endpoint: "https://api.anthropic.com/v1/messages", ...options };
    this.thresholds = { ...DEFAULT_CLASSIFIER_THRESHOLDS, ...options.thresholds };
  }
  async classify(chat: ChatContext, projects: ProjectProfile[]): Promise<ClassificationResult | null> {
    if (!this.options.apiKey) return null;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(this.options.endpoint, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.options.model, max_tokens: 300, temperature: 0, system: "You are a precise conversation project classifier. Return only strict JSON.", messages: [{ role: "user", content: promptFor(chat, projects, this.options.maxContextChars) }] }),
    });
    if (!response.ok) throw new Error(`Anthropic classifier HTTP ${response.status}`);
    const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const raw = data.content?.find((part) => part.type === "text")?.text;
    return typeof raw === "string" ? parseClassification(raw, projects, this.thresholds) : null;
  }
}

/** Deterministic classifier first, then optional semantic classifier. */
export class LayeredClassifier implements ChatClassifier {
  constructor(
    private readonly deterministic: ChatClassifier,
    private readonly semantic?: ChatClassifier,
    private readonly rules: ProjectRules = {},
  ) {}
  async classify(chat: ChatContext, projects: ProjectProfile[]): Promise<ClassificationResult | null> {
    const enriched = projects.map((project) => ({
      ...project,
      aliases: [
        ...project.aliases,
        ...Object.entries(this.rules.aliases ?? {})
          .filter(([, target]) => findProject(target, projects)?.name === project.name)
          .map(([alias]) => alias),
      ],
    }));
    const direct = await this.deterministic.classify(chat, enriched);
    if (direct) return direct;
    return this.semantic?.classify(chat, enriched) ?? null;
  }
}

export function classifierForName(name: "openai" | "anthropic" | "none", options: { apiKey?: string; model?: string; endpoint?: string; thresholds?: Partial<ClassifierThresholds> } = {}): ChatClassifier | undefined {
  if (name === "none") return undefined;
  const model = options.model || (name === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5");
  const llmOptions = { ...options, model };
  return name === "openai" ? new OpenAIClassifier(llmOptions) : new AnthropicClassifier(llmOptions);
}

export interface CreateClassifierOptions {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  thresholds?: Partial<ClassifierThresholds>;
  rules?: ProjectRules;
  maxContextChars?: number;
}

/** One entry point for the organizer: deterministic first, optional LLM second. */
export function createClassifier(name: "openai" | "anthropic" | "none", options: CreateClassifierOptions = {}): ChatClassifier {
  const deterministic = new DeterministicClassifier(options.rules, options.thresholds);
  const semantic = classifierForName(name, options);
  return new LayeredClassifier(deterministic, semantic, options.rules);
}
