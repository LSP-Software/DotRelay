import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  confirmResult,
  errorCard,
  kv,
  markLine,
  numberedRow,
  railText,
  selectionRow,
} from "./components";
import { colorLevel, setToneLevel } from "./theme";

const ESC = "\x1b";
const hostile = `Prod${ESC}]0;owned${ESC}\\‮${ESC}[2J\u009b31m`;
const withoutStyling = (text: string): string =>
  text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("rendering primitives", () => {
  let previous: ReturnType<typeof colorLevel>;
  beforeEach(() => {
    previous = colorLevel();
    setToneLevel("256");
  });
  afterEach(() => setToneLevel(previous));

  test("kv sanitizes server-supplied keys and values but keeps its own styling", () => {
    const rendered = kv([
      { key: "Environment", value: hostile, tone: "warn" },
      { key: `Name${ESC}[8m`, value: "line\nbreak" },
      { key: "Missing" },
    ]);
    expect(rendered).toContain(`${ESC}[`);
    const visible = withoutStyling(rendered);
    expect(visible).not.toContain(ESC);
    expect(visible).not.toContain("\u009b");
    expect(visible).not.toContain("‮");
    expect(visible).toContain("Prod]0;owned\\[2J31m");
    expect(visible).toContain("line break");
    expect(visible).toContain("—");
  });

  test("selection and numbered rows sanitize labels and details", () => {
    for (const rendered of [
      selectionRow({ label: hostile, detail: hostile }, true),
      selectionRow({ label: hostile, detail: hostile }, false),
      numberedRow(1, { label: hostile, detail: hostile }),
    ]) {
      expect(rendered).toContain(`${ESC}[`);
      const visible = withoutStyling(rendered);
      expect(visible).not.toContain(ESC);
      expect(visible).not.toContain("‮");
      expect(visible).toContain("Prod]0;owned");
    }
  });
});

describe("the rail", () => {
  let previous: ReturnType<typeof colorLevel>;
  beforeEach(() => {
    previous = colorLevel();
    setToneLevel("off");
  });
  afterEach(() => setToneLevel(previous));

  test("text wraps on the rail at the terminal width", () => {
    const wrapped = railText(
      "Send it from a browser or device you already use, or open it with your recovery code.",
      "muted",
      46,
    );
    for (const line of wrapped.split("\n")) {
      expect(line.startsWith("│  ")).toBe(true);
      expect([...line].length).toBeLessThanOrEqual(46);
    }
  });

  test("a URL longer than the room stays whole so it can be copied", () => {
    const url = "https://api.dotrelay.dev/device?user_code=WDJB-MJHT-LONG-CODE";
    expect(railText(`Open ${url}`, "muted", 40)).toContain(url);
  });

  test("numbered steps wrap under their text", () => {
    const wrapped = railText(
      "2. Install the DotRelay GitHub App and choose this repository.",
      "muted",
      40,
    ).split("\n");
    expect(wrapped[0]).toStartWith("│  2. Install");
    expect(wrapped[1]).toStartWith("│     ");
  });

  test("a step keeps its timing on the right when there is room", () => {
    expect(markLine("ok", "Signed in", "3.8s", 80)).toMatch(
      /^◇ {2}Signed in +3\.8s$/,
    );
    expect(markLine("ok", "Signed in", "3.8s", 46)).toBe("◇  Signed in");
  });

  test("an error ends with the command to run next", () => {
    expect(
      errorCard({
        title: "You're signed out of api.dotrelay.dev",
        detail: "Sign in with GitHub.",
        next: "dotrelay login",
      }),
    ).toBe(
      "■  You're signed out of api.dotrelay.dev\n│  Sign in with GitHub.\n│\n└  next  dotrelay login\n",
    );
  });

  test("a settled confirm keeps the answer on one line", () => {
    expect(confirmResult("Publish? [y/N]", true)).toBe("◇  Publish? Yes\n│");
    expect(
      confirmResult("Sign in with GitHub?", false, ["Sign in", "Not now"]),
    ).toBe("◇  Sign in with GitHub? Not now\n│");
  });
});
