import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";

import type { ConversationProvider } from "../provider.js";
import type {
  ArchiveOutcome,
  ChatContext,
  ChatSummary,
  ListChatsOptions,
  MessageExcerpt,
  MoveOutcome,
  Project,
} from "../../types/index.js";
import { chatGptSelectors, chatGptUrls, genericChatGptLabels } from "./selectors.js";
import { RateLimitedError, UnsupportedConversationError } from "../../errors.js";
import { sanitizedPageHtml, sanitizedUrl } from "../../utils/diagnostics.js";

export interface ChatGPTProviderOptions {
  /** URL is injectable to make local/staging UI reconnaissance easy. */
  baseUrl?: string;
  authenticationTimeoutMs?: number;
  diagnosticsDir?: string;
}

type ProjectCandidate = Project & { element?: Locator };

const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DIAGNOSTICS_DIR = path.join(".state", "debug");
const CONTEXT_CHAR_LIMIT = 12_000;

/** Browser adapter for chatgpt.com. All ChatGPT-specific UI knowledge lives here. */
export class ChatGPTProvider implements ConversationProvider {
  readonly provider = "chatgpt" as const;

  private readonly baseUrl: string;
  private readonly authenticationTimeoutMs: number;
  private readonly diagnosticsDir: string;
  private cachedProjects?: Project[];

  constructor(private readonly page: Page, options: ChatGPTProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? chatGptUrls.home;
    this.authenticationTimeoutMs = options.authenticationTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.diagnosticsDir = options.diagnosticsDir ?? DEFAULT_DIAGNOSTICS_DIR;
  }

  async open(): Promise<void> {
    if (!this.isChatGptUrl(this.page.url())) {
      await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
    }

    await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    // The shell is a SPA and can take a moment to render after navigation. A
    // short bounded wait is enough; all subsequent operations auto-wait.
    await this.page
      .locator("main, nav, [role='navigation'], [role='main']")
      .first()
      .waitFor({ state: "attached", timeout: 8_000 })
      .catch(() => undefined);
  }

  async isAuthenticated(): Promise<boolean> {
    const url = this.page.url();
    if (chatGptUrls.login.test(url)) return false;

    if (/just a moment/i.test(await this.page.title().catch(() => ""))) return false;

    const loginControls = this.page.getByRole("button", { name: genericChatGptLabels.login });
    const loginLinks = this.page.getByRole("link", { name: genericChatGptLabels.login });
    if ((await this.visibleCount(loginControls)) > 0 || (await this.visibleCount(loginLinks)) > 0) {
      return false;
    }

    const cookies = await this.page.context().cookies("https://chatgpt.com").catch(() => []);
    const sessionCookie = cookies.some((cookie) =>
      /(?:session[-_]?token|access[-_]?token|auth[-_]?session)/i.test(cookie.name),
    );
    if (sessionCookie) return true;

    const profileControl = this.page.locator([
      '[data-testid*="profile" i]',
      'button[aria-label*="profile" i]',
      'button[aria-label*="account" i]',
      'button[aria-label*="user menu" i]',
    ].join(","));
    if ((await this.visibleCount(profileControl)) > 0) return true;

    const privateNavigation = this.page.locator([
      'a[href*="/c/"]',
      'a[href*="/conversation/"]',
      'a[href*="/project"]',
      'a[href*="/g/g-p-"]',
    ].join(","));
    if ((await this.visibleCount(privateNavigation)) > 0) return true;

    return this.hasAuthenticatedSessionEndpoint();
  }

  async waitForAuthentication(): Promise<void> {
    if (await this.isAuthenticated()) return;

    const deadline = Date.now() + this.authenticationTimeoutMs;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(1_000);
      if (await this.isAuthenticated()) return;
    }

    throw new Error(
      `Timed out waiting for ChatGPT authentication after ${this.authenticationTimeoutMs}ms. ` +
        "Complete login manually in the headed browser and retry.",
    );
  }

  async listProjects(): Promise<Project[]> {
    await this.open();
    await this.ensureSidebarHydrated();
    await this.ensureProjectsSectionVisible();

    const showMore = this.page.getByRole("button", { name: /^show more$/i }).first();
    if ((await showMore.count()) > 0 && await showMore.isVisible().catch(() => false)) {
      await showMore.click().catch(() => undefined);
      await this.page.waitForTimeout(250);
    }

    const candidates: ProjectCandidate[] = [];
    for (const selector of chatGptSelectors.projectLinks) {
      const links = this.page.locator(selector);
      const count = await links.count();
      for (let index = 0; index < count; index += 1) {
        const element = links.nth(index);
        if (!(await element.isVisible().catch(() => false))) continue;
        const project = await this.readProjectElement(element);
        if (project) candidates.push({ ...project, element });
      }
    }

    const icons = this.page.locator(chatGptSelectors.projectItems);
    const iconCount = await icons.count();
    for (let index = 0; index < iconCount; index += 1) {
      const row = icons.nth(index).locator("xpath=ancestor::*[@role='button' and @data-sidebar-item='true'][1]");
      const name = normalizeName(await row.innerText().catch(() => ""));
      if (name) candidates.push({ name, element: row });
    }

    const optionButtons = this.page.locator(chatGptSelectors.projectOptionButtons);
    const optionCount = await optionButtons.count();
    for (let index = 0; index < optionCount; index += 1) {
      const element = optionButtons.nth(index);
      const label = await element.getAttribute("aria-label");
      const name = normalizeName(label?.replace(/^Open project options for\s+/i, "") ?? "");
      if (name) candidates.push({ name, element });
    }

    // Some ChatGPT versions render projects as buttons without an href. These
    // are deliberately constrained to the project section to avoid mistaking
    // arbitrary sidebar buttons for projects.
    const section = await this.findProjectsSection();
    if (section) {
      const buttons = section.getByRole("button");
      const count = await buttons.count();
      for (let index = 0; index < count; index += 1) {
        const element = buttons.nth(index);
        const label = await this.elementLabel(element);
        if (!label || genericChatGptLabels.createProject.test(label) || /^(?:collapse|expand|show|hide)\s+projects?$/i.test(label)) continue;
        candidates.push({ name: label, element });
      }
    }

    return this.dedupeProjects(candidates);
  }

  async listChats(options: ListChatsOptions = {}): Promise<ChatSummary[]> {
    await this.open();
    await this.ensureSidebarHydrated();
    const maxChats = options.maxChats ?? Number.POSITIVE_INFINITY;
    const knownKeys = options.knownKeys ?? new Set<string>();
    const stopCount = options.knownChatStopCount ?? 20;
    const chats: ChatSummary[] = [];
    const seen = new Set<string>();
    let consecutiveKnown = 0;
    let unchangedRounds = 0;

    for (let round = 0; round < 100 && chats.length < maxChats; round += 1) {
      const links = await this.readChatLinks();
      if (round === 0 && links.length === 0) {
        // Distinguish "nothing new to do" from "the sidebar never loaded".
        // Reporting an empty read as success is how a blocked run looks calm.
        await this.assertNotThrottled();
        throw new Error("ChatGPT's conversation sidebar contained no conversations — it did not load");
      }
      const seenBefore = seen.size;
      for (const chat of links) {
        const key = this.chatKey(chat);
        if (seen.has(key)) continue;
        seen.add(key);

        if (this.isKnownChat(chat, key, knownKeys)) {
          consecutiveKnown += 1;
          if (consecutiveKnown >= stopCount) break;
          continue;
        }
        consecutiveKnown = 0;
        chats.push(chat);
        if (chats.length >= maxChats) break;
      }

      if (chats.length >= maxChats || consecutiveKnown >= stopCount) break;
      // The sidebar is virtualized: it keeps roughly a screenful of links in
      // the DOM no matter how far you scroll, so the link *count* never grows.
      // Progress is measured by whether scrolling revealed conversations not
      // seen before — the only signal that survives virtualization.
      if (seen.size === seenBefore) unchangedRounds += 1;
      else unchangedRounds = 0;
      if (unchangedRounds >= 3) break;
      if (!(await this.scrollConversationList())) break;
    }

    return chats.slice(0, maxChats);
  }

  async openChat(chat: ChatSummary): Promise<void> {
    if (chat.url) {
      const absolute = new URL(chat.url, this.baseUrl).toString();
      if (this.page.url() !== absolute) {
        await this.page.goto(absolute, { waitUntil: "domcontentloaded" });
      }
    } else {
      const links = this.page.locator(chatGptSelectors.chatLinks.join(","));
      const candidate = links.filter({ hasText: chat.title }).first();
      if ((await candidate.count()) === 0) {
        throw new Error(`Could not find ChatGPT conversation without URL: ${chat.title}`);
      }
      await candidate.click();
    }
    await this.page
      .locator("main, [role='main']")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => undefined);
    await this.page.locator(chatGptSelectors.messageTurns.join(","))
      .first()
      .waitFor({ state: "attached", timeout: 20_000 });
    await this.assertOpenConversationIs(chat);
  }

  /**
   * Confirms the requested conversation is the one on screen.
   *
   * ChatGPT is a SPA: a navigation that times out or is swallowed leaves the
   * *previous* conversation rendered. Reading that as the requested one silently
   * classifies chat A using chat B's content — which produced a run where eight
   * unrelated conversations all "matched" the same game-development keywords.
   */
  private async assertOpenConversationIs(chat: ChatSummary): Promise<void> {
    const expected = chat.id ?? (chat.url ? this.idFromUrl(chat.url, chatGptUrls.chat) : undefined);
    if (!expected) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.idFromUrl(this.page.url(), chatGptUrls.chat) === expected) return;
      await this.page.waitForTimeout(500);
    }
    throw new Error(
      `ChatGPT is still showing a different conversation: expected ${expected}, page is at ${sanitizedUrl(this.page.url())}`,
    );
  }

  async readChatContext(chat: ChatSummary): Promise<ChatContext> {
    await this.openChat(chat);
    const excerpts = await this.readMessageExcerpts();
    const title = chat.title || (await this.readConversationTitle());
    return {
      id: chat.id ?? this.idFromUrl(this.page.url(), chatGptUrls.chat),
      title,
      url: this.page.url(),
      excerpts: this.trimExcerpts(excerpts),
    };
  }

  async getCurrentProject(chat: ChatSummary): Promise<Project | null> {
    await this.openChat(chat);
    return this.readProjectOfOpenConversation();
  }

  /** Reads the owning project of whatever conversation is currently open. */
  private async readProjectOfOpenConversation(): Promise<Project | null> {
    // Project-scoped chat URLs are the most reliable signal when available.
    // Read once up front: listProjects touches the sidebar and can navigate.
    const conversationUrl = this.page.url();
    const scopeId = this.idFromUrl(conversationUrl, chatGptUrls.projectScope);
    const projects = await this.knownProjects();
    if (scopeId) {
      const match = projects.find(
        (project) => project.id === scopeId || (project.name && slugOf(scopeId).endsWith(slugOf(project.name))),
      );
      if (match) return match;
    }

    // In other UI versions the breadcrumb is a project link. Restrict lookup
    // to links visible in the main/breadcrumb area, not the whole sidebar.
    const main = this.page.locator("main, [role='main']").first();
    const projectLinks = main.locator(chatGptSelectors.projectLinks.join(","));
    const count = await projectLinks.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = await this.readProjectElement(projectLinks.nth(index));
      // The conversation header also carries controls whose labels contain the
      // word "project" — "Add to project sources" is not a project name. Only a
      // label the sidebar actually lists as a project counts as evidence.
      if (!candidate || PROJECT_ACTION_LABEL.test(candidate.name)) continue;
      const known = projects.find((project) => sameName(project.name, candidate.name));
      if (known) return known;
    }
    return null;
  }

  /**
   * The sidebar project list is stable within a run and walking it is the
   * single most expensive read here, so it is fetched once and reused.
   */
  private async knownProjects(): Promise<Project[]> {
    if (!this.cachedProjects) this.cachedProjects = await this.listProjects();
    return this.cachedProjects;
  }

  /**
   * Fallback signal for projects the sidebar did not expose: ChatGPT embeds a
   * slug of the project name in the `g-p-<id>-<slug>` URL segment.
   */
  private urlBelongsToProject(url: string, projectName: string): boolean {
    const scopeId = this.idFromUrl(url, chatGptUrls.projectScope);
    const slug = slugOf(projectName);
    return Boolean(scopeId && slug && slugOf(scopeId).endsWith(`-${slug}`));
  }

  async createProject(name: string): Promise<Project> {
    const normalizedName = normalizeName(name);
    if (!normalizedName) throw new Error("Cannot create a ChatGPT project with an empty name");

    const existing = (await this.listProjects()).find((project) => sameName(project.name, normalizedName));
    if (existing) return existing;

    await this.ensureSidebarHydrated();
    await this.ensureProjectsSectionVisible();
    await this.openCreateProjectDialog();

    const input = this.page.locator('input[name="projectName"]').first();
    await input.fill(normalizedName);
    const create = this.page.getByRole("button", { name: /^create project$/i }).last();
    await create.click();
    await input.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    await this.page.waitForTimeout(500);
    this.cachedProjects = undefined;

    const projects = await this.listProjects();
    const created = projects.find((project) => sameName(project.name, normalizedName));
    if (created) return created;
    const id = this.idFromUrl(this.page.url(), chatGptUrls.project);
    if (id) return { id, name: normalizedName, url: this.page.url() };
    throw new Error(`ChatGPT project dialog closed but project was not discoverable: ${normalizedName}`);
  }

  async addChatToProject(chat: ChatSummary, project: Project): Promise<MoveOutcome> {
    await this.assertNotThrottled();
    // Conversations that live under a custom GPT (/g/g-<id>/c/<id>) have no
    // "Move to project" action anywhere in their menus. Recognising them by URL
    // costs nothing and saves a menu interaction plus an error record per run,
    // every run, for a conversation that can never be placed.
    if (chat.url && /\/g\/g-/.test(chat.url)) {
      throw new UnsupportedConversationError(
        "ChatGPT offers no Move to project action for conversations inside a custom GPT",
      );
    }
    // What ChatGPT throttles is conversation *history access* — opening chats.
    // The row's own menu carries "Move to project", so when the row is on screen
    // the whole move costs no navigation at all. Opening the conversation first,
    // then reloading it up to three times to verify, is what burned the budget
    // and ended runs after a couple of dozen conversations.
    const fromList = await this.conversationRowVisible(chat);
    if (!fromList) {
      await this.openChat(chat);
      const current = await this.readProjectOfOpenConversation();
      if (current && sameName(current.name, project.name)) {
        return { verified: true, observedProject: current.name };
      }
    }

    await this.openConversationMenu(chat);
    // Scoped to the open menu on purpose. Searching the whole page for the
    // text "Move to project" matches the conversation body itself whenever the
    // conversation happens to discuss moving chats into projects — the click
    // then lands on a code span and no menu ever opens.
    const menu = this.page.locator('[role="menu"]').last();
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    const moveAction = menu
      .getByRole("menuitem", { name: genericChatGptLabels.moveToProject })
      .or(menu.getByRole("menuitem", { name: /^(?:move|add)\b.*\bproject/i }))
      .first();
    if ((await moveAction.count()) === 0) {
      throw new Error("ChatGPT's Move to project action was not present in the conversation menu");
    }
    // Radix submenus open on pointer entry, and once open the submenu overlaps
    // its own trigger — so a click afterwards is blocked by the very panel it
    // was meant to reveal. Hover, and only click if hovering was not enough.
    await moveAction.hover().catch(() => undefined);
    if (!(await this.projectChooserVisible(2_000))) {
      await moveAction
        .click({ timeout: 5_000 })
        .catch(() => moveAction.evaluate((element) => (element as HTMLElement).click()));
    }
    await this.chooseProjectInOpenMenu(project);
    return fromList ? this.confirmFromList(chat, project) : this.confirmChatInProject(project);
  }

  /** True when this conversation's row is on screen, so its menu can be used. */
  private async conversationRowVisible(chat: ChatSummary): Promise<boolean> {
    if (!chat.id) return false;
    return this.page
      .locator(`a[href*="/c/${chat.id}"]`)
      .first()
      .isVisible()
      .catch(() => false);
  }

  /**
   * Confirms a move made from the history list, without opening the conversation.
   *
   * ChatGPT keeps a conversation in the history list after it joins a project
   * and annotates the row — the label reads like "<title>, chat in project
   * <name>", which is exactly how listChats picked up those titles. That
   * annotation is the evidence. If it does not appear, the move is reported as
   * unconfirmed rather than assumed good.
   */
  private async confirmFromList(chat: ChatSummary, project: Project): Promise<MoveOutcome> {
    if (!chat.id) return { verified: false, detail: "no conversation id to re-read the row with" };
    const row = this.page.locator(`a[href*="/c/${chat.id}"]`).first();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.page.waitForTimeout(700);
      const label = `${await row.getAttribute("aria-label").catch(() => "")} ${await row.innerText().catch(() => "")}`;
      const normalized = normalizeName(label);
      if (normalized.includes(normalizeName(project.name))) {
        return { verified: true, observedProject: project.name };
      }
      // A row that left the list entirely is also consistent with a move, but on
      // its own it is not evidence: virtualization removes rows too. It is only
      // reported, never treated as success.
      if ((await row.count()) === 0) {
        return {
          verified: false,
          observedProject: project.name,
          detail: "the row left the history list without showing a project label, so membership is unconfirmed",
        };
      }
    }
    return {
      verified: false,
      observedProject: project.name,
      detail: "the history row never showed the project label after the move",
    };
  }

  /**
   * Re-reads the conversation after a move instead of trusting that the click
   * worked. ChatGPT gives no feedback when a menu action is a no-op, so this is
   * the only thing standing between a failed move and a false `moved` record.
   */
  private async confirmChatInProject(project: Project): Promise<MoveOutcome> {
    let observed: Project | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.page.waitForTimeout(600);
      await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await this.page
        .locator(chatGptSelectors.messageTurns.join(","))
        .first()
        .waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => undefined);
      // The URL is checked first: it is free and, unlike reading the sidebar,
      // cannot itself navigate away from the conversation being verified.
      if (this.urlBelongsToProject(this.page.url(), project.name)) {
        return { verified: true, observedProject: project.name };
      }
      observed = await this.readProjectOfOpenConversation();
      if (observed && sameName(observed.name, project.name)) {
        return { verified: true, observedProject: observed.name };
      }
    }
    return {
      verified: false,
      observedProject: observed?.name,
      detail: observed
        ? `conversation still reads as project "${observed.name}"`
        : "no project could be read from the conversation after the move",
    };
  }

  /**
   * Archives a conversation from its row in the history list.
   *
   * Used for conversations no project can hold — a custom-GPT chat has no "Move
   * to project" action — so the only way to get them out of the way is to
   * archive them. Nothing is deleted: archived conversations stay reachable under
   * Settings > Archived chats, which is why this is safe to do in bulk.
   */
  async archiveChat(chat: ChatSummary): Promise<ArchiveOutcome> {
    await this.assertNotThrottled();
    if (!chat.id) return { archived: false, detail: "no conversation id to find the row with" };
    const row = this.page.locator(`a[href*="/c/${chat.id}"]`).first();
    if (!(await row.isVisible().catch(() => false))) {
      return { archived: false, detail: "the conversation row is not in the history list" };
    }

    await this.openConversationMenu(chat);
    const menu = this.page.locator('[role="menu"]').last();
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    const archive = menu.getByRole("menuitem", { name: /^archive$/i }).first();
    if ((await archive.count()) === 0) {
      await this.page.keyboard.press("Escape").catch(() => undefined);
      return { archived: false, detail: "no Archive action in the conversation menu" };
    }
    await archive.click({ timeout: 5_000 }).catch(() =>
      archive.evaluate((element) => (element as HTMLElement).click()),
    );

    // The row leaving the history list is exactly what archiving does, so here —
    // unlike a move — its disappearance is the evidence, not a guess.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.page.waitForTimeout(700);
      if ((await row.count()) === 0) return { archived: true };
    }
    return { archived: false, detail: "the conversation row stayed in the history list" };
  }

  async captureDiagnostics(action: string, error?: unknown): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const directory = path.resolve(this.diagnosticsDir, `${stamp}-chatgpt-${safeName(action)}`);
    await mkdir(directory, { recursive: true });
    const screenshotPath = path.join(directory, "screenshot.png");
    const htmlPath = path.join(directory, "page.html");
    const metadataPath = path.join(directory, "metadata.json");

    await this.page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
    await writeFile(htmlPath, await sanitizedPageHtml(this.page), "utf8");
    await writeFile(
      metadataPath,
      JSON.stringify(
        {
          provider: this.provider,
          action,
          capturedAt: new Date().toISOString(),
          url: sanitizedUrl(this.page.url()),
          title: await this.page.title().catch(() => ""),
          error: error instanceof Error ? error.stack ?? error.message : error ? String(error) : undefined,
        },
        null,
        2,
      ),
      "utf8",
    );
    return directory;
  }

  async inspect(): Promise<void> {
    const links = await this.page.locator("a").evaluateAll((elements) =>
      elements
        .slice(0, 200)
        .map((element) => ({
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
          href: (element as HTMLAnchorElement).href,
          aria: element.getAttribute("aria-label"),
        }))
        .filter((item) => item.text || item.aria),
    );
    console.log(JSON.stringify({ url: this.page.url(), links }, null, 2));
  }

  async close(): Promise<void> {
    // BrowserSession owns the persistent context. Closing this injected page
    // here would also make it impossible to reuse the authenticated session.
  }

  private async ensureProjectsSectionVisible(): Promise<void> {
    const section = await this.findProjectsSection();
    if (section) return;
    const projectsControl = this.page
      .getByRole("button", { name: genericChatGptLabels.projects })
      .or(this.page.getByRole("link", { name: genericChatGptLabels.projects }))
      .or(this.page.getByText(genericChatGptLabels.projects))
      .first();
    if ((await projectsControl.count()) > 0 && (await projectsControl.isVisible().catch(() => false))) {
      await projectsControl.click().catch(() => undefined);
    }
  }

  private async findProjectsSection(): Promise<Locator | null> {
    const headings = this.page.getByText(genericChatGptLabels.projects).first();
    if ((await headings.count()) === 0 || !(await headings.isVisible().catch(() => false))) return null;
    // Returning a parent locator lets listProjects handle versions where
    // project entries are buttons rather than anchors. The XPath is limited
    // to this one structural relationship; all UI matching remains semantic.
    return headings.locator("xpath=..");
  }

  private async openCreateProjectDialog(): Promise<void> {
    const control = this.page
      .getByRole("button", { name: genericChatGptLabels.createProject })
      .or(this.page.getByRole("link", { name: genericChatGptLabels.createProject }))
      .or(this.page.getByText(genericChatGptLabels.createProject))
      .first();
    if ((await control.count()) === 0) {
      throw new Error("Could not find ChatGPT's New project control");
    }
    await control.click();
    await this.page.locator(chatGptSelectors.projectDialog).first().waitFor({ state: "visible", timeout: 10_000 });
  }

  /**
   * Opens the menu of one specific conversation.
   *
   * `[data-testid="conversation-options-button"]` is NOT unique: every row in
   * the history list has one, and ChatGPT gives each an id of the form
   * `conversation-options-<chat id>`. Taking `.first()` therefore aimed at
   * whichever row the sidebar happened to render first — and since every row's
   * menu offers "Move to project", a wrong hit moves the wrong conversation.
   * The id is used when known, and the row that links to this conversation is
   * the only fallback.
   */
  private async openConversationMenu(chat?: ChatSummary): Promise<void> {
    if (chat?.id) {
      const row = this.page.locator(`a[href*="/c/${chat.id}"]`).first();
      await row.hover({ timeout: 2_500 }).catch(() => undefined);
      const byId = this.page.locator(`#conversation-options-${chat.id}`).first();
      const inRow = this.page
        .locator(`li:has(a[href*="/c/${chat.id}"]) [data-testid="conversation-options-button"]`)
        .first();
      for (const control of [byId, inRow]) {
        if ((await control.count()) === 0) continue;
        const clicked = await control
          .click({ timeout: 4_000 })
          .then(() => true)
          .catch(async () =>
            control.evaluate((element) => {
              (element as HTMLElement).click();
              return true;
            }).catch(() => false),
          );
        if (clicked) return;
      }
    }
    const headerControl = this.page.locator('[data-testid="conversation-options-button"]').first();
    if (!chat?.id && (await headerControl.count()) > 0 && await headerControl.isVisible().catch(() => false)) {
      await headerControl.click();
      return;
    }
    const main = this.page.locator("main, [role='main']").first();
    let control = main.locator(chatGptSelectors.conversationMenu.filter((selector) => !selector.includes("conversation-options-button")).join(",")).first();
    if ((await control.count()) === 0) control = this.page.locator(chatGptSelectors.conversationMenu.join(",")).first();
    if ((await control.count()) === 0) {
      control = this.page
        .getByRole("button", { name: /more|options|conversation menu/i })
        .first();
    }
    if ((await control.count()) === 0) throw new Error("Could not find ChatGPT conversation menu");
    await control.click();
  }

  private async chooseProjectInOpenMenu(project: Project): Promise<void> {
    const chooserReady = this.page.getByRole("menuitem", { name: /^new project$/i }).last();
    await chooserReady.waitFor({ state: "visible", timeout: 10_000 });

    const item = await this.findProjectMenuItem(project.name);
    if (!item) {
      throw new Error(
        `ChatGPT project "${project.name}" was not found in the project chooser after scrolling it to the end`,
      );
    }
    // Radix re-renders this submenu as the pointer moves. Dispatching the
    // semantic item's click directly avoids a stale inner text node while
    // still exercising the same application event handler.
    await item.evaluate((element) => (element as HTMLElement).click());
    await chooserReady.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    await this.page.waitForTimeout(400);
  }

  /**
   * The project chooser is a scrollable list: with more than a handful of
   * projects the target is simply not rendered until the list is scrolled. The
   * previous implementation only looked at the initial page of items, which is
   * why moves into projects further down the list silently did nothing.
   */
  private async findProjectMenuItem(projectName: string): Promise<Locator | null> {
    const chooser = this.projectChooser();
    const wanted = normalizeName(projectName).toLocaleLowerCase();
    let previousOffset = -1;

    for (let round = 0; round < 40; round += 1) {
      const items = chooser.getByRole("menuitem");
      const count = await items.count();
      for (let index = 0; index < count; index += 1) {
        const item = items.nth(index);
        const label = normalizeName(await this.elementLabel(item)).toLocaleLowerCase();
        if (label === wanted) return item;
      }

      const offset = await this.scrollChooser(chooser);
      if (offset === null || offset === previousOffset) return null;
      previousOffset = offset;
      await this.page.waitForTimeout(200);
    }
    return null;
  }

  /**
   * ChatGPT signals throttling with a full-screen modal that swallows every
   * click. Left undetected it turns into a run of identical "click timed out"
   * failures, one per conversation. A dismissible modal is dismissed; one that
   * survives means the account is genuinely rate limited and the run must stop.
   */
  private async assertNotThrottled(): Promise<void> {
    const modal = this.page
      .locator(chatGptSelectors.rateLimitModal)
      .or(this.page.locator('[role="dialog"]').filter({ hasText: chatGptSelectors.rateLimitText }));
    if (!(await modal.first().isVisible().catch(() => false))) return;

    await this.page.keyboard.press("Escape").catch(() => undefined);
    await this.page
      .getByRole("button", { name: /^(?:close|dismiss|got it|ok)$/i })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await this.page.waitForTimeout(750);
    if (!(await modal.first().isVisible().catch(() => false))) return;

    throw new RateLimitedError(
      "ChatGPT is rate limiting conversation history access and is blocking the UI with a modal. " +
        "Wait before continuing; already organized conversations are saved and the rest stay queued.",
    );
  }

  /** The project chooser is open once its "New project" entry is on screen. */
  private async projectChooserVisible(timeout: number): Promise<boolean> {
    return this.page
      .getByRole("menuitem", { name: /^new project$/i })
      .last()
      .waitFor({ state: "visible", timeout })
      .then(() => true)
      .catch(() => false);
  }

  /** The submenu popover that holds the project list, not the parent menu. */
  private projectChooser(): Locator {
    return this.page
      .locator('[role="menu"]')
      .filter({ has: this.page.getByRole("menuitem", { name: /^new project$/i }) })
      .last();
  }

  /** Scrolls the chooser down one viewport. Returns the new offset, or null. */
  private async scrollChooser(chooser: Locator): Promise<number | null> {
    return chooser
      .evaluate((element) => {
        const isScrollable = (node: Element): boolean => node.scrollHeight > node.clientHeight + 4;
        const scroller = (isScrollable(element)
          ? element
          : Array.from(element.querySelectorAll("*")).find(isScrollable)) as HTMLElement | undefined;
        if (!scroller) return null;
        scroller.scrollTop = Math.min(
          scroller.scrollTop + Math.max(scroller.clientHeight * 0.8, 120),
          scroller.scrollHeight,
        );
        return scroller.scrollTop;
      })
      .catch(() => null);
  }

  /**
   * Prefers the sidebar's own history list. Falling back to every `/c/` link on
   * the page also picks up conversations referenced inside the open chat, whose
   * labels are message text rather than titles.
   */
  private async conversationLinks(): Promise<Locator> {
    const sidebar = this.page.locator(chatGptSelectors.sidebarChatLinks.join(","));
    if ((await sidebar.count()) > 0) return sidebar;
    return this.page.locator(chatGptSelectors.chatLinks.join(","));
  }

  private async readChatLinks(): Promise<ChatSummary[]> {
    const links = await this.conversationLinks();
    const result: ChatSummary[] = [];
    const count = await links.count();
    for (let index = 0; index < count; index += 1) {
      const element = links.nth(index);
      if (!(await element.isVisible().catch(() => false))) continue;
      const href = await element.getAttribute("href");
      if (!href) continue;
      const accessible = await element.getAttribute("aria-label");
      if (accessible && /pinned conversation/i.test(accessible)) continue;
      const title = cleanChatTitle(accessible || (await this.elementLabel(element)) || "Untitled conversation");
      if (/^(?:new chat|home|search|projects?)$/i.test(title)) continue;
      result.push({ id: this.idFromUrl(href, chatGptUrls.chat), title, url: new URL(href, this.baseUrl).toString() });
    }
    return result;
  }

  /**
   * Scrolls the sidebar's own scroll container. Nudging the last link into view
   * is not enough once the list is virtualized: the last rendered link is
   * already on screen, so the nudge is a no-op and the walk stalls after a
   * screenful. Walking up to the real scrollable ancestor always advances.
   */
  private async scrollConversationList(): Promise<boolean> {
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

    if (!advanced) await last.scrollIntoViewIfNeeded().catch(() => undefined);
    // Virtualized rows need a moment to render after the scroll position moves.
    await this.page.waitForTimeout(450);
    return true;
  }

  private async readProjectElement(element: Locator): Promise<Project | null> {
    const name = normalizeName(await this.elementLabel(element));
    if (!name || genericChatGptLabels.projects.test(name) || genericChatGptLabels.createProject.test(name)) return null;
    const href = await element.getAttribute("href");
    const id = href ? this.idFromUrl(href, chatGptUrls.project) : undefined;
    return { id, name, url: href ? new URL(href, this.baseUrl).toString() : undefined };
  }

  private async readConversationTitle(): Promise<string> {
    const heading = this.page.getByRole("heading").first();
    const label = await this.elementLabel(heading);
    if (label && !/chatgpt|home|new chat/i.test(label)) return label;
    return (await this.page.title()).replace(/\s*[-|].*$/, "").trim();
  }

  private async readMessageExcerpts(): Promise<MessageExcerpt[]> {
    const turns = this.page.locator(chatGptSelectors.messageTurns.join(","));
    const count = await turns.count();
    const all: MessageExcerpt[] = [];
    for (let index = 0; index < count; index += 1) {
      const element = turns.nth(index);
      if (!(await element.isVisible().catch(() => false))) continue;
      const text = cleanText(await element.innerText().catch(() => ""));
      if (!text) continue;
      // A turn can be re-rendered mid-read; losing one excerpt is acceptable,
      // failing the whole conversation over it is not.
      const role = (await element
        .getAttribute("data-message-author-role", { timeout: 2_000 })
        .catch(() => null)) as MessageExcerpt["role"] | null;
      if (role === "user" || role === "assistant") all.push({ role, text });
    }
    return all;
  }

  private trimExcerpts(excerpts: MessageExcerpt[]): MessageExcerpt[] {
    const users = excerpts.filter((item) => item.role === "user");
    const assistants = excerpts.filter((item) => item.role === "assistant");
    const selected = [
      ...users.slice(0, 1),
      ...assistants.slice(0, 1),
      ...users.slice(-5),
      ...assistants.slice(-3),
    ];
    const deduped: MessageExcerpt[] = [];
    const seen = new Set<string>();
    let length = 0;
    for (const excerpt of selected) {
      const key = `${excerpt.role}:${excerpt.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const remaining = CONTEXT_CHAR_LIMIT - length;
      if (remaining <= 0) break;
      const text = excerpt.text.slice(0, remaining);
      deduped.push({ role: excerpt.role, text });
      length += text.length;
    }
    return deduped;
  }

  private async elementLabel(element: Locator): Promise<string> {
    const text = cleanText(await element.innerText().catch(() => ""));
    if (text) return text;
    return cleanText(
      (await element.getAttribute("aria-label")) ??
        (await element.getAttribute("title")) ??
        (await element.getAttribute("data-label")) ??
        "",
    );
  }

  private async visibleCount(locator: Locator): Promise<number> {
    const count = await locator.count();
    let visible = 0;
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
    }
    return visible;
  }

  private async ensureSidebarHydrated(): Promise<void> {
    const openSidebar = this.page.getByRole("button", { name: /open sidebar/i }).first();
    if ((await openSidebar.count()) > 0 && await openSidebar.isVisible().catch(() => false)) {
      await openSidebar.click().catch(() => undefined);
    }
    await this.page.locator('[data-testid="accounts-profile-button"]').last()
      .waitFor({ state: "visible", timeout: 12_000 });
    // One reload as a second chance. A single timed wait made a slow render
    // indistinguishable from an empty account, and the run then aborted with
    // "the sidebar contained no conversations" on a history full of them.
    const rows = this.page.locator(`${chatGptSelectors.chatLinks.join(",")}, ${chatGptSelectors.projectItems}`);
    for (const attempt of [0, 1]) {
      if (await rows.first().waitFor({ state: "attached", timeout: 8_000 }).then(() => true).catch(() => false)) break;
      if (attempt === 0) {
        await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await this.page.waitForTimeout(1_200);
      }
    }
    await this.page.waitForTimeout(250);
  }

  private async hasAuthenticatedSessionEndpoint(): Promise<boolean> {
    return this.page.evaluate(async () => {
      try {
        const response = await fetch("/api/auth/session", { credentials: "include" });
        if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return false;
        const value = await response.json() as { user?: unknown; expires?: unknown; accessToken?: unknown };
        return Boolean(value?.user || value?.accessToken || value?.expires);
      } catch {
        return false;
      }
    }).catch(() => false);
  }

  private dedupeProjects(projects: ProjectCandidate[]): Project[] {
    const result: Project[] = [];
    const seen = new Set<string>();
    for (const project of projects) {
      const key = project.id ? `id:${project.id}` : `name:${normalizeName(project.name).toLocaleLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ id: project.id, name: project.name, url: project.url });
    }
    return result;
  }

  private chatKey(chat: ChatSummary): string {
    return chat.id ? `id:${chat.id}` : `url:${chat.url ?? chat.title.toLocaleLowerCase()}`;
  }

  private isKnownChat(chat: ChatSummary, internalKey: string, knownKeys: Set<string>): boolean {
    if (knownKeys.has(internalKey)) return true;
    // StateStore uses `${provider}:${id|url|normalized title}`. Accepting
    // that public key here allows the adapter to stop scrolling promptly.
    const stable = chat.id || chat.url || chat.title.trim().toLocaleLowerCase();
    return knownKeys.has(`${this.provider}:${stable}`);
  }

  private idFromUrl(value: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(value);
    return match?.slice(1).find((value): value is string => Boolean(value));
  }

  private isChatGptUrl(value: string): boolean {
    try {
      return new URL(value).hostname.endsWith("chatgpt.com") || new URL(value).hostname.endsWith("openai.com");
    } catch {
      return false;
    }
  }
}

export default ChatGPTProvider;

function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanText(value: string): string {
  return normalizeName(value).replace(/^(?:copy|edit|delete|more options)\s*/i, "").trim();
}

function cleanChatTitle(value: string): string {
  return normalizeName(value)
    .replace(/,\s*(?:work|chat|pinned conversation)$/i, "")
    .trim()
    // Defence in depth: a real ChatGPT title is short. Anything longer has
    // picked up message text, which would then poison the learned profiles.
    .slice(0, 120)
    .trim();
}

/** Labels that mention a project but name an action or a panel, not a project. */
const PROJECT_ACTION_LABEL =
  /^(?:add|move|open|new|create|remove|manage)\b|project\s+(?:sources?|files?|settings|instructions|options)/i;

/** Accent-insensitive slug matching ChatGPT's own URL slugs. */
const COMBINING_MARKS = /[̀-ͯ]/g;

function slugOf(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sameName(left: string, right: string): boolean {
  return normalizeName(left).toLocaleLowerCase() === normalizeName(right).toLocaleLowerCase();
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "action";
}
