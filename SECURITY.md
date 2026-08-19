# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub Security Advisories:
[**Report a vulnerability**](https://github.com/KakunynQA/claudeen-organizero/security/advisories/new)
(the *Security* tab on this repository → *Report a vulnerability*).

Include what you did, what happened, and what you expected. You should get an
acknowledgement within a week. This is a small, unfunded project, so there is no
bug bounty — only credit in the advisory, if you want it.

## Never attach these to a report

The most likely way to leak your own account through this project is a helpful
bug report. Before attaching anything, check that it is not one of:

| Path | What it holds |
| --- | --- |
| `.state/browser/<provider>/` | A live browser profile: **authenticated ChatGPT/Claude session cookies.** Anyone with this directory is logged in as you. |
| `.env` | Your `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. |
| `config/config.json`, `config/project-rules.json` | Your rules, which usually quote real conversation titles. |
| `.state/data/<provider>/` | Cached conversation titles, excerpts, and links. |
| `.state/debug/*/screenshot.png` | **Not sanitized.** It is a picture of your screen, including the sidebar. |

All five are gitignored, and none of them should ever reach this repository.

The sanitized HTML in `.state/debug/` (see `src/utils/diagnostics.ts`) strips
scripts, input values, `contenteditable` text, and any attribute matching
`token|secret|authorization|cookie|credential` — but it still contains the page
structure around your conversations. Read it before you send it.

## What this tool does with your data

- **Credentials are never requested, stored, or automated.** You log in by hand
  in a real browser window; the tool reuses the session cookie you created, in a
  profile kept separate from your everyday browser.
- **Nothing is sent anywhere by default.** There is no telemetry, no analytics,
  and no network call other than to the site you are organizing.
- **Conversation text leaves your machine only if you set an API key**, and then
  only the trimmed excerpt of conversations the local layers could not classify,
  sent directly to OpenAI or Anthropic. Without a key, classification is fully
  local and undecided conversations are recorded as `needs-review`.
- **All state is local**, under `.state/`, written with mode `0600`.

## Supported versions

The `main` branch is the only supported version. There are no backports.
