# claudeen-organizero

Sorts your ChatGPT and Claude conversation history into Projects, automatically.

It drives a real browser through your own logged-in session, reads each recent
conversation, decides which Project it belongs to, and moves it there — then
**checks that the move actually happened** before recording it as done.

```
[03/20] Injeção de Dependência Hilt
     → kakunyn-copilot
     confidence 0.84 · Distinctive project keywords matched: hilt, android.
     ✓ moved
```

- **Providers:** `chatgpt` (chatgpt.com) and `claude` (claude.ai)
- **Runs are incremental:** already-organized conversations are skipped on later runs
- **Nothing leaves your machine** except the classification prompt, and only if you enable an API key
- **License:** MIT

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [First login](#first-login)
- [Dry run](#dry-run)
- [Organize](#organize)
- [Verify](#verify)
- [Report](#report)
- [Classification](#classification)
- [Writing good rules](#writing-good-rules)
- [Commands and flags](#commands-and-flags)
- [Architecture](#architecture)
- [Troubleshooting UI changes](#troubleshooting-ui-changes)
- [Privacy](#privacy)
- [Limitations and caveats](#limitations-and-caveats)
- [Contributing](#contributing)

## How it works

```
  discover chats  ──▶  read context  ──▶  classify  ──▶  move  ──▶  verify
   (sidebar,            (title + a few     (rules →       (menu     (re-read the
    incremental)         messages)          keywords →     action)    conversation)
                                            LLM)
```

1. **Discover.** The sidebar is scrolled until enough unseen conversations are
   found, or until a run of already-known ones proves there is nothing new.
2. **Read.** The first and last few messages are extracted — enough to judge the
   topic, small enough to keep an LLM call cheap.
3. **Classify.** Three layers, cheapest first: your manual rules, then keyword
   matching against learned project profiles, then optionally an LLM.
4. **Move.** The provider performs the site's own "Move to project" action.
5. **Verify.** The conversation is re-read from the site. Only a move that can
   be observed is recorded as `moved`; anything else is recorded as
   `unverified` and retried on the next run.

Step 5 is the point of the tool. A browser UI fails silently: a menu item
scrolled out of view is simply never clicked, and nothing reports an error. An
unverified move written to state as `moved` is worse than a visible failure,
because the conversation is then skipped forever.

## Requirements

- Node.js 20 or newer
- Google Chrome, Brave, or Edge (Playwright's Chromium is used as a fallback)
- A ChatGPT or Claude account with Projects available
- Optional: an OpenAI or Anthropic API key, for conversations that rules and
  keywords cannot decide

## Install

```bash
npm install
```

If no Chrome-family browser is installed, add the fallback once:

```bash
npx playwright install chromium
```

Configuration is optional. Copy `config/config.example.json` to
`config/config.json` to change defaults, and
`config/project-rules.example.json` to `config/project-rules.json` to add
aliases and rules. Both real config files are gitignored, because they can
contain conversation titles.

## First login

```bash
npm run login -- --provider chatgpt
npm run login -- --provider claude
```

This opens a **normally installed** browser, not a Playwright-controlled OAuth
window — many identity providers refuse the latter. Log in manually, complete
any CAPTCHA or verification, wait for the app to load, then close that browser
window yourself. The command waits for you and saves a dedicated profile under
`.state/browser/<provider>/`.

The tool never asks for, stores, or automates your credentials. It only reuses
the session cookie you created by hand, and each provider gets its own profile,
separate from your everyday browser.

## Dry run

Always start here.

```bash
npm run organize -- --provider chatgpt --dry-run --max-chats 20
```

A dry run reads the site and prints the decision it *would* make for each
conversation. It creates nothing, moves nothing, and writes nothing to state.

## Organize

```bash
npm run organize -- --provider chatgpt
npm run organize -- --provider claude --max-chats 50
```

The run summary distinguishes outcomes that matter:

```
Processed: 20
Moved: 14
Unverified (will be retried): 1
Already organized: 3
Projects created: 0
Needs review: 2
Errors: 0
```

`Needs review` means the classifier was not confident enough — by design, not a
failure. `Unverified` means the move was attempted but could not be confirmed;
those conversations stay in the queue and are retried automatically.

`needs-review` is deliberately *not* retried, so an ambiguous conversation does
not cost tokens on every run. After adding an API key or new rules, reconsider
them explicitly:

```bash
npm run organize -- --provider chatgpt --reprocess
```

## Verify

Audits what the local state claims against what the sites actually show.

```bash
npm run verify -- --provider chatgpt --dry-run     # report only
npm run verify -- --provider chatgpt               # report and requeue
```

Every conversation recorded as `moved` or `already-organized` is reopened and
its real project is read back. Records that do not match are downgraded to
`unverified`, so the next `organize` run retries them.

Add `--rebuild-profiles` to additionally discard learned keyword profiles and
recompute them from verified conversations only. Use it after a bad run: a
project that absorbed conversations it should not have will also have absorbed
their vocabulary, and that vocabulary keeps attracting more of the same.

```bash
npm run verify -- --provider chatgpt --rebuild-profiles
```

## Report

Turns the local state into a Markdown file you can read top to bottom.

```bash
npm run report -- --provider chatgpt
npm run report -- --provider claude --out ~/claude-report.md
```

Without `--out` the file is written to `.state/report-<provider>.md`.

The report opens with a per-status count, then one section per project — in
alphabetical order — listing every conversation recorded as `moved` or
`already-organized`, followed by the `Needs review`, `Unverified`, and `Errors`
sections. Each row carries the conversation title, its opening message, and a
link back to it.

The **Opening message** column is the conversation's first user message,
captured verbatim and truncated. It is not an LLM-written summary, and nothing
in this command calls a classifier. It exists so a placement can be
double-checked from a title that is too vague to judge, without reopening the
conversation.

Like `status`, `report` reads state only and never opens a browser, so asking
for an audit cannot disturb a run in progress.

## Classification

Three layers run in order, and the first confident answer wins.

**1. Manual rules** — `config/project-rules.json`. A rule fires when any of its
terms appears in the conversation, and always wins with full confidence.

**2. Keyword profiles** — each project accumulates distinctive terms from the
titles of conversations verified to be in it. Matching is word-boundary based
(`casa` does not match `casaco`), terms claimed by more than one project are
ignored, and a single generic word buried in a long transcript is not treated as
evidence.

Learned keywords are capped by `keywordCeiling` (default `0.68`), which sits
*below* the existing-project threshold. They therefore inform the LLM and break
ties, but never move a conversation unaided. This is deliberate: profiles are
built from a handful of short titles, so their vocabulary drifts generic
quickly — and once a generic term is allowed to decide a move, that move teaches
the profile more generic terms, until one project absorbs everything. Raise the
ceiling above `existingProjectThreshold` if you want the unguarded behaviour.

A project name matching in the conversation **title** is strong evidence; the
same name appearing somewhere in the body is not, unless the name is
distinctive. A project called `Casa` will not claim every chat that happens to
mention a house.

**3. LLM** — only for what the first two layers left undecided, so the token
cost stays proportional to the genuinely ambiguous conversations. Defaults are
`gpt-4o-mini` and `claude-haiku-4-5`; override with `OPENAI_MODEL` /
`ANTHROPIC_MODEL` or in `config/config.json`.

Without an API key the first two layers still work; undecided conversations are
recorded as `needs-review` and left alone.

Two thresholds guard the result. Moving into an **existing** project needs
`existingProjectThreshold` (default `0.70`). **Creating** a project needs
`newProjectThreshold` (default `0.88`), because a spurious new project is much
harder to undo than a misplaced chat.

## Writing good rules

```json
{
  "aliases": { "Kakunyn Technology": "kakunyn" },
  "rules": [
    { "contains": ["elden ring", "godrick", "malenia"], "project": "Elden Ring" },
    { "contains": ["dkim", "dmarc"], "review": true }
  ]
}
```

Rules outrank every other signal, which makes a careless term expensive: a rule
containing `"melhor"` or `"process"` will file unrelated conversations with
confidence `1.0`, and no amount of semantic judgement downstream can override
it. Prefer proper nouns, product names, and jargon that appears nowhere else.

Set `"review": true` instead of a project when a term marks a topic you want to
sort by hand.

Do not generate rules from your existing chat titles. It looks like a shortcut
and it is really a snapshot of history that will not generalise to a single new
conversation.

## Commands and flags

| Command | Purpose |
| --- | --- |
| `login` | Open a real browser to authenticate once, per provider |
| `organize` | Classify and move conversations |
| `verify` | Re-check organized conversations against the live site |
| `projects` | List and cache the projects discovered in the sidebar |
| `status` | Print local counters without opening a browser |
| `report` | Write a Markdown audit of the local state, grouped by project |
| `inspect` | Print a sanitized UI inventory, for repairing selectors |

| Flag | Effect |
| --- | --- |
| `--provider <chatgpt\|claude>` | Required. Which site to drive |
| `--dry-run` | Read and decide, change nothing |
| `--max-chats <n>` | Cap how many conversations to handle |
| `--out <path>` | `report` only: where to write the Markdown (default `.state/report-<provider>.md`) |
| `--refresh-projects` | Re-read the project list instead of using the cache |
| `--reprocess` | Reconsider conversations already recorded |
| `--backfill` | Keep scanning past known conversations into older history |
| `--rebuild-profiles` | `verify` only: recompute keyword profiles from verified chats |
| `--headless` | Run without a visible window (headed is the default) |
| `--debug` | Print stack traces |

## Architecture

```
src/
  cli.ts                    argument parsing and command dispatch
  organizer.ts              the run loop: discover → classify → move → record
  verifier.ts               audits recorded state against the live site
  browser/                  persistent profile, launch, manual-login flow
  classifier/
    deterministic-classifier.ts   rules and keyword profiles
    llm-classifiers.ts            OpenAI and Anthropic fallbacks
    classifier.ts                 the layered classifier that chains them
  providers/
    provider.ts             the interface every site adapter implements
    chatgpt/                chatgpt.com adapter + its selectors
    claude/                 claude.ai adapter + its selectors
  state/state-store.ts      atomic JSON state and an append-only action log
```

`ConversationProvider` is the seam. The organizer only knows semantic
operations — list projects, open a chat, move it, read which project it is in —
so site-specific UI knowledge stays inside one adapter, and each adapter keeps
its selectors in a single `selectors.ts`.

Adding a provider means implementing that interface; nothing else changes.

## Troubleshooting UI changes

Both sites change their markup without notice. When something breaks:

```bash
npm run inspect -- --provider chatgpt --debug
```

Every failed operation also writes a screenshot, sanitized page HTML, and
metadata to `.state/debug/<timestamp>-<provider>-<action>/`. Start repairs in
the failing provider's `selectors.ts`.

Three failure modes have accounted for every real breakage so far, and none of
them is a missing selector:

- **Scrollable lists.** The project chooser only renders a first page of
  entries, so a project further down is invisible until the list is scrolled.
  Both adapters scroll their chooser to the end before concluding a project is
  absent.
- **Page-wide text matching.** A conversation that *discusses* moving chats into
  projects contains the literal string "Move to project", and an unscoped
  locator will happily click that code span instead of the menu item. Every menu
  lookup is scoped to the open `[role="menu"]`.
- **Submenus that cover their own trigger.** Radix opens a submenu on hover;
  once open it overlaps the trigger, so a click afterwards is blocked by the
  panel it was meant to reveal. Hover first, click only if hovering was not
  enough.
- **Virtualized sidebars.** The history list keeps roughly a screenful of links
  in the DOM however far you scroll, so the link *count* never grows. Loop
  termination is based on whether scrolling revealed conversations not seen
  before, never on counting rendered rows.
- **Rate-limit modals.** ChatGPT blocks the UI with a full-screen overlay when
  it throttles history access. Undetected, it becomes a run of identical click
  timeouts, one per conversation. The run stops instead, and nothing pending is
  marked as failed.

## Privacy

- `.state/` holds browser cookies, cached conversation metadata, and debug
  captures. It is gitignored. **Do not share it.**
- `config/config.json` and `config/project-rules.json` are gitignored, because
  rules often quote conversation titles. Only the `.example.json` files ship.
- Debug captures are sanitized before being written, but review them before
  attaching one to a bug report.
- Conversation text is sent to an LLM provider only when you configure an API
  key, and only for conversations the local layers could not decide.

## Limitations and caveats

- Automating a web UI you do not own can conflict with its terms of service.
  You are responsible for how you use this on your own account.
- The tool moves conversations. It never deletes them, but a move is yours to
  undo — start with `--dry-run` and a small `--max-chats`.
- Selectors track two third-party UIs and will break when those UIs change.
- Only Chrome-family browsers are supported.
- Classification is a judgement call. `needs-review` is the honest answer for an
  ambiguous conversation, and it is meant to be common.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports about broken selectors are
especially welcome — include the sanitized capture from `.state/debug/` and the
site you were on.

```bash
npm run typecheck
npm test
```
