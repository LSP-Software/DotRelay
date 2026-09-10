import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createClassificationBoard,
  renderClassificationBoard,
} from "./classify-ui";
import { CliInvocationError } from "./errors";
import { rewriteRegion, selectOption } from "./ui";

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
    ).rejects.toThrow(new CliInvocationError("choose an option from the list"));
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
    ).rejects.toThrow(new CliInvocationError("choose an option from the list"));
  });
});
