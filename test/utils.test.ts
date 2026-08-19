import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { tokenize, containsTerm } from "../src/classifier/utils.js";

describe("tokenize", () => {
  it("should split text into word tokens on boundaries", () => {
    const tokens = tokenize("hello world");
    assert.ok(tokens.has("hello"));
    assert.ok(tokens.has("world"));
    assert.equal(tokens.size, 2);
  });

  it("should lowercase all tokens", () => {
    const tokens = tokenize("HELLO World");
    assert.ok(tokens.has("hello"));
    assert.ok(tokens.has("world"));
    assert.ok(!tokens.has("HELLO"));
  });

  it("should handle Portuguese words with accents", () => {
    const tokens = tokenize("São Paulo análise");
    assert.ok(tokens.has("são"));
    assert.ok(tokens.has("paulo"));
    assert.ok(tokens.has("análise"));
    assert.equal(tokens.size, 3);
  });

  it("should split on punctuation boundaries", () => {
    const tokens = tokenize("hello, world! How's this?");
    assert.ok(tokens.has("hello"));
    assert.ok(tokens.has("world"));
    assert.ok(tokens.has("how's"));
    assert.ok(tokens.has("this"));
  });

  it("should include hyphens and apostrophes in tokens", () => {
    const tokens = tokenize("well-known don't");
    assert.ok(tokens.has("well-known"));
    assert.ok(tokens.has("don't"));
  });

  it("should handle Unicode word characters", () => {
    const tokens = tokenize("café naïve Zürich");
    assert.ok(tokens.has("café"));
    assert.ok(tokens.has("naïve"));
    assert.ok(tokens.has("zürich"));
  });

  it("should return empty set for empty string", () => {
    const tokens = tokenize("");
    assert.equal(tokens.size, 0);
  });

  it("should handle multiple spaces", () => {
    const tokens = tokenize("hello    world");
    assert.ok(tokens.has("hello"));
    assert.ok(tokens.has("world"));
    assert.equal(tokens.size, 2);
  });
});

describe("containsTerm", () => {
  describe("single-word terms (word-boundary matching)", () => {
    it("should match a word in tokens", () => {
      const tokens = tokenize("hello world");
      assert.ok(containsTerm(tokens, "hello world", "hello"));
    });

    it("should NOT match a partial word", () => {
      const tokens = tokenize("hello world");
      assert.ok(!containsTerm(tokens, "hello world", "hell"));
    });

    it("should NOT match 'casa' in 'por acaso'", () => {
      const tokens = tokenize("por acaso");
      assert.ok(!containsTerm(tokens, "por acaso", "casa"));
    });

    it("should NOT match 'casa' in 'casaco'", () => {
      const tokens = tokenize("casaco");
      assert.ok(!containsTerm(tokens, "casaco", "casa"));
    });

    it("should match 'casa' as standalone word", () => {
      const tokens = tokenize("minha casa é bonita");
      assert.ok(containsTerm(tokens, "minha casa é bonita", "casa"));
    });

    it("should match Portuguese accented words", () => {
      const tokens = tokenize("a análise foi importante");
      assert.ok(containsTerm(tokens, "a análise foi importante", "análise"));
    });

    it("should NOT match when case differs in tokens", () => {
      const tokens = tokenize("HELLO");
      assert.ok(containsTerm(tokens, "HELLO", "hello"));
    });
  });

  describe("multi-word terms (phrase matching)", () => {
    it("should match a phrase in text", () => {
      const tokens = tokenize("I am learning machine learning");
      const text = "I am learning machine learning";
      assert.ok(containsTerm(tokens, text, "machine learning"));
    });

    it("should match a phrase with lowercase", () => {
      const tokens = tokenize("I am learning MACHINE LEARNING");
      const text = "i am learning machine learning";
      assert.ok(containsTerm(tokens, text, "machine learning"));
    });

    it("should NOT match an incomplete phrase", () => {
      const tokens = tokenize("I am learning machine learning");
      const text = "i am learning machine learning";
      assert.ok(!containsTerm(tokens, text, "machine other"));
    });

    it("should match Portuguese multi-word phrases", () => {
      const tokens = tokenize("São Paulo");
      const text = "são paulo";
      assert.ok(containsTerm(tokens, text, "são paulo"));
    });

    it("should handle phrases with accents", () => {
      const tokens = tokenize("análise de dados");
      const text = "análise de dados";
      assert.ok(containsTerm(tokens, text, "análise de dados"));
    });

    it("should NOT match phrase split across non-contiguous tokens", () => {
      const tokens = tokenize("hello foo world");
      const text = "hello foo world";
      assert.ok(!containsTerm(tokens, text, "hello world"));
    });
  });

  describe("edge cases", () => {
    it("should handle empty term", () => {
      const tokens = tokenize("hello world");
      assert.ok(!containsTerm(tokens, "hello world", ""));
    });

    it("should handle empty text and tokens", () => {
      const tokens = tokenize("");
      assert.ok(!containsTerm(tokens, "", "hello"));
    });

    it("should be case-insensitive for tokens", () => {
      const tokens = tokenize("Hello World");
      assert.ok(containsTerm(tokens, "hello world", "hello"));
      assert.ok(containsTerm(tokens, "HELLO WORLD", "world"));
    });
  });
});
