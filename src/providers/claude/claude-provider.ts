import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";

import type { ConversationProvider } from "../provider.js";
import type {
  ChatContext,
  ChatSummary,
  ListChatsOptions,
  MessageExcerpt,
  MoveOutcome,
  Project,
  ProjectReading,
} from "../../types/index.js";
import { CLAUDE_SELECTORS, CLAUDE_URLS } from "./selectors.js";
import { RateLimitedError } from "../../errors.js";
import { sanitizedPageHtml, sanitizedUrl } from "../../utils/diagnostics.js";

export interface ClaudeProviderOptions {
  /** A dedicated state directory. It is never the user's normal Chrome profile. */
  stateDir?: string;
  baseUrl?: string;
  /** Useful for callers that pass a page factory instead of a BrowserContext. */
  page?: Page;
  authenticationTimeoutMs?: number;
}

type PageOrContext = Page | BrowserContext;

const MAX_EXCERPT_LENGTH = 1_800;
const MAX_CONTEXT_LENGTH = 8_000;
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Claude renders an icon glyph from the Unicode private-use area before every
 * project name, so the label reads like "<glyph> Research". Those code points
 * survive `trim()`, which made " Research" a different project from "Research":
 * the lookup missed and the organizer created a second, empty project with the
 * name it had been asked for. Icon glyphs carry no meaning here, so they are
 * dropped along with the other invisibles at the one point where text enters.
 */
function compact(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value: string): string {
  return compact(value).toLocaleLowerCase().replace(/[“”"'`]/g, "");
}

function trimExcerpt(value: string): string {
  const text = compact(value);
  return text.length > MAX_EXCERPT_LENGTH
    ? `${text.slice(0, MAX_EXCERPT_LENGTH)}…`
    : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyUiNoise(text: string): boolean {
  const normalized = normalize(text);
  return (
    !normalized ||
    normalized.length < 2 ||
    /^(new chat|projects?|settings|help|share|send|stop|retry|log out|sign out)$/.test(normalized)
  );
}

/**
 * Playwright adapter for claude.ai.
 *
 * The provider intentionally uses semantic operations (open menu, choose
 * project, read messages) rather than exposing selectors to the organizer.
 * Claude's UI is a moving target, so each operation has a small set of
 * accessible fallbacks and produces diagnostics on failure.
 */
export class ClaudeProvider implements ConversationProvider {
  readonly provider = "claude" as const;

  private readonly context?: BrowserContext;
  private readonly stateDir: string;
  private readonly baseUrl: string;
  private readonly authenticationTimeoutMs: number;
  private page?: Page;
  private cachedProjects?: Project[];

  constructor(pageOrContext: PageOrContext, options: ClaudeProviderOptions = {}) {
    // Page has goto; BrowserContext does not. This avoids depending on a
    // project-specific browser-session wrapper while supporting both callers.
    if ("goto" in pageOrContext) {
      this.page = pageOrContext as Page;
    } else {
      this.context = pageOrContext as BrowserContext;
      this.page = options.page;
    }
    this.stateDir = options.stateDir ?? join(process.cwd(), ".state");
    this.baseUrl = options.baseUrl ?? CLAUDE_URLS.home;
    this.authenticationTimeoutMs = options.authenticationTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  }

  private async getPage(): Promise<Page> {
    if (this.page) return this.page;
    if (!this.context) throw new Error("ClaudeProvider requires a Playwright Page or BrowserContext");
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  private async visible(locator: Locator): Promise<boolean> {
    try {
      return await locator.first().isVisible({ timeout: 700 });
    } catch {
      return false;
    }
  }

  private async clickFirst(locators: Locator[]): Promise<boolean> {
    for (const locator of locators) {
      if (!(await this.visible(locator))) continue;
      try {
        await locator.first().click({ timeout: 2_500 });
        return true;
      } catch {
        // A locator can become stale while Claude re-renders. Try the next
        // semantic fallback instead of failing on the first hint.
      }
    }
    return false;
  }

  /**
   * Walking the sidebar is the most expensive read in this adapter and the
   * project list does not change within a run unless we create one, so it is
   * fetched once and reused. createProject invalidates it.
   *
   * An empty result is never cached: listProjects scrapes whatever page is
   * loaded, so `[]` usually means the sidebar had not hydrated yet rather than
   * that the account has no projects. Caching that one unlucky read would make
   * getCurrentProject return null for every remaining conversation in the run.
   */
  private async knownProjects(): Promise<Project[]> {
    if (!this.cachedProjects?.length) this.cachedProjects = await this.listProjects();
    return this.cachedProjects;
  }

  /**
   * Prefers the history sidebar. Falling back to every `/chat/` link on the page
   * also picks up conversations linked from inside the open conversation, whose
   * labels are message text rather than titles.
   */
  private async conversationLinks(): Promise<Locator> {
    const page = await this.getPage();
    const sidebar = page.locator(CLAUDE_SELECTORS.sidebarChatLinks.join(","));
    if ((await sidebar.count()) > 0) return sidebar;
    return page.locator(CLAUDE_SELECTORS.chatLinks.join(","));
  }

  /** Menus, submenus and dialogs currently on screen, outermost first. */
  private async visibleOverlays(): Promise<Locator[]> {
    const page = await this.getPage();
    const overlays = page.locator(CLAUDE_SELECTORS.overlayContainers);
    const count = Math.min(await overlays.count(), 10);
    const result: Locator[] = [];
    for (let index = 0; index < count; index += 1) {
      const overlay = overlays.nth(index);
      if (await overlay.isVisible().catch(() => false)) result.push(overlay);
    }
    return result;
  }

  /**
   * Claude signals throttling with a modal overlay that swallows every click.
   * Left undetected it degrades into one identical "click timed out" failure per
   * conversation. A dismissible modal is dismissed; one that survives means the
   * account is genuinely rate limited and the whole run has to stop.
   */
  private async assertNotThrottled(): Promise<void> {
    const page = await this.getPage();
    await this.assertNotBotChecked();
    if (!(await this.throttlingOverlayVisible())) return;

    await page.keyboard.press("Escape").catch(() => undefined);
    await page
      .getByRole("button", { name: CLAUDE_SELECTORS.dismissLabels })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await page.waitForTimeout(750);
    if (!(await this.throttlingOverlayVisible())) return;

    throw new RateLimitedError(
      "Claude is rate limiting the account and is blocking the UI with a modal overlay. " +
        "Wait before continuing; already organized conversations are saved and the rest stay queued.",
    );
  }

  /**
   * A throttling overlay is either explicitly marked as one, or is a modal whose
   * own text mentions a limit. Plain menus and the project chooser are dialogs
   * too, so the text check is what keeps this from firing on normal UI.
   */
  private async throttlingOverlayVisible(): Promise<boolean> {
    const page = await this.getPage();
    const marked = page.locator(CLAUDE_SELECTORS.rateLimitOverlay).first();
    if (await marked.isVisible().catch(() => false)) return true;

    const modal = page.locator('[role="dialog"][aria-modal="true"]').first();
    if (!(await modal.isVisible().catch(() => false))) return false;
    const text = compact(await modal.innerText().catch(() => ""));
    return CLAUDE_SELECTORS.rateLimitText.test(text);
  }

  async open(): Promise<void> {
    const page = await this.getPage();
    const current = page.url();
    if (!current.startsWith(this.baseUrl)) {
      await page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(250);
  }

  async isAuthenticated(): Promise<boolean> {
    const page = await this.getPage();
    const url = page.url();
    if (CLAUDE_SELECTORS.loginPath.test(url)) return false;

    const signIn = page.getByRole("link", { name: /(?:sign in|log in|login|create account)/i });
    const signInButton = page.getByRole("button", { name: /(?:sign in|log in|login|create account)/i });
    if ((await this.visible(signIn)) || (await this.visible(signInButton))) {
      // A logged-out landing page has neither conversations nor the app shell.
      const appEvidence = await page.locator('a[href*="/chat/"], textarea, [contenteditable="true"]').count();
      if (appEvidence === 0) return false;
    }

    const appEvidence = await page.locator('a[href*="/chat/"], textarea, [contenteditable="true"], [data-testid*="message"]').count();
    return appEvidence > 0 || !/claude\.ai/i.test(url);
  }

  async waitForAuthentication(): Promise<void> {
    const page = await this.getPage();
    if (await this.isAuthenticated()) return;

    console.log("Claude authentication required. Log in manually in the opened browser window; waiting…");
    try {
      await page.waitForFunction(
        () => {
          const path = window.location.pathname;
          const login = /\/(?:login|sign-in|auth)(?:\/|$)/i.test(path);
          const app = Boolean(
            document.querySelector('a[href*="/chat/"], textarea, [contenteditable="true"], [data-testid*="message"]'),
          );
          return !login && app;
        },
        undefined,
        { timeout: this.authenticationTimeoutMs },
      );
    } catch {
      throw new Error(
        `Timed out waiting for Claude authentication after ${this.authenticationTimeoutMs}ms. ` +
          "Complete login manually in the headed browser and retry.",
      );
    }
    await page.waitForTimeout(500);
  }

  private projectFromLink(text: string, href: string): Project | null {
    let parsed: URL;
    try {
      parsed = new URL(href, this.baseUrl);
    } catch {
      return null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex((part) => /^projects?$/i.test(part));
    const projectId = markerIndex >= 0 ? parts[markerIndex + 1] : undefined;
    if (!projectId) return null;
    if (/^(?:new|create|add)$/i.test(projectId)) return null;
    const name = compact(text.split("\n").map(compact).filter(Boolean).at(-1));
    if (!name || /^projects?$/i.test(name)) return null;
    return { id: projectId, name, url: parsed.toString() };
  }

  /** The `/project/<id>` segment of a URL, or undefined when there is none. */
  private projectIdFromUrl(value: string): string | undefined {
    let parsed: URL;
    try {
      parsed = new URL(value, this.baseUrl);
    } catch {
      return undefined;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex((part) => /^projects?$/i.test(part));
    const id = markerIndex >= 0 ? parts[markerIndex + 1] : undefined;
    // `/projects/new` is the creation route, not a project.
    return id && !/^(?:new|create|add)$/i.test(id) ? id : undefined;
  }

  private async projectLinks(): Promise<Array<{ locator: Locator; href: string; text: string }>> {
    const page = await this.getPage();
    const links = page.locator("a[href]");
    const count = Math.min(await links.count(), 500);
    const result: Array<{ locator: Locator; href: string; text: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
      const href = (await link.getAttribute("href")) ?? "";
      if (!CLAUDE_SELECTORS.projectsHref.test(href)) continue;
      const text = compact((await link.innerText().catch(() => "")) || (await link.getAttribute("aria-label")) || (await link.getAttribute("title")));
      result.push({ locator: link, href, text });
    }
    return result;
  }

  /**
   * Navigates and waits long enough for Claude's client-side rendering to put
   * content on the page. `domcontentloaded` fires before the app has drawn a
   * single conversation row, so a read straight after it finds nothing.
   */
  private async gotoAndSettle(url: string): Promise<void> {
    const page = await this.getPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
  }

  /** Absolute URL for one of Claude's own pages, honouring a configured base. */
  private pageUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  async listProjects(): Promise<Project[]> {
    const page = await this.getPage();
    let discovered = await this.collectProjects();
    if (discovered.size === 0) {
      // The app shell only lists projects while its sidebar is expanded, so an
      // empty result here means "not on screen", not "no projects". Claude's own
      // /projects page renders them as content. The previous URL is restored
      // because callers such as getCurrentProject read the conversation that was
      // open before asking which projects exist.
      const previous = page.url();
      await this.gotoAndSettle(this.pageUrl("/projects"));
      discovered = await this.collectProjects();
      if (previous && previous !== page.url()) {
        await this.gotoAndSettle(previous).catch(() => undefined);
      }
    }
    return [...discovered.values()];
  }

  private async collectProjects(): Promise<Map<string, Project>> {
    const page = await this.getPage();
    const discovered = new Map<string, Project>();
    for (const candidate of await this.projectLinks()) {
      const project = this.projectFromLink(candidate.text, candidate.href);
      if (!project) continue;
      const key = project.id ?? normalize(project.name);
      if (!discovered.has(key)) discovered.set(key, project);
    }

    // Some Claude builds render projects as buttons instead of links. Only
    // consider buttons near a Projects heading to avoid treating chat titles
    // as projects.
    if (discovered.size === 0) {
      const heading = page.getByRole("heading", { name: /projects?/i }).first();
      if (await this.visible(heading)) {
        const nearby = heading.locator("xpath=..//*[self::button or self::a]");
        const count = Math.min(await nearby.count(), 100);
        for (let index = 0; index < count; index += 1) {
          const item = nearby.nth(index);
          const name = compact((await item.innerText().catch(() => "")) || (await item.getAttribute("aria-label")));
          if (!name || /^projects?$/i.test(name) || isLikelyUiNoise(name)) continue;
          discovered.set(normalize(name), { name });
        }
      }
    }
    return discovered;
  }

  /**
   * Identity keys for one conversation, in precedence order — the same rule
   * StateStore.chatKey uses.
   *
   * The title is only a fallback for a row with no id and no url. Matching on
   * *any* of the three meant a new conversation sharing a title with an
   * organized one ("Untitled", a re-asked question) was treated as already
   * known: it never reached the classifier, and each false match pushed the
   * scroll closer to its consecutive-known cutoff.
   */
  private chatKey(chat: ChatSummary): string[] {
    const stable = chat.id || chat.url || chat.title;
    return stable ? [normalize(stable)] : [];
  }

  /**
   * Scrolls the history list's real scroll container. Nudging the last anchor
   * into view is not enough once the list is virtualized: the last rendered
   * anchor is already on screen, so the nudge is a no-op. Walking up from the
   * anchor to the nearest scrollable ancestor always advances, and the return
   * value reports only whether the viewport moved — never whether new rows
   * appeared, which the caller measures for itself.
   */
  private async scrollConversationList(): Promise<boolean> {
    const page = await this.getPage();
    const last = (await this.conversationLinks()).last();
    if ((await last.count()) === 0) return false;

    const advanced = await last
      .evaluate((element) => {
        const isScrollable = (node: Element): boolean => node.scrollHeight > node.clientHeight + 4;
        let node: HTMLElement | null = element as HTMLElement;
        while (node && !isScrollable(node)) node = node.parentElement;
        if (!node) return false;
        const before = node.scrollTop;
        node.scrollTop = Math.min(before + node.clientHeight * 0.9, node.scrollHeight);
        return node.scrollTop !== before;
      })
      .catch(() => false);

    // On /recents the list is page content, not a scroll box: the walk upwards
    // finds no scrollable ancestor and the old code silently stopped advancing
    // while still reporting success, which is how a long history looked like 25
    // conversations. Scrolling the window is the fallback that actually moves.
    const windowAdvanced = advanced
      ? false
      : await page
          .evaluate(() => {
            const before = window.scrollY;
            window.scrollBy(0, Math.max(window.innerHeight * 0.9, 400));
            return window.scrollY !== before;
          })
          .catch(() => false);

    if (!advanced && !windowAdvanced) await last.scrollIntoViewIfNeeded().catch(() => undefined);
    // Rows are fetched, not just rendered: /recents appends the next page from
    // the network, which needs noticeably longer than a virtualized re-render.
    await page.waitForTimeout(900);
    await this.clickLoadMore();
    return true;
  }

  /**
   * Waits for the history to actually render, with one reload as a second
   * chance. A fixed pause cannot do this job: the same page took under a second
   * on one run and longer than that on the next, and the short read reported an
   * account full of conversations as an empty history.
   */
  private async waitForConversationLinks(): Promise<void> {
    const page = await this.getPage();
    const anchors = page.locator(CLAUDE_SELECTORS.chatLinks.join(","));
    for (const attempt of [0, 1]) {
      if (await anchors.first().waitFor({ state: "attached", timeout: 15_000 }).then(() => true).catch(() => false)) {
        await this.waitForStableCount(anchors);
        return;
      }
      if (attempt === 0) {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await page.waitForTimeout(1_200);
      }
    }
  }

  /**
   * Waits until the list stops growing, not until it starts.
   *
   * /recents fills in progressively, so reading the moment the first anchor
   * attaches captures a snapshot of whatever had arrived — the same page read as
   * 25 conversations, then 1, then 20 across three runs, and a discovery that
   * silently under-reads is worse than one that fails, because the missing
   * conversations look like conversations that do not exist.
   */
  private async waitForStableCount(anchors: Locator): Promise<void> {
    const page = await this.getPage();
    let previous = -1;
    let stable = 0;
    for (let round = 0; round < 25 && stable < 3; round += 1) {
      const count = await anchors.count();
      stable = count === previous ? stable + 1 : 0;
      previous = count;
      await page.waitForTimeout(400);
    }
  }

  /**
   * Some builds stop infinite scrolling behind an explicit control. Clicking it
   * when present costs one lookup per scroll and is the difference between the
   * first page of history and all of it.
   */
  private async clickLoadMore(): Promise<void> {
    const page = await this.getPage();
    const control = page
      .getByRole("button", { name: /^(?:load|show|see)\s+more/i })
      .or(page.getByRole("link", { name: /^(?:load|show|see)\s+more/i }))
      .first();
    if (!(await this.visible(control))) return;
    await control.click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(900);
  }

  async listChats(options: ListChatsOptions = {}): Promise<ChatSummary[]> {
    const page = await this.getPage();
    if (!page.url().startsWith(this.baseUrl)) await this.open();
    // Discovery reads /recents, not the app shell. On the shell the history
    // sidebar starts collapsed, so it holds no conversation anchors at all and
    // the scrape reports an empty history for a full account.
    const recents = this.pageUrl("/recents");
    if (!page.url().startsWith(recents)) await this.gotoAndSettle(recents);
    // Checked before the read, not after: a bot check renders no conversations,
    // and "no conversations" is indistinguishable from an empty history.
    await this.assertNotBotChecked();
    await this.waitForConversationLinks();
    const maxChats = Math.max(0, options.maxChats ?? 50);
    const known = options.knownKeys ?? new Set<string>();
    const knownStopCount = Math.max(1, options.knownChatStopCount ?? 8);
    const chats = new Map<string, ChatSummary>();
    const seen = new Set<string>();
    let consecutiveKnown = 0;
    let unchangedRounds = 0;

    for (let attempt = 0; attempt < 60 && chats.size < maxChats; attempt += 1) {
      const links = await this.conversationLinks();
      const count = Math.min(await links.count(), 600);
      if (attempt === 0 && count === 0) {
        // Distinguish "no new conversations to organize" from "the sidebar never
        // loaded". Reporting a failed read as an empty history is how a blocked
        // run looks perfectly calm while doing nothing at all.
        await this.assertNotThrottled();
        throw new Error("Claude's conversation sidebar contained no conversations — it did not load");
      }
      const seenBefore = seen.size;
      for (let index = 0; index < count && chats.size < maxChats; index += 1) {
        const link = links.nth(index);
        const href = (await link.getAttribute("href")) ?? "";
        if (!CLAUDE_SELECTORS.chatHref.test(href)) continue;
        const absoluteUrl = new URL(href, this.baseUrl).toString();
        const pathParts = new URL(absoluteUrl).pathname.split("/").filter(Boolean);
        const id = pathParts.at(-1);
        const title = compact((await link.innerText().catch(() => "")) || (await link.getAttribute("aria-label")) || (await link.getAttribute("title")));
        if (!id || !title || isLikelyUiNoise(title)) continue;
        const chat: ChatSummary = { id, title, url: absoluteUrl };
        const keySet = this.chatKey(chat);
        const dedupeKey = normalize(absoluteUrl);
        if (seen.has(dedupeKey)) continue;
        // Known conversations count as progress too: a scroll that only reveals
        // already-organized chats still moved the list forward.
        seen.add(dedupeKey);
        const alreadyKnown = keySet.some((key) => known.has(key));
        if (alreadyKnown) {
          consecutiveKnown += 1;
          if (consecutiveKnown >= knownStopCount) break;
          continue;
        }
        consecutiveKnown = 0;
        chats.set(dedupeKey, chat);
      }
      if (chats.size >= maxChats || consecutiveKnown >= knownStopCount) break;
      // The sidebar is virtualized: it holds roughly a screenful of anchors no
      // matter how far you scroll, so the anchor *count* never grows and any
      // loop that stops on an unchanged count stops after one screen. Progress
      // is whether this scroll revealed conversations not seen before.
      // Six rather than three: a network-backed page can return nothing for a
      // couple of scrolls and then resume. Three rounds ended discovery early on
      // a history that had plenty left.
      unchangedRounds = seen.size === seenBefore ? unchangedRounds + 1 : 0;
      if (unchangedRounds >= 6) break;
      if (!(await this.scrollConversationList())) break;
    }
    return [...chats.values()].slice(0, maxChats);
  }

  async openChat(chat: ChatSummary): Promise<void> {
    const page = await this.getPage();
    if (chat.url) {
      const url = new URL(chat.url, this.baseUrl).toString();
      if (page.url() !== url) await page.goto(url, { waitUntil: "domcontentloaded" });
    } else if (chat.id) {
      await page.goto(`${this.baseUrl.replace(/\/$/, "")}/chat/${encodeURIComponent(chat.id)}`, { waitUntil: "domcontentloaded" });
    } else {
      throw new Error(`Cannot open Claude chat without id or url: ${chat.title}`);
    }
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(300);
  }

  /**
   * Navigates to the conversation unless the page is already showing it.
   *
   * Every read that claims to describe a specific conversation goes through
   * this first: reading whatever page happens to be loaded is how a run ends up
   * judging forty conversations from a single view of the app home page.
   */
  private async ensureChatOpen(chat: ChatSummary): Promise<void> {
    const currentUrl = (await this.getPage()).url();
    const expectedUrl = chat.url ? new URL(chat.url, this.baseUrl).toString() : undefined;
    const onChat = chat.id ? currentUrl.includes(`/chat/${chat.id}`) : false;
    if ((expectedUrl && currentUrl !== expectedUrl) || (!expectedUrl && chat.id && !onChat)) {
      await this.openChat(chat);
    }
  }

  /**
   * The conversation list already carries the real title, so it is trusted
   * first. Reading the DOM instead used to return the transcript's first
   * markdown heading — `main`'s first heading is a message, not the
   * conversation — which silently replaced titles like "Organizar conversas em
   * projects" with whatever the assistant had written in bold. Classification
   * reads the title, so every title-based rule stopped matching.
   */
  private async readTitle(chat: ChatSummary): Promise<string> {
    if (chat.title && !isLikelyUiNoise(chat.title)) return compact(chat.title);
    const page = await this.getPage();
    const candidates = [
      page.locator('[data-testid*="chat-title" i]').first(),
      page.locator("h1").first(),
      page.locator("main").getByRole("heading").first(),
      page.locator("title").first(),
    ];
    for (const candidate of candidates) {
      const text = compact(await candidate.innerText().catch(() => ""));
      if (text && !isLikelyUiNoise(text)) return text;
    }
    return chat.title;
  }

  private async extractMessageExcerpts(): Promise<MessageExcerpt[]> {
    const page = await this.getPage();
    const candidates = page.locator("main [data-testid], main [data-message-author-role], main [data-role]");
    const count = Math.min(await candidates.count(), 300);
    const excerpts: MessageExcerpt[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const text = trimExcerpt(await candidate.innerText().catch(() => ""));
      if (isLikelyUiNoise(text) || seen.has(text)) continue;
      const testId = compact(await candidate.getAttribute("data-testid"));
      const author = compact(
        (await candidate.getAttribute("data-message-author-role")) ||
          (await candidate.getAttribute("data-role")) ||
          (await candidate.getAttribute("aria-label")) ||
          testId,
      );
      let role: MessageExcerpt["role"];
      if (CLAUDE_SELECTORS.userMessageTestId.test(author)) role = "user";
      else if (CLAUDE_SELECTORS.assistantMessageTestId.test(author)) role = "assistant";
      else if (CLAUDE_SELECTORS.messageTestId.test(author)) {
        // Unknown message markers are most commonly user/assistant turns. An
        // alternating fallback keeps the context useful on older DOM builds.
        role = excerpts.length % 2 === 0 ? "user" : "assistant";
      } else continue;
      seen.add(text);
      excerpts.push({ role, text });
    }

    if (excerpts.length === 0) {
      // Last-resort extraction for a UI build that has no message test IDs.
      // Paragraphs are deliberately capped and never logged wholesale.
      const paragraphs = page.locator("main p");
      const countParagraphs = Math.min(await paragraphs.count(), 20);
      for (let index = 0; index < countParagraphs; index += 1) {
        const text = trimExcerpt(await paragraphs.nth(index).innerText().catch(() => ""));
        if (!isLikelyUiNoise(text) && !seen.has(text)) {
          seen.add(text);
          excerpts.push({ role: index === 0 ? "user" : "assistant", text });
        }
      }
    }

    const users = excerpts.filter((excerpt) => excerpt.role === "user").slice(0, 1).concat(excerpts.filter((excerpt) => excerpt.role === "user").slice(-5));
    const assistants = excerpts.filter((excerpt) => excerpt.role === "assistant").slice(0, 1).concat(excerpts.filter((excerpt) => excerpt.role === "assistant").slice(-3));
    const result: MessageExcerpt[] = [];
    for (const excerpt of [...users, ...assistants]) {
      if (!result.some((existing) => existing.role === excerpt.role && existing.text === excerpt.text)) result.push(excerpt);
    }
    return result;
  }

  async readChatContext(chat: ChatSummary): Promise<ChatContext> {
    await this.ensureChatOpen(chat);
    const title = await this.readTitle(chat);
    const excerpts = await this.extractMessageExcerpts();
    let total = title.length;
    const limited: MessageExcerpt[] = [];
    for (const excerpt of excerpts) {
      if (total + excerpt.text.length > MAX_CONTEXT_LENGTH) break;
      limited.push(excerpt);
      total += excerpt.text.length;
    }
    return { id: chat.id, title, url: chat.url ?? (await this.getPage()).url(), excerpts: limited };
  }

  async getCurrentProject(chat: ChatSummary, expected?: string): Promise<ProjectReading> {
    // The caller only supplies the conversation, so the answer has to be read
    // from that conversation. Verifier.run relies on this: it never navigates.
    await this.ensureChatOpen(chat);
    const page = await this.getPage();
    const projectId = this.projectIdFromUrl(page.url());
    let projects = await this.knownProjects();

    if (projectId) {
      const byId = this.findProjectById(projects, projectId);
      if (byId) return { read: "ok", project: byId };
      // The id proves membership, but a raw uuid is not a name: reporting it as
      // one made the verifier record `found it in "3f2a-…"` and downgrade a
      // correct placement. Re-list once in case the cached list was scraped
      // from a conversation page and only ever held one project.
      this.cachedProjects = undefined;
      projects = await this.knownProjects();
      const resolved = this.findProjectById(projects, projectId);
      if (resolved) return { read: "ok", project: resolved };
      if (expected && normalize(expected) === normalize(projectId)) {
        return { read: "ok", project: { id: projectId, name: expected } };
      }
      return { read: "unreadable", reason: `the conversation is in project ${projectId}, whose name could not be resolved` };
    }

    if (projects.length === 0) {
      return { read: "unreadable", reason: "the project list could not be read, so a project name cannot be recognised" };
    }

    // Claude occasionally shows a project breadcrumb in the app shell while
    // keeping /chat/<id> in the URL. Scoped to the header on purpose: a plain
    // `main a[href*="/project/"]` also matches a claude.ai/project/<id> link
    // pasted into the transcript, which would be read as this conversation's
    // own project.
    const mainProjectLinks = page.locator('main header a[href*="/project/"], main nav a[href*="/project/"]');
    const count = Math.min(await mainProjectLinks.count(), 5);
    for (let index = 0; index < count; index += 1) {
      const link = mainProjectLinks.nth(index);
      const project = this.projectFromLink(compact(await link.innerText().catch(() => "")), (await link.getAttribute("href")) ?? "");
      if (!project) continue;
      // The conversation header also carries controls whose labels mention
      // projects ("Add to project"). Only a project the sidebar actually lists
      // is evidence that this conversation lives in one.
      const known = projects.find(
        (candidate) => candidate.id === project.id || normalize(candidate.name) === normalize(project.name),
      );
      if (known) return { read: "ok", project: known };
    }
    return { read: "none" };
  }

  private findProjectById(projects: Project[], projectId: string): Project | undefined {
    return projects.find((project) => project.id === projectId || project.url?.includes(`/${projectId}`));
  }

  /**
   * Opens the menu of one specific conversation.
   *
   * Claude renders this control in the conversation list, not in the header, and
   * labels it "More options for <title>" — so a search for "menu"/"options"/"…"
   * inside `main` found nothing and every move failed at the first step. The
   * control is also inert until its row is hovered, which is why a plain click
   * timed out even with the button on screen.
   *
   * Every candidate is tied to this conversation's own title or id. A sweep over
   * all `aria-haspopup` buttons would find dozens of identical controls — one per
   * conversation — and each of them offers "Add to project", so a wrong hit would
   * silently move somebody else's conversation.
   */
  private async openConversationMenu(chat?: ChatSummary): Promise<void> {
    const page = await this.getPage();
    if (chat?.id) {
      await page
        .locator(`a[href*="/chat/${chat.id}"]`)
        .first()
        .hover({ timeout: 2_500 })
        .catch(() => undefined);
      await page.waitForTimeout(200);
    }

    const groups: Locator[] = [];
    if (chat?.title) {
      groups.push(page.getByRole("button", { name: `More options for ${chat.title}`, exact: true }));
    }
    if (chat?.id) {
      groups.push(page.locator(`li:has(a[href*="/chat/${chat.id}"]) button[aria-haspopup="menu"]`));
    }
    groups.push(page.locator("main").getByRole("button", { name: CLAUDE_SELECTORS.conversationMenuLabels }));

    for (const group of groups) {
      const count = Math.min(await group.count(), 4);
      for (let index = 0; index < count; index += 1) {
        const button = group.nth(index);
        if ((await button.count()) === 0) continue;
        const clicked = await button
          .click({ timeout: 4_000 })
          .then(() => true)
          .catch(async () =>
            button
              .evaluate((element) => {
                (element as HTMLElement).click();
                return true;
              })
              .catch(() => false),
          );
        if (!clicked) continue;
        await page.waitForTimeout(350);
        if (await this.overlayOffersProjectAction()) return;
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(150);
      }
    }
    throw new Error("Claude conversation menu button was not found");
  }

  /**
   * Stops the run when Cloudflare has replaced the app with its bot check.
   *
   * There is nothing to click through: the page holds no conversations, no
   * projects and no menus, so every later step fails for a reason that has
   * nothing to do with the step. Reported as a throttle because the remedy is
   * identical — stop, wait, resume — and because the organizer already knows to
   * leave the queue untouched when throttled.
   */
  private async assertNotBotChecked(): Promise<void> {
    const page = await this.getPage();
    const title = (await page.title().catch(() => "")) ?? "";
    const heading = await page
      .locator("body")
      .innerText()
      .then((text) => text.replace(/\s+/g, " ").slice(0, 400))
      .catch(() => "");
    if (!CLAUDE_SELECTORS.botCheckText.test(`${title} ${heading}`)) return;
    throw new RateLimitedError(
      "Claude is serving Cloudflare's bot check instead of the app, so nothing can be read or clicked. " +
        "It cannot be dismissed — wait before continuing; already organized conversations are saved.",
    );
  }

  /** True when this conversation's row is on screen, so its menu can be used. */
  private async conversationRowVisible(chat: ChatSummary): Promise<boolean> {
    if (!chat.id) return false;
    const page = await this.getPage();
    const row = page.locator(`a[href*="/chat/${chat.id}"]`).first();
    return this.visible(row);
  }

  /** True when a menu currently on screen contains the move-to-project action. */
  private async overlayOffersProjectAction(): Promise<boolean> {
    for (const overlay of await this.visibleOverlays()) {
      const action = overlay
        .getByRole("menuitem", { name: CLAUDE_SELECTORS.projectActionLabels })
        .or(overlay.getByRole("button", { name: CLAUDE_SELECTORS.projectActionLabels }));
      if ((await action.count()) > 0) return true;
    }
    return false;
  }

  /**
   * Activates the "Add/Move to project" entry of the open conversation menu.
   *
   * Every candidate is scoped to the open menu. Searching the whole page for the
   * text "Add to project" also matches the conversation body whenever the
   * conversation itself discusses moving chats into projects — the click then
   * lands on a code span in the transcript and no menu ever opens.
   */
  private async clickProjectAction(): Promise<void> {
    const page = await this.getPage();
    const overlays = await this.visibleOverlays();
    if (overlays.length === 0) throw new Error("Claude conversation menu did not open");

    let found = false;
    for (const overlay of [...overlays].reverse()) {
      const candidates = [
        // Claude's own hook for this item, stable across label wording.
        overlay.locator('[data-testid="move-to-project-trigger"]'),
        overlay.getByRole("menuitem", { name: CLAUDE_SELECTORS.projectActionLabels }),
        overlay.getByRole("button", { name: CLAUDE_SELECTORS.projectActionLabels }),
        overlay.getByText(CLAUDE_SELECTORS.projectActionLabels).first(),
      ];
      for (const candidate of candidates) {
        if (!(await this.visible(candidate))) continue;
        found = true;
        if (await this.revealProjectChooser(candidate.first(), overlays.length)) {
          await page.waitForTimeout(250);
          return;
        }
      }
    }
    throw new Error(
      found
        ? "Claude's Move/Add to project action did not open a project chooser"
        : "Claude Move/Add to project action was not found in the open conversation menu",
    );
  }

  /**
   * Radix opens a submenu on pointer entry, and once open the submenu overlaps
   * its own trigger — so a click afterwards is intercepted by the very panel it
   * was meant to reveal. Hover first, and only click when hovering alone did not
   * open anything (builds where the entry opens a modal dialog instead).
   */
  private async revealProjectChooser(action: Locator, overlaysBefore: number): Promise<boolean> {
    const page = await this.getPage();
    await action.hover({ timeout: 2_500 }).catch(() => undefined);
    if (await this.waitForAdditionalOverlay(overlaysBefore, 1_500)) return true;

    try {
      await action.click({ timeout: 2_500 });
    } catch {
      // A Radix item can be re-created under the pointer. Dispatching the click
      // on the element itself still reaches the application's own handler.
      await action.evaluate((element) => (element as HTMLElement).click()).catch(() => undefined);
    }
    await page.waitForTimeout(250);
    return this.waitForAdditionalOverlay(overlaysBefore, 2_500);
  }

  /**
   * The chooser is open once one more overlay is on screen than before. Counting
   * overlays avoids guessing at markup for a submenu this adapter has not seen.
   */
  private async waitForAdditionalOverlay(before: number, timeoutMs: number): Promise<boolean> {
    const page = await this.getPage();
    const deadline = Date.now() + timeoutMs;
    do {
      if ((await this.visibleOverlays()).length > before) return true;
      await page.waitForTimeout(200);
    } while (Date.now() < deadline);
    return false;
  }

  private async chooseProject(project: Project): Promise<void> {
    const page = await this.getPage();
    const namePattern = new RegExp(`^${escapeRegExp(project.name)}$`, "i");
    const overlays = page.locator(CLAUDE_SELECTORS.overlayContainers);

    // The chooser is a scrollable list. A project below the fold is not
    // clickable until it is scrolled into view, so each pass re-checks the
    // overlays and then advances the scroll position by one viewport.
    //
    // Candidates stay scoped to the open overlays: a page-wide match on the
    // project name would happily click the same words inside the transcript.
    for (let round = 0; round < 30; round += 1) {
      const overlayCount = Math.min(await overlays.count(), 10);
      for (let index = 0; index < overlayCount; index += 1) {
        const overlay = overlays.nth(index);
        const clicked = await this.clickFirst([
          overlay.getByRole("menuitem", { name: namePattern }).first(),
          overlay.getByRole("option", { name: namePattern }).first(),
          overlay.getByText(namePattern).first(),
        ]);
        if (clicked) {
          await page.waitForTimeout(250);
          return;
        }
      }
      if (!(await this.scrollOverlays(overlays))) break;
      await page.waitForTimeout(200);
    }

    throw new Error(`Claude project "${project.name}" was not found in the project chooser`);
  }

  /** Scrolls every open overlay down one viewport. False when none moved. */
  private async scrollOverlays(overlays: Locator): Promise<boolean> {
    const count = Math.min(await overlays.count(), 10);
    let moved = false;
    for (let index = 0; index < count; index += 1) {
      const advanced = await overlays
        .nth(index)
        .evaluate((element) => {
          const isScrollable = (node: Element): boolean => node.scrollHeight > node.clientHeight + 4;
          const scroller = (isScrollable(element)
            ? element
            : Array.from(element.querySelectorAll("*")).find(isScrollable)) as HTMLElement | undefined;
          if (!scroller) return false;
          const before = scroller.scrollTop;
          scroller.scrollTop = Math.min(
            before + Math.max(scroller.clientHeight * 0.8, 120),
            scroller.scrollHeight,
          );
          return scroller.scrollTop !== before;
        })
        .catch(() => false);
      moved = moved || advanced;
    }
    return moved;
  }

  async createProject(name: string): Promise<Project> {
    const page = await this.getPage();
    const normalizedName = compact(name);
    if (!normalizedName) throw new Error("Cannot create a Claude project with an empty name");

    const existing = (await this.knownProjects()).find((project) => normalize(project.name) === normalize(normalizedName) || project.aliases?.some((alias) => normalize(alias) === normalize(normalizedName)));
    if (existing) return existing;

    const create = page.getByRole("button", { name: CLAUDE_SELECTORS.createProjectLabels });
    const createLink = page.getByRole("link", { name: CLAUDE_SELECTORS.createProjectLabels });
    const projectsHeading = page.getByRole("heading", { name: /projects?/i });
    if (!(await this.clickFirst([create, createLink]))) {
      // A Projects heading may expose its action through an adjacent button.
      const parentButton = projectsHeading.locator("xpath=..//button");
      if (!(await this.clickFirst([parentButton]))) throw new Error("Claude create-project control was not found");
    }
    await page.waitForTimeout(250);

    const dialog = page.getByRole("dialog").last();
    const inputCandidates = [
      dialog.getByRole("textbox", { name: /project name|name/i }),
      dialog.locator('input[placeholder*="project" i], input[name*="project" i], input').first(),
      page.getByRole("textbox", { name: /project name|name/i }).last(),
    ];
    let input: Locator | undefined;
    for (const candidate of inputCandidates) {
      if (await this.visible(candidate)) {
        input = candidate;
        break;
      }
    }
    if (!input) throw new Error("Claude project dialog did not contain a name field");
    await input.fill(normalizedName);
    // Claude's dialog labels its submit "Create project", not "Create": an
    // exact-word regex found nothing and the whole creation path failed with
    // "submit button was not found" while the filled dialog sat on screen.
    const submitLabel = /^(?:create|save|continue|done|criar|salvar)(?:\s+(?:a\s+)?(?:project|projeto))?$/i;
    const submit = dialog.getByRole("button", { name: submitLabel });
    const pageSubmit = page.getByRole("button", { name: submitLabel }).last();
    if (!(await this.clickFirst([submit, pageSubmit]))) throw new Error("Claude project dialog submit button was not found");
    await page.waitForTimeout(500);

    // The sidebar changed, so the cached list is stale from here on.
    this.cachedProjects = undefined;
    const projects = await this.listProjects();
    const created = projects.find((project) => normalize(project.name) === normalize(normalizedName));
    if (created) return created;
    // If the UI navigated directly to the new project before the sidebar was
    // hydrated, retain the stable URL/id while returning the requested name.
    const createdId = this.projectIdFromUrl(page.url());
    if (createdId) return { id: createdId, name: normalizedName, url: new URL(page.url(), this.baseUrl).toString() };
    throw new Error(`Claude project "${normalizedName}" was not visible after creation`);
  }

  async addChatToProject(chat: ChatSummary, project: Project): Promise<MoveOutcome> {
    // Checked before any click: a throttling overlay intercepts every one of
    // them, and each blind attempt costs a conversation an error record.
    await this.assertNotThrottled();

    // Moving from the conversation list costs no navigation at all — the row's
    // own menu carries "Add to project". Opening the conversation instead means
    // one page load to move plus more to verify, per conversation, which is what
    // spent the rate-limit budget and drew the bot check.
    const fromList = await this.conversationRowVisible(chat);
    if (!fromList) {
      await this.ensureChatOpen(chat);
      const current = await this.getCurrentProject(chat, project.name);
      if (current.read === "ok" && normalize(current.project.name) === normalize(project.name)) {
        return { verified: true, observedProject: current.project.name };
      }
    }

    await this.openConversationMenu(chat);
    await this.clickProjectAction();
    await this.chooseProject(project);
    // A confirmation step is present in some Claude builds and absent in others,
    // so its absence is not an error — the outcome is decided by re-reading the
    // conversation, never by whether this click found a button.
    const confirm = (await this.visibleOverlays())
      .map((overlay) => overlay.getByRole("button", { name: /^(?:move|add|confirm)$/i }).first());
    if (confirm.length > 0) await this.clickFirst(confirm);
    if (!fromList) return this.confirmChatInProject(chat, project);
    // Nothing on the list — or on the conversation, which carries no project
    // reference at all in this build — proves membership, so this move is
    // reported as unconfirmed on purpose rather than assumed good. The project
    // pass is what settles it, at one page per project instead of per chat.
    return {
      verified: false,
      observedProject: project.name,
      detail: "moved from the conversation list; membership still has to be confirmed against the project page",
    };
  }

  /**
   * Claude's menu gives no feedback when an action is a no-op, so the move is
   * re-read from the conversation rather than assumed. Reporting an unverified
   * move as success would make the organizer skip the chat on every later run.
   */
  private async confirmChatInProject(chat: ChatSummary, project: Project): Promise<MoveOutcome> {
    const page = await this.getPage();
    let observed: Project | null = null;
    let unreadable: string | undefined;
    let reopened = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.waitForTimeout(600);
      // The page merely sitting on /project/<id> proves nothing: a chooser that
      // lists projects as anchors navigates there on click without adding the
      // conversation, and Claude's project URL carries no conversation identity.
      // Evidence has to come from re-reading the conversation itself.
      //
      // Re-navigating is a read step, so a failed navigation is retried rather
      // than fatal — but it must never be mistaken for a confirmed move, which
      // is why the loop continues instead of falling through to a stale page.
      //
      // A plain openChat is not enough here: the move does not change the
      // /chat/<id> URL, so its "already on this page" shortcut skipped the
      // navigation and this loop re-read the *pre-move* DOM three times in a
      // row. Force a real reload so there is something new to read.
      reopened = await this.reopenForVerification(chat);
      if (!reopened) continue;
      const reading = await this.getCurrentProject(chat, project.name);
      if (reading.read === "unreadable") {
        unreadable = reading.reason;
        continue;
      }
      if (reading.read === "none") continue;
      observed = reading.project;
      if (normalize(observed.name) === normalize(project.name)) {
        return { verified: true, observedProject: observed.name };
      }
      // A project-scoped URL yields an id but no readable name, so the id is
      // accepted as evidence in its own right.
      if (project.id && observed.id === project.id) {
        return { verified: true, observedProject: project.name };
      }
    }
    if (!reopened) {
      return { verified: false, detail: "the conversation could not be re-opened to verify the move" };
    }
    return {
      verified: false,
      observedProject: observed?.name,
      detail: observed
        ? `conversation still reads as project "${observed.name}"`
        : unreadable
          ? `the conversation could not be read after the move: ${unreadable}`
          : "no project could be read from the conversation after the move",
    };
  }

  /**
   * Re-opens a conversation with a genuine round-trip to the server, for the one
   * caller that has to see state the move just changed. Reports whether it
   * actually happened, so a failed reload is never read as a confirmed move.
   */
  private async reopenForVerification(chat: ChatSummary): Promise<boolean> {
    try {
      const page = await this.getPage();
      await this.openChat(chat);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
      return true;
    } catch {
      return false;
    }
  }

  async captureDiagnostics(action: string, error?: unknown): Promise<string> {
    const page = await this.getPage();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeAction = action.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "action";
    const directory = join(this.stateDir, "debug", `${stamp}-claude-${safeAction}`);
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, "screenshot.png"), fullPage: true }).catch(() => undefined);
    await writeFile(join(directory, "page.html"), await sanitizedPageHtml(page), "utf8");
    await writeFile(
      join(directory, "metadata.json"),
      JSON.stringify(
        {
          provider: this.provider,
          action,
          url: sanitizedUrl(page.url()),
          title: await page.title().catch(() => ""),
          capturedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : error ? String(error) : undefined,
        },
        null,
        2,
      ),
      "utf8",
    );
    return directory;
  }

  async inspect(): Promise<void> {
    const page = await this.getPage();
    console.log(`Claude URL: ${page.url()}`);
    console.log(`Claude title: ${await page.title().catch(() => "")}`);
    console.log(`Projects discovered: ${(await this.listProjects()).length}`);
    console.log(`Chats visible: ${await (await this.conversationLinks()).count()}`);
    console.log(`Authenticated: ${await this.isAuthenticated()}`);
    await this.captureDiagnostics("inspect");
  }

  async close(): Promise<void> {
    // The browser session owns the context. Closing it here would make the
    // organizer unable to persist/reuse the profile, so this is intentionally
    // a no-op for an injected Page/BrowserContext.
  }
}

export default ClaudeProvider;
