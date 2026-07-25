import { describe, expect, test } from "bun:test";
import { main, renderHelp, version } from "./index";

describe("CLI foundation", () => {
  test("renders help without requiring a runtime dependency", () => {
    expect(main(["--help"])).toBe(renderHelp());
  });

  test("reports its foundation version", () => {
    expect(main(["--version"])).toBe(version);
  });
});
