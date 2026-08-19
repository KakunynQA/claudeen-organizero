import type { ArchiveOutcome, ChatContext, ChatSummary, ListChatsOptions, MoveOutcome, Project, ProviderName } from "../types/index.js";

export interface ConversationProvider {
  readonly provider: ProviderName;
  open(): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  waitForAuthentication(): Promise<void>;
  listProjects(): Promise<Project[]>;
  listChats(options?: ListChatsOptions): Promise<ChatSummary[]>;
  openChat(chat: ChatSummary): Promise<void>;
  readChatContext(chat: ChatSummary): Promise<ChatContext>;
  /**
   * Reads the project owning `chat`. Implementations must navigate to the
   * conversation themselves: callers such as the verifier pass a conversation
   * without opening it, and answering from whatever page is loaded turns a whole
   * verification pass into one reading of the app home page.
   */
  getCurrentProject(chat: ChatSummary): Promise<Project | null>;
  createProject(name: string): Promise<Project>;
  /**
   * Moves a conversation into a project and reports whether the result was
   * actually observed afterwards. Implementations throw on an outright failure
   * and return `verified: false` only when the move could not be confirmed.
   */
  addChatToProject(chat: ChatSummary, project: Project): Promise<MoveOutcome>;
  /**
   * Archives a conversation, for the ones that cannot be placed in a project at
   * all. Optional: a provider that has no archive action simply omits it, and the
   * caller reports that rather than pretending the conversation was handled.
   */
  archiveChat?(chat: ChatSummary): Promise<ArchiveOutcome>;
  captureDiagnostics(action: string, error?: unknown): Promise<string>;
  inspect(): Promise<void>;
  close(): Promise<void>;
}
