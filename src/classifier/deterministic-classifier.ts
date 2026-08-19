import type { ChatContext, ClassificationResult, ProjectProfile } from "../types/index.js";
import type { ChatClassifier, ClassifierThresholds, ProjectRules } from "./classifier.js";
import { DEFAULT_CLASSIFIER_THRESHOLDS } from "./classifier.js";
import { clampConfidence, containsTerm, findProject, normalizeName, tokenize } from "./utils.js";

interface Candidate {
  project: ProjectProfile;
  confidence: number;
  reason: string;
}

/**
 * Cheap first pass. It only returns a result when evidence is unambiguous;
 * callers can then fall through to an LLM without spending tokens on obvious chats.
 */
export class DeterministicClassifier implements ChatClassifier {
  private readonly rules: ProjectRules;
  private readonly thresholds: ClassifierThresholds;

  constructor(rules: ProjectRules = {}, thresholds: Partial<ClassifierThresholds> = {}) {
    this.rules = rules;
    this.thresholds = { ...DEFAULT_CLASSIFIER_THRESHOLDS, ...thresholds };
  }

  async classify(chat: ChatContext, projects: ProjectProfile[]): Promise<ClassificationResult | null> {
    const text = `${chat.title}\n${chat.excerpts.map((excerpt) => excerpt.text).join("\n")}`;
    const normalizedText = normalizeName(text);
    const normalizedTitle = normalizeName(chat.title);
    const bodyTokens = tokenize(normalizedText);
    const titleTokens = tokenize(normalizedTitle);
    const ambiguous = ambiguousKeywords(projects);

    // Manual rules always win. A rule fires when any configured marker appears;
    // users can make a marker as specific as they need (for example "Godrick").
    for (const rule of this.rules.rules ?? []) {
      const terms = rule.contains.map(normalizeName).filter(Boolean);
      // Word-boundary matching, not substring: a rule term "unity" must not fire
      // on "community" or "opportunity". Manual rules win with full confidence,
      // so a substring collision here is unrecoverable downstream.
      const matches = terms.filter((term) => containsTerm(bodyTokens, normalizedText, term));
      if (!matches.length) continue;
      if (rule.review) {
        return this.result("", 0, `Manual rule requires review: ${matches.join(", ")}.`, false);
      }
      if (!rule.project) continue;
      const project = findProject(rule.project, projects);
      if (project) {
        return this.result(project.name, 1, `Manual rule matched: ${matches.join(", ")}.`, true);
      }
      const requestedName = applyProjectAlias(rule.project, this.rules);
      return this.result(requestedName, 1, `Manual rule matched: ${matches.join(", ")}.`, false);
    }

    if (!projects.length) return null;

    const candidates: Candidate[] = [];
    for (const project of projects) {
      const configuredAliases = Object.entries(this.rules.aliases ?? {})
        .filter(([, target]) => normalizeName(target) === normalizeName(project.name))
        .map(([alias]) => alias);
      const exactNames = [project.name, ...project.aliases, ...configuredAliases].map(normalizeName).filter((name) => name.length >= 2);
      const nameMatches = exactNames.filter((name) => containsTerm(bodyTokens, normalizedText, name));
      if (nameMatches.length) {
        // Where the name appears matters more than that it appears. A project
        // called "Casa" is a common word: finding it somewhere in a transcript
        // says nothing, while finding it in the title is strong evidence. Only
        // a distinctive name earns confidence from the body alone.
        const inTitle = nameMatches.some((name) => containsTerm(titleTokens, normalizedTitle, name));
        const distinctive = nameMatches.some(
          (name) => name.includes(" ") || (name.length >= 6 && !ambiguous.has(name)),
        );
        const base = inTitle ? 0.94 : distinctive ? 0.86 : 0.62;
        const confidence = Math.min(0.98, base + Math.min(0.04, (nameMatches.length - 1) * 0.02));
        candidates.push({
          project,
          confidence,
          reason: `Project name or alias matched ${inTitle ? "in the title" : "in the body"}: ${nameMatches[0]}.`,
        });
        continue;
      }

      const keywords = project.keywords
        .map(normalizeName)
        .filter((keyword) => keyword.length >= 4 && !ambiguous.has(keyword));
      const matches = keywords.filter((keyword) => containsTerm(bodyTokens, normalizedText, keyword));
      const titleMatches = matches.filter((keyword) => containsTerm(titleTokens, normalizedTitle, keyword));
      // A single shared word inside a long transcript is not evidence. Requiring
      // either two body keywords or one title keyword is what stops a project
      // from absorbing every chat once its profile has grown broad.
      if (matches.length < 2 && titleMatches.length === 0) continue;
      const score = Math.min(6, matches.length + titleMatches.length * 2);
      const confidence = Math.min(this.thresholds.keywordCeiling, 0.52 + score * 0.055);
      candidates.push({ project, confidence, reason: `Distinctive project keywords matched: ${matches.slice(0, 4).join(", ")}.` });
    }

    // Known example chats make repeat runs deterministic even if a project has
    // few keywords. This is deliberately below an exact-name match.
    if (chat.id) {
      for (const project of projects) {
        if (project.exampleChatIds.includes(chat.id)) {
          candidates.push({ project, confidence: 0.92, reason: "Chat ID is a known example for this project." });
        }
      }
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    const [best, second] = candidates;
    if (!best || best.confidence < this.thresholds.existingProject) return null;
    // If two projects have almost identical evidence, leave it for semantic review.
    if (second && best.confidence - second.confidence < 0.08) return null;
    return this.result(best.project.name, best.confidence, best.reason, true);
  }

  private result(projectName: string, confidence: number, reason: string, existingProject: boolean): ClassificationResult {
    return { projectName, confidence: clampConfidence(confidence), reason, existingProject };
  }
}

/**
 * Keywords claimed by more than one project carry no signal, and keywords that
 * are generic in any project's vocabulary are worse than none — they let one
 * broad profile out-match every specific one.
 */
export function ambiguousKeywords(projects: ProjectProfile[]): Set<string> {
  const owners = new Map<string, number>();
  for (const project of projects) {
    for (const keyword of new Set(project.keywords.map(normalizeName))) {
      owners.set(keyword, (owners.get(keyword) ?? 0) + 1);
    }
  }
  const ambiguous = new Set(GENERIC_TERMS);
  for (const [keyword, count] of owners) if (count > 1) ambiguous.add(keyword);
  return ambiguous;
}

/**
 * Words that describe how someone talks to a chat assistant rather than what
 * the conversation is about. Kept small and language-aware for the two
 * languages the tool has been exercised with.
 */
const GENERIC_TERMS = new Set([
  "ajuda", "analise", "análise", "arquivo", "busca", "chat", "codigo", "código", "como", "conversa",
  "criar", "dados", "erro", "escrever", "exemplo", "fazer", "ideia", "jeito", "link", "links", "lista",
  "melhor", "melhoria", "modelo", "problema", "processo", "projeto", "prompt", "resumo", "simples",
  "solucao", "solução", "teste", "testes", "usar",
  "about", "code", "create", "data", "error", "example", "file", "help", "idea", "list", "make",
  "model", "problem", "project", "prompt", "question", "review", "simple", "solution", "summary",
  "test", "tests", "write",
]);

/** Apply a manual alias to a proposed project name. */
export function applyProjectAlias(name: string, rules: ProjectRules): string {
  const normalized = normalizeName(name);
  const alias = Object.entries(rules.aliases ?? {}).find(([from]) => normalizeName(from) === normalized);
  return alias?.[1]?.trim() || name.trim();
}
