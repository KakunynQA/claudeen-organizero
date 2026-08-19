/**
 * Raised when the provider is throttling us rather than failing a specific
 * operation.
 *
 * This is not a per-conversation error: retrying the next conversation will hit
 * the same wall, and the sites signal it with a modal overlay that intercepts
 * every click, so each further attempt burns a conversation into an error
 * record for no reason. The organizer stops the run when it sees this.
 */
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

/**
 * The conversation cannot be placed in a project by any sequence of clicks — the
 * site does not offer the action for this kind of conversation. Distinct from a
 * failure, which is worth retrying.
 */
export class UnsupportedConversationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedConversationError";
  }
}
