import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ChatContext, ProjectProfile } from "../src/types/index.js";
import { DeterministicClassifier, ambiguousKeywords } from "../src/classifier/deterministic-classifier.js";
import type { ProjectRules } from "../src/classifier/classifier.js";

describe("DeterministicClassifier", () => {
  describe("manual rules win with confidence 1", () => {
    it("should return confidence 1 when a manual rule matches", async () => {
      const rules: ProjectRules = {
        rules: [
          {
            contains: ["Godrick"],
            project: "TestProject",
          },
        ],
      };
      const classifier = new DeterministicClassifier(rules);
      const chat: ChatContext = {
        id: "chat1",
        title: "Conversation about Godrick the Grafted",
        excerpts: [{ role: "user", text: "Tell me about Godrick" }],
      };
      const projects: ProjectProfile[] = [
        {
          name: "TestProject",
          description: "",
          keywords: ["test"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.ok(result);
      assert.equal(result.confidence, 1);
      assert.equal(result.projectName, "TestProject");
      assert.equal(result.existingProject, true);
    });
  });

  describe("word-boundary matching for Portuguese words", () => {
    it("should NOT match 'casa' in 'por acaso'", async () => {
      const classifier = new DeterministicClassifier();
      const chat: ChatContext = {
        id: "chat1",
        title: "Discussion about an accidental thing",
        excerpts: [
          { role: "user", text: "Por acaso, eu descobri isso" },
          { role: "assistant", text: "Que achado interessante" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "CasaProject",
          description: "",
          keywords: ["casa"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.equal(result, null, "should not match 'casa' in 'por acaso'");
    });

    it("should NOT match 'casa' in 'casaco'", async () => {
      const classifier = new DeterministicClassifier();
      const chat: ChatContext = {
        id: "chat1",
        title: "About clothing",
        excerpts: [{ role: "user", text: "Preciso de um casaco quente" }],
      };
      const projects: ProjectProfile[] = [
        {
          name: "CasaProject",
          description: "",
          keywords: ["casa"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.equal(result, null, "should not match 'casa' in 'casaco'");
    });

    it("should match word boundary correctly with Portuguese text", async () => {
      const classifier = new DeterministicClassifier({}, { keywordCeiling: 0.95 });
      const chat: ChatContext = {
        id: "chat1",
        title: "General discussion",
        excerpts: [
          { role: "user", text: "Preciso de python javascript typescript para meu projeto" },
          { role: "assistant", text: "Python e javascript são ótimas escolhas para desenvolvimento" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "ProgrammingProject",
          description: "",
          keywords: ["python", "javascript", "typescript", "desenvolvimento"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.ok(result, "should match when multiple keywords appear in body");
      assert.equal(result.projectName, "ProgrammingProject");
    });
  });

  describe("keyword evidence in title vs body", () => {
    it("should return null when a single keyword appears only in body of long text", async () => {
      const classifier = new DeterministicClassifier();
      const longBody = Array(100)
        .fill("Some generic discussion about various things. ")
        .join("");
      const chat: ChatContext = {
        id: "chat1",
        title: "General discussion",
        excerpts: [{ role: "user", text: longBody + "Also mentioned: algorithm" }],
      };
      const projects: ProjectProfile[] = [
        {
          name: "AlgoProject",
          description: "",
          keywords: ["algorithm"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.equal(result, null, "single body keyword in long text is not evidence");
    });

    it("should return a candidate with 4+ keywords in body (meets confidence threshold)", async () => {
      const classifier = new DeterministicClassifier({}, { keywordCeiling: 0.95 });
      const chat: ChatContext = {
        id: "chat1",
        title: "General discussion",
        excerpts: [
          { role: "user", text: "I am using database framework testing and optimization" },
          { role: "assistant", text: "Your database approach with framework optimization is solid" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "AlgoProject",
          description: "",
          keywords: ["database", "framework", "testing", "optimization"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.ok(result, "4+ body keywords should meet confidence threshold");
      assert.equal(result.projectName, "AlgoProject");
    });

    it("should return a candidate with 2+ body keywords and 1+ title keyword", async () => {
      const classifier = new DeterministicClassifier({}, { keywordCeiling: 0.95 });
      const chat: ChatContext = {
        id: "chat1",
        title: "Framework and optimization discussion",
        excerpts: [
          { role: "user", text: "I need database optimization strategies" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "AlgoProject",
          description: "",
          keywords: ["framework", "database", "optimization"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.ok(result, "2+ body keywords + 1+ title keyword should produce a candidate");
      assert.equal(result.projectName, "AlgoProject");
    });
  });

  describe("ambiguous keywords shared by multiple projects", () => {
    it("should ignore a keyword claimed by two projects", async () => {
      const classifier = new DeterministicClassifier();
      const chat: ChatContext = {
        id: "chat1",
        title: "Technical discussion",
        excerpts: [
          { role: "user", text: "I need to create a model for this dataset" },
          { role: "assistant", text: "The model design is important" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "ProjectA",
          description: "",
          keywords: ["model", "framework"],
          aliases: [],
          exampleChatIds: [],
        },
        {
          name: "ProjectB",
          description: "",
          keywords: ["model", "algorithm"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.equal(result, null, "shared keyword 'model' should be ignored by ambiguousKeywords");
    });

    it("should use ambiguousKeywords to filter shared terms", () => {
      const projects: ProjectProfile[] = [
        {
          name: "ProjectA",
          description: "",
          keywords: ["casa", "model", "processo"],
          aliases: [],
          exampleChatIds: [],
        },
        {
          name: "ProjectB",
          description: "",
          keywords: ["model", "algoritmo"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const ambiguous = ambiguousKeywords(projects);
      assert.ok(ambiguous.has("model"), "'model' should be ambiguous");
      assert.ok(!ambiguous.has("casa"), "'casa' should not be ambiguous");
      assert.ok(!ambiguous.has("algoritmo"), "'algoritmo' should not be ambiguous");
    });
  });

  describe("ambiguity margin: near-identical evidence returns null", () => {
    it("should return null when confidence difference is below threshold", async () => {
      const classifier = new DeterministicClassifier();
      const chat: ChatContext = {
        id: "chat1",
        title: "Framework and design patterns",
        excerpts: [
          { role: "user", text: "I'm working on a framework implementation" },
          { role: "assistant", text: "Framework design is crucial" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "ProjectA",
          description: "",
          keywords: ["framework", "interface"],
          aliases: [],
          exampleChatIds: [],
        },
        {
          name: "ProjectB",
          description: "",
          keywords: ["framework", "design"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.equal(
        result,
        null,
        "two projects with very similar confidence should return null due to ambiguity"
      );
    });

    it("should return a result when confidence difference exceeds threshold", async () => {
      const classifier = new DeterministicClassifier({}, { keywordCeiling: 0.95 });
      const chat: ChatContext = {
        id: "chat1",
        title: "Database optimization",
        excerpts: [
          { role: "user", text: "I need to optimize my database queries" },
          { role: "assistant", text: "Database indexing helps significantly" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "ProjectA",
          description: "",
          keywords: ["database", "queries", "indexing", "performance"],
          aliases: [],
          exampleChatIds: [],
        },
        {
          name: "ProjectB",
          description: "",
          keywords: ["system"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.ok(result, "significant confidence difference should produce a result");
      assert.equal(result.projectName, "ProjectA");
    });
  });

  describe("generic terms are excluded", () => {
    it("should not match on generic Portuguese terms", async () => {
      const classifier = new DeterministicClassifier();
      const chat: ChatContext = {
        id: "chat1",
        title: "Help with a problem",
        excerpts: [
          { role: "user", text: "I have a problem and need help" },
          { role: "assistant", text: "This is a common problem" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "ProjectA",
          description: "",
          keywords: ["problema"],
          aliases: [],
          exampleChatIds: [],
        },
        {
          name: "ProjectB",
          description: "",
          keywords: ["ajuda"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.equal(result, null, "generic terms should be excluded");
    });

    it("should not match on generic English terms", async () => {
      const classifier = new DeterministicClassifier();
      const chat: ChatContext = {
        id: "chat1",
        title: "Code help and review",
        excerpts: [
          { role: "user", text: "Can you help me with this code and review it?" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "ProjectA",
          description: "",
          keywords: ["code", "help", "review"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.equal(result, null, "generic English terms should be excluded");
    });
  });

  describe("default threshold behavior: keyword ceiling", () => {
    it("learned keywords alone do not move a conversation under default thresholds", async () => {
      const classifier = new DeterministicClassifier();
      const chat: ChatContext = {
        id: "chat1",
        title: "Discussion on performance",
        excerpts: [
          { role: "user", text: "I need to optimize database queries and improve indexing" },
          { role: "assistant", text: "Database performance is critical for scalability" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "PerformanceProject",
          description: "",
          keywords: ["database", "queries", "indexing", "performance"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.equal(
        result,
        null,
        "strong keyword evidence (4 keywords including in title) still returns null because keyword ceiling (0.68) is below existingProject threshold (0.70)"
      );
    });

    it("a project name match is not subject to the keyword ceiling", async () => {
      const classifier = new DeterministicClassifier();
      const chat: ChatContext = {
        id: "chat1",
        title: "Working on WebAssembly today",
        excerpts: [
          { role: "user", text: "I need to optimize some generic things" },
        ],
      };
      const projects: ProjectProfile[] = [
        {
          name: "WebAssembly",
          description: "",
          keywords: ["optimization", "performance"],
          aliases: [],
          exampleChatIds: [],
        },
      ];
      const result = await classifier.classify(chat, projects);
      assert.ok(result, "project name in title should match with default thresholds");
      assert.equal(result.projectName, "WebAssembly");
      assert.equal(
        result.reason,
        "Project name or alias matched in the title: webassembly."
      );
    });
  });
});
