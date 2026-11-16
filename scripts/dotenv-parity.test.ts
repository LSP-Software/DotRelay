import { describe, expect, test } from "bun:test";
import {
  parseDotenv as parseCli,
  serializeDotenv as serializeCli,
} from "../apps/cli/src/dotenv";
import {
  parseDotenv as parseWeb,
  serializeDotenv as serializeWeb,
} from "../apps/web/lib/dotenv";

// A .env file pasted into or downloaded from the web editor means what
// `dotrelay push` and `dotrelay pull` mean by it (apps/web/lib/dotenv.ts).
const SOURCES = [
  'A="\\$HOME"',
  'A="\\${HOME}"',
  'A="\\${HOME:-fallback}"',
  'A="\\$5"',
  'A="\\$(id)"',
  'A="cost \\$"',
  'A="\\\\$HOME"',
  'A="\\\\\\$HOME"',
  'A="$HOME \\` \\" \\n \\t"',
  "A='\\$HOME'",
  "A=\\$HOME",
];

const VALUES = [
  "$HOME",
  "\\$HOME",
  "${HOME}",
  "\\${HOME:-x}",
  "${A:-$(id)}",
  "$5",
  "\\$5",
  "$(id) `id`",
  "$2b$10$abcdefghijklmnopqrstuv",
  "it's $HOME",
  "line\nbreak\r\ttab",
  'say "hi" \\ end',
  "$",
  "\\",
  "",
];

describe("CLI and web dotenv parity", () => {
  test("both read the same file the same way", () => {
    for (const source of SOURCES)
      expect({ source, entries: parseWeb(source) }).toEqual({
        source,
        entries: parseCli(source),
      });
  });

  test("a file either one writes reads back the same in both", () => {
    const entries = VALUES.map((value, index) => ({
      name: `V${index}`,
      value,
    }));
    for (const written of [serializeWeb(entries), serializeCli(entries)]) {
      expect(parseWeb(written)).toEqual(entries);
      expect(parseCli(written)).toEqual(entries);
    }
  });
});
