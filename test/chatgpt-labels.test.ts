import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PROJECT_ACTION_LABEL, cleanText } from "../src/providers/chatgpt/chatgpt-provider.js";

/**
 * Both of these decide whether a label read off the page is treated as a
 * project name. Getting them wrong is silent: the project simply stops being
 * recognisable, and every conversation in it reads as being in no project.
 */
describe("cleanText", () => {
  it("strips a row-action prefix that is a separate word", () => {
    assert.equal(cleanText("Copy Prompts"), "Prompts");
    assert.equal(cleanText("Delete Old Notes"), "Old Notes");
    assert.equal(cleanText("More options Research"), "Research");
  });

  it("leaves a name that merely begins with one of those words", () => {
    // The bug this pins: an unanchored strip turned "Copywriting" into
    // "writing" and "Editorial" into "orial".
    assert.equal(cleanText("Copywriting"), "Copywriting");
    assert.equal(cleanText("Editorial"), "Editorial");
    assert.equal(cleanText("Deleted Scenes"), "Deleted Scenes");
    assert.equal(cleanText("Copycat"), "Copycat");
  });

  it("collapses whitespace", () => {
    assert.equal(cleanText("  Two   Words  "), "Two Words");
  });
});

describe("PROJECT_ACTION_LABEL", () => {
  it("rejects the controls that really are actions or panels", () => {
    for (const label of [
      "Add to project sources",
      "Move to project",
      "Remove from project",
      "New project",
      "Create project",
      "Manage project files",
      "Project settings",
      "Project instructions",
      "Project files",
    ]) {
      assert.ok(PROJECT_ACTION_LABEL.test(label), `${JSON.stringify(label)} should be rejected`);
    }
  });

  it("keeps project names that merely start with an action verb", () => {
    // Each of these was rejected by the old bare-leading-verb alternation, so
    // the breadcrumb could never confirm a conversation in one of them.
    for (const label of [
      "New Website",
      "Open Source",
      "Move to Berlin",
      "Manage Rentals",
      "Add Ons",
      "Create Studio",
      "Removals",
      "Project Files Archive",
      "Research",
    ]) {
      assert.ok(!PROJECT_ACTION_LABEL.test(label), `${JSON.stringify(label)} is a legitimate project name`);
    }
  });
});
