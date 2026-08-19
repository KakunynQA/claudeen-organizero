/**
 * ChatGPT changes its class names frequently. Keep the selectors used by the
 * adapter in one place and prefer semantic selectors in the implementation.
 * Href fragments are currently more stable than generated class names.
 */
export const chatGptSelectors = {
  projectLinks: [
    'a[href*="/project"]',
    'a[href*="/project/"]',
    'a[href*="/projects/"]',
    '[data-testid*="project"]',
  ],
  projectItems: '[data-testid="project-folder-icon"]',
  projectOptionButtons: 'button[aria-label^="Open project options for "]',
  /**
   * Conversation links anywhere on the page. Kept only as a fallback: the page
   * body also contains `/c/` links (search results, referenced conversations),
   * and their labels carry message text rather than a clean title.
   */
  chatLinks: [
    'a[href*="/c/"]',
    'a[href*="/conversation/"]',
  ],
  /** Conversation links in the sidebar, which is the actual history list. */
  sidebarChatLinks: [
    'a[data-sidebar-item="true"][href*="/c/"]',
    'nav a[href*="/c/"]',
    '[role="navigation"] a[href*="/c/"]',
  ],
  messageTurns: [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
  ],
  projectDialog: 'input[name="projectName"]',
  /** Overlay ChatGPT shows when it throttles conversation history access. */
  rateLimitModal: '[data-testid*="rate-limit" i], [id*="rate-limit" i]',
  /**
   * The throttling dialog carries no test id — it is an ordinary dialog whose
   * text says "Too many requests / We've temporarily limited access to your
   * conversations". Matching the wording is the only reliable hook, and without
   * it a throttled run reported "the sidebar contained no conversations", which
   * reads as an empty account instead of a temporary block.
   */
  rateLimitText:
    /too many requests|temporarily limited access|making requests too quickly|rate limit|try again later/i,
  conversationMenu: [
    '[data-testid="conversation-options-button"]',
    'button[aria-label*="more" i]',
    'button[aria-label*="option" i]',
    'button[title*="more" i]',
    'button[title*="option" i]',
  ],
} as const;

export const chatGptUrls = {
  home: "https://chatgpt.com/",
  login: /(?:auth\/login|auth\/register|account\/login)/i,
  project: /(?:\/projects?\/([^/?#]+)|\/g\/(g-p-[^/?#]+)\/project)/i,
  /**
   * A conversation that lives inside a project keeps the project segment in its
   * own URL (`/g/g-p-<id>-<slug>/c/<chat-id>`), so this is the cheapest reliable
   * signal that a move actually landed.
   */
  projectScope: /\/g\/(g-p-[^/?#]+)/i,
  chat: /\/(?:c|conversation)\/([^/?#]+)/i,
} as const;

export const genericChatGptLabels = {
  projects: /^(?:projects?|project)$/i,
  createProject: /^(?:new|create)\s+project$/i,
  moveToProject: /^(?:move|add)(?:\s+conversation)?\s+to\s+project$/i,
  login: /^(?:log\s*in|sign\s*in|sign\s*up|create\s+account)$/i,
} as const;
