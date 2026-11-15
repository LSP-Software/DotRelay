import { describe, expect, test } from "bun:test";
import {
  classifyDotenv,
  diffDotenvEntries,
  literalDotenvNames,
  parseDotenv,
  serializeDotenv,
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

  test("accepts trailing comments after quoted values without including them", () => {
    expect(
      parseDotenv(
        'TOKEN="example" # comment\nSINGLE_QUOTED=\'value\'   # another\nEMPTY_QUOTED="" # empty\n',
      ),
    ).toEqual([
      { name: "TOKEN", value: "example" },
      { name: "SINGLE_QUOTED", value: "value" },
      { name: "EMPTY_QUOTED", value: "" },
    ]);
    expect(parseDotenv('TOKEN="example"# inline comment\n')).toEqual([
      { name: "TOKEN", value: "example" },
    ]);
  });

  test("accepts multiline quoted values and preserves line breaks", () => {
    expect(
      parseDotenv(
        'CERT="-----BEGIN CERT-----\nabc\n-----END CERT-----" # inline\nNEXT=yes\n',
      ),
    ).toEqual([
      {
        name: "CERT",
        value: "-----BEGIN CERT-----\nabc\n-----END CERT-----",
      },
      { name: "NEXT", value: "yes" },
    ]);
    expect(parseDotenv("KEY='line one\nline two'")).toEqual([
      { name: "KEY", value: "line one\nline two" },
    ]);
  });

  test("accepts CRLF line endings, including inside quoted values", () => {
    const entries = parseDotenv('A="one\r\ntwo" # note\r\nB=x\r\n');
    expect(entries).toEqual([
      { name: "A", value: "one\r\ntwo" },
      { name: "B", value: "x" },
    ]);
    expect(parseDotenv(serializeDotenv(entries))).toEqual(entries);
  });

  test("interprets supported double-quoted escapes and keeps single quotes literal", () => {
    expect(
      parseDotenv(
        'A="tab\\there \\"quoted\\" \\n newline \\r cr \\\\ backslash"',
      ),
    ).toEqual([
      {
        name: "A",
        value: 'tab\there "quoted" \n newline \r cr \\ backslash',
      },
    ]);
    expect(parseDotenv("B='literal \\n stays'")).toEqual([
      { name: "B", value: "literal \\n stays" },
    ]);
  });

  test("never executes interpolation or shell code while parsing", () => {
    expect(parseDotenv("CMD=$(echo hello)\nBT=`id`\nREF=$HOME/path\n")).toEqual(
      [
        { name: "CMD", value: "$(echo hello)" },
        { name: "BT", value: "`id`" },
        { name: "REF", value: "$HOME/path" },
      ],
    );
  });

  test("round-trips values through serialize and parse without changing content", () => {
    const source =
      'QUOTED="hello world"\n' +
      'MULTI="line one\nline two"\n' +
      'ESCAPED="tab\\there \\"quoted\\" \\n \\r \\\\ end"\n' +
      "EMPTY=\n" +
      "SINGLE='plain'\n";
    const entries = parseDotenv(source);
    expect(entries).toEqual([
      { name: "QUOTED", value: "hello world" },
      { name: "MULTI", value: "line one\nline two" },
      { name: "ESCAPED", value: 'tab\there "quoted" \n \r \\ end' },
      { name: "EMPTY", value: "" },
      { name: "SINGLE", value: "plain" },
    ]);
    expect(parseDotenv(serializeDotenv(entries))).toEqual(entries);
  });

  test("serializeDotenv escapes every character parseDotenv interprets", () => {
    expect(
      serializeDotenv([
        {
          name: "A",
          value: 'tab\there "quoted" \n newline \r cr \\ backslash',
        },
      ]),
    ).toBe('A="tab\\there \\"quoted\\" \\n newline \\r cr \\\\ backslash"\n');
  });

  test("keeps a leading # in unquoted values literal unless preceded by whitespace", () => {
    expect(parseDotenv("A=#c\nB=a # d\nC= # comment\nD=\t# comment\n")).toEqual(
      [
        { name: "A", value: "#c" },
        { name: "B", value: "a" },
        { name: "C", value: "" },
        { name: "D", value: "" },
      ],
    );
  });

  test("reports malformed assignments with line and column diagnostics", () => {
    expect(() => parseDotenv("  not an assignment")).toThrow(
      /invalid dotenv assignment on line 1, column 3/,
    );
    expect(() => parseDotenv("A=x\rB=y")).toThrow(
      /stray carriage return; use LF or CRLF line endings/,
    );
    expect(() => parseDotenv("A=x\r")).toThrow(
      /stray carriage return; use LF or CRLF line endings/,
    );
    expect(() => parseDotenv("A=x\r \nB=y")).toThrow(
      /stray carriage return; use LF or CRLF line endings/,
    );
    expect(() => parseDotenv('A="x\r"')).toThrow(
      /stray carriage return; use LF or CRLF line endings/,
    );
    expect(() => parseDotenv("VALUE=one\nVALUE=two")).toThrow(
      /duplicate dotenv Variable: VALUE on line 2/,
    );
  });

  test("reports unterminated and trailing quoted syntax with line and column diagnostics", () => {
    expect(() => parseDotenv('A="x\nmore')).toThrow(
      /unterminated double-quoted dotenv value for A starting on line 1, column 3/,
    );
    expect(() => parseDotenv("A='x\nmore'")).not.toThrow();
    expect(() => parseDotenv('A="x" tail')).toThrow(
      /unexpected content after the closing quote of A on line 1, column 7/,
    );
  });

  test("keeps unknown double-quoted escapes literally, like npm dotenv", () => {
    expect(parseDotenv('A="C:\\Users\\me"\nB="a\\qb"\n')).toEqual([
      { name: "A", value: "C:\\Users\\me" },
      { name: "B", value: "a\\qb" },
    ]);
    expect(parseDotenv('A="line1\\\nline2"\n')).toEqual([
      { name: "A", value: "line1\\\nline2" },
    ]);
  });

  test("names the file in parse errors when the caller gives it", () => {
    expect(() => parseDotenv("BAD-NAME=value", "/tmp/app/.env")).toThrow(
      /^\/tmp\/app\/\.env: invalid dotenv assignment on line 1, column 1$/,
    );
    expect(() => parseDotenv("BAD-NAME=value")).toThrow(
      /^invalid dotenv assignment/,
    );
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

describe("serializeDotenv safety", () => {
  test("writes $ so an expander sees the text the source gave it", () => {
    // `${HOME}` from an unquoted line stays expandable; escaping it would
    // turn dotenv-expand and Next.js interpolation into a literal.
    const source = 'E=${HOME}/x\nL="cost \\$5"\nM="a $B c"\n';
    const entries = parseDotenv(source);
    expect(entries).toEqual([
      { name: "E", value: "${HOME}/x" },
      { name: "L", value: "cost \\$5" },
      { name: "M", value: "a $B c" },
    ]);
    expect(serializeDotenv(entries)).toBe(
      'E="${HOME}/x"\nL="cost \\$5"\nM="a $B c"\n',
    );
    expect(parseDotenv(serializeDotenv(entries))).toEqual(entries);
    expect(serializeDotenv([{ name: "A", value: "plain value" }])).toBe(
      "A='plain value'\n",
    );
    expect(serializeDotenv([{ name: "A", value: "it's $HOME `id`\n" }])).toBe(
      'A="it\'s $HOME \\`id\\`\\n"\n',
    );
    expect(parseDotenv('A="\\$X \\`y\\`"\n')).toEqual([
      { name: "A", value: "\\$X `y`" },
    ]);
  });

  test("keeps a $ that is not a variable reference literal", () => {
    // Command substitution and bare dollars are never references an
    // expander resolves; double quotes would hand `$(id)` to a shell.
    expect(serializeDotenv([{ name: "T", value: "pa$word$(id)" }])).toBe(
      "T='pa$word$(id)'\n",
    );
    expect(serializeDotenv([{ name: "H", value: "$2b$10$abc" }])).toBe(
      "H='$2b$10$abc'\n",
    );
    expect(serializeDotenv([{ name: "D", value: "costs 5$" }])).toBe(
      "D='costs 5$'\n",
    );
    expect(serializeDotenv([{ name: "M", value: "a\nb $(id)" }])).toBe(
      "M='a\nb $(id)'\n",
    );
    for (const value of ["pa$word$(id)", "$2b$10$abc", "a\nb $(id)"])
      expect(parseDotenv(serializeDotenv([{ name: "A", value }]))).toEqual([
        { name: "A", value },
      ]);
    // A Value that also holds a single quote cannot be single-quoted.
    expect(serializeDotenv([{ name: "Q", value: "it's $(id)" }])).toBe(
      'Q="it\'s $(id)"\n',
    );
  });

  test("a Value read from a single-quoted line is written back literally", () => {
    const source = "P='pa$word'\nR=\"${HOME}/x\"\nU=$HOME\n";
    const literal = literalDotenvNames(source);
    expect([...literal]).toEqual(["P"]);
    const entries = parseDotenv(source);
    expect(serializeDotenv(entries, { literalNames: literal })).toBe(
      "P='pa$word'\nR=\"${HOME}/x\"\nU=\"$HOME\"\n",
    );
    expect(
      parseDotenv(serializeDotenv(entries, { literalNames: literal })),
    ).toEqual(entries);
  });

  test("keeps a backslash before $ distinct from an escaped backslash", () => {
    const entries = [
      { name: "A", value: "\\$X" },
      { name: "B", value: "\\\\$X" },
      { name: "C", value: "$X\\" },
    ];
    expect(serializeDotenv(entries)).toBe(
      'A="\\$X"\nB="\\\\\\$X"\nC="$X\\\\"\n',
    );
    expect(parseDotenv(serializeDotenv(entries))).toEqual(entries);
  });

  test("rejects invalid and duplicate names", () => {
    expect(() => serializeDotenv([{ name: "1A", value: "" }])).toThrow(
      /names must match/,
    );
    expect(() =>
      serializeDotenv([
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ]),
    ).toThrow(/duplicate/);
  });

  test("round-trips U+2028 and U+2029", () => {
    const entries = [
      { name: "A", value: "x\u2028y\u2029z" },
      { name: "B", value: "\u2028'\u2029" },
    ];
    expect(parseDotenv(serializeDotenv(entries))).toEqual(entries);
  });

  test("round-trips random Unicode strings", () => {
    let seed = 0x2f6e2b1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    const special = [..."'\"\\$`\n\r\t #=\u2028\u2029\u0000\u0085"];
    const randomChar = (): string => {
      const r = random();
      if (r < 0.4) return special[Math.floor(random() * special.length)] ?? "";
      if (r < 0.7) return String.fromCodePoint(32 + Math.floor(random() * 95));
      const cp = Math.floor(random() * 0x110000);
      return String.fromCodePoint(cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp);
    };
    for (let i = 0; i < 2000; i += 1) {
      const value = Array.from(
        { length: Math.floor(random() * 24) },
        randomChar,
      ).join("");
      const entries = [
        { name: "A", value },
        { name: "B_2", value: `${value}\r` },
      ];
      expect(parseDotenv(serializeDotenv(entries))).toEqual(entries);
    }
  });
});
