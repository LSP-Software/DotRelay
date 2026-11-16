// A strict .env reader and writer for the browser, ported from the CLI's
// apps/cli/src/dotenv.ts so a file pasted into the web editor, or downloaded
// from it, means exactly what `dotrelay push` and `dotrelay pull` mean by it.
// Anything the CLI rejects is rejected here with the same line and column.

export type DotenvEntry = Readonly<{
  readonly name: string;
  readonly value: string;
}>;

export class DotenvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DotenvError";
  }
}

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const escapeHelp = 'only \\\\, \\", \\$, \\`, \\n, \\r and \\t are supported';

// Whether the `$` at `index` starts a reference an expander resolves:
// `$NAME`, `${NAME}`, or `${NAME:-default}` and its kin.
const REFERENCE_AT =
  /^\$(?:[A-Za-z_]|\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=+?][^}]*)?\})/;
const startsReference = (text: string, index: number): boolean =>
  REFERENCE_AT.test(text.slice(index));

const readQuotedValue = (
  lines: readonly string[],
  crlf: readonly boolean[],
  startLine: number,
  startCol: number,
  quote: '"' | "'",
  name: string,
): { value: string; line: number; col: number } => {
  const chunks: string[] = [];
  let line = startLine;
  let col = startCol + 1;
  for (;;) {
    const text = lines[line];
    if (text === undefined)
      throw new DotenvError(
        `Unterminated ${
          quote === '"' ? "double" : "single"
        }-quoted value for ${name} starting on line ${startLine + 1}, column ${startCol + 1}.`,
      );
    while (col < text.length) {
      const ch = text.charAt(col);
      if (ch === quote) return { value: chunks.join(""), line, col };
      if (quote === '"' && ch === "\\") {
        const next = text[col + 1];
        if (next === undefined)
          throw new DotenvError(
            `A backslash at the end of line ${line + 1}, column ${col + 1} in the double-quoted value for ${name} is not a supported escape; ${escapeHelp}.`,
          );
        if (
          next !== "n" &&
          next !== "r" &&
          next !== "t" &&
          next !== "\\" &&
          next !== '"' &&
          next !== "$" &&
          next !== "`"
        )
          throw new DotenvError(
            `Unsupported escape "\\${next}" on line ${line + 1}, column ${col + 1} in the double-quoted value for ${name}; ${escapeHelp}.`,
          );
        // As in the CLI, `\$` before a variable reference (`\$NAME`,
        // `\${NAME}`) is expansion syntax and stays in the Value as written;
        // before anything else it means a plain `$`.
        chunks.push(
          next === "n"
            ? "\n"
            : next === "r"
              ? "\r"
              : next === "t"
                ? "\t"
                : next === "$" && startsReference(text, col + 1)
                  ? "\\$"
                  : next,
        );
        col += 2;
        continue;
      }
      chunks.push(ch);
      col += 1;
    }
    chunks.push(crlf[line] ? "\r\n" : "\n");
    line += 1;
    col = 0;
  }
};

const parseUnquotedValue = (text: string): string => {
  let valueEnd = text.length;
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === "#" && /\s/.test(text.charAt(i - 1))) {
      valueEnd = i;
      break;
    }
  }
  return text.slice(0, valueEnd).trim();
};

export const parseDotenv = (source: string): readonly DotenvEntry[] => {
  const rawLines = source.split("\n");
  const crlf = rawLines.map(
    (raw, i) => i < rawLines.length - 1 && raw.endsWith("\r"),
  );
  const lines = rawLines.map((raw, i) => (crlf[i] ? raw.slice(0, -1) : raw));
  const entries: DotenvEntry[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < lines.length) {
    const line = index + 1;
    const original = lines[index] ?? "";
    const trimmed = original.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    const lead = original.length - original.trimStart().length;
    if (original.includes("\r"))
      throw new DotenvError(
        `Invalid assignment on line ${line}, column ${lead + 1}: the line contains a stray carriage return.`,
      );
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/s.exec(
      trimmed,
    );
    if (!match)
      throw new DotenvError(
        `Invalid assignment on line ${line}, column ${lead + 1}. Use NAME=value.`,
      );
    const name = match[1] ?? "";
    if (seen.has(name))
      throw new DotenvError(`${name} appears twice (again on line ${line}).`);
    seen.add(name);
    const valueStart = original.indexOf("=") + 1;
    let valueCol = valueStart;
    while (
      valueCol < original.length &&
      (original[valueCol] === " " || original[valueCol] === "\t")
    )
      valueCol += 1;
    const firstChar = original[valueCol];
    let value: string;
    if (firstChar === '"' || firstChar === "'") {
      const parsed = readQuotedValue(
        lines,
        crlf,
        index,
        valueCol,
        firstChar,
        name,
      );
      const after = (lines[parsed.line] ?? "").slice(parsed.col + 1);
      const content = after.trimStart();
      if (content !== "" && !content.startsWith("#")) {
        const contentCol = parsed.col + 2 + (after.length - content.length);
        throw new DotenvError(
          `Unexpected text after the closing quote of ${name} on line ${parsed.line + 1}, column ${contentCol}.`,
        );
      }
      value = parsed.value;
      index = parsed.line + 1;
    } else {
      value = parseUnquotedValue(original.slice(valueStart));
      index += 1;
    }
    entries.push(Object.freeze({ name, value }));
  }
  return Object.freeze(entries);
};

// Single quotes are literal for sh and python-dotenv, but Bun's loader still
// expands `$` inside them, so any value with `$` or a backtick takes the
// double-quoted form the CLI writes: a `$` that starts a reference stays as
// written, as does a `\$` before one, and every other `$`, every backtick
// and every backslash is escaped, so Bun, sh and dotenv-expand read the
// rest literally and the parser above reads the same Value back.
const serializeValue = (value: string): string => {
  if (!/['\n\r$`]/.test(value)) return `'${value}'`;
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const ch = value.charAt(index);
    if (ch === "\\")
      escaped +=
        value[index + 1] === "$" && startsReference(value, index + 1)
          ? "\\"
          : "\\\\";
    else if (ch === "$") escaped += startsReference(value, index) ? "$" : "\\$";
    else if (ch === "\n") escaped += "\\n";
    else if (ch === "\r") escaped += "\\r";
    else if (ch === "\t") escaped += "\\t";
    else if (ch === '"') escaped += '\\"';
    else if (ch === "`") escaped += "\\`";
    else escaped += ch;
  }
  return `"${escaped}"`;
};

export const serializeDotenv = (entries: readonly DotenvEntry[]): string => {
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (!variableName.test(name))
      throw new DotenvError(
        `Can't write ${JSON.stringify(name)}: names must match [A-Za-z_][A-Za-z0-9_]*.`,
      );
    if (seen.has(name)) throw new DotenvError(`Can't write ${name} twice.`);
    seen.add(name);
  }
  if (entries.length === 0) return "";
  return `${entries
    .map(({ name, value }) => `${name}=${serializeValue(value)}`)
    .join("\n")}\n`;
};
