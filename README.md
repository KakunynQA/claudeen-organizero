# claudeen-organizero

[![CI](https://github.com/KakunynQA/claudeen-organizero/actions/workflows/ci.yml/badge.svg)](https://github.com/KakunynQA/claudeen-organizero/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Sorts your ChatGPT and Claude conversation history into Projects, automatically.

It drives a real browser through your own logged-in session, reads each recent
conversation, decides which Project it belongs to, and moves it there — then
**checks that the move actually happened** before recording it as done.

```
[03/20] android-app: dependency injection with Hilt
     → android-app
     confidence 0.94 · Project name or alias matched in the title: android-app.
     ✓ moved
```

- **Providers:** `chatgpt` (chatgpt.com) and `claude` (claude.ai)
- **Runs are incremental:** already-organized conversations are skipped on later runs
- **Nothing leaves your machine** except the classification prompt, and only if you enable an API key
- **License:** MIT

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [First login](#first-login)
- [Dry run](#dry-run)
- [Scan](#scan)
- [Organize](#organize)
- [Archiving what cannot be moved](#archiving-what-cannot-be-moved)
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

## Why this exists

I had hundreds of ChatGPT and Claude conversations and no way to find anything
in them. Every time I needed something I had written weeks earlier, I was
scrolling a sidebar and guessing at half-remembered titles.

Both sites have Projects, which solve this — but only if the conversations are
actually in them, and filing hundreds of old chats by hand is not something
anyone is going to sit down and do. So I wrote this to do the filing.

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
git clone https://github.com/KakunynQA/claudeen-organizero.git
cd claudeen-organizero
npm install
```

Every command below is run from the repository root: configuration and state are
resolved relative to the working directory.

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

## Scan

`scan` is the bulk-review path, and the one to reach for on a history that has
never been organized. It reads and classifies every conversation, writes each
decision to local state as a *proposal*, and touches nothing on the site.

```bash
npm run scan -- --provider chatgpt --titles-only
npm run report -- --provider chatgpt
```

The report then opens with a **Proposals from the last scan** block, one table
per proposed project, so a whole history can be judged in one sitting instead of
one conversation at a time.

This is not the same as `organize --dry-run`. A dry run prints its decisions and
writes nothing; a scan persists them, so the moves can be made later as a single
decided batch instead of re-reading everything. Pair it with `--titles-only` to
classify from the sidebar titles alone: one page load plus scrolling for the
entire history, rather than a navigation per conversation, which is what draws
rate limits and bot checks.

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
Unsupported (the site offers no way to move these): 0
Errors: 0
```

`Needs review` means the classifier was not confident enough — by design, not a
failure. `Unverified` means the move was attempted but could not be confirmed;
those conversations stay in the queue and are retried automatically.

`Unsupported` means the site itself offers no *Move to project* action for that
conversation — a custom-GPT chat, for example. That is a settled answer, not a
transient failure, so it is never retried; see
[Archiving what cannot be moved](#archiving-what-cannot-be-moved).

`needs-review` is deliberately *not* retried, so an ambiguous conversation does
not cost tokens on every run. After adding an API key or new rules, reconsider
them explicitly:

```bash
npm run organize -- --provider chatgpt --reprocess
```

## Archiving what cannot be moved

Some conversations have no *Move to project* action at all, and they accumulate
as `unsupported`. Archiving them clears the history without deleting anything.

```bash
npm run archive -- --provider chatgpt --dry-run
npm run archive -- --provider chatgpt --max-chats 10
```

This is deliberately narrow. It only ever touches conversations the local state
has *already recorded* as `unsupported`, so a mistyped command cannot archive a
conversation that merely failed once. It is currently implemented for `chatgpt`
only; `--provider claude` exits with an error.

It does change your account, so start with `--dry-run` and cap the first real
batch with `--max-chats`.

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

The report opens with a per-status count. If the last run was a
[scan](#scan), a **Proposals from the last scan** block comes next — one table
per proposed project, carrying extra `Proposed project` and `Confidence`
columns, and moving nothing. Then comes one section per project, in
alphabetical order, listing every conversation recorded as `moved` or
`already-organized`, followed by `Needs review`, `Unverified`, `Cannot be
moved`, `Archived`, and `Errors`. Empty sections are omitted, and row numbers
run continuously through the whole document so a row can be referred to by
number. Each row carries the conversation title, its opening message, and a
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
  "aliases": { "FromSoftware": "Elden Ring" },
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
| `scan` | Classify every conversation read-only; proposals show up in the next `report` |
| `organize` | Classify and move conversations |
| `archive` | Archive conversations already recorded as `unsupported` (ChatGPT only) |
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
| `--out <path>` | `report` only: where to write the Markdown (default `.state/report-<provider>.md`). `~` is expanded; relative paths resolve from the repository root |
| `--refresh-projects` | Re-read the project list instead of using the cache |
| `--reprocess` | Reconsider conversations already recorded |
| `--backfill` | Keep scanning past known conversations into older history |
| `--titles-only` | `organize`/`scan` only: classify from the sidebar title alone, never opening a conversation. Far faster and much less likely to trip a rate limit; the trade-off is that no excerpt is recorded |
| `--rebuild-profiles` | `verify` only: recompute keyword profiles from verified chats |
| `--headless` | Run without a visible window (headed is the default) |
| `--debug` | Print stack traces |

## Architecture

```
src/
  cli.ts                    argument parsing and command dispatch
  organizer.ts              the run loop: discover → classify → move → record
  verifier.ts               audits recorded state against the live site
  report.ts                 renders local state as Markdown (pure, no I/O)
  errors.ts                 the two errors that change control flow
  types/index.ts            the shared vocabulary
  config/config.ts          defaults, config.json, .env, project rules
  browser/                  persistent profile, launch, manual-login flow
  classifier/
    classifier.ts                 interfaces and the default thresholds
    deterministic-classifier.ts   rules and keyword profiles
    llm-classifiers.ts            OpenAI/Anthropic calls, and the layered
                                  classifier that chains them
  providers/
    provider.ts             the interface every site adapter implements
    chatgpt/                chatgpt.com adapter + its selectors
    claude/                 claude.ai adapter + its selectors
  state/state-store.ts      atomic JSON state and an append-only action log
  utils/diagnostics.ts      HTML and URL sanitizers for the debug captures
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

Five failure modes have accounted for every real breakage so far, and none of
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
  marked as failed. `--titles-only` is the documented way to avoid provoking
  this on a large history: it never opens a conversation, so the whole run costs
  one page load plus scrolling.

## Privacy

- `.state/` holds browser cookies, cached conversation metadata, and debug
  captures. It is gitignored. **Do not share it.**
- `config/config.json` and `config/project-rules.json` are gitignored, because
  rules often quote conversation titles. Only the `.example.json` files ship.
- Debug captures are sanitized before being written, but review them before
  attaching one to a bug report.
- Conversation text is sent to an LLM provider only when you configure an API
  key, and only for conversations the local layers could not decide.
- There is no telemetry and no analytics. See [SECURITY.md](SECURITY.md) for the
  full data-handling notes and the private disclosure path.

## Limitations and caveats

- Automating a web UI you do not own can conflict with its terms of service.
  You are responsible for how you use this on your own account.
- The tool moves conversations, and `archive` archives them. It never deletes
  anything, but both are yours to undo — start with `--dry-run` and a small
  `--max-chats`.
- `archive` is implemented for ChatGPT only.
- Selectors track two third-party UIs and will break when those UIs change.
- Only Chrome-family browsers are supported.
- Classification is a judgement call. `needs-review` is the honest answer for an
  ambiguous conversation, and it is meant to be common.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports about broken selectors are
especially welcome — include the sanitized capture from `.state/debug/` and the
site you were on, and read
[what never to attach](SECURITY.md#never-attach-these-to-a-report) first.

```bash
npm run typecheck   # src/ and test/
npm test
```

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md) — report vulnerabilities privately, not in an issue
- [License](LICENSE) — MIT
