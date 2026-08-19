import { ensureAuthenticated } from "./browser/auth.js";
import { rebuildProfileKeywords, type VerifiedChats } from "./organizer.js";
import type { ConversationProvider } from "./providers/provider.js";
import type { StateStore } from "./state/state-store.js";
import type { ProcessedChat } from "./types/index.js";

export interface VerifyOptions {
  /** Report mismatches without rewriting the local state. */
  dryRun: boolean;
  /** Discard learned keyword profiles and rebuild them from verified chats. */
  rebuildProfiles: boolean;
  maxChats: number;
}

export interface VerifyStats {
  checked: number;
  confirmed: number;
  mismatched: number;
  missing: number;
  errors: number;
}

const normalize = (value: string): string => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * Re-reads every conversation the local state claims to have organized and
 * compares it against the live site.
 *
 * This exists because a browser automation can be wrong about its own effects:
 * a menu click that lands on nothing leaves the state file saying `moved` while
 * the conversation never left the inbox. Records that fail verification are
 * downgraded to `unverified` so the next organize run picks them up again.
 */
export class Verifier {
  constructor(
    private readonly provider: ConversationProvider,
    private readonly store: StateStore,
  ) {}

  async run(options: VerifyOptions): Promise<VerifyStats> {
    const stats: VerifyStats = { checked: 0, confirmed: 0, mismatched: 0, missing: 0, errors: 0 };
    await this.provider.open();
    await ensureAuthenticated(this.provider);

    const file = await this.store.loadChats();
    const claimed = file.chats
      .filter((chat) => chat.status === "moved" || chat.status === "already-organized")
      .slice(0, options.maxChats);

    if (!claimed.length) {
      console.log("\nNothing to verify: no conversation is recorded as organized.");
      return stats;
    }

    console.log(`\nVerifying ${claimed.length} conversation(s) recorded as organized...`);
    const confirmedByProject = new Map<string, VerifiedChats>();

    for (const [zeroIndex, chat] of claimed.entries()) {
      stats.checked += 1;
      const label = `[${String(zeroIndex + 1).padStart(2, "0")}/${String(claimed.length).padStart(2, "0")}] ${chat.title}`;
      try {
        const actual = await this.provider.getCurrentProject({ id: chat.id, title: chat.title, url: chat.url });
        const expected = chat.project ?? "";
        if (actual && expected && normalize(actual.name) === normalize(expected)) {
          stats.confirmed += 1;
          console.log(`${label}\n     ✓ in "${actual.name}"`);
          const verified = confirmedByProject.get(actual.name) ?? { titles: [], chatIds: [] };
          verified.titles.push(chat.title);
          if (chat.id) verified.chatIds.push(chat.id);
          confirmedByProject.set(actual.name, verified);
          continue;
        }

        if (!actual) stats.missing += 1;
        else stats.mismatched += 1;
        console.log(
          `${label}\n     ✗ expected "${expected || "(none recorded)"}" but found ${actual ? `"${actual.name}"` : "no project"}`,
        );
        if (!options.dryRun) await this.downgrade(chat, actual?.name);
      } catch (error) {
        stats.errors += 1;
        console.error(`${label}\n     ✗ ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.rebuildProfiles && !options.dryRun) {
      const index = await this.store.loadProjectIndex();
      rebuildProfileKeywords(index, confirmedByProject);
      await this.store.saveProjectIndex(index);
      console.log("\nRebuilt keyword profiles from verified conversations only.");
    }

    console.log("\n--------------------------------");
    console.log(`Checked: ${stats.checked}`);
    console.log(`Confirmed: ${stats.confirmed}`);
    console.log(`In the wrong project: ${stats.mismatched}`);
    console.log(`Not in any project: ${stats.missing}`);
    console.log(`Errors: ${stats.errors}`);
    if (options.dryRun) console.log("\nDRY RUN: local state was not changed.");
    else if (stats.mismatched + stats.missing > 0) {
      console.log("\nThose conversations are queued again. Re-run organize to retry them.");
    }
    return stats;
  }

  private async downgrade(chat: ProcessedChat, observedProject?: string): Promise<void> {
    await this.store.upsertChat({
      ...chat,
      status: "unverified",
      processedAt: new Date().toISOString(),
      error: observedProject
        ? `verification found it in "${observedProject}" instead of "${chat.project ?? ""}"`
        : "verification found it in no project",
    });
    await this.store.recordAction({
      type: "verification-failed",
      chatKey: chat.key,
      title: chat.title,
      expected: chat.project,
      observed: observedProject,
    });
  }
}
