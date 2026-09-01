import { CliInvocationError } from "./errors";

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

const parseValue = (raw: string, line: number): string => {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1)
      throw new CliInvocationError(
        `invalid quoted dotenv value on line ${line}`,
      );
    const body = value.slice(1, -1);
    return body.replaceAll(/\\([\\"nrt])/g, (_, escaped: string) => {
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      return escaped;
    });
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1)
      throw new CliInvocationError(
        `invalid quoted dotenv value on line ${line}`,
      );
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "").trim();
};

export const parseDotenv = (source: string): readonly DotenvEntry[] => {
  const entries: DotenvEntry[] = [];
  const seen = new Set<string>();
  for (const [index, original] of source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .entries()) {
    const line = index + 1;
    const trimmed = original.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/.exec(
      trimmed,
    );
    if (!match)
      throw new CliInvocationError(`invalid dotenv assignment on line ${line}`);
    const [, name, rawValue] = match;
    if (!name || !variableName.test(name))
      throw new CliInvocationError(
        `invalid dotenv Variable name on line ${line}`,
      );
    if (seen.has(name))
      throw new CliInvocationError(`duplicate dotenv Variable: ${name}`);
    seen.add(name);
    entries.push(
      Object.freeze({ name, value: parseValue(rawValue ?? "", line) }),
    );
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
      const classification = classifications[entry.name];
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

export const serializeDotenv = (entries: readonly DotenvEntry[]): string =>
  `${entries
    .map(({ name, value }) => {
      const escaped = value
        .replaceAll("\\", "\\\\")
        .replaceAll("\n", "\\n")
        .replaceAll('"', '\\"');
      return `${name}="${escaped}"`;
    })
    .join("\n")}\n`;
