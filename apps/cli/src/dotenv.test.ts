import { describe, expect, test } from "bun:test";
import { classifyDotenv, parseDotenv, summarizeClassification } from "./dotenv";

describe("local dotenv parsing", () => {
  test("preserves empty values and parses quoted values", () => {
    expect(
      parseDotenv(
        "EMPTY=\nQUOTED=\"hello world\"\nSINGLE='value'\nexport FLAG=yes\n",
      ),
    ).toEqual([
      { name: "EMPTY", value: "" },
      { name: "QUOTED", value: "hello world" },
      { name: "SINGLE", value: "value" },
      { name: "FLAG", value: "yes" },
    ]);
  });

  test("rejects malformed and duplicate variables", () => {
    expect(() => parseDotenv("BAD-NAME=value")).toThrow();
    expect(() => parseDotenv("VALUE=one\nVALUE=two")).toThrow("duplicate");
    expect(() =>
      classifyDotenv([{ name: "constructor", value: "" }], {}),
    ).toThrow("classification is required");
  });

  test("summarizes classifications without exposing values", () => {
    const summary = summarizeClassification([
      { name: "PUBLIC", value: "secret", classification: "shared" },
      { name: "LOCAL", value: "private", classification: "user-defined" },
      { name: "EMPTY", value: "", classification: "shared" },
    ]);
    expect(summary).toEqual({
      variableCount: 3,
      sharedValueCount: 2,
      userDefinedValueCount: 1,
      names: ["PUBLIC", "LOCAL", "EMPTY"],
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});
