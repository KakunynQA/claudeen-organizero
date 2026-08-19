#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { BrowserSession } from "./browser/browser-session.js";
import { ensureAuthenticated } from "./browser/auth.js";
import { runNativeLogin } from "./browser/installed-browser.js";
import { createClassifier } from "./classifier/index.js";
import { defaultClassifier, loadConfig, loadProjectRules } from "./config/config.js";
import { Organizer } from "./organizer.js";
import { ChatGPTProvider } from "./providers/chatgpt/index.js";
import { ClaudeProvider } from "./providers/claude/index.js";
import type { ConversationProvider } from "./providers/provider.js";
import { buildReport } from "./report.js";
import { StateStore } from "./state/state-store.js";
import { Verifier } from "./verifier.js";
import type { ProviderName } from "./types/index.js";

type Command = "login" | "organize" | "scan" | "archive" | "verify" | "projects" | "status" | "inspect" | "report";

const COMMANDS: Command[] = ["login", "organize", "scan", "archive", "verify", "projects", "status", "inspect", "report"];

interface CliOptions {
  command: Command;
  provider: ProviderName;
  dryRun: boolean;
  maxChats?: number;
  /** Where `report` writes its Markdown; defaults to the state directory. */
  out?: string;
  refreshProjects: boolean;
  reprocess: boolean;
  headed: boolean;
  debug: boolean;
  backfill: boolean;
  rebuildProfiles: boolean;
  titlesOnly: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv.shift() as Command | undefined;
  if (!command || !COMMANDS.includes(command)) {
    throw new Error(
      `Usage: npm run <${COMMANDS.join("|")}> -- --provider <chatgpt|claude> [options]\n`
      + "       scan reads and classifies every conversation without touching the site, then report renders the proposals\n"
      + "       report writes a Markdown audit of the local state; use --out <path> to choose the file",
    );
  }
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["provider", "max-chats", "out"].includes(key)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
      values.set(key, value);
    } else if (["dry-run", "refresh-projects", "reprocess", "backfill", "rebuild-profiles", "titles-only", "headless", "debug"].includes(key)) {
      values.set(key, true);
    } else throw new Error(`Unknown option: --${key}`);
  }
  const provider = values.get("provider");
  if (provider !== "chatgpt" && provider !== "claude") throw new Error("--provider must be chatgpt or claude");
  const rawOut = values.get("out");
  const rawMax = values.get("max-chats");
  const maxChats = typeof rawMax === "string" ? Number(rawMax) : undefined;
  if (maxChats !== undefined && (!Number.isInteger(maxChats) || maxChats < 1)) {
    throw new Error("--max-chats must be a positive integer");
  }
  // Rejected at the edge, before a browser is opened. Rebuilding profiles from
  // a capped pass would recompute each examined project's keywords from only
  // the slice that happened to fit under the cap.
  if (command === "verify" && values.has("rebuild-profiles") && maxChats !== undefined) {
    throw new Error(
      "--rebuild-profiles recomputes a project's keywords from every conversation verified in the pass, "
      + "so it has to see the whole state. Drop --max-chats.",
    );
  }
  return {
    command,
    provider,
    dryRun: values.has("dry-run"),
    maxChats,
    out: typeof rawOut === "string" ? rawOut : undefined,
    refreshProjects: values.has("refresh-projects"),
    reprocess: values.has("reprocess"),
    headed: !values.has("headless"),
    debug: values.has("debug"),
    backfill: values.has("backfill"),
    rebuildProfiles: values.has("rebuild-profiles"),
    titlesOnly: values.has("titles-only"),
  };
}

/**
 * `resolve()` leaves a leading `~` alone, so `--out ~/report.md` used to create a
 * directory literally named `~` inside the repository.
 */
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = new StateStore(config.stateDir, options.provider);

  console.log("claudeen-organizero\n");
  console.log(`Provider: ${options.provider === "chatgpt" ? "ChatGPT" : "Claude"}`);

  if (options.command === "status") {
    const summary = await store.summary();
    console.log(`Projects cached: ${summary.projects}`);
    console.log(`Chats recorded: ${summary.chats}`);
    for (const [status, count] of Object.entries(summary.byStatus).sort()) console.log(`${status}: ${count}`);
    return;
  }

  // Reads state only, like `status`: the report must never touch the site, so a
  // run in progress cannot be disturbed by asking for an audit.
  if (options.command === "report") {
    const { chats } = await store.loadChats();
    const path = resolve(expandTilde(options.out ?? `${config.stateDir}/report-${options.provider}.md`));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buildReport(chats, options.provider), "utf8");
    console.log(`Wrote report for ${chats.length} conversation(s) to ${path}`);
    return;
  }

  if (options.command === "login") {
    console.log("\nOpening a normal installed browser for manual authentication.");
    await runNativeLogin(options.provider, config);
    return;
  }

  const session = new BrowserSession(options.provider, config, options.headed, options.debug);
  const { page } = await session.launch();
  const provider: ConversationProvider = options.provider === "chatgpt"
    ? new ChatGPTProvider(page, { baseUrl: config.urls.chatgpt, diagnosticsDir: `${config.stateDir}/debug` })
    : new ClaudeProvider(page, { baseUrl: config.urls.claude, stateDir: config.stateDir });

  let shuttingDown = false;
  const handleSignal = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nClosing the dedicated browser session...");
    await provider.close().catch(() => undefined);
    await session.close().catch(() => undefined);
    process.exit(130);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    if (options.command === "inspect") {
      await provider.open();
      await ensureAuthenticated(provider);
      await provider.inspect();
      return;
    }

    if (options.command === "projects") {
      await provider.open();
      await ensureAuthenticated(provider);
      const projects = await provider.listProjects();
      await store.saveProjects(projects);
      if (projects.length === 0) console.log("No projects discovered.");
      else for (const project of projects) console.log(`- ${project.name}${project.url ? ` · ${project.url}` : ""}`);
      console.log(`\nCached ${projects.length} projects.`);
      return;
    }

    // Archives what no project can hold. Deliberately narrow: it only ever
    // touches conversations the local state already marked "unsupported", so a
    // mistyped command cannot archive a conversation that simply failed once.
    if (options.command === "archive") {
      if (!provider.archiveChat) throw new Error(`Archiving is not implemented for ${options.provider}`);
      const { chats } = await store.loadChats();
      const targets = chats.filter((chat) => chat.status === "unsupported").slice(0, options.maxChats ?? Number.POSITIVE_INFINITY);
      console.log(`Mode: ${options.dryRun ? "DRY RUN" : "LIVE"}`);
      console.log(`
Archiving ${targets.length} conversation(s) the site cannot move...`);
      await provider.open();
      await ensureAuthenticated(provider);
      // The rows live in the history list, so it has to be on screen — the same
      // reason the move path reads the list instead of opening conversations.
      await provider.listChats({ maxChats: 1 });
      let archived = 0;
      let failed = 0;
      for (const [index, chat] of targets.entries()) {
        const label = `[${String(index + 1).padStart(2, "0")}/${String(targets.length).padStart(2, "0")}] ${chat.title}`;
        if (options.dryRun) {
          console.log(`${label}
     DRY RUN: would archive; no changes made`);
          continue;
        }
        const outcome = await provider.archiveChat({ id: chat.id, title: chat.title, url: chat.url }).catch((error: unknown) => ({
          archived: false,
          detail: error instanceof Error ? error.message : String(error),
        }));
        if (outcome.archived) {
          archived += 1;
          console.log(`${label}
     ✓ archived`);
          await store.upsertChat({ ...chat, status: "archived", processedAt: new Date().toISOString(), error: undefined });
          await store.recordAction({ type: "archived", chatKey: chat.key, title: chat.title });
        } else {
          failed += 1;
          console.log(`${label}
     ✗ ${outcome.detail ?? "could not archive"}`);
        }
      }
      console.log("\n--------------------------------");
      console.log(`Archived: ${archived}`);
      console.log(`Left alone: ${failed}`);
      return;
    }

    if (options.command === "verify") {
      console.log(`Mode: ${options.dryRun ? "DRY RUN" : "LIVE"}`);
      await new Verifier(provider, store).run({
        dryRun: options.dryRun,
        rebuildProfiles: options.rebuildProfiles,
        maxChats: options.maxChats ?? Number.POSITIVE_INFINITY,
      });
      return;
    }

    const classifierName = defaultClassifier(options.provider, config.classifier.provider);
    const rules = loadProjectRules();
    const apiKey = classifierName === "openai" ? process.env.OPENAI_API_KEY : classifierName === "anthropic" ? process.env.ANTHROPIC_API_KEY : undefined;
    const model = classifierName === "openai"
      ? process.env.OPENAI_MODEL ?? config.classifier.openaiModel
      : process.env.ANTHROPIC_MODEL ?? config.classifier.anthropicModel;
    const classifier = createClassifier(classifierName, {
      apiKey,
      model,
      rules,
      thresholds: {
        existingProject: config.classifier.existingProjectThreshold,
        newProject: config.classifier.newProjectThreshold,
        keywordCeiling: config.classifier.keywordCeiling,
      },
      maxContextChars: config.classifier.maxContextChars,
    });
    console.log(`Mode: ${options.command === "scan" ? "SCAN (read only)" : options.dryRun ? "DRY RUN" : "LIVE"}`);
    console.log(`Classifier: deterministic${classifierName === "none" ? " only" : ` + ${classifierName} (${model})`}`);
    const organizer = new Organizer(provider, classifier, store, config);
    await organizer.run({
      dryRun: options.dryRun || options.command === "scan",
      scan: options.command === "scan",
      titlesOnly: options.titlesOnly,
      maxChats: options.maxChats ?? config.discovery.defaultMaxChats,
      refreshProjects: options.refreshProjects,
      reprocess: options.reprocess,
      backfill: options.backfill,
    });
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await provider.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  }
}

run().catch((error) => {
  console.error(`\nFatal: ${error instanceof Error ? error.message : String(error)}`);
  if (process.argv.includes("--debug") && error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
