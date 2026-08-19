export type ProviderName = "chatgpt" | "claude";
export type ClassifierName = "openai" | "anthropic" | "none";

export interface Project {
  id?: string;
  name: string;
  url?: string;
  aliases?: string[];
}

export interface ChatSummary {
  id?: string;
  title: string;
  url?: string;
}

export interface MessageExcerpt {
  role: "user" | "assistant";
  text: string;
}

export interface ChatContext {
  id?: string;
  title: string;
  url?: string;
  excerpts: MessageExcerpt[];
}

export interface ListChatsOptions {
  maxChats?: number;
  knownKeys?: Set<string>;
  knownChatStopCount?: number;
}

export interface ProjectProfile {
  name: string;
  description: string;
  keywords: string[];
  aliases: string[];
  exampleChatIds: string[];
}

/**
 * Result of asking a provider to move a conversation into a project.
 *
 * A provider must never report success it did not observe: browser UIs fail
 * silently (a menu item that is scrolled out of view, a click that lands on a
 * re-rendered node), and an unverified move recorded as `moved` is worse than a
 * visible failure — the conversation is then skipped forever on later runs.
 */
/** Result of archiving a conversation, for the ones no project can hold. */
export interface ArchiveOutcome {
  archived: boolean;
  detail?: string;
}

export interface MoveOutcome {
  verified: boolean;
  /** The project the conversation was actually observed in, when readable. */
  observedProject?: string;
  /** Why verification failed, for the run log and the stored record. */
  detail?: string;
}

export interface ClassificationResult {
  projectName: string;
  confidence: number;
  reason: string;
  existingProject: boolean;
}

export interface ProcessedChat {
  key: string;
  id?: string;
  url?: string;
  title: string;
  provider: ProviderName;
  project?: string;
  processedAt: string;
  classificationConfidence: number;
  /**
   * "unsupported" is a settled outcome, unlike "error": the site itself offers no
   * way to place this conversation (a ChatGPT custom-GPT chat has no "Move to
   * project" action at all). Retrying it can only fail again, so it is recorded
   * once and left alone.
   */
  status: "moved" | "already-organized" | "needs-review" | "unverified" | "dry-run" | "error" | "unsupported" | "archived";
  error?: string;
  /**
   * The opening user message, captured so a report can be reviewed without
   * reopening every conversation. It is NOT an LLM summary.
   */
  excerpt?: string;
}
