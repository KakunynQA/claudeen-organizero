import type { AppConfig } from "./config/config.js";
import type { ChatClassifier } from "./classifier/classifier.js";
import { ensureAuthenticated } from "./browser/auth.js";
import { RateLimitedError, UnsupportedConversationError } from "./errors.js";
import type { ConversationProvider } from "./providers/provider.js";
import { chatKey, type ProjectIndexFile, type StateStore } from "./state/state-store.js";
import type { ChatContext, ClassificationResult, ProcessedChat, Project, ProjectProfile } from "./types/index.js";

export interface OrganizeOptions {
  dryRun: boolean;
  /**
   * Read and classify every conversation, write the proposal to local state,
   * and touch nothing on the site. Exists so a whole history can be reviewed in
   * one pass — and so the moves can then run as a single decided batch, instead
   * of a read-classify-move loop that spends the rate-limit budget twice.
   */
  scan: boolean;
  /**
   * Classify from the conversation list alone, without opening a single
   * conversation. Discovery is then one page load plus scrolls for the whole
   * history, instead of one navigation per conversation — which is what spends
   * the rate-limit budget and draws bot checks. The cost is no excerpt: the
   * title is all the classifier and the reviewer get.
   */
  titlesOnly: boolean;
  maxChats: number;
  refreshProjects: boolean;
  reprocess: boolean;
  backfill: boolean;
}

interface RunStats {
  processed: number;
  scanned: number;
  moved: number;
  unverified: number;
  alreadyOrganized: number;
  projectsCreated: number;
  needsReview: number;
  unsupported: number;
  errors: number;
}

const normalize = (value: string): string => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * An exact-case match wins before the case-insensitive one.
 *
 * Two projects can differ only by case — a real "Kakunyn" and a stray "kakunyn"
 * created by an earlier bug — and a case-insensitive search returns whichever
 * the sidebar happens to list first. That is a coin flip over where a
 * conversation lands, so the name the rule actually spells is preferred.
 */
function findProject(projects: Project[], name: string): Project | undefined {
  const exact = name.trim();
  const wanted = normalize(name);
  return (
    projects.find((project) => project.name.trim() === exact) ??
    projects.find((project) => (project.aliases ?? []).some((alias) => alias.trim() === exact)) ??
    projects.find((project) =>
      normalize(project.name) === wanted || (project.aliases ?? []).some((alias) => normalize(alias) === wanted),
    )
  );
}

/** Longest excerpt kept on a record: enough to recognise a conversation, short
 * enough that the state file and the report stay readable. */
const EXCERPT_LIMIT = 240;

/**
 * The first thing the user actually asked, which is what makes a placement
 * recognisable in the report without reopening the conversation.
 */
export function openingUserExcerpt(context: ChatContext): string | undefined {
  const opening = context.excerpts.find((excerpt) => excerpt.role === "user");
  const text = opening?.text.replace(/\s+/g, " ").trim() ?? "";
  return text ? text.slice(0, EXCERPT_LIMIT) : undefined;
}

function formatResult(index: number, total: number, title: string, result: ClassificationResult | null): void {
  console.log(`\n[${String(index).padStart(2, "0")}/${String(total).padStart(2, "0")}] ${title}`);
  if (!result) console.log("     → unclassified");
  else {
    console.log(`     → ${result.projectName}${result.existingProject ? "" : " (new)"}`);
    console.log(`     confidence ${result.confidence.toFixed(2)} · ${result.reason}`);
  }
}

export class Organizer {
  constructor(
    private readonly provider: ConversationProvider,
    private readonly classifier: ChatClassifier,
    private readonly store: StateStore,
    private readonly config: AppConfig,
  ) {}

  async run(options: OrganizeOptions): Promise<RunStats> {
    const stats: RunStats = { processed: 0, scanned: 0, moved: 0, unverified: 0, alreadyOrganized: 0, projectsCreated: 0, needsReview: 0, unsupported: 0, errors: 0 };
    await this.provider.open();
    await ensureAuthenticated(this.provider);

    const cached = await this.store.loadProjects();
    let projects = cached.projects;
    if (options.refreshProjects || projects.length === 0) {
      projects = deduplicateProjects(await this.provider.listProjects());
      if (!options.dryRun) await this.store.saveProjects(projects);
    }

    console.log(`Projects cached: ${cached.projects.length}`);
    console.log(`Projects available: ${projects.length}`);
    console.log("\nScanning conversations...");

    const processedFile = await this.store.loadChats();
    const knownKeys = new Set<string>();
    // Errors and unverified moves stay eligible for another attempt; treating
    // them as done is what let a broken run look like a successful one.
    // None of these is a settled outcome, so none of them makes a conversation
    // "done". "dry-run" is a proposal awaiting the run that acts on it, and
    // "needs-review" means no decision was reached — usually because no rule
    // described the conversation yet. Rules are edited precisely to answer those,
    // and treating them as done meant every newly written rule needed a full
    // --reprocess, which re-reads the entire history to fix a handful of chats.
    const retryable = new Set<ProcessedChat["status"]>(["error", "unverified", "dry-run", "needs-review"]);
    for (const chat of processedFile.chats.filter((item) => !retryable.has(item.status))) {
      knownKeys.add(chat.key);
      knownKeys.add(chatKey(this.provider.provider, chat));
      if (chat.id) {
        knownKeys.add(chat.id.toLocaleLowerCase());
        knownKeys.add(`id:${chat.id}`);
      }
      if (chat.url) {
        knownKeys.add(chat.url.toLocaleLowerCase());
        knownKeys.add(`url:${chat.url}`);
      }
      knownKeys.add(chat.title.trim().toLocaleLowerCase());
    }
    const chats = await this.provider.listChats({
      maxChats: options.maxChats,
      knownKeys: options.reprocess ? new Set() : knownKeys,
      knownChatStopCount: options.backfill ? 1_000 : this.config.discovery.knownChatStopCount,
    });
    const candidates = options.reprocess ? chats : chats.filter((chat) => !knownKeys.has(chatKey(this.provider.provider, chat)));

    for (const [zeroIndex, chat] of candidates.entries()) {
      // Both sites throttle rapid history access. Pacing the loop costs a few
      // seconds per run and avoids losing the run to a rate-limit modal.
      if (zeroIndex > 0 && this.config.discovery.delayBetweenChatsMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.config.discovery.delayBetweenChatsMs));
      }
      const key = chatKey(this.provider.provider, chat);
      stats.processed++;
      let printed = false;
      let excerpt: string | undefined;
      try {
        const context = options.titlesOnly
          ? { id: chat.id, title: chat.title, url: chat.url, excerpts: [] }
          : await this.provider.readChatContext(chat);
        if (!options.titlesOnly) excerpt = openingUserExcerpt(context);
        const profiles = await this.projectProfiles(projects);
        const result = await this.classifier.classify(context, profiles);
        formatResult(zeroIndex + 1, candidates.length, chat.title, result);
        printed = true;
        if (options.scan) {
          stats.scanned++;
          await this.persist(chat, key, result, "dry-run", { excerpt });
          continue;
        }
        if (!result || !result.projectName.trim()) {
          stats.needsReview++;
          console.log("     ⚠ needs review");
          if (!options.dryRun) await this.persist(chat, key, result, "needs-review", { excerpt });
          continue;
        }

        let project = findProject(projects, result.projectName);
        if (!project) {
          const refreshed = deduplicateProjects(await this.provider.listProjects());
          projects = deduplicateProjects([...projects, ...refreshed]);
          project = findProject(projects, result.projectName);
          if (!options.dryRun) await this.store.saveProjects(projects);
        }

        const threshold = project
          ? this.config.classifier.existingProjectThreshold
          : this.config.classifier.newProjectThreshold;
        if (result.confidence < threshold) {
          stats.needsReview++;
          console.log(`     ⚠ needs review (threshold ${threshold.toFixed(2)})`);
          if (!options.dryRun) await this.persist(chat, key, result, "needs-review", { excerpt });
          continue;
        }

        const current = await this.provider.getCurrentProject(chat);
        if (current && normalize(current.name) === normalize(project?.name ?? result.projectName)) {
          stats.alreadyOrganized++;
          console.log(options.dryRun ? "     DRY RUN: SKIP — already organized; no changes made" : "     ✓ already organized");
          if (!options.dryRun) {
            await this.persist(chat, key, result, "already-organized", { excerpt });
            await this.learn(project ?? current, chat.id ?? key, chat.title);
          }
          continue;
        }
        if (options.dryRun) {
          console.log(`     DRY RUN: ${project ? "MOVE" : "CREATE + MOVE"} → ${result.projectName}; no changes made`);
          continue;
        }

        if (!project) {
          project = await this.provider.createProject(cleanProjectName(result.projectName));
          projects = deduplicateProjects([...projects, project]);
          await this.store.saveProjects(projects);
          stats.projectsCreated++;
          await this.store.recordAction({ type: "project-created", name: project.name });
        }

        const outcome = await this.provider.addChatToProject(chat, project);
        if (!outcome.verified) {
          stats.unverified++;
          console.log(`     ⚠ move could not be verified — ${outcome.detail ?? "unknown reason"}`);
          await this.persist(chat, key, result, "unverified", { excerpt, detail: outcome.detail });
          // Deliberately no learn() call: an unconfirmed move must not feed the
          // project profile, or a wrong guess reinforces itself on later runs.
          continue;
        }
        stats.moved++;
        console.log("     ✓ moved");
        await this.persist(chat, key, result, "moved", { excerpt });
        await this.learn(project, chat.id ?? key, chat.title);
      } catch (error) {
        // Throttling is not this conversation's fault and the next one will hit
        // the same wall. Stop, and leave the chat unrecorded so it is retried.
        // Not a failure to retry: the site has no action for this conversation.
        if (error instanceof UnsupportedConversationError) {
          stats.unsupported++;
          console.log(`     ⊘ ${error.message}`);
          if (!options.dryRun) await this.persist(chat, key, null, "unsupported", { excerpt, detail: error.message });
          continue;
        }
        if (error instanceof RateLimitedError) {
          console.error(`\n     ⏸ ${error.message}`);
          break;
        }
        stats.errors++;
        const message = error instanceof Error ? error.message : String(error);
        if (!printed) console.error(`\n[${String(zeroIndex + 1).padStart(2, "0")}/${String(candidates.length).padStart(2, "0")}] ${chat.title}`);
        console.error(`     ✗ ${message}`);
        const diagnostics = options.dryRun
          ? "disabled during dry run"
          : await this.provider.captureDiagnostics("process-chat", error).catch(() => "diagnostics unavailable");
        if (!options.dryRun) {
          const failed: ProcessedChat = {
            key, id: chat.id, url: chat.url, title: chat.title, provider: this.provider.provider,
            processedAt: new Date().toISOString(), classificationConfidence: 0, status: "error",
            error: `${message}; diagnostics: ${diagnostics}`, excerpt,
          };
          await this.store.upsertChat(failed);
          await this.store.recordAction({ type: "error", chatKey: key, title: chat.title, error: message, diagnostics });
        }
      }
    }

    printSummary(stats);
    return stats;
  }

  private async projectProfiles(projects: Project[]): Promise<ProjectProfile[]> {
    const index = await this.store.loadProjectIndex();
    return projects.map((project) => index.projects[project.name] ?? {
      name: project.name,
      description: "",
      keywords: [project.name],
      aliases: project.aliases ?? [],
      exampleChatIds: [],
    });
  }

  private async persist(
    chat: { id?: string; url?: string; title: string },
    key: string,
    result: ClassificationResult | null,
    status: ProcessedChat["status"],
    extra: { excerpt?: string; detail?: string } = {},
  ): Promise<void> {
    const { excerpt, detail } = extra;
    const item: ProcessedChat = {
      key, id: chat.id, url: chat.url, title: chat.title, provider: this.provider.provider,
      project: result?.projectName, processedAt: new Date().toISOString(),
      classificationConfidence: result?.confidence ?? 0, status, error: detail, excerpt,
    };
    await this.store.upsertChat(item);
    await this.store.recordAction({ type: status, chatKey: key, title: chat.title, project: result?.projectName, confidence: result?.confidence, detail });
  }

  private async learn(project: Project, chatId: string, title: string): Promise<void> {
    const index = await this.store.loadProjectIndex();
    const profile = index.projects[project.name] ?? {
      name: project.name, description: "", keywords: [project.name], aliases: project.aliases ?? [], exampleChatIds: [],
    };
    if (!profile.exampleChatIds.includes(chatId)) profile.exampleChatIds.push(chatId);
    profile.exampleChatIds = profile.exampleChatIds.slice(-25);

    // Harvesting every word of every title is what let one project swallow the
    // rest: generic words such as "processo" or "melhor" entered the profile,
    // matched the next unrelated chat, and the wrong match then taught the
    // profile even more generic words. Only terms that no other project claims
    // are kept, and the budget is small enough to stay a signal, not a net.
    const claimedElsewhere = new Set<string>();
    for (const [name, other] of Object.entries(index.projects)) {
      if (name === project.name) continue;
      for (const keyword of other.keywords) claimedElsewhere.add(normalize(keyword));
    }
    for (const word of title.match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) ?? []) {
      const candidate = normalize(word);
      if (GENERIC_TITLE_WORDS.has(candidate) || claimedElsewhere.has(candidate)) continue;
      if (profile.keywords.some((item) => normalize(item) === candidate)) continue;
      profile.keywords.push(word);
    }
    profile.keywords = dropKeywordsClaimedElsewhere(profile.keywords, claimedElsewhere).slice(0, 12);
    index.projects[project.name] = profile;
    await this.store.saveProjectIndex(index);
  }
}

/**
 * Title words that say nothing about which project a conversation belongs to.
 * The project name itself is always kept, so a profile never becomes empty.
 */
const GENERIC_TITLE_WORDS = new Set([
  "ajuda", "análise", "analise", "arquivo", "busca", "como", "conversa", "criar", "dados", "erro",
  "escrever", "exemplo", "fazer", "ideia", "jeito", "link", "links", "lista", "melhor", "melhoria",
  "modelo", "para", "problema", "processo", "projeto", "prompt", "resumo", "simples", "sobre",
  "solução", "solucao", "teste", "testes", "usar", "uma",
  "about", "after", "code", "conversation", "create", "data", "error", "example", "file", "help",
  "idea", "list", "make", "model", "problem", "project", "prompt", "question", "review", "simple",
  "solution", "summary", "test", "tests", "that", "this", "with", "write",
]);

const TITLE_WORD = /[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu;

export interface VerifiedChats {
  titles: string[];
  chatIds: string[];
}

/**
 * Recomputes every profile from conversations whose placement was actually
 * verified, discarding whatever earlier runs learned from moves that never
 * happened. Both halves of a profile are rebuilt: keywords, and the example
 * chat IDs — an ID left over from a failed move keeps re-asserting the wrong
 * project at high confidence, which is exactly what it is designed to do.
 *
 * A term is kept only when exactly one project uses it, so the profiles stay
 * mutually exclusive by construction.
 */
export function rebuildProfileKeywords(index: ProjectIndexFile, verifiedByProject: Map<string, VerifiedChats>): void {
  const termCounts = new Map<string, Map<string, number>>();
  for (const [projectName, verified] of verifiedByProject) {
    const counts = new Map<string, number>();
    for (const title of verified.titles) {
      for (const word of title.match(TITLE_WORD) ?? []) {
        const term = normalize(word);
        if (GENERIC_TITLE_WORDS.has(term) || normalize(projectName) === term) continue;
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    }
    termCounts.set(projectName, counts);
  }

  const owners = new Map<string, number>();
  for (const counts of termCounts.values()) {
    for (const term of counts.keys()) owners.set(term, (owners.get(term) ?? 0) + 1);
  }

  for (const [projectName, profile] of Object.entries(index.projects)) {
    const counts = termCounts.get(projectName);
    const distinctive = [...(counts ?? new Map<string, number>())]
      .filter(([term]) => owners.get(term) === 1)
      .sort((left, right) => right[1] - left[1])
      .map(([term]) => term)
      .slice(0, 11);
    profile.keywords = [projectName, ...distinctive];
    profile.exampleChatIds = verifiedByProject.get(projectName)?.chatIds ?? [];
    index.projects[projectName] = profile;
  }
}

/** Removes terms another project already owns, so profiles stay disjoint. */
function dropKeywordsClaimedElsewhere(keywords: string[], claimedElsewhere: Set<string>): string[] {
  const kept: string[] = [];
  for (const [position, keyword] of keywords.entries()) {
    // Index 0 is the project's own name and always stays.
    if (position === 0 || !claimedElsewhere.has(normalize(keyword))) kept.push(keyword);
  }
  return kept;
}

export function deduplicateProjects(projects: Project[]): Project[] {
  const result: Project[] = [];
  for (const project of projects) {
    if (!project.name.trim()) continue;
    const existing = findProject(result, project.name);
    if (!existing) result.push({ ...project, name: cleanProjectName(project.name) });
  }
  return result;
}

export function cleanProjectName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 60);
}

function printSummary(stats: RunStats): void {
  console.log("\n--------------------------------");
  console.log(`Processed: ${stats.processed}`);
  if (stats.scanned) console.log(`Scanned (proposals recorded, site untouched): ${stats.scanned}`);
  console.log(`Moved: ${stats.moved}`);
  console.log(`Unverified (will be retried): ${stats.unverified}`);
  console.log(`Already organized: ${stats.alreadyOrganized}`);
  console.log(`Projects created: ${stats.projectsCreated}`);
  console.log(`Needs review: ${stats.needsReview}`);
  console.log(`Unsupported (the site offers no way to move these): ${stats.unsupported}`);
  console.log(`Errors: ${stats.errors}`);
}
