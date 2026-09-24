import { describe, expect, test } from "bun:test";
import { parseArguments } from "./args";
import { CliInvocationError } from "./errors";
import type { WorkflowOptions } from "./workflow-core";
import { rotateProjectEpoch } from "./workflow-epoch-rotation";

const options = {
  noInput: true,
  force: false,
  stdoutIsTerminal: false,
  stateDirectory: "/tmp",
  contextPath: "",
} as WorkflowOptions;

describe("project rotate confirmation", () => {
  test("refuses a non-interactive rotation that was not confirmed", async () => {
    await expect(
      rotateProjectEpoch(
        options,
        parseArguments(["project", "rotate", "--no-input"]),
      ),
    ).rejects.toBeInstanceOf(CliInvocationError);
  });
});
