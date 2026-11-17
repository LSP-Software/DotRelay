import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createClassificationBoard,
  renderClassificationBoard,
} from "./classify-ui";
import { CliInvocationError } from "./errors";
import type { TerminalIo } from "./terminal";
import { colorLevel, setToneLevel } from "./theme";
import {
  confirmAction,
  readTerminalSecret,
  rewriteRegion,
  selectOption,
} from "./ui";

describe("CLI region rewrite", () => {
  test("never uses a full-screen clear", () => {
    const board = renderClassificationBoard(createClassificationBoard(["A"]));
    expect(board).not.toContain("\x1b[2J");
    expect(board).not.toContain("\x1b[H");
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: string | Buffer) => {
      written += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    rewriteRegion(output, 4, "next line\n");
    expect(written).not.toContain("\x1b[2J");
    expect(written).not.toContain("\x1b[H");
  });

  test("counts a line wider than the terminal as the rows it wraps onto", () => {
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 20,
    });
    let written = "";
    output.on("data", (chunk: string | Buffer) => {
      written += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    // 45 visible characters on a 20-column terminal take 3 rows.
    const rows = rewriteRegion(output, 0, `${"x".repeat(45)}\nshort`);
    expect(rows).toBe(4);
    rewriteRegion(output, rows, "next");
    expect(written).toContain("\x1b[4F");
  });
});

const selectTerminal = () => ({
  input: new PassThrough(),
  output: new PassThrough(),
});

describe("selectOption line input", () => {
  const choices = [
    { id: "a", label: "development" },
    { id: "b", label: "production" },
  ];

  test("defaults to the first option when Enter is pressed", async () => {
    const id = await selectOption("Environment", choices, {
      terminal: selectTerminal(),
      prompt: async () => "",
    });
    expect(id).toBe("a");
  });

  test("rejects an empty reply when defaultToFirst is false", async () => {
    await expect(
      selectOption("Environment", choices, {
        terminal: selectTerminal(),
        prompt: async () => "",
        defaultToFirst: false,
      }),
    ).rejects.toThrow(
      new CliInvocationError("Choose one of the options in the list."),
    );
  });

  test("accepts an explicit number when defaultToFirst is false", async () => {
    const id = await selectOption("Environment", choices, {
      terminal: selectTerminal(),
      prompt: async () => "2",
      defaultToFirst: false,
    });
    expect(id).toBe("b");
  });

  test("still rejects out-of-range numbers", async () => {
    await expect(
      selectOption("Environment", choices, {
        terminal: selectTerminal(),
        prompt: async () => "3",
      }),
    ).rejects.toThrow(
      new CliInvocationError("Choose one of the options in the list."),
    );
  });

  test("reports an unreadable terminal with a remedy on closed stdin", async () => {
    const terminal = selectTerminal();
    terminal.input.end();
    const error = await selectOption("Environment", choices, {
      terminal,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CliInvocationError);
    expect(String((error as Error).message)).toContain(
      "Couldn't read an answer from the terminal",
    );
    expect(String((error as Error).message)).toContain("--no-input");
  });
});

const rawSelectTerminal = () => {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  return {
    terminal: { input, output: new PassThrough() } as unknown as TerminalIo,
    input,
  };
};

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("selectOption raw TTY", () => {
  const choices = [
    { id: "a", label: "development" },
    { id: "b", label: "production" },
  ];

  test("rejects a bare Enter when defaultToFirst is false", async () => {
    const { terminal, input } = rawSelectTerminal();
    const pending = selectOption("Environment", choices, {
      terminal,
      defaultToFirst: false,
    });
    input.write("\r");
    input.end();
    await expect(pending).rejects.toThrow(
      new CliInvocationError("Choose one of the options in the list."),
    );
  });

  test("confirms the highlighted option after the cursor moves", async () => {
    const { terminal, input } = rawSelectTerminal();
    const pending = selectOption("Environment", choices, {
      terminal,
      defaultToFirst: false,
    });
    input.write("\u001b[B");
    await tick();
    input.write("\r");
    input.end();
    expect(await pending).toBe("b");
  });

  test("still defaults to the first option when defaultToFirst is not disabled", async () => {
    const { terminal, input } = rawSelectTerminal();
    const pending = selectOption("Environment", choices, { terminal });
    input.write("\r");
    input.end();
    expect(await pending).toBe("a");
  });
});

describe("confirmAction line input", () => {
  test("only y or yes approves", async () => {
    const answer = async (line: string) =>
      await confirmAction("Publish?", {
        terminal: selectTerminal(),
        prompt: async () => line,
      });
    expect(await answer("")).toBe(false);
    expect(await answer("n")).toBe(false);
    expect(await answer("no")).toBe(false);
    expect(await answer("y")).toBe(true);
    expect(await answer("YES")).toBe(true);
  });

  test("a non-silent prompt is shown with the typed-answer hint", async () => {
    const seen: string[] = [];
    const result = await confirmAction("Publish?", {
      terminal: selectTerminal(),
      prompt: async (question) => {
        seen.push(question);
        return "n";
      },
    });
    expect(result).toBe(false);
    expect(seen).toEqual(["Publish? [y/N]"]);
  });

  test("a silent prompt receives the already-printed question", async () => {
    const seen: string[] = [];
    const result = await confirmAction("Publish? [y/N]", {
      terminal: selectTerminal(),
      prompt: async (question) => {
        seen.push(question);
        return "y";
      },
      silent: true,
    });
    expect(result).toBe(true);
    expect(seen).toEqual(["Publish? [y/N]"]);
  });
});

const rawConfirmTerminal = () => {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: string | Buffer) => {
    written += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  return {
    terminal: { input, output } as unknown as TerminalIo,
    input,
    outputText: async (): Promise<string> => {
      await tick();
      return written;
    },
  };
};

describe("confirmAction raw TTY", () => {
  // These assert rendered text, so colour must not split it into spans
  // when the suite runs in a colour terminal.
  let tone: ReturnType<typeof colorLevel>;
  beforeEach(() => {
    tone = colorLevel();
    setToneLevel("off");
  });
  afterEach(() => setToneLevel(tone));
  test("a bare Enter confirms the default No choice", async () => {
    const { terminal, input } = rawConfirmTerminal();
    const pending = confirmAction("Publish?", { terminal });
    input.write("\r");
    input.end();
    expect(await pending).toBe(false);
  });

  test("a bare Enter confirms the default Yes choice when it is the default", async () => {
    const { terminal, input } = rawConfirmTerminal();
    const pending = confirmAction("Trust this Server Profile?", {
      terminal,
      default: "yes",
    });
    input.write("\r");
    input.end();
    expect(await pending).toBe(true);
  });

  test("Enter confirms the highlighted choice after the cursor moves", async () => {
    const { terminal, input } = rawConfirmTerminal();
    const pending = confirmAction("Publish?", { terminal });
    input.write("\u001b[B");
    await tick();
    input.write("\r");
    input.end();
    expect(await pending).toBe(true);
  });

  test("y and n answer directly", async () => {
    const first = rawConfirmTerminal();
    const pending = confirmAction("Publish?", { terminal: first.terminal });
    first.input.write("y");
    first.input.end();
    expect(await pending).toBe(true);
    const second = rawConfirmTerminal();
    const again = confirmAction("Publish?", { terminal: second.terminal });
    second.input.write("n");
    second.input.end();
    expect(await again).toBe(false);
  });

  test("Esc declines", async () => {
    const { terminal, input } = rawConfirmTerminal();
    const pending = confirmAction("Publish?", { terminal });
    input.write("\u001b");
    input.end();
    expect(await pending).toBe(false);
  });

  test("Ctrl+C cancels the confirmation", async () => {
    const { terminal, input } = rawConfirmTerminal();
    const pending = confirmAction("Publish?", { terminal });
    input.write("\u0003");
    input.end();
    await expect(pending).rejects.toThrow(new CliInvocationError("Cancelled."));
  });

  test("renders the boxed choices and leaves a decision record", async () => {
    const { terminal, input, outputText } = rawConfirmTerminal();
    const pending = confirmAction("Publish?", { terminal });
    input.write("\u001b[B");
    await tick();
    input.write("\r");
    input.end();
    await pending;
    const shown = await outputText();
    expect(shown).toContain("Publish?");
    expect(shown).toContain("Yes");
    expect(shown).toContain("No");
    expect(shown).toContain("←→ enter · y/n");
    expect(shown).toContain("◇  Publish? Yes");
    expect(shown).not.toContain("\x1b[2J");
    expect(shown).not.toContain("\x1b[H");
  });
});

const rawSecretTerminal = () => {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: string | Buffer) => {
    written += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  return {
    terminal: { input, output } as unknown as TerminalIo,
    input,
    outputText: async (): Promise<string> => {
      await tick();
      return written;
    },
  };
};

describe("readTerminalSecret raw TTY", () => {
  // These assert rendered text, so colour must not split it into spans
  // when the suite runs in a colour terminal.
  let tone: ReturnType<typeof colorLevel>;
  beforeEach(() => {
    tone = colorLevel();
    setToneLevel("off");
  });
  afterEach(() => setToneLevel(tone));
  test("returns the typed secret and masks the input", async () => {
    const { terminal, input, outputText } = rawSecretTerminal();
    const pending = readTerminalSecret("Recovery Code", { terminal });
    input.write("K4ET-P7Q");
    await tick();
    input.write("\r");
    input.end();
    expect(await pending).toBe("K4ET-P7Q");
    const shown = await outputText();
    expect(shown).toContain("◆  Recovery Code");
    expect(shown).toContain("········");
    expect(shown).not.toContain("K4ET-P7Q");
  });

  test("Backspace removes the last character", async () => {
    const { terminal, input } = rawSecretTerminal();
    const pending = readTerminalSecret("Recovery Code", { terminal });
    input.write("ABC\u007f");
    await tick();
    input.write("\r");
    input.end();
    expect(await pending).toBe("AB");
  });

  test("keeps non-ASCII characters and drops control characters", async () => {
    const { terminal, input } = rawSecretTerminal();
    const pending = readTerminalSecret("Recovery Code", { terminal });
    input.write("pässwörd😀\u0001\u0085x😀\u007f");
    await tick();
    input.write("\r");
    input.end();
    expect(await pending).toBe("pässwörd😀x");
  });

  test("an empty secret is rejected", async () => {
    const { terminal, input } = rawSecretTerminal();
    const pending = readTerminalSecret("Recovery Code", { terminal });
    input.write("\r");
    input.end();
    await expect(pending).rejects.toThrow("can't be empty");
  });

  test("Esc cancels the prompt", async () => {
    const { terminal, input } = rawSecretTerminal();
    const pending = readTerminalSecret("Recovery Code", { terminal });
    input.write("\u001b");
    input.end();
    await expect(pending).rejects.toThrow(new CliInvocationError("Cancelled."));
  });

  test("Ctrl+C cancels the prompt", async () => {
    const { terminal, input } = rawSecretTerminal();
    const pending = readTerminalSecret("Recovery Code", { terminal });
    input.write("\u0003");
    input.end();
    await expect(pending).rejects.toThrow(new CliInvocationError("Cancelled."));
  });
});

describe("readTerminalSecret non-interactive channels", () => {
  test("a non-TTY stdin line is read with an echo warning", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: string | Buffer) => {
      written += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    const pending = readTerminalSecret("Recovery Code", {
      terminal: { input, output } as unknown as TerminalIo,
    });
    input.write("K4ET-P7QN\n");
    input.end();
    expect(await pending).toBe("K4ET-P7QN");
    expect(written).toContain("stdin isn't a terminal");
  });

  test("an embedding prompt callback supplies the secret", async () => {
    const answer = await readTerminalSecret("Recovery Code", {
      prompt: async () => "K4ET-P7QN",
    });
    expect(answer).toBe("K4ET-P7QN");
  });

  test("--no-input refuses to read a secret from the terminal", async () => {
    await expect(
      readTerminalSecret("Recovery Code", {
        terminal: selectTerminal(),
        noInput: true,
      }),
    ).rejects.toThrow(
      new CliInvocationError(
        "--no-input can't ask for a secret. Pass it in a file with the command's --*-file flag, or pipe it to stdin.",
      ),
    );
  });
});
