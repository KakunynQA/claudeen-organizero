import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildReport } from "../src/report.js";
import type { ProcessedChat } from "../src/types/index.js";

function chat(overrides: Partial<ProcessedChat> & { title: string }): ProcessedChat {
  return {
    key: overrides.title,
    provider: "chatgpt",
    processedAt: "2026-01-01T00:00:00.000Z",
    classificationConfidence: 0.9,
    status: "moved",
    ...overrides,
  };
}

/** The line of the table that renders a given conversation, for cell-level assertions. */
function rowFor(report: string, needle: string): string {
  const rows = report.split("\n").filter((line) => line.startsWith("| ") && line.includes(needle));
  assert.equal(rows.length, 1, `expected exactly one row containing ${JSON.stringify(needle)}`);
  return rows[0]!;
}

/** Cell separators only: an escaped `\|` is content, not a column break. */
function separatorCount(row: string): number {
  return (row.match(/(?<!\\)\|/g) ?? []).length;
}

function headingIndex(report: string, heading: string): number {
  const index = report.split("\n").indexOf(`## ${heading}`);
  assert.notEqual(index, -1, `missing heading: ${heading}`);
  return index;
}

describe("buildReport", () => {
  it("should title the report with the provider label", () => {
    assert.ok(buildReport([], "claude").startsWith("# Organization report — Claude"));
    assert.ok(buildReport([], "chatgpt").startsWith("# Organization report — ChatGPT"));
  });

  it("should group placed conversations under one heading per project", () => {
    const report = buildReport(
      [
        chat({ title: "Hilt setup", project: "android-app" }),
        chat({ title: "Hilt modules", project: "android-app" }),
        chat({ title: "Boss fights", project: "Elden Ring", status: "already-organized" }),
      ],
      "chatgpt",
    );
    assert.ok(report.includes("## android-app"));
    assert.ok(report.includes("## Elden Ring"));
    const heading = headingIndex(report, "android-app");
    const rowIndex = report.split("\n").indexOf(rowFor(report, "Hilt modules"));
    assert.ok(rowIndex > heading, "a project's rows must follow its own heading");
  });

  it("should order project headings alphabetically", () => {
    const report = buildReport(
      [
        chat({ title: "Z chat", project: "Zebra" }),
        chat({ title: "M chat", project: "Middle" }),
        chat({ title: "A chat", project: "Alpha" }),
      ],
      "chatgpt",
    );
    assert.ok(headingIndex(report, "Alpha") < headingIndex(report, "Middle"));
    assert.ok(headingIndex(report, "Middle") < headingIndex(report, "Zebra"));
  });

  it("should group placed conversations without a project name under a placeholder heading", () => {
    const report = buildReport([chat({ title: "Nameless", project: "   " })], "chatgpt");
    assert.ok(report.includes("## (no project recorded)"));
  });

  it("should say so when nothing has been placed yet", () => {
    const report = buildReport([chat({ title: "Ambiguous", status: "needs-review" })], "chatgpt");
    assert.ok(report.includes("No conversation has been placed in a project yet."));
  });

  it("should keep needs-review, unverified and error records out of the project sections", () => {
    const report = buildReport(
      [
        chat({ title: "Placed one", project: "Alpha" }),
        chat({ title: "Too ambiguous", status: "needs-review", project: "Alpha" }),
        chat({ title: "Move not confirmed", status: "unverified", project: "Alpha" }),
        chat({ title: "Blew up", status: "error", error: "timeout", project: "Alpha" }),
      ],
      "chatgpt",
    );
    const alpha = headingIndex(report, "Alpha");
    for (const [title, heading] of [
      ["Too ambiguous", "Needs review"],
      ["Move not confirmed", "Unverified"],
      ["Blew up", "Errors"],
    ] as const) {
      const section = headingIndex(report, heading);
      assert.ok(section > alpha, `${heading} must come after the project sections`);
      assert.ok(report.split("\n").indexOf(rowFor(report, title)) > section, `${title} belongs under ${heading}`);
    }
  });

  it("should omit sections that have no records", () => {
    const report = buildReport([chat({ title: "Placed one", project: "Alpha" })], "chatgpt");
    assert.ok(!report.includes("## Needs review"));
    assert.ok(!report.includes("## Unverified"));
    assert.ok(!report.includes("## Errors"));
  });

  it("should not let a pipe, a newline or a backtick break the table row", () => {
    const report = buildReport(
      [
        chat({
          title: "Release | v2\nsecond line with `code`",
          excerpt: "run `npm test`\nthen a | b | c",
          url: "https://chatgpt.com/c/a|b)c",
          project: "Alpha",
        }),
      ],
      "chatgpt",
    );
    const row = rowFor(report, "Release");
    // Number plus three columns, plus the leading and trailing edge: five breaks.
    assert.equal(separatorCount(row), 5);
    assert.ok(!row.includes("\n"));
    assert.ok(row.includes("Release \\| v2 second line with `code`"));
    assert.ok(row.includes("run `npm test` then a \\| b \\| c"));
    // A raw `|` or `)` in the URL would end the Markdown link early.
    assert.ok(row.includes("[open](https://chatgpt.com/c/a%7Cb%29c)"));
  });

  it("should render placeholders instead of undefined for a missing url and excerpt", () => {
    const report = buildReport([chat({ title: "Bare record", project: "Alpha" })], "chatgpt");
    const row = rowFor(report, "Bare record");
    assert.equal(row, "| 1 | Bare record | - | - |");
    assert.ok(!report.includes("undefined"));
  });

  it("should count every status in the summary line", () => {
    const report = buildReport(
      [
        chat({ title: "One", project: "Alpha" }),
        chat({ title: "Two", project: "Alpha" }),
        chat({ title: "Three", status: "already-organized", project: "Alpha" }),
        chat({ title: "Four", status: "needs-review" }),
        chat({ title: "Five", status: "error", error: "boom" }),
      ],
      "chatgpt",
    );
    const summary = report.split("\n")[2]!;
    assert.ok(summary.startsWith("5 conversation(s) recorded — "), summary);
    assert.ok(summary.includes("moved: 2"));
    assert.ok(summary.includes("already-organized: 1"));
    assert.ok(summary.includes("needs-review: 1"));
    assert.ok(summary.includes("error: 1"));
  });

  it("should report an empty state without inventing counts", () => {
    const report = buildReport([], "chatgpt");
    assert.ok(report.includes("0 conversation(s) recorded — none."));
  });

  it("should end with exactly one trailing newline", () => {
    const report = buildReport([chat({ title: "One", project: "Alpha" })], "chatgpt");
    assert.ok(report.endsWith("|\n"));
    assert.ok(!report.endsWith("\n\n"));
  });
});
