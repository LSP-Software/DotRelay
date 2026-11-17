import { CliInvocationError } from "./errors";

export type ValueOwnership = "shared" | "user-defined";

export type DotenvEntry = Readonly<{
  readonly name: string;
  readonly value: string;
}>;
export type ClassifiedDotenvEntry = DotenvEntry &
  Readonly<{
    readonly classification: "shared" | "user-defined";
    readonly description?: string;
  }>;

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Whether the `$` at `index` starts a reference an expander resolves:
// `$NAME`, `${NAME}`, or `${NAME:-default}` and its kin.
const REFERENCE_AT =
  /^\$(?:[A-Za-z_]|\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=+?][^}]*)?\})/;
const startsReference = (text: string, index: number): boolean =>
  REFERENCE_AT.test(text.slice(index));

// Escapes that only exist to survive the double quotes are decoded. `\$`
// before a variable reference (`\$NAME`, `\${NAME}`) is expansion syntax
// rather than quoting, so it stays in the Value as written: dotenv-expand,
// Next.js and Bun read it as a literal dollar sign, and writing the Value
// back emits the same text. `\$` before anything else (`\$(`, `\$5`, a
// final `\$`) means a plain `$` to every reader, since no expander treats
// those as references, so it is decoded; the serializer writes such a `$`
// that way to keep a shell from running it. Any other backslash sequence is
// kept literally, as the npm dotenv package does.
const DECODED_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
  '"': '"',
  "`": "`",
};

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
      throw new CliInvocationError(
        `the ${
          quote === '"' ? "double" : "single"
        } quote that opens ${name} on line ${startLine + 1}, column ${startCol + 1} is never closed`,
      );
    while (col < text.length) {
      const ch = text.charAt(col);
      if (ch === quote) return { value: chunks.join(""), line, col };
      if (quote === '"' && ch === "\\") {
        const next = text[col + 1];
        if (next === undefined) {
          chunks.push(ch);
          col += 1;
          continue;
        }
        const decoded = Object.hasOwn(DECODED_ESCAPES, next)
          ? DECODED_ESCAPES[next]
          : next === "$" && !startsReference(text, col + 1)
            ? "$"
            : undefined;
        chunks.push(decoded ?? `\\${next}`);
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

type ParsedEntries = Readonly<{
  readonly entries: readonly DotenvEntry[];
  /** Names whose Value was single-quoted, which every reader takes literally. */
  readonly literal: ReadonlySet<string>;
}>;

const parseEntries = (source: string): ParsedEntries => {
  const rawLines = source.split("\n");
  const crlf = rawLines.map(
    (raw, i) => i < rawLines.length - 1 && raw.endsWith("\r"),
  );
  const lines = rawLines.map((raw, i) => (crlf[i] ? raw.slice(0, -1) : raw));
  const entries: DotenvEntry[] = [];
  const literal = new Set<string>();
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
      throw new CliInvocationError(
        `line ${line}, column ${lead + 1} has a stray carriage return. Save the file with LF or CRLF line endings.`,
      );
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/ds.exec(
      trimmed,
    );
    if (!match)
      throw new CliInvocationError(
        `line ${line}, column ${lead + 1} isn't a NAME=value assignment`,
      );
    const name = match[1] ?? "";
    const nameCol =
      (match.indices?.[1]?.[0] ?? 0) +
      (original.length - original.trimStart().length) +
      1;
    if (!variableName.test(name))
      throw new CliInvocationError(
        `the variable name on line ${line}, column ${nameCol} isn't valid. Names use letters, digits and underscores, and can't start with a digit.`,
      );
    if (seen.has(name))
      throw new CliInvocationError(
        `${name} is set twice. The duplicate is on line ${line}.`,
      );
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
        throw new CliInvocationError(
          `there's extra text after the closing quote of ${name} on line ${parsed.line + 1}, column ${contentCol}`,
        );
      }
      value = parsed.value;
      if (firstChar === "'") literal.add(name);
      index = parsed.line + 1;
    } else {
      value = parseUnquotedValue(original.slice(valueStart));
      index += 1;
    }
    entries.push(Object.freeze({ name, value }));
  }
  return Object.freeze({ entries: Object.freeze(entries), literal });
};

const withSourcePath = <T>(parse: () => T, sourcePath?: string): T => {
  try {
    return parse();
  } catch (error) {
    if (sourcePath !== undefined && error instanceof CliInvocationError)
      throw new CliInvocationError(`${sourcePath}: ${error.message}`);
    throw error;
  }
};

/**
 * Parses a dotenv file. Errors name `sourcePath` when it is given, so a
 * malformed line points at the file that holds it.
 */
export const parseDotenv = (
  source: string,
  sourcePath?: string,
): readonly DotenvEntry[] =>
  withSourcePath(() => parseEntries(source).entries, sourcePath);

/**
 * The names a dotenv file single-quotes. Their Values were meant literally,
 * so a pull that rewrites the file keeps them literal.
 */
export const literalDotenvNames = (
  source: string,
  sourcePath?: string,
): ReadonlySet<string> =>
  withSourcePath(() => parseEntries(source).literal, sourcePath);

export const classifyDotenv = (
  entries: readonly DotenvEntry[],
  classifications: Readonly<
    Record<
      string,
      Readonly<{
        classification: "shared" | "user-defined";
        description?: string;
      }>
    >
  >,
): readonly ClassifiedDotenvEntry[] => {
  return Object.freeze(
    entries.map((entry) => {
      const classification = Object.hasOwn(classifications, entry.name)
        ? classifications[entry.name]
        : undefined;
      if (!classification)
        throw new CliInvocationError(
          `${entry.name} needs to be marked Team or Only me`,
        );
      return Object.freeze({ ...entry, ...classification });
    }),
  );
};

export const summarizeClassification = (
  entries: readonly ClassifiedDotenvEntry[],
) =>
  Object.freeze({
    variableCount: entries.length,
    sharedValueCount: entries.filter(
      (entry) => entry.classification === "shared",
    ).length,
    userDefinedValueCount: entries.filter(
      (entry) => entry.classification === "user-defined",
    ).length,
    names: Object.freeze(entries.map((entry) => entry.name)),
  });

export type DotenvDiffChange = Readonly<{
  readonly kind: "added" | "updated" | "removed";
  readonly name: string;
  readonly localValue: string | null;
  readonly remoteValue: string | null;
  readonly ownership?: ValueOwnership | undefined;
}>;

export const diffDotenvEntries = (
  local: readonly DotenvEntry[],
  remote: readonly DotenvEntry[],
): readonly DotenvDiffChange[] => {
  const remoteByName = new Map(
    remote.map((entry) => [entry.name, entry.value]),
  );
  const localNames = new Set(local.map((entry) => entry.name));
  const changes: DotenvDiffChange[] = [];
  for (const entry of local) {
    const remoteValue = remoteByName.get(entry.name);
    if (remoteValue === undefined)
      changes.push(
        Object.freeze({
          kind: "added",
          name: entry.name,
          localValue: entry.value,
          remoteValue: null,
        }),
      );
    else if (remoteValue !== entry.value)
      changes.push(
        Object.freeze({
          kind: "updated",
          name: entry.name,
          localValue: entry.value,
          remoteValue,
        }),
      );
  }
  for (const entry of remote) {
    if (localNames.has(entry.name)) continue;
    changes.push(
      Object.freeze({
        kind: "removed",
        name: entry.name,
        localValue: null,
        remoteValue: entry.value,
      }),
    );
  }
  return Object.freeze(changes);
};

// Whether every `$` in the Value starts a reference an expander resolves.
// Anything else, such as `$(command)`, `$2b$` or a trailing `$`, is not
// something an expander should see.
const onlyReferences = (value: string): boolean => {
  for (let index = value.indexOf("$"); index >= 0;) {
    if (!startsReference(value, index)) return false;
    index = value.indexOf("$", index + 1);
  }
  return true;
};

// A Value is written so the parser above reads it back unchanged, and so a
// file sourced into a shell (`set -a; . ./.env`) never runs any of it.
// Values with no quote, line break, `$` or backtick use single quotes,
// which every reader takes literally. So does a single-quotable Value read
// from a single-quoted line, and one whose `$` is not a variable
// reference. Otherwise the Value is double-quoted: a `$` that starts a
// reference stays as written so an expander (dotenv-expand, Next.js, Bun)
// and a shell expand it, a `\$` the source used before a reference stays
// `\$`, and every other `$`, every backtick and every backslash is escaped,
// so `$(…)`, `$((…))` and `` `…` `` reach no shell. A Value that holds a
// single quote cannot be single-quoted and relies on these escapes.
const serializeValue = (value: string, literal: boolean): string => {
  if (!/['\n\r$`]/.test(value)) return `'${value}'`;
  const singleQuotable = !/['\r]/.test(value);
  if (singleQuotable && (literal || !onlyReferences(value)))
    return `'${value}'`;
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

export const serializeDotenv = (
  entries: readonly DotenvEntry[],
  options: Readonly<{ readonly literalNames?: ReadonlySet<string> }> = {},
): string => {
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (!variableName.test(name))
      throw new CliInvocationError(
        `can't write ${JSON.stringify(name)} to a dotenv file. Names must match [A-Za-z_][A-Za-z0-9_]*.`,
      );
    if (seen.has(name))
      throw new CliInvocationError(
        `can't write ${name} to a dotenv file twice`,
      );
    seen.add(name);
  }
  return `${entries
    .map(
      ({ name, value }) =>
        `${name}=${serializeValue(value, options.literalNames?.has(name) ?? false)}`,
    )
    .join("\n")}\n`;
};
