import { CliInvocationError, sanitizeCliText } from "./errors";
import { type TerminalIo, readTerminalLine } from "./terminal";

export type VariableClassification = "shared" | "user-defined";

export type ClassificationDraft = Readonly<{
  readonly name: string;
  readonly classification: VariableClassification;
}>;

export type ClassificationBoardState = Readonly<{
  readonly drafts: readonly ClassificationDraft[];
  readonly cursor: number;
}>;

export const toggleClassification = (
  classification: VariableClassification,
): VariableClassification =>
  classification === "shared" ? "user-defined" : "shared";

export const createClassificationBoard = (
  names: readonly string[],
  initial: Readonly<Partial<Record<string, VariableClassification>>> = {},
): ClassificationBoardState => {
  if (names.length === 0)
    throw new CliInvocationError("there are no Variables to classify");
  return Object.freeze({
    drafts: Object.freeze(
      names.map((name) =>
        Object.freeze({
          name,
          classification: initial[name] ?? "shared",
        }),
      ),
    ),
    cursor: 0,
  });
};

const labelWidth = (drafts: readonly ClassificationDraft[]): number =>
  Math.max(...drafts.map((draft) => draft.name.length), 8);

export const renderClassificationBoard = (
  state: ClassificationBoardState,
  options: Readonly<{ readonly interactive: boolean }> = {
    interactive: true,
  },
): string => {
  const width = labelWidth(state.drafts);
  const rows = state.drafts.map((draft, index) => {
    const marker = options.interactive
      ? index === state.cursor
        ? ">"
        : " "
      : `${index + 1}.`;
    const name = sanitizeCliText(draft.name).padEnd(width, " ");
    const shared =
      draft.classification === "shared" ? "[shared]" : " shared ";
    const userDefined =
      draft.classification === "user-defined"
        ? "[user-defined]"
        : " user-defined ";
    return `${marker} ${name}  ${shared}  ${userDefined}`;
  });
  return [
    "Classify Variables",
    "",
    ...rows,
    "",
    options.interactive
      ? "↑/↓ move · space toggle · enter continue"
      : "Enter a number to toggle, or press Enter to continue",
    "",
  ].join("\n");
};

export const applyClassificationAction = (
  state: ClassificationBoardState,
  action: "up" | "down" | "toggle" | "done" | number,
): ClassificationBoardState & Readonly<{ readonly done?: true }> => {
  if (action === "done") return Object.freeze({ ...state, done: true as const });
  if (action === "up")
    return Object.freeze({
      ...state,
      cursor: (state.cursor - 1 + state.drafts.length) % state.drafts.length,
    });
  if (action === "down")
    return Object.freeze({
      ...state,
      cursor: (state.cursor + 1) % state.drafts.length,
    });
  const index = action === "toggle" ? state.cursor : action - 1;
  if (!Number.isInteger(index) || index < 0 || index >= state.drafts.length)
    throw new CliInvocationError("choose a Variable from the list");
  return Object.freeze({
    drafts: Object.freeze(
      state.drafts.map((draft, draftIndex) =>
        draftIndex === index
          ? Object.freeze({
              ...draft,
              classification: toggleClassification(draft.classification),
            })
          : draft,
      ),
    ),
    cursor: index,
  });
};

const parseLineAction = (
  line: string,
): "done" | number => {
  const trimmed = line.trim().toLowerCase();
  if (trimmed === "" || trimmed === "done" || trimmed === "y" || trimmed === "yes")
    return "done";
  const choice = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(choice))
    throw new CliInvocationError("enter a Variable number or press Enter");
  return choice;
};

type ReadableWithRawMode = NodeJS.ReadableStream &
  Partial<{
    readonly isTTY: boolean;
    setRawMode: (enabled: boolean) => void;
    resume: () => void;
    pause: () => void;
    setEncoding: (encoding: BufferEncoding) => void;
  }>;

type WritableWithClear = NodeJS.WritableStream &
  Partial<{
    readonly isTTY: boolean;
  }>;

const supportsRawMode = (input: ReadableWithRawMode): boolean =>
  Boolean(input.isTTY && typeof input.setRawMode === "function");

const readRawKey = async (
  input: ReadableWithRawMode,
): Promise<string> =>
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

const keyAction = (
  key: string,
): "up" | "down" | "toggle" | "done" | "ignore" => {
  if (key === "\u0003") throw new CliInvocationError("classification cancelled");
  if (key === "\r" || key === "\n") return "done";
  if (key === " " || key === "\t" || key === "h" || key === "l") return "toggle";
  if (key === "\u001b[A" || key === "k") return "up";
  if (key === "\u001b[B" || key === "j") return "down";
  if (key === "\u001b[D" || key === "\u001b[C") return "toggle";
  return "ignore";
};

const rewriteBoard = (
  output: WritableWithClear,
  previousLines: number,
  board: string,
): number => {
  const lines = board.split("\n").length;
  if (output.isTTY) output.write("\x1b[H\x1b[2J");
  else if (previousLines > 0) output.write("\n");
  output.write(board);
  return lines;
};

const runRawClassificationBoard = async (
  names: readonly string[],
  initial: Readonly<Partial<Record<string, VariableClassification>>>,
  terminal: TerminalIo,
): Promise<Readonly<Record<string, VariableClassification>>> => {
  const input = terminal.input as ReadableWithRawMode;
  const output = terminal.output as WritableWithClear;
  let state = createClassificationBoard(names, initial);
  input.setEncoding?.("utf8");
  input.setRawMode?.(true);
  input.resume?.();
  let rendered = 0;
  try {
    output.write("\x1b[?25l");
    rendered = rewriteBoard(
      output,
      0,
      renderClassificationBoard(state, { interactive: true }),
    );
    for (;;) {
      const action = keyAction(await readRawKey(input));
      if (action === "ignore") continue;
      const next = applyClassificationAction(state, action);
      state = next;
      rendered = rewriteBoard(
        output,
        rendered,
        renderClassificationBoard(state, { interactive: true }),
      );
      if ("done" in next && next.done) break;
    }
  } finally {
    output.write("\x1b[?25h");
    input.setRawMode?.(false);
  }
  return Object.freeze(
    Object.fromEntries(
      state.drafts.map((draft) => [draft.name, draft.classification]),
    ),
  );
};

const runLineClassificationBoard = async (
  names: readonly string[],
  initial: Readonly<Partial<Record<string, VariableClassification>>>,
  options: Readonly<{
    readonly terminal?: TerminalIo;
    readonly prompt?: (question: string) => Promise<string>;
  }>,
): Promise<Readonly<Record<string, VariableClassification>>> => {
  let state = createClassificationBoard(names, initial);
  const output = options.terminal?.output ?? process.stderr;
  for (;;) {
    output.write(`${renderClassificationBoard(state, { interactive: false })}`);
    const line = options.prompt
      ? await options.prompt("Toggle")
      : await readTerminalLine("Toggle", options.terminal);
    const action = parseLineAction(line);
    const next = applyClassificationAction(state, action);
    state = next;
    if ("done" in next && next.done) break;
  }
  return Object.freeze(
    Object.fromEntries(
      state.drafts.map((draft) => [draft.name, draft.classification]),
    ),
  );
};

export const classifyVariablesInteractively = async (
  names: readonly string[],
  initial: Readonly<Partial<Record<string, VariableClassification>>> = {},
  options: Readonly<{
    readonly terminal?: TerminalIo;
    readonly prompt?: (question: string) => Promise<string>;
  }> = {},
): Promise<Readonly<Record<string, VariableClassification>>> => {
  const terminal = options.terminal ?? {
    input: process.stdin,
    output: process.stderr,
  };
  if (!options.prompt && supportsRawMode(terminal.input as ReadableWithRawMode))
    return runRawClassificationBoard(names, initial, terminal);
  return runLineClassificationBoard(names, initial, {
    ...options,
    terminal,
  });
};
