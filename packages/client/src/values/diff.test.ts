import { describe, expect, test } from "bun:test";
import { splitInlineValueDiff } from "./diff";

describe("inline value diffs", () => {
  test("keep the shared characters and mark only the edit", () => {
    expect(splitInlineValueDiff("abc", "abcd")).toEqual({
      prefix: "abc",
      removed: "",
      added: "d",
      suffix: "",
    });
    expect(splitInlineValueDiff("abcd", "abc")).toEqual({
      prefix: "abc",
      removed: "d",
      added: "",
      suffix: "",
    });
    expect(splitInlineValueDiff("abc", "abd")).toEqual({
      prefix: "ab",
      removed: "c",
      added: "d",
      suffix: "",
    });
    expect(
      splitInlineValueDiff("postgres://old@host/db", "postgres://new@host/db"),
    ).toEqual({
      prefix: "postgres://",
      removed: "old",
      added: "new",
      suffix: "@host/db",
    });
  });
});
