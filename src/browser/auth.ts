import type { ConversationProvider } from "../providers/provider.js";

export async function ensureAuthenticated(provider: ConversationProvider): Promise<void> {
  if (await provider.isAuthenticated()) return;
  console.log("\nAuthentication is required.");
  console.log("Log in manually in the opened browser (Google OAuth is fine).");
  console.log("Complete any CAPTCHA or verification there; credentials are never requested by this tool.\n");
  await provider.waitForAuthentication();
  console.log("Authentication detected. The dedicated browser profile will be reused.\n");
}
