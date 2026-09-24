import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryCredentialStore } from "@dotrelay/client";
import type { StrictJsonClient } from "./admin";
import { parseArguments } from "./args";
import { CliError, CliInvocationError } from "./errors";
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

  test("reports a missing login before asking for confirmation", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "rotate-precheck-"));
    try {
      let confirmations = 0;
      const admin: StrictJsonClient = {
        get: async () => {
          throw new CliError(
            "authentication",
            "login is required for this Server Profile",
            {},
            "authentication_required",
          );
        },
        post: async () => ({}),
      };
      const error = await rotateProjectEpoch(
        {
          profile: {
            name: "relay",
            origin: "https://relay.example",
            pin: {
              origin: "https://relay.example",
              serverProfileId: "11111111-1111-4111-8111-111111111111",
            },
          },
          credentials: createMemoryCredentialStore(),
          stateDirectory,
          contextPath: join(stateDirectory, "missing-context.json"),
          confirm: async () => {
            confirmations += 1;
            return true;
          },
          noInput: false,
          force: false,
          stdoutIsTerminal: false,
          admin,
        },
        parseArguments(["project", "rotate"]),
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("authentication_required");
      expect(confirmations).toBe(0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
