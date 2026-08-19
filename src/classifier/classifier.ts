import type { ChatContext, ClassificationResult, ProjectProfile } from "../types/index.js";

export interface ChatClassifier {
  classify(chat: ChatContext, projects: ProjectProfile[]): Promise<ClassificationResult | null>;
}

/** A manual override file. Rules are intentionally small and easy to edit. */
export interface ProjectRule {
  contains: string[];
  project?: string;
  review?: boolean;
}

export interface ProjectRules {
  aliases?: Record<string, string>;
  rules?: ProjectRule[];
}

export interface ClassifierThresholds {
  /** Minimum confidence to accept a match to a known project. */
  existingProject: number;
  /** Minimum confidence to accept a proposed new project. */
  newProject: number;
  /**
   * Ceiling on confidence derived from *learned* keyword profiles.
   *
   * Below `existingProject` by default, which means learned keywords inform the
   * LLM and break ties but never move a conversation on their own. Profiles are
   * built from a handful of short titles, so their vocabulary drifts generic
   * fast — and a generic term that decides a move teaches the profile more
   * generic terms, which is how one project ends up absorbing everything.
   *
   * Raise it above `existingProject` to let keyword matches act unaided.
   */
  keywordCeiling: number;
}

export const DEFAULT_CLASSIFIER_THRESHOLDS: ClassifierThresholds = {
  existingProject: 0.70,
  newProject: 0.88,
  keywordCeiling: 0.68,
};
