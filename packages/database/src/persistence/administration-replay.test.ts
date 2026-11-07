import { describe, expect, test } from "bun:test";
import {
  AdministrationRepository,
  MembershipAdministrationRepository,
} from "./administration-repository";
import { ProjectNotActiveError } from "./repository-core";
import { sha384Digest } from "./validation";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const DEVICE_ID = "10000000-0000-4000-8000-000000000002";
const TEAM_ID = "10000000-0000-4000-8000-000000000003";
const PROJECT_ID = "10000000-0000-4000-8000-000000000004";
const ENVIRONMENT_ID = "10000000-0000-4000-8000-000000000005";
const MEMBERSHIP_ID = "10000000-0000-4000-8000-000000000006";
const OPERATION_ID = "10000000-0000-4000-8000-000000000007";

const commandBytes = new Uint8Array([0xa0]);

const operationInput = async () => ({
  id: OPERATION_ID,
  actorUserId: USER_ID,
  actorDeviceId: DEVICE_ID,
  kind: "ADMINISTRATION" as const,
  commandBytes,
  commandDigest: await sha384Digest(commandBytes),
});

// A transaction double in the state left behind by an already committed
// lifecycle command: the entity is in its new lifecycle and the operation row
// for the same Idempotency-Key is COMMITTED.
const committedState = async (
  status: "COMMITTED" | "STAGED",
  lifecycle: "ACTIVE" | "ARCHIVED" | "REMOVED",
) => {
  const writes: string[] = [];
  const operation = {
    id: OPERATION_ID,
    actorUserId: USER_ID,
    actorDeviceId: DEVICE_ID,
    kind: "ADMINISTRATION",
    status,
    commandDigest: await sha384Digest(commandBytes),
  };
  const transaction = {
    $executeRaw: async () => 1,
    project: {
      findUnique: async () => ({
        id: PROJECT_ID,
        teamId: TEAM_ID,
        lifecycle,
      }),
      update: async () => {
        writes.push("project");
        return {};
      },
    },
    environment: {
      findUnique: async () => ({
        id: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        lifecycle,
        project: { id: PROJECT_ID, teamId: TEAM_ID, lifecycle: "ACTIVE" },
      }),
      update: async () => {
        writes.push("environment");
        return {};
      },
    },
    membership: {
      findUnique: async () => ({
        id: MEMBERSHIP_ID,
        teamId: TEAM_ID,
        role: "MEMBER",
        lifecycle,
      }),
      findFirst: async () => ({ role: "OWNER", lifecycle: "ACTIVE" }),
      update: async () => {
        writes.push("membership");
        return {};
      },
    },
    device: { findFirst: async () => ({ id: DEVICE_ID }) },
    operation: {
      createMany: async () => ({ count: 0 }),
      findUnique: async () => operation,
      update: async () => {
        writes.push("operation");
        return operation;
      },
    },
    auditEvent: {
      create: async () => {
        writes.push("audit");
        return {};
      },
    },
  };
  const database = {
    $transaction: async (callback: (value: unknown) => unknown) =>
      callback(transaction),
  } as never;
  return { database, writes };
};

describe("lifecycle command replay", () => {
  const administration = new AdministrationRepository();
  const memberships = new MembershipAdministrationRepository();
  const cases = [
    {
      name: "archiveProject",
      lifecycle: "ARCHIVED",
      run: (database: never, operation: never) =>
        administration.archiveProject(database, {
          projectId: PROJECT_ID,
          operation,
        }),
    },
    {
      name: "restoreProject",
      lifecycle: "ACTIVE",
      run: (database: never, operation: never) =>
        administration.restoreProject(database, {
          projectId: PROJECT_ID,
          operation,
        }),
    },
    {
      name: "archiveEnvironment",
      lifecycle: "ARCHIVED",
      run: (database: never, operation: never) =>
        administration.archiveEnvironment(database, {
          environmentId: ENVIRONMENT_ID,
          operation,
        }),
    },
    {
      name: "restoreEnvironment",
      lifecycle: "ACTIVE",
      run: (database: never, operation: never) =>
        administration.restoreEnvironment(database, {
          environmentId: ENVIRONMENT_ID,
          operation,
        }),
    },
    {
      name: "remove",
      lifecycle: "REMOVED",
      run: (database: never, operation: never) =>
        memberships.remove(database, {
          teamId: TEAM_ID,
          membershipId: MEMBERSHIP_ID,
          operation,
        }),
    },
  ] as const;

  for (const { name, lifecycle, run } of cases)
    test(`${name} returns the committed outcome for the same key`, async () => {
      const { database, writes } = await committedState("COMMITTED", lifecycle);
      const result = await run(database, (await operationInput()) as never);
      expect(result).toMatchObject({
        idempotent: true,
        operation: { id: OPERATION_ID, status: "COMMITTED" },
      });
      expect(writes).toEqual([]);
    });

  test("a new command still fails the lifecycle precondition", async () => {
    const { database, writes } = await committedState("STAGED", "ARCHIVED");
    await expect(
      administration.archiveProject(database, {
        projectId: PROJECT_ID,
        operation: await operationInput(),
      }),
    ).rejects.toBeInstanceOf(ProjectNotActiveError);
    expect(writes).toEqual([]);
  });
});
