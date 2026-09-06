import { CliInvocationError } from "./errors";
import { readTerminalLine, type TerminalIo } from "./terminal";

export type ColorRole =
  | "danger"
  | "dim"
  | "graphite"
  | "ok"
  | "paper"
  | "warn"
  | "wax";

export const PRODUCT_WORDMARK = "dotrelay — DotRelay standalone CLI";

export const MARK = Object.freeze({
  brand: "{·}",
  step: "·",
  cursor: "❯",
  ok: "✓",
  error: "✕",
});

export const GUTTER = "  ";
export const BODY = "     ";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ESC = "\u001b";
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

const palette: Record<
  ColorRole,
  Readonly<{ readonly truecolor: string; readonly indexed: string }>
> = {
  graphite: { truecolor: "\x1b[38;2;154;168;164m", indexed: "\x1b[38;5;246m" },
  paper: { truecolor: "\x1b[38;2;232;239;236m", indexed: "\x1b[97m" },
  wax: { truecolor: "\x1b[38;2;110;226;164m", indexed: "\x1b[38;5;79m" },
  dim: { truecolor: "\x1b[38;2;107;122;118m", indexed: "\x1b[2m" },
  ok: { truecolor: "\x1b[38;2;110;226;164m", indexed: "\x1b[38;5;79m" },
  warn: { truecolor: "\x1b[38;2;232;196;92m", indexed: "\x1b[38;5;179m" },
  danger: { truecolor: "\x1b[38;2;224;112;96m", indexed: "\x1b[38;5;167m" },
};

const supportsTruecolor = (): boolean => {
  const term = process.env.COLORTERM ?? "";
  return term.includes("truecolor") || term.includes("24bit");
};

export const colorEnabled = (): boolean => {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stderr.isTTY || process.stdout.isTTY);
};

export const paint = (
  text: string,
  role: ColorRole,
  options: Readonly<{ readonly bold?: boolean }> = {},
): string => {
  if (!colorEnabled()) return text;
  const color = supportsTruecolor()
    ? palette[role].truecolor
    : palette[role].indexed;
  const weight = options.bold ? BOLD : "";
  return `${weight}${color}${text}${RESET}`;
};

export const visibleWidth = (text: string): number =>
  Array.from(text.replace(ANSI, "")).length;

export const padVisible = (text: string, width: number): string =>
  `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;

const markerFor = (role: ColorRole): string => {
  if (role === "ok") return paint(MARK.ok, "ok");
  if (role === "danger") return paint(MARK.error, "danger");
  if (role === "warn") return paint(MARK.step, "warn");
  return paint(MARK.step, role);
};

export type HelpEntry = Readonly<{
  readonly command: string;
  readonly detail: string;
}>;

export type HelpSection = Readonly<{
  readonly title: string;
  readonly entries: readonly HelpEntry[];
}>;

export const renderWordmark = (): string =>
  `${GUTTER}${paint(MARK.brand, "wax")}  ${paint(PRODUCT_WORDMARK, "paper", {
    bold: true,
  })}`;

export const renderSectionTitle = (title: string): string =>
  `${GUTTER}${paint(title, "wax")}`;

export const renderHelpEntries = (
  entries: readonly HelpEntry[],
  options: Readonly<{ readonly commandRole?: ColorRole }> = {},
): string => {
  const width = Math.max(...entries.map((entry) => entry.command.length), 8);
  const commandRole = options.commandRole ?? "paper";
  return entries
    .map((entry) => {
      const command = paint(entry.command.padEnd(width, " "), commandRole);
      return `${BODY}${command}  ${paint(entry.detail, "graphite")}`;
    })
    .join("\n");
};

export const renderHelpDocument = (
  sections: readonly HelpSection[],
  footer: readonly string[] = [],
): string => {
  const lines = [
    renderWordmark(),
    "",
    renderSectionTitle("Usage"),
    `${BODY}${paint("$", "dim")}  ${paint("dotrelay <command>", "paper")}`,
  ];
  for (const section of sections) {
    lines.push(
      "",
      renderSectionTitle(section.title),
      renderHelpEntries(section.entries),
    );
  }
  if (footer.length > 0) {
    lines.push("", renderSectionTitle("Notes"));
    for (const line of footer) lines.push(`${BODY}${paint(line, "graphite")}`);
  }
  return lines.join("\n");
};

export type LabeledRow = Readonly<{
  readonly label: string;
  readonly value: string;
  readonly tone?: ColorRole;
}>;

export const renderLabeledRows = (rows: readonly LabeledRow[]): string => {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.label.length), 6);
  return rows
    .map((row) => {
      const label = paint(row.label.padEnd(width, " "), "dim");
      const value = paint(row.value, row.tone ?? "graphite");
      return `${BODY}${label}  ${value}`;
    })
    .join("\n");
};

export const renderCard = (
  title: string,
  options: Readonly<{
    readonly tone?: ColorRole;
    readonly mark?: "brand" | "status";
    readonly body?: readonly string[];
    readonly rows?: readonly LabeledRow[];
    readonly hint?: string;
    readonly highlight?: string;
  }> = {},
): string => {
  const tone = options.tone ?? "wax";
  const marker =
    options.mark === "brand" ? paint(MARK.brand, "wax") : markerFor(tone);
  const lines = [
    `${GUTTER}${marker}  ${paint(title, "paper", { bold: true })}`,
  ];
  const body = options.body ?? [];
  if (body.length > 0 || options.highlight || (options.rows?.length ?? 0) > 0)
    lines.push("");
  for (const row of body)
    lines.push(row.length === 0 ? "" : `${BODY}${paint(row, "graphite")}`);
  if (options.highlight) {
    if (body.length > 0) lines.push("");
    lines.push(`${BODY}${paint(options.highlight, "paper", { bold: true })}`);
  }
  if (options.rows && options.rows.length > 0) {
    if (body.length > 0 || options.highlight) lines.push("");
    lines.push(renderLabeledRows(options.rows));
  }
  if (options.hint) {
    lines.push("");
    lines.push(`${BODY}${paint(options.hint, "dim")}`);
  }
  lines.push("");
  return lines.join("\n");
};

export const renderTable = (
  title: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: Readonly<{ readonly empty?: string }> = {},
): string => {
  if (rows.length === 0)
    return renderCard(title, { body: [options.empty ?? "Nothing to show"] });
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row[index] ?? "").length),
      header.length === 0 ? 1 : 4,
    ),
  );
  const format = (cells: readonly string[], role: ColorRole): string =>
    `${BODY}${cells
      .map((cell, index) =>
        paint(padVisible(cell, widths[index] ?? cell.length), role),
      )
      .join("  ")}`;
  return [
    `${GUTTER}${paint(MARK.brand, "wax")}  ${paint(title, "paper", {
      bold: true,
    })}`,
    "",
    format(headers, "dim"),
    ...rows.map((row) => format(row, "graphite")),
    "",
  ].join("\n");
};

export const renderError = (detail: string): string =>
  renderCard("Could not continue", {
    tone: "danger",
    body: [detail],
  });

export const renderStep = (
  title: string,
  body: readonly string[] = [],
  hint?: string,
): string => renderCard(title, { body, hint });

type WritableTty = NodeJS.WritableStream & Partial<{ readonly isTTY: boolean }>;

export const rewriteRegion = (
  output: NodeJS.WritableStream,
  previousLines: number,
  next: string,
): number => {
  const tty = output as WritableTty;
  const text = next.endsWith("\n") ? next : `${next}\n`;
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (tty.isTTY && previousLines > 0) {
    output.write(`\x1b[${previousLines}F`);
    output.write("\x1b[0J");
  } else if (!tty.isTTY && previousLines > 0) output.write("\n");
  output.write(text);
  return lines;
};

type ReadableRaw = NodeJS.ReadableStream &
  Partial<{
    readonly isTTY: boolean;
    setRawMode: (enabled: boolean) => void;
    resume: () => void;
    setEncoding: (encoding: BufferEncoding) => void;
  }>;

export const supportsRawMode = (input: NodeJS.ReadableStream): boolean => {
  const raw = input as ReadableRaw;
  return Boolean(raw.isTTY && typeof raw.setRawMode === "function");
};

const readRawKey = async (input: ReadableRaw): Promise<string> =>
  await new Promise((resolve, reject) => {
    const onData = (chunk: string | Buffer) => {
      cleanup();
      resolve(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("error", onError);
    };
    input.once("data", onData);
    input.once("error", onError);
    input.resume?.();
  });

export type SelectOption = Readonly<{
  readonly id: string;
  readonly label: string;
}>;

const markerColumnWidth = (count: number, interactive: boolean): number =>
  interactive ? MARK.cursor.length : String(count).length + 1;

const renderSelect = (
  title: string,
  options: readonly SelectOption[],
  cursor: number,
  interactive: boolean,
): string => {
  const markerWidth = markerColumnWidth(options.length, interactive);
  const rows = options
    .map((option, index) => {
      const selected = interactive && index === cursor;
      const marker = interactive
        ? selected
          ? paint(MARK.cursor, "wax")
          : " "
        : `${index + 1}.`;
      const label = selected
        ? paint(option.label, "paper", { bold: true })
        : paint(option.label, "graphite");
      return `${BODY}${padVisible(marker, markerWidth)}  ${label}`;
    })
    .join("\n");
  const hint = interactive
    ? "↑/↓ move  ·  enter select"
    : "Enter a number, or press Enter for the first option";
  return [
    `${GUTTER}${paint(MARK.brand, "wax")}  ${paint(title, "paper", {
      bold: true,
    })}`,
    "",
    rows,
    "",
    `${BODY}${paint(hint, "dim")}`,
    "",
  ].join("\n");
};

export const selectOption = async (
  title: string,
  choices: readonly SelectOption[],
  options: Readonly<{
    readonly terminal?: TerminalIo;
    readonly prompt?: (question: string) => Promise<string>;
    readonly noInput?: boolean;
  }> = {},
): Promise<string> => {
  const firstChoice = choices[0];
  if (!firstChoice) throw new CliInvocationError("there is nothing to select");
  if (choices.length === 1) return firstChoice.id;
  if (options.noInput)
    throw new CliInvocationError(`${title} requires an explicit choice`);
  const terminal = options.terminal ?? {
    input: process.stdin,
    output: process.stderr,
  };
  if (!options.prompt && supportsRawMode(terminal.input)) {
    const input = terminal.input as ReadableRaw;
    const output = terminal.output;
    let cursor = 0;
    input.setEncoding?.("utf8");
    input.setRawMode?.(true);
    input.resume?.();
    output.write("\x1b[?25l");
    let rendered = rewriteRegion(
      output,
      0,
      renderSelect(title, choices, cursor, true),
    );
    try {
      for (;;) {
        const key = await readRawKey(input);
        if (key === "\u0003")
          throw new CliInvocationError("selection cancelled");
        if (key === "\r" || key === "\n") {
          const selected = choices[cursor];
          if (!selected)
            throw new CliInvocationError("there is nothing to select");
          return selected.id;
        }
        if (key === "\u001b[A" || key === "k")
          cursor = (cursor - 1 + choices.length) % choices.length;
        else if (key === "\u001b[B" || key === "j")
          cursor = (cursor + 1) % choices.length;
        else continue;
        rendered = rewriteRegion(
          output,
          rendered,
          renderSelect(title, choices, cursor, true),
        );
      }
    } finally {
      output.write("\x1b[?25h");
      input.setRawMode?.(false);
      input.pause?.();
    }
  }
  const output = terminal.output;
  output.write(renderSelect(title, choices, 0, false));
  const line = options.prompt
    ? await options.prompt(title)
    : await readTerminalLine(title, terminal);
  const trimmed = line.trim();
  if (trimmed.length === 0) return firstChoice.id;
  const index = Number.parseInt(trimmed, 10);
  const numbered = choices[index - 1];
  if (
    !Number.isInteger(index) ||
    index < 1 ||
    index > choices.length ||
    !numbered
  )
    throw new CliInvocationError("choose an option from the list");
  return numbered.id;
};

export const confirmAction = async (
  question: string,
  options: Readonly<{
    readonly terminal?: TerminalIo;
    readonly prompt?: (question: string) => Promise<string>;
    readonly confirm?: (question: string) => Promise<boolean>;
    readonly noInput?: boolean;
  }> = {},
): Promise<boolean> => {
  if (options.confirm) return options.confirm(question);
  if (options.noInput)
    throw new CliInvocationError(`${question} requires interactive input`);
  const terminal = options.terminal;
  const answer = options.prompt
    ? await options.prompt(`${question} [y/N]`)
    : await readTerminalLine(`${question} [y/N]`, terminal);
  return (
    answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes"
  );
};

export const writeNotice = (
  output: NodeJS.WritableStream,
  title: string,
  detail?: string,
  tone: ColorRole = "ok",
): void => {
  const line = detail
    ? `${GUTTER}${markerFor(tone)}  ${paint(title, "paper")}  ${paint(
        detail,
        "graphite",
      )}\n`
    : `${GUTTER}${markerFor(tone)}  ${paint(title, "paper")}\n`;
  output.write(line);
};

export { type ReadableRaw, readRawKey };
