import { CliInvocationError, sanitizeCliText } from "./errors";
import { readTerminalLine, type TerminalIo } from "./terminal";
import { bar, markLine, railText } from "./components";
import {
  paint,
  type ReadableRaw,
  readRawKey,
  rewriteRegion,
  supportsRawMode,
} from "./ui";

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

export const ownershipCopy = (
  classification: VariableClassification,
): string => (classification === "shared" ? "Team" : "Only me");

export const createClassificationBoard = (
  names: readonly string[],
  initial: Readonly<Partial<Record<string, VariableClassification>>> = {},
): ClassificationBoardState => {
  if (names.length === 0)
    throw new CliInvocationError("There are no new variables to sort.");
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
  const count = state.drafts.length;
  const title = `${count === 1 ? "1 new variable" : `${count} new variables`} in .env. Who gets each value?`;
  const rows = state.drafts.map((draft, index) => {
    const selected = options.interactive && index === state.cursor;
    const marker = options.interactive
      ? selected
        ? paint("●", "brand")
        : paint("○", "faint")
      : paint(`${index + 1}.`, "muted");
    const name = sanitizeCliText(draft.name).padEnd(width, " ");
    // Both choices sit on the row; the current one is bracketed.
    const choices = (["shared", "user-defined"] as const)
      .map((choice) =>
        choice === draft.classification
          ? paint(`[${ownershipCopy(choice)}]`, selected ? "brand" : "fg")
          : paint(` ${ownershipCopy(choice)} `, "faint"),
      )
      .join(" ");
    return `${bar()}  ${marker} ${selected ? name : paint(name, "muted")}  ${choices}`;
  });
  const hint = options.interactive
    ? "↑↓ move · space switches · enter continues"
    : "Enter a number to switch it, or press Enter to continue";
  return [
    markLine("info", title),
    ...rows,
    railText(
      "Team: teammates get it when they pull. Only me: stays private to you; teammates don't get it.",
      "faint",
    ),
    `${bar()}  ${paint(hint, "ghost")}`,
    "",
  ].join("\n");
};

/** The settled board: one line counting each choice. */
export const renderClassificationSummary = (
  state: ClassificationBoardState,
): string => {
  const team = state.drafts.filter(
    (draft) => draft.classification === "shared",
  ).length;
  const mine = state.drafts.length - team;
  const parts = [
    ...(team > 0 ? [`${team} Team`] : []),
    ...(mine > 0 ? [`${mine} Only me`] : []),
  ];
  return `${markLine("ok", `New variables ${paint(parts.join(", "), "faint")}`)}\n${bar()}\n`;
};

export const applyClassificationAction = (
  state: ClassificationBoardState,
  action: "up" | "down" | "toggle" | "done" | number,
): ClassificationBoardState & Readonly<{ readonly done?: true }> => {
  if (action === "done")
    return Object.freeze({ ...state, done: true as const });
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
    throw new CliInvocationError("Choose one of the variables in the list.");
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

const parseLineAction = (line: string): "done" | number => {
  const trimmed = line.trim().toLowerCase();
  if (
    trimmed === "" ||
    trimmed === "done" ||
    trimmed === "y" ||
    trimmed === "yes"
  )
    return "done";
  const choice = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(choice))
    throw new CliInvocationError(
      "Enter a variable's number, or press Enter to continue.",
    );
  return choice;
};

const keyAction = (
  key: string,
): "up" | "down" | "toggle" | "done" | "ignore" => {
  if (key === "\u0003") throw new CliInvocationError("Cancelled.");
  if (key === "\r" || key === "\n") return "done";
  if (key === " " || key === "\t" || key === "h" || key === "l")
    return "toggle";
  if (key === "\u001b[A" || key === "k") return "up";
  if (key === "\u001b[B" || key === "j") return "down";
  if (key === "\u001b[D" || key === "\u001b[C") return "toggle";
  return "ignore";
};

const runRawClassificationBoard = async (
  names: readonly string[],
  initial: Readonly<Partial<Record<string, VariableClassification>>>,
  terminal: TerminalIo,
): Promise<Readonly<Record<string, VariableClassification>>> => {
  const input = terminal.input as ReadableRaw;
  const output = terminal.output;
  let state = createClassificationBoard(names, initial);
  input.setEncoding?.("utf8");
  input.setRawMode?.(true);
  input.resume?.();
  let rendered = 0;
  try {
    output.write("\x1b[?25l");
    rendered = rewriteRegion(
      output,
      0,
      renderClassificationBoard(state, { interactive: true }),
    );
    for (;;) {
      const action = keyAction(await readRawKey(input));
      if (action === "ignore") continue;
      if (action === "done") {
        state = applyClassificationAction(state, "done");
        rewriteRegion(output, rendered, renderClassificationSummary(state));
        break;
      }
      state = applyClassificationAction(state, action);
      rendered = rewriteRegion(
        output,
        rendered,
        renderClassificationBoard(state, { interactive: true }),
      );
    }
  } finally {
    output.write("\x1b[?25h");
    input.setRawMode?.(false);
    input.pause?.();
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
  if (!options.prompt && supportsRawMode(terminal.input))
    return runRawClassificationBoard(names, initial, terminal);
  return runLineClassificationBoard(names, initial, {
    ...options,
    terminal,
  });
};
