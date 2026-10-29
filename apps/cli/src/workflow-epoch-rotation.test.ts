import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryCredentialStore,
  ProtocolTransportError,
} from "@dotrelay/client";
import { createProblem } from "@dotrelay/contracts";
import type { StrictJsonClient } from "./admin";
import { parseArguments } from "./args";
import {
  CliError,
  CliInvocationError,
  diagnosticForError,
  EXIT_CODES,
} from "./errors";
import type { WorkflowOptions } from "./workflow-core";
import {
  planEpochRotation,
  rotateProjectEpoch,
  rotationTransportFailure,
} from "./workflow-epoch-rotation";

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

describe("planEpochRotation", () => {
  const environment = (
    id: string,
    lifecycle: "active" | "archived",
    currentHeadId: string | null,
    currentHeadHash: string | null,
  ) =>
    Object.freeze({
      id,
      projectId: "33333333-3333-4333-8333-333333333333",
      label: id,
      lifecycle,
      currentHeadId,
      currentHeadHash,
    });

  const codeOf = (plan: () => unknown): string | undefined => {
    try {
      plan();
    } catch (error) {
      return error instanceof CliError ? error.code : undefined;
    }
    return undefined;
  };

  test("plans one shared operation across every active environment", () => {
    const targets = planEpochRotation(
      [
        environment(
          "11111111-1111-4111-8111-111111111111",
          "active",
          "10000000-0000-4000-8000-000000000001",
          "11".repeat(48),
        ),
        environment(
          "22222222-2222-4222-8222-222222222222",
          "active",
          "20000000-0000-4000-8000-000000000002",
          "22".repeat(48),
        ),
        environment(
          "33333333-3333-4333-8333-333333333333",
          "archived",
          "30000000-0000-4000-8000-000000000003",
          "33".repeat(48),
        ),
      ],
      "11111111-1111-4111-8111-111111111111",
    );
    // The archived environment is excluded; the two active ones are planned as
    // separate transitions of the single shared operation.
    expect(targets).toEqual([
      {
        environmentId: "11111111-1111-4111-8111-111111111111",
        expectedHeadId: "10000000-0000-4000-8000-000000000001",
        expectedHeadHash: new Uint8Array(48).fill(0x11),
      },
      {
        environmentId: "22222222-2222-4222-8222-222222222222",
        expectedHeadId: "20000000-0000-4000-8000-000000000002",
        expectedHeadHash: new Uint8Array(48).fill(0x22),
      },
    ]);
  });

  test("rejects a rotation that does not start from an active environment", () => {
    expect(
      codeOf(() =>
        planEpochRotation(
          [
            environment(
              "11111111-1111-4111-8111-111111111111",
              "active",
              "10000000-0000-4000-8000-000000000001",
              "11".repeat(48),
            ),
          ],
          "99999999-9999-4999-8999-999999999999",
        ),
      ),
    ).toBe("epoch_rotation_unsupported");
  });

  test("rejects a project with no active environment", () => {
    expect(
      codeOf(() =>
        planEpochRotation(
          [
            environment(
              "11111111-1111-4111-8111-111111111111",
              "archived",
              "10000000-0000-4000-8000-000000000001",
              "11".repeat(48),
            ),
          ],
          "11111111-1111-4111-8111-111111111111",
        ),
      ),
    ).toBe("epoch_rotation_unsupported");
  });

  test("rejects a rotation while an active environment has no revision", () => {
    expect(
      codeOf(() =>
        planEpochRotation(
          [
            environment(
              "11111111-1111-4111-8111-111111111111",
              "active",
              "10000000-0000-4000-8000-000000000001",
              "11".repeat(48),
            ),
            environment(
              "22222222-2222-4222-8222-222222222222",
              "active",
              null,
              null,
            ),
          ],
          "11111111-1111-4111-8111-111111111111",
        ),
      ),
    ).toBe("environment_empty");
  });
});

describe("rotationTransportFailure", () => {
  test("maps membership_not_active to a conflict (exit 4) with membership guidance", () => {
    const error = rotationTransportFailure(
      new ProtocolTransportError(createProblem("membership_not_active")),
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error.category).toBe("conflict");
    expect(error.code).toBe("membership_not_active");
    const diagnostic = diagnosticForError(error);
    expect(diagnostic.code).toBe("membership_not_active");
    expect(diagnostic.exitCode).toBe(EXIT_CODES.conflict);
    expect(diagnostic.detail).toContain(
      "Membership in this Team is not active",
    );
  });

  test("keeps the stale_epoch guidance and conflict category", () => {
    const error = rotationTransportFailure(
      new ProtocolTransportError(createProblem("stale_epoch")),
    );
    expect(error.category).toBe("conflict");
    expect(error.code).toBe("stale_epoch");
    expect(error.message).toContain(
      "the project epoch changed before this rotation landed",
    );
    expect(diagnosticForError(error).exitCode).toBe(EXIT_CODES.conflict);
  });

  test("classifies an unstructured transport failure as a transient service error", () => {
    const error = rotationTransportFailure(new Error("socket closed"));
    expect(error.category).toBe("transient");
    expect(error.code).toBe("service_unavailable");
    expect(diagnosticForError(error).exitCode).toBe(EXIT_CODES.transient);
  });
});
