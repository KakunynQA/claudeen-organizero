import type { ProcessedChat, ProviderName } from "./types/index.js";

const PROVIDER_LABELS: Record<ProviderName, string> = { chatgpt: "ChatGPT", claude: "Claude" };

/** Statuses that mean "this conversation sits in a project right now". */
const PLACED: ReadonlySet<ProcessedChat["status"]> = new Set(["moved", "already-organized"]);

const TABLE_HEADER = ["| # | Conversation | Opening message | Link |", "| --- | --- | --- | --- |"];

/**
 * Proposals carry two extra columns the audit does not need: where the
 * classifier wants to put the conversation, and how sure it is. Reviewing those
 * side by side is the whole point of a scan.
 */
const PROPOSAL_HEADER = [
  "| # | Conversation | Opening message | Proposed project | Confidence | Link |",
  "| --- | --- | --- | --- | --- | --- |",
];

/**
 * Makes arbitrary user text safe inside a Markdown table cell. Titles and
 * excerpts come from conversations in any language and may contain pipes or
 * newlines, either of which silently breaks the whole table.
 */
function cell(value: string | undefined): string {
  const flat = (value ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat || "-";
}

function linkCell(url: string | undefined): string {
  return url ? `[open](${url.replace(/\s+/g, "").replace(/\|/g, "%7C").replace(/[)]/g, "%29")})` : "-";
}

/**
 * Rows are numbered across the whole document so a reviewer can answer with
 * numbers ("12, 30 -> pessoal") instead of retyping titles.
 */
function row(chat: ProcessedChat, number: number): string {
  return `| ${number} | ${cell(chat.title)} | ${cell(chat.excerpt)} | ${linkCell(chat.url)} |`;
}

function proposalRow(chat: ProcessedChat, number: number): string {
  const confidence = chat.classificationConfidence ? chat.classificationConfidence.toFixed(2) : "-";
  return `| ${number} | ${cell(chat.title)} | ${cell(chat.excerpt)} | ${cell(chat.project) } | ${confidence} | ${linkCell(chat.url)} |`;
}

function summaryLine(chats: ProcessedChat[]): string {
  const counts = new Map<string, number>();
  for (const chat of chats) counts.set(chat.status, (counts.get(chat.status) ?? 0) + 1);
  const parts = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([status, count]) => `${status}: ${count}`);
  return `${chats.length} conversation(s) recorded — ${parts.length ? parts.join(" · ") : "none"}.`;
}

/** Groups placed conversations by project name, sorted alphabetically. */
function byProject(chats: ProcessedChat[]): Map<string, ProcessedChat[]> {
  const groups = new Map<string, ProcessedChat[]>();
  for (const chat of chats.filter((item) => PLACED.has(item.status))) {
    const name = chat.project?.trim() || "(no project recorded)";
    const group = groups.get(name) ?? [];
    group.push(chat);
    groups.set(name, group);
  }
  return new Map([...groups].sort(([left], [right]) => left.localeCompare(right)));
}

/** Shared row counter, so numbering is continuous across every section. */
interface Counter { value: number }

function section(title: string, chats: ProcessedChat[], counter: Counter, proposals = false): string[] {
  if (!chats.length) return [];
  const header = proposals ? PROPOSAL_HEADER : TABLE_HEADER;
  const render = proposals ? proposalRow : row;
  return [`## ${title}`, "", ...header, ...chats.map((chat) => render(chat, (counter.value += 1))), ""];
}

/** Groups scan proposals by the project the classifier suggested. */
function proposalsByProject(chats: ProcessedChat[]): Map<string, ProcessedChat[]> {
  const groups = new Map<string, ProcessedChat[]>();
  for (const chat of chats.filter((item) => item.status === "dry-run")) {
    const name = chat.project?.trim() || "(no proposal)";
    const group = groups.get(name) ?? [];
    group.push(chat);
    groups.set(name, group);
  }
  // The undecided group is the one that needs the reviewer, so it goes last
  // rather than wherever the alphabet puts a parenthesis.
  return new Map(
    [...groups].sort(([left], [right]) =>
      left === "(no proposal)" ? 1 : right === "(no proposal)" ? -1 : left.localeCompare(right),
    ),
  );
}

/**
 * Renders the local state as a Markdown audit the user can read top to bottom
 * to double-check placements. Pure: no filesystem, no console.
 */
export function buildReport(chats: ProcessedChat[], provider: ProviderName): string {
  const lines: string[] = [`# Organization report — ${PROVIDER_LABELS[provider]}`, "", summaryLine(chats), ""];

  const counter: Counter = { value: 0 };
  const proposals = proposalsByProject(chats);
  if (proposals.size > 0) {
    lines.push(
      "## Proposals from the last scan",
      "",
      "Nothing below has been moved: a scan only reads. Reply with the row numbers you want changed.",
      "",
    );
    for (const [project, group] of proposals) {
      lines.push(...section(`Proposed: ${project}`, group, counter, true));
    }
  }

  const groups = byProject(chats);
  if (groups.size === 0 && proposals.size === 0) lines.push("No conversation has been placed in a project yet.", "");
  else for (const [project, placed] of groups) lines.push(...section(project, placed, counter));

  lines.push(...section("Needs review", chats.filter((chat) => chat.status === "needs-review"), counter));
  lines.push(...section("Unverified", chats.filter((chat) => chat.status === "unverified"), counter));
  lines.push(
    ...section(
      "Cannot be moved (the site offers no action for these)",
      chats.filter((chat) => chat.status === "unsupported"),
      counter,
    ),
  );
  lines.push(...section("Archived", chats.filter((chat) => chat.status === "archived"), counter));
  lines.push(...section("Errors", chats.filter((chat) => chat.status === "error"), counter));

  return `${lines.join("\n").trimEnd()}\n`;
}
