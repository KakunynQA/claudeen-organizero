/**
 * Claude's DOM changes fairly often. Keep all low-level selector hints in one
 * place and let the provider's semantic methods try accessible locators first.
 */
export const CLAUDE_SELECTORS = {
  projectsHref: /\/projects?(?:\/|$)/i,
  chatHref: /\/chat\//i,
  loginPath: /\/(?:login|sign-in|auth)(?:\/|$)/i,
  projectNames: ["Projects", "Project"],
  createProjectLabels: /^(?:new|create|add)\s+project$/i,
  projectActionLabels: /(?:move|add)\s+(?:to\s+)?project/i,
  conversationMenuLabels: /(?:conversation|chat).*(?:menu|options)|(?:more|options)/i,
  messageTestId: /(?:message|conversation|turn)/i,
  userMessageTestId: /(?:user|human|prompt)/i,
  assistantMessageTestId: /(?:assistant|claude|response)/i,
  /**
   * Conversation links in the history sidebar, which is the real history list.
   * Preferred over the broad selector because the message body of an open
   * conversation can also contain `/chat/` links whose labels are prose.
   */
  sidebarChatLinks: [
    'nav a[href*="/chat/"]',
    '[role="navigation"] a[href*="/chat/"]',
    'aside a[href*="/chat/"]',
    '[data-testid*="sidebar" i] a[href*="/chat/"]',
  ],
  /** Every conversation link on the page. Fallback only: see sidebarChatLinks. */
  chatLinks: ['a[href*="/chat/"]'],
  /**
   * Containers Claude (Radix) uses for menus, submenus and modal dialogs. Any
   * search for a menu action must be scoped to one of these: matching the text
   * "Add to project" page-wide also hits the conversation body whenever the
   * conversation itself discusses moving chats between projects.
   */
  overlayContainers: '[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]',
  /**
   * Blocking overlay Claude puts up when it rate limits the account. Matching is
   * deliberately loose (test id / id / aria-modal wording) because the exact
   * markup differs per build; a false positive is harmless since the provider
   * tries to dismiss it once before concluding the account is throttled.
   */
  rateLimitOverlay:
    '[data-testid*="rate-limit" i], [data-testid*="usage-limit" i], [id*="rate-limit" i], [id*="usage-limit" i]',
  /** Text a throttling overlay shows, used to recognise a generic modal. */
  rateLimitText: /(?:rate\s*limit|usage\s*limit|message\s*limit|too\s*many\s*requests|limit\s*reached|try\s*again\s*later)/i,
  /**
   * Cloudflare's bot check, which Claude serves in place of the app after a burst
   * of automated navigation. It is not a rate limit and not an empty account, but
   * both of those are what the run used to report — so the real cause of a dead
   * run was invisible. It also cannot be dismissed: the only cure is waiting.
   */
  botCheckText: /performing security verification|verify you are human|checking your browser|just a moment|cf-browser-verification|enable javascript and cookies/i,
  /** Buttons that close an informational modal. */
  dismissLabels: /^(?:close|dismiss|got it|ok|okay|continue)$/i,
} as const;

export const CLAUDE_URLS = {
  home: "https://claude.ai/",
  newChat: "https://claude.ai/new",
  /**
   * Claude's own full-history and project pages.
   *
   * Landing on `/new` leaves the history sidebar collapsed and empty, so
   * scraping it there discovers nothing and looks indistinguishable from an
   * account with no conversations. These pages render the same data as first
   * class content, so discovery navigates to them instead of coaxing a sidebar.
   */
  recents: "https://claude.ai/recents",
  projects: "https://claude.ai/projects",
} as const;
