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

const escapeHelp = 'only \\\\, \\", \\n, \\r and \\t are supported';

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
        `unterminated ${
          quote === '"' ? "double" : "single"
        }-quoted dotenv value for ${name} starting on line ${startLine + 1}, column ${startCol + 1}`,
      );
    while (col < text.length) {
      const ch = text.charAt(col);
      if (ch === quote) return { value: chunks.join(""), line, col };
      if (quote === '"' && ch === "\\") {
        const next = text[col + 1];
        if (next === undefined)
          throw new CliInvocationError(
            `a backslash at the end of line ${line + 1}, column ${col + 1} in the double-quoted dotenv value for ${name} is not a supported escape; ${escapeHelp}`,
          );
        if (
          next !== "n" &&
          next !== "r" &&
          next !== "t" &&
          next !== "\\" &&
          next !== '"'
        )
          throw new CliInvocationError(
            `unsupported escape "\\${next}" on line ${line + 1}, column ${col + 1} in the double-quoted dotenv value for ${name}; ${escapeHelp}`,
          );
        chunks.push(
          next === "n"
            ? "\n"
            : next === "r"
              ? "\r"
              : next === "t"
                ? "\t"
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
      throw new CliInvocationError(
        `invalid dotenv assignment on line ${line}, column ${lead + 1}: the line contains a stray carriage return; use LF or CRLF line endings`,
      );
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/d.exec(
      trimmed,
    );
    if (!match)
      throw new CliInvocationError(
        `invalid dotenv assignment on line ${line}, column ${lead + 1}`,
      );
    const name = match[1] ?? "";
    const nameCol =
      (match.indices?.[1]?.[0] ?? 0) +
      (original.length - original.trimStart().length) +
      1;
    if (!variableName.test(name))
      throw new CliInvocationError(
        `invalid dotenv Variable name on line ${line}, column ${nameCol}`,
      );
    if (seen.has(name))
      throw new CliInvocationError(
        `duplicate dotenv Variable: ${name} on line ${line}`,
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
          `unexpected content after the closing quote of ${name} on line ${parsed.line + 1}, column ${contentCol}`,
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
          `classification is required for ${entry.name}`,
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

export const serializeDotenv = (entries: readonly DotenvEntry[]): string =>
  `${entries
    .map(({ name, value }) => {
      const escaped = value
        .replaceAll("\\", "\\\\")
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r")
        .replaceAll("\t", "\\t")
        .replaceAll('"', '\\"');
      return `${name}="${escaped}"`;
    })
    .join("\n")}\n`;
