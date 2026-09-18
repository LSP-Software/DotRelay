import {
  numberedHint,
  numberedRow,
  selectionHint,
  selectionRow,
  selectionTitle,
} from "./components";
import { CliInvocationError } from "./errors";
import { readTerminalLine, type TerminalIo } from "./terminal";

export {
  bold,
  paint,
  type Tone,
  terminalWidth,
  truncate,
  visibleWidth,
} from "./theme";

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
  readonly detail?: string | undefined;
}>;

const renderSelect = (
  title: string,
  options: readonly SelectOption[],
  cursor: number,
  interactive: boolean,
  defaultToFirst = true,
): string => {
  const rows = options
    .map((option, index) =>
      interactive
        ? selectionRow(
            { label: option.label, detail: option.detail },
            index === cursor,
          )
        : numberedRow(index + 1, {
            label: option.label,
            detail: option.detail,
          }),
    )
    .join("\n");
  const hint = interactive ? selectionHint(true) : numberedHint(defaultToFirst);
  return `${selectionTitle(title)}\n\n${rows}\n\n${hint}\n`;
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
  if (choices.length === 1) {
    const only = choices[0];
    if (!only) throw new CliInvocationError("there is nothing to select");
    return only.id;
  }
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
          const chosen = choices[cursor];
          if (!chosen)
            throw new CliInvocationError("choose an option from the list");
          return chosen.id;
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

export type { TerminalIo } from "./terminal";
export type { ReadableRaw };
export { readRawKey };
