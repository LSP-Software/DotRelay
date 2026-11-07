import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { kv, numberedRow, selectionRow } from "./components";
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
