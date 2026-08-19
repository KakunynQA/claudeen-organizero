import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ProjectProfile } from "../src/types/index.js";
import {
  cleanProjectName,
  deduplicateProjects,
  rebuildProfileKeywords,
  type VerifiedChats,
} from "../src/organizer.js";
import type { ProjectIndexFile } from "../src/state/state-store.js";

describe("cleanProjectName", () => {
  it("should trim leading and trailing whitespace", () => {
    const result = cleanProjectName("  My Project  ");
    assert.equal(result, "My Project");
  });

  it("should collapse multiple spaces into single space", () => {
    const result = cleanProjectName("My   Project   Name");
    assert.equal(result, "My Project Name");
  });

  it("should cap length at 60 characters", () => {
    const longName = "This is a very long project name that exceeds sixty characters by quite a bit";
    const result = cleanProjectName(longName);
    assert.ok(result.length <= 60, `Length should be <= 60, got ${result.length}`);
    assert.ok(result.startsWith("This is a very long project"));
  });

  it("should handle empty string", () => {
    const result = cleanProjectName("");
    assert.equal(result, "");
  });

  it("should handle string with only spaces", () => {
    const result = cleanProjectName("   ");
    assert.equal(result, "");
  });

  it("should preserve Unicode characters", () => {
    const result = cleanProjectName("Café São Paulo");
    assert.equal(result, "Café São Paulo");
  });

  it("should trim and collapse in combination", () => {
    const result = cleanProjectName("  Project  With   Many    Spaces  ");
    assert.equal(result, "Project With Many Spaces");
  });
});

describe("deduplicateProjects", () => {
  it("should drop projects with empty names", () => {
    const projects = [
      { name: "Project A", aliases: [] },
      { name: "", aliases: [] },
      { name: "Project B", aliases: [] },
    ];
    const result = deduplicateProjects(projects);
    assert.equal(result.length, 2);
    assert.ok(result.some((p) => p.name === "Project A"));
    assert.ok(result.some((p) => p.name === "Project B"));
    assert.ok(!result.some((p) => p.name === ""));
  });

  it("should drop case-insensitive duplicates, keeping first", () => {
    const projects = [
      { name: "MyProject", aliases: [] },
      { name: "myproject", aliases: [] },
      { name: "MYPROJECT", aliases: [] },
    ];
    const result = deduplicateProjects(projects);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "MyProject");
  });

  it("should handle projects with spaces normalized", () => {
    const projects = [
      { name: "My Project", aliases: [] },
      { name: "My  Project", aliases: [] },
    ];
    const result = deduplicateProjects(projects);
    assert.equal(result.length, 1);
  });

  it("should drop projects with whitespace-only names", () => {
    const projects = [
      { name: "Valid Project", aliases: [] },
      { name: "   ", aliases: [] },
      { name: "Another", aliases: [] },
    ];
    const result = deduplicateProjects(projects);
    assert.equal(result.length, 2);
  });

  it("should clean project names using cleanProjectName", () => {
    const projects = [
      { name: "  Project   A  ", aliases: [] },
      { name: "Project B", aliases: [] },
    ];
    const result = deduplicateProjects(projects);
    assert.equal(result[0].name, "Project A");
  });

  it("should preserve aliases in non-duplicate projects", () => {
    const projects = [
      { name: "ProjectA", aliases: ["AliasA"] },
      { name: "ProjectB", aliases: ["AliasB1", "AliasB2"] },
    ];
    const result = deduplicateProjects(projects);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0].aliases, ["AliasA"]);
    assert.deepEqual(result[1].aliases, ["AliasB1", "AliasB2"]);
  });
});

describe("rebuildProfileKeywords", () => {
  it("should set project name as first keyword", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: ["old", "keywords"],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([["ProjectA", { titles: ["ProjectA setup"], chatIds: [] }]]);
    rebuildProfileKeywords(index, verifiedByProject);
    assert.equal(index.projects.ProjectA.keywords[0], "ProjectA");
  });

  it("should exclude generic title words", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([
      ["ProjectA", { titles: ["ProjectA help review problema processo"], chatIds: [] }],
    ]);
    rebuildProfileKeywords(index, verifiedByProject);
    const keywords = index.projects.ProjectA.keywords;
    assert.ok(!keywords.includes("help"));
    assert.ok(!keywords.includes("review"));
    assert.ok(!keywords.includes("problema"));
    assert.ok(!keywords.includes("processo"));
    assert.equal(keywords[0], "ProjectA");
  });

  it("should exclude generic Portuguese words", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([
      ["ProjectA", { titles: ["ProjectA ajuda análise problema processo"], chatIds: [] }],
    ]);
    rebuildProfileKeywords(index, verifiedByProject);
    const keywords = index.projects.ProjectA.keywords;
    assert.ok(!keywords.includes("ajuda"));
    assert.ok(!keywords.includes("análise"));
    assert.ok(!keywords.includes("problema"));
    assert.ok(!keywords.includes("processo"));
    assert.equal(keywords[0], "ProjectA");
  });

  it("should exclude terms appearing in both projects", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
        ProjectB: {
          name: "ProjectB",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([
      ["ProjectA", { titles: ["ProjectA database optimization"], chatIds: [] }],
      ["ProjectB", { titles: ["ProjectB database migration"], chatIds: [] }],
    ]);
    rebuildProfileKeywords(index, verifiedByProject);
    const keywordsA = index.projects.ProjectA.keywords;
    const keywordsB = index.projects.ProjectB.keywords;
    assert.ok(!keywordsA.includes("database"));
    assert.ok(!keywordsB.includes("database"));
    assert.ok(keywordsA.includes("optimization"));
    assert.ok(keywordsB.includes("migration"));
  });

  it("should keep unique terms for each project", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
        ProjectB: {
          name: "ProjectB",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([
      ["ProjectA", { titles: ["ProjectA frontend react typescript"], chatIds: [] }],
      ["ProjectB", { titles: ["ProjectB backend nodejs python"], chatIds: [] }],
    ]);
    rebuildProfileKeywords(index, verifiedByProject);
    const keywordsA = index.projects.ProjectA.keywords;
    const keywordsB = index.projects.ProjectB.keywords;
    assert.ok(keywordsA.includes("frontend"));
    assert.ok(keywordsA.includes("react"));
    assert.ok(keywordsA.includes("typescript"));
    assert.ok(keywordsB.includes("backend"));
    assert.ok(keywordsB.includes("nodejs"));
    assert.ok(keywordsB.includes("python"));
  });

  it("should limit keywords to at most 12 (11 distinctive + 1 project name)", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([
      [
        "ProjectA",
        { titles: ["ProjectA alpha beta gamma delta epsilon zeta theta iota kappa lambda mu nu xi"], chatIds: [] },
      ],
    ]);
    rebuildProfileKeywords(index, verifiedByProject);
    const keywords = index.projects.ProjectA.keywords;
    assert.ok(keywords.length <= 12);
    assert.equal(keywords[0], "ProjectA");
  });

  it("should handle empty titles for a project", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: ["old"],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([["ProjectA", { titles: [], chatIds: [] }]]);
    rebuildProfileKeywords(index, verifiedByProject);
    const keywords = index.projects.ProjectA.keywords;
    assert.equal(keywords[0], "ProjectA");
    assert.equal(keywords.length, 1);
  });

  it("should rank keywords by frequency (most common first)", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([
      [
        "ProjectA",
        { titles: ["ProjectA database", "ProjectA database", "ProjectA database", "ProjectA schema"], chatIds: [] },
      ],
    ]);
    rebuildProfileKeywords(index, verifiedByProject);
    const keywords = index.projects.ProjectA.keywords;
    assert.equal(keywords[0], "ProjectA");
    assert.equal(keywords[1], "database");
    assert.equal(keywords[2], "schema");
  });

  it("should exclude project name itself from distinctive keywords", () => {
    const index: ProjectIndexFile = {
      projects: {
        MySQLDatabase: {
          name: "MySQLDatabase",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: [],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([
      ["MySQLDatabase", { titles: ["MySQLDatabase setup and optimization"], chatIds: [] }],
    ]);
    rebuildProfileKeywords(index, verifiedByProject);
    const keywords = index.projects.MySQLDatabase.keywords;
    assert.equal(keywords[0], "MySQLDatabase");
    assert.ok(!keywords.slice(1).includes("MySQLDatabase"));
    assert.ok(!keywords.slice(1).includes("mysqldatabase"));
  });

  it("should replace exampleChatIds with verified chatIds", () => {
    const index: ProjectIndexFile = {
      projects: {
        ProjectA: {
          name: "ProjectA",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: ["stale-1", "stale-2"],
        },
        ProjectB: {
          name: "ProjectB",
          description: "",
          keywords: [],
          aliases: [],
          exampleChatIds: ["old-id"],
        },
      },
    };
    const verifiedByProject = new Map<string, VerifiedChats>([
      ["ProjectA", { titles: ["ProjectA setup"], chatIds: ["ok-1"] }],
    ]);
    rebuildProfileKeywords(index, verifiedByProject);
    assert.deepEqual(index.projects.ProjectA.exampleChatIds, ["ok-1"]);
    assert.deepEqual(index.projects.ProjectB.exampleChatIds, []);
  });
});

describe("deduplicateProjects preserves observed names", () => {
  /**
   * Names read from the site are identities, not free text. Truncating them to
   * 60 characters cached a project under a name the chooser never renders, and
   * the exact-label lookup then failed with "project ... was not found in the
   * project chooser after scrolling it to the end".
   */
  it("does not truncate a long project name", () => {
    const long = "A project whose name is considerably longer than sixty characters in total";
    assert.ok(long.length > 60, "fixture must exceed the old truncation limit");
    const [only] = deduplicateProjects([{ name: long }]);
    assert.equal(only?.name, long);
  });

  it("recognises a long project as already present instead of appending a copy", () => {
    const long = "A project whose name is considerably longer than sixty characters in total";
    // The sidebar scan yields the same project through several selectors, so
    // one call routinely sees the raw name more than once. While the first copy
    // was stored truncated, findProject compared the next raw name against that
    // shortened entry, missed, and appended a duplicate — every single refresh.
    const projects = deduplicateProjects([{ name: long }, { name: long }, { name: `${long} ` }]);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.name, long);
  });

  it("still collapses whitespace in an observed name", () => {
    const [only] = deduplicateProjects([{ name: "  Spaced   Out  " }]);
    assert.equal(only?.name, "Spaced Out");
  });

  it("keeps bounding a name this tool is about to create", () => {
    // cleanProjectName remains the authoring path's guard; only the observing
    // path stopped using it.
    assert.equal(cleanProjectName("x".repeat(80)).length, 60);
  });
});
