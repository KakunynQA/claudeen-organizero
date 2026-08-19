# Contributing

Thanks for taking the time. This project drives two third-party UIs that change
without warning, so most useful contributions are small and specific.

## Getting set up

```bash
npm install
npm run typecheck
npm test
```

Everything is TypeScript with native ESM. Imports use explicit `.js` extensions,
including in tests.

## Reporting a broken selector

This is the most valuable kind of report.

1. Reproduce with `npm run organize -- --provider <provider> --dry-run --max-chats 3 --debug`.
2. Find the newest directory under `.state/debug/`.
3. **Review it before attaching it.** The HTML is sanitized, but the screenshot
   is not — it may show your conversation titles.
4. Open an issue with the provider, the operation that failed, the error
   message, and what the UI looked like at that moment.

## Making a change

- **Provider changes belong in one adapter.** `src/providers/<provider>/`. The
  organizer must not learn anything site-specific; if it needs to, the
  `ConversationProvider` interface is what should grow.
- **Selectors go in `selectors.ts`.** Prefer accessible roles and names over
  class names, which both sites regenerate on every deploy.
- **Never report an unobserved success.** A mutating operation either verifies
  its own effect or reports `verified: false`. Silently returning from a menu
  action that did nothing is the bug this project exists to avoid.
- **Add a test for anything that can be tested without a browser.** The
  classifier, the state store, and the profile logic are all pure.
- **English only** in code, comments, commit messages, and docs. Conversation
  data in local config files can be in any language.

## Pull requests

Keep them focused, explain what UI change motivated the fix, and make sure
`npm run typecheck` and `npm test` pass. If your change alters what gets moved,
say how you verified it — ideally with a `--dry-run` transcript.

## Code of conduct

Be decent. Assume good faith. Disagreements about approach get resolved by
looking at the failing case together.
