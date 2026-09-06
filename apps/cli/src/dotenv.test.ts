import { describe, expect, test } from "bun:test";
import {
  classifyDotenv,
  diffDotenvEntries,
  parseDotenv,
  summarizeClassification,
} from "./dotenv";

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

  test("diffs local dotenv entries against remote names and values", () => {
    expect(
      diffDotenvEntries(
        [
          { name: "KEEP", value: "same" },
          { name: "CHANGED", value: "next" },
          { name: "NEW", value: "fresh" },
        ],
        [
          { name: "KEEP", value: "same" },
          { name: "CHANGED", value: "prev" },
          { name: "GONE", value: "old" },
        ],
      ),
    ).toEqual([
      {
        kind: "updated",
        name: "CHANGED",
        localValue: "next",
        remoteValue: "prev",
      },
      { kind: "added", name: "NEW", localValue: "fresh", remoteValue: null },
      { kind: "removed", name: "GONE", localValue: null, remoteValue: "old" },
    ]);
    expect(
      diffDotenvEntries(
        [{ name: "EMPTY", value: "" }],
        [{ name: "EMPTY", value: "" }],
      ),
    ).toEqual([]);
  });
});
