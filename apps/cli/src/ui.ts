import { CliInvocationError } from "./errors";
import { readTerminalLine, type TerminalIo } from "./terminal";

export type ColorRole = "graphite" | "paper" | "wax" | "dim" | "ok";

const RESET = "\x1b[0m";

const palette: Record<
  ColorRole,
  Readonly<{ readonly truecolor: string; readonly indexed: string }>
> = {
  graphite: { truecolor: "\x1b[38;2;138;134;128m", indexed: "\x1b[38;5;245m" },
  paper: { truecolor: "\x1b[38;2;244;241;236m", indexed: "\x1b[97m" },
  wax: { truecolor: "\x1b[38;2;196;92;74m", indexed: "\x1b[38;5;167m" },
  dim: { truecolor: "\x1b[38;2;92;88;84m", indexed: "\x1b[2m" },
  ok: { truecolor: "\x1b[38;2;111;143;106m", indexed: "\x1b[38;5;107m" },
};

const supportsTruecolor = (): boolean => {
  const term = process.env.COLORTERM ?? "";
  return term.includes("truecolor") || term.includes("24bit");
};

export const paint = (text: string, role: ColorRole): string => {
  if (!process.stderr.isTTY && !process.stdout.isTTY) return text;
  const color = supportsTruecolor()
    ? palette[role].truecolor
    : palette[role].indexed;
  return `${color}${text}${RESET}`;
};

export const renderStep = (
  title: string,
  body: readonly string[] = [],
  hint?: string,
): string => {
  const lines = [`  ${paint("·", "wax")}  ${paint(title, "paper")}`, ""];
  for (const row of body) lines.push(row.length === 0 ? "" : `     ${row}`);
  if (hint) {
    lines.push("");
    lines.push(`     ${paint(hint, "dim")}`);
  }
  lines.push("");
  return lines.join("\n");
};

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

const renderSelect = (
  title: string,
  options: readonly SelectOption[],
  cursor: number,
  interactive: boolean,
  defaultToFirst = true,
): string => {
  const header = `  ${paint("·", "wax")}  ${paint(title, "paper")}\n\n`;
  const rows = options
    .map((option, index) => {
      const marker = interactive
        ? index === cursor
          ? paint("·", "wax")
          : " "
        : `${index + 1}.`;
      const label =
        interactive && index === cursor
          ? paint(option.label, "paper")
          : paint(option.label, "graphite");
      return `     ${marker}  ${label}`;
    })
    .join("\n");
  const hint = interactive
    ? "↑/↓ move · enter select"
    : defaultToFirst
      ? "Enter a number, or press Enter for the first option"
      : "Enter a number";
  return `${header}${rows}\n\n     ${paint(hint, "dim")}\n`;
};

export const selectOption = async (
  title: string,
  choices: readonly SelectOption[],
  options: Readonly<{
    readonly terminal?: TerminalIo;
    readonly prompt?: (question: string) => Promise<string>;
    readonly noInput?: boolean;
    readonly defaultToFirst?: boolean;
  }> = {},
): Promise<string> => {
  if (choices.length === 0)
    throw new CliInvocationError("there is nothing to select");
  if (choices.length === 1) return choices[0]!.id;
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
    // A bare Enter only confirms the highlighted option once the operator
    // has moved the cursor; otherwise it is an empty answer and must not
    // steer the choice to the first item in list order.
    let moved = false;
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
          if (options.defaultToFirst === false && !moved)
            throw new CliInvocationError("choose an option from the list");
          return choices[cursor]!.id;
        }
        if (key === "\u001b[A" || key === "k") {
          moved = true;
          cursor = (cursor - 1 + choices.length) % choices.length;
        } else if (key === "\u001b[B" || key === "j") {
          moved = true;
          cursor = (cursor + 1) % choices.length;
        } else continue;
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
  output.write(renderSelect(title, choices, 0, false, options.defaultToFirst));
  const line = options.prompt
    ? await options.prompt(title)
    : await readTerminalLine(title, terminal);
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    if (options.defaultToFirst === false)
      throw new CliInvocationError("choose an option from the list");
    const first = choices[0];
    if (!first) throw new CliInvocationError("there is nothing to select");
    return first.id;
  }
  const index = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(index) || index < 1 || index > choices.length)
    throw new CliInvocationError("choose an option from the list");
  const chosen = choices[index - 1];
  if (!chosen) throw new CliInvocationError("choose an option from the list");
  return chosen.id;
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
    throw new CliInvocationError(
      "this command requires interactive input; remove --no-input to answer the prompt",
    );
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
    ? `  ${paint("·", tone)}  ${paint(title, "paper")}  ${paint(detail, "graphite")}\n`
    : `  ${paint("·", tone)}  ${paint(title, "paper")}\n`;
  output.write(line);
};

export { type ReadableRaw, readRawKey };
