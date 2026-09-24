import {
  confirmBox,
  confirmHint,
  confirmResult,
  confirmRows,
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

// Fixed diagnostic for an interactive prompt that cannot be read (closed
// stdin, no TTY). The question itself is never echoed: it may carry
// revealed Values, so only this fixed message - including the automation
// remedy - may surface through the diagnostic.
export const UNREADABLE_TERMINAL_MESSAGE =
  "the terminal could not be read, so the interactive prompt went unanswered; run in an interactive terminal, or re-run with --no-input";

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
  // A closed stdin rejects inside readTerminalLine with a plain Error that
  // would otherwise be masked as an opaque unexpected_failure: map it to
  // the fixed unreadable-terminal diagnostic instead.
  let line: string;
  if (options.prompt) {
    line = await options.prompt(title);
  } else {
    try {
      line = await readTerminalLine(title, terminal);
    } catch {
      throw new CliInvocationError(UNREADABLE_TERMINAL_MESSAGE);
    }
  }
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

export const parseConfirmAnswer = (answer: string): boolean => {
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
};

const renderConfirm = (
  question: string,
  silent: boolean,
  cursor: number,
): string =>
  silent
    ? `${confirmRows(cursor)}\n${confirmHint()}`
    : confirmBox(question, cursor);

const runRawConfirm = async (
  question: string,
  terminal: TerminalIo,
  options: Readonly<{
    readonly silent?: boolean;
    readonly default?: "yes" | "no";
  }> = {},
): Promise<boolean> => {
  const input = terminal.input as ReadableRaw;
  const output = terminal.output;
  const silent = options.silent ?? false;
  let cursor = options.default === "yes" ? 0 : 1;
  input.setEncoding?.("utf8");
  input.setRawMode?.(true);
  input.resume?.();
  output.write("\x1b[?25l");
  let rendered = rewriteRegion(
    output,
    0,
    renderConfirm(question, silent, cursor),
  );
  try {
    for (;;) {
      const key = await readRawKey(input);
      if (key === "\u0003")
        throw new CliInvocationError("confirmation cancelled");
      const single = key.length === 1 ? key.toLowerCase() : key;
      let decided: boolean | null = null;
      if (single === "y") decided = true;
      else if (single === "n") decided = false;
      else if (key === "\u001b") decided = false;
      else if (key === "\r" || key === "\n") decided = cursor === 0;
      else if (
        key === "\u001b[A" ||
        key === "\u001b[B" ||
        key === "j" ||
        key === "k"
      )
        cursor = 1 - cursor;
      if (decided !== null) {
        rewriteRegion(output, rendered, confirmResult(question, decided));
        return decided;
      }
      rendered = rewriteRegion(
        output,
        rendered,
        renderConfirm(question, silent, cursor),
      );
    }
  } finally {
    output.write("\x1b[?25h");
    input.setRawMode?.(false);
    input.pause?.();
  }
};

export const confirmAction = async (
  question: string,
  options: Readonly<{
    readonly terminal?: TerminalIo;
    readonly prompt?: (question: string) => Promise<string>;
    readonly confirm?: (question: string) => Promise<boolean>;
    readonly noInput?: boolean;
    /** The question is already printed, for example inside a review frame. */
    readonly silent?: boolean;
    /** The choice a bare Enter approves; defaults to "no". */
    readonly default?: "yes" | "no";
  }> = {},
): Promise<boolean> => {
  if (options.confirm) return options.confirm(question);
  if (options.noInput)
    throw new CliInvocationError(
      "this command requires interactive input; remove --no-input to answer the prompt",
    );
  const terminal = options.terminal ?? {
    input: process.stdin,
    output: process.stderr,
  };
  if (options.prompt)
    return parseConfirmAnswer(
      await options.prompt(options.silent ? question : `${question} [y/N]`),
    );
  if (supportsRawMode(terminal.input))
    return runRawConfirm(question, terminal, options);
  const answer = await readTerminalLine(
    options.silent ? question : `${question} [y/N]`,
    terminal,
    !options.silent,
  );
  return parseConfirmAnswer(answer);
};
// Reads a secret from the terminal without echoing it. On a raw-mode TTY the
// input is masked with dots; on a non-TTY stream one line is read from stdin
// and a warning is printed because the shell may echo the value. An embedding
// `prompt` callback supplies the secret directly.
export const readTerminalSecret = async (
  question: string,
  options: Readonly<{
    readonly terminal?: TerminalIo;
    readonly prompt?: (question: string) => Promise<string>;
    readonly noInput?: boolean;
  }> = {},
): Promise<string> => {
  const { terminal } = options;
  if (options.prompt) return options.prompt(question);
  if (options.noInput)
    throw new CliInvocationError(
      "--no-input does not read secrets from the terminal; pass the value with a --*-file flag or pipe it to stdin",
    );
  const input = (terminal?.input ?? process.stdin) as ReadableRaw;
  const output = terminal?.output ?? process.stderr;
  if (supportsRawMode(input)) {
    input.setEncoding?.("utf8");
    input.setRawMode?.(true);
    input.resume?.();
    const written = rewriteRegion(output, 0, `${question}:`);
    let buffer = "";
    const render = (masked: string) =>
      rewriteRegion(
        output,
        written,
        buffer ? `${question}: ${masked}` : `${question}:`,
      );
    try {
      for (;;) {
        const key = await readRawKey(input);
        if (key === "\u0003" || key === "\u001b")
          throw new CliInvocationError("secret input cancelled");
        if (key.startsWith("\u001b")) continue;
        for (const ch of key) {
          if (ch === "\r" || ch === "\n") {
            if (buffer.length === 0)
              throw new CliInvocationError(`${question} must not be empty`);
            return buffer;
          }
          if (ch === "\u0008" || ch === "\u007f") {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              render("·".repeat(buffer.length));
            }
            continue;
          }
          if (ch >= " " && ch <= "~") {
            buffer += ch;
            render("·".repeat(buffer.length));
          }
        }
      }
    } finally {
      rewriteRegion(output, written, `${question}:`);
      output.write("\x1b[0J\n");
      input.setRawMode?.(false);
      input.pause?.();
    }
  }
  output.write(
    "warning: stdin is not a terminal, so the secret may be echoed or logged by the calling process\n",
  );
  return (await readTerminalLine(question, terminal)).trim();
};

export type { TerminalIo } from "./terminal";
export type { ReadableRaw };
export { readRawKey };
