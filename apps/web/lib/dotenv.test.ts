import { describe, expect, test } from "bun:test";
import { DotenvError, parseDotenv, serializeDotenv } from "./dotenv";

// These cases mirror apps/cli/src/dotenv.test.ts so a file means the same
// thing in the browser and in the CLI.
describe("browser dotenv parsing", () => {
  test("preserves empty values, quotes, and export prefixes", () => {
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

  test("skips comments and blank lines, and strips trailing comments", () => {
    expect(
      parseDotenv(
        '# header\n\nTOKEN="example" # comment\nA=#c\nB=a # d\nC= # comment\n',
      ),
    ).toEqual([
      { name: "TOKEN", value: "example" },
      { name: "A", value: "#c" },
      { name: "B", value: "a" },
      { name: "C", value: "" },
    ]);
  });

  test("reads multiline quoted values and CRLF line endings", () => {
    expect(
      parseDotenv('CERT="-----BEGIN-----\nabc\n-----END-----"\r\nNEXT=yes\r\n'),
    ).toEqual([
      { name: "CERT", value: "-----BEGIN-----\nabc\n-----END-----" },
      { name: "NEXT", value: "yes" },
    ]);
  });

  test("interprets double-quoted escapes and keeps single quotes literal", () => {
    expect(parseDotenv('A="tab\\there \\"q\\" \\n \\\\"')).toEqual([
      { name: "A", value: 'tab\there "q" \n \\' },
    ]);
    expect(parseDotenv("B='literal \\n stays'")).toEqual([
      { name: "B", value: "literal \\n stays" },
    ]);
  });

  test("never interpolates", () => {
    expect(parseDotenv("CMD=$(echo hi)\nREF=$HOME/x\n")).toEqual([
      { name: "CMD", value: "$(echo hi)" },
      { name: "REF", value: "$HOME/x" },
    ]);
  });

  test("keeps \\$ before a reference and decodes it before anything else", () => {
    expect(parseDotenv('A="\\$HOME \\${PATH} \\$5 \\$(id) \\$"')).toEqual([
      { name: "A", value: "\\$HOME \\${PATH} $5 $(id) $" },
    ]);
  });

  test("rejects malformed input with a line number", () => {
    expect(() => parseDotenv("  not an assignment")).toThrow(
      "line 1, column 3",
    );
    expect(() => parseDotenv("BAD-NAME=value")).toThrow(DotenvError);
    expect(() => parseDotenv("VALUE=one\nVALUE=two")).toThrow(
      "VALUE appears twice (again on line 2)",
    );
    expect(() => parseDotenv('A="x\\qx"')).toThrow("Unsupported escape");
    expect(() => parseDotenv('A="x\nmore')).toThrow("Unterminated");
    expect(() => parseDotenv('A="x" tail')).toThrow("after the closing quote");
    expect(() => parseDotenv("A=x\rB=y")).toThrow("carriage return");
  });
});

describe("browser dotenv writing", () => {
  test("round-trips every value the parser reads", () => {
    const entries = [
      { name: "QUOTED", value: "hello world" },
      { name: "MULTI", value: "line one\nline two" },
      { name: "ESCAPED", value: 'tab\there "quoted" \n \r \\ end' },
      { name: "DOLLAR", value: "$HOME and `id`" },
      { name: "APOS", value: "it's" },
      { name: "EMPTY", value: "" },
    ];
    expect(parseDotenv(serializeDotenv(entries))).toEqual(entries);
  });

  test("writes references for expanders and escapes every other $", () => {
    expect(
      serializeDotenv([{ name: "A", value: "$HOME \\$PATH $5 $(id)" }]),
    ).toBe('A="$HOME \\$PATH \\$5 \\$(id)"\n');
  });

  test("single-quotes plain values and writes nothing for no entries", () => {
    expect(serializeDotenv([{ name: "A", value: "b c" }])).toBe("A='b c'\n");
    expect(serializeDotenv([])).toBe("");
  });

  test("refuses names a .env file cannot hold", () => {
    expect(() => serializeDotenv([{ name: "1BAD", value: "" }])).toThrow(
      DotenvError,
    );
    expect(() =>
      serializeDotenv([
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ]),
    ).toThrow("twice");
  });
});
