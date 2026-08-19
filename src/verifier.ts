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
  /** Pages that could not be read. Not a verdict, so these are never downgraded. */
  unreadable: number;
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
    const stats: VerifyStats = { checked: 0, confirmed: 0, mismatched: 0, missing: 0, unreadable: 0, errors: 0 };
    // Projects this pass reached a definite answer about. Only these may have
    // their learned profile rebuilt: --rebuild-profiles used to reset every
    // project in the index, so verifying a 20-chat slice of a 200-chat state
    // wiped the keywords of every project the slice never touched.
    const examined = new Set<string>();
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
        const expected = chat.project ?? "";
        const reading = await this.provider.getCurrentProject(
          { id: chat.id, title: chat.title, url: chat.url },
          expected || undefined,
        );

        // An unreadable page is not a verdict. Downgrading on it rewrote good
        // `moved` records as `unverified` in bulk the moment a sidebar failed to
        // hydrate — the exact failure this command exists to catch, produced by
        // the command itself. Leave the record alone and look again next pass.
        if (reading.read === "unreadable") {
          stats.unreadable += 1;
          console.log(`${label}\n     ? could not be read: ${reading.reason} — left as is`);
          continue;
        }

        const actual = reading.read === "ok" ? reading.project : null;
        if (actual && expected && normalize(actual.name) === normalize(expected)) {
          stats.confirmed += 1;
          console.log(`${label}\n     ✓ in "${actual.name}"`);
          // Keyed by the recorded spelling: a provider may answer with the name
          // it read from the page, and rebuildProfileKeywords looks profiles up
          // by the name the index already uses.
          const verified = confirmedByProject.get(expected) ?? { titles: [], chatIds: [] };
          verified.titles.push(chat.title);
          if (chat.id) verified.chatIds.push(chat.id);
          confirmedByProject.set(expected, verified);
          examined.add(normalize(expected));
          continue;
        }

        if (!actual) stats.missing += 1;
        else stats.mismatched += 1;
        if (expected) examined.add(normalize(expected));
        console.log(
          `${label}\n     ✗ expected "${expected || "(none recorded)"}" but found ${actual ? `"${actual.name}"` : "no project"}`,
        );
        if (!options.dryRun) await this.downgrade(chat, actual?.name);
      } catch (error) {
        stats.errors += 1;
        // A conversation that threw was never judged, so its project must not be
        // rebuilt from a corpus that is missing it. One error quarantines the
        // whole profile for this pass.
        if (chat.project) examined.delete(normalize(chat.project));
        console.error(`${label}\n     ✗ ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.rebuildProfiles && !options.dryRun) {
      const index = await this.store.loadProjectIndex();
      rebuildProfileKeywords(index, confirmedByProject, examined);
      await this.store.saveProjectIndex(index);
      console.log("\nRebuilt keyword profiles for the projects this pass examined.");
    }

    console.log("\n--------------------------------");
    console.log(`Checked: ${stats.checked}`);
    console.log(`Confirmed: ${stats.confirmed}`);
    console.log(`In the wrong project: ${stats.mismatched}`);
    console.log(`Not in any project: ${stats.missing}`);
    console.log(`Could not be read (left as is): ${stats.unreadable}`);
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
