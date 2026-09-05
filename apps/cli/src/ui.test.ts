import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createClassificationBoard,
  renderClassificationBoard,
} from "./classify-ui";
import {
  PRODUCT_WORDMARK,
  renderCard,
  renderError,
  renderHelpDocument,
  rewriteRegion,
} from "./ui";

describe("CLI region rewrite", () => {
  test("never uses a full-screen clear", () => {
    const board = renderClassificationBoard(createClassificationBoard(["A"]));
    expect(board).not.toContain("\x1b[2J");
    expect(board).not.toContain("\x1b[H");
    const output = new PassThrough();
    let written = "";
    output.write = (chunk: string | Uint8Array) => {
      written += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      return true;
    };
    rewriteRegion(output, 4, "next line\n");
    expect(written).not.toContain("\x1b[2J");
    expect(written).not.toContain("\x1b[H");
  });
});

describe("CLI presentation", () => {
  test("help keeps the product wordmark and aligned command columns", () => {
    const help = renderHelpDocument([
      {
        title: "Everyday",
        entries: [
          { command: "status", detail: "Show this machine's connection" },
          { command: "setup <origin>", detail: "Trust this Server Profile" },
        ],
      },
    ]);
    expect(help).toContain(PRODUCT_WORDMARK);
    expect(help).toContain("setup <origin>");
    expect(help).toContain("Show this machine's connection");
    expect(help).not.toContain("\x1b[2J");
  });

  test("cards and errors keep Values out of the chrome", () => {
    const card = renderCard("Published", {
      tone: "ok",
      body: ["3 encrypted lanes"],
    });
    expect(card).toContain("Published");
    expect(card).toContain("3 encrypted lanes");
    const error = renderError("unknown command: boom");
    expect(error).toContain("Could not continue");
    expect(error).toContain("unknown command: boom");
  });
});
