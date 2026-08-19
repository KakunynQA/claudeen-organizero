import type { ChatContext, ProjectProfile } from "../types/index.js";

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function compactText(value: string, maxCharacters = 1200): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxCharacters);
}

/** Keep prompts/logs small while preserving user messages preferentially. */
export function chatForClassification(chat: ChatContext, maxCharacters = 6000): ChatContext {
  const title = compactText(chat.title, 300);
  const excerpts = chat.excerpts
    .filter((excerpt) => compactText(excerpt.text).length > 0)
    .map((excerpt) => ({ ...excerpt, text: compactText(excerpt.text, 1800) }));
  const selected = excerpts.filter((excerpt) => excerpt.role === "user").concat(excerpts.filter((excerpt) => excerpt.role === "assistant"));
  const output = [] as typeof excerpts;
  let used = title.length;
  for (const excerpt of selected) {
    if (used >= maxCharacters) break;
    const remaining = Math.max(100, maxCharacters - used);
    const text = excerpt.text.slice(0, Math.min(remaining, 1800));
    output.push({ ...excerpt, text });
    used += text.length;
  }
  return { id: chat.id, url: chat.url, title, excerpts: output };
}

export function findProject(projectName: string, projects: ProjectProfile[]): ProjectProfile | undefined {
  const wanted = normalizeName(projectName);
  return projects.find((project) => {
    const candidates = [project.name, ...project.aliases];
    return candidates.some((candidate) => normalizeName(candidate) === wanted);
  });
}

/**
 * Splits text into lowercase word tokens. Keyword matching runs against these
 * rather than against raw substrings: `"casa"` must not match `"por acaso"`,
 * and `"links"` must not match every URL in a transcript.
 */
export function tokenize(value: string): Set<string> {
  const tokens = value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  return new Set(tokens);
}

/** Word-boundary match for single words, phrase match for multi-word terms. */
export function containsTerm(tokens: Set<string>, text: string, term: string): boolean {
  return term.includes(" ") ? text.includes(term) : tokens.has(term);
}

export function clampConfidence(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export function safeReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const reason = compactText(value, 500);
  return reason || fallback;
}
