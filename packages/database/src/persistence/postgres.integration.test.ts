import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type {
  DatabaseClient,
  OperationInput,
  ProtocolObjectInput,
  RevisionPublicationInput,
} from "..";
import {
  AdministrationDisclosureRepository,
  AdministrationRepository,
  createDatabaseClient,
  EnvironmentRepository,
  MembershipAdministrationRepository,
  OperationConflictError,
  OperationRepository,
  ProjectRepository,
  ProtocolObjectRepository,
  PublicationRepository,
  SecurityRequestLogRepository,
  StagedObjectRepository,
  StaleHeadError,
  SyncRepository,
  sha384Digest,
} from "..";

const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_repository_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const testDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (testDatabaseUrl) {
  testDatabaseUrl.pathname = `/${testDatabaseName}`;
}
const adminDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (adminDatabaseUrl) {
  adminDatabaseUrl.pathname = "/postgres";
}
let database: DatabaseClient;
const textEncoder = new TextEncoder();
let protocolSequence = 1;
const databasePackage = fileURLToPath(new URL("../..", import.meta.url));
const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const runMigrations = async () => {
  if (!testDatabaseUrl) throw new Error("DATABASE_URL is required");
  const subprocess = Bun.spawn(
    ["bun", "x", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
    {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl.toString() },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`migration failed: ${stdout}\n${stderr}`);
};

const createOperationInput = async <Kind extends OperationInput["kind"]>(
  actorUserId: string,
  label: string,
  kind: Kind = "ADMINISTRATION" as Kind,
) => {
  const commandBytes = textEncoder.encode(label);
  return {
    id: crypto.randomUUID(),
    actorUserId,
    kind,
    commandBytes,
    commandDigest: await sha384Digest(commandBytes),
  } as const;
};

const createProtocolObjectInput = async (
  kind: number,
  projectId: string,
  environmentId: string,
): Promise<ProtocolObjectInput> => {
  const canonicalBytes = new Uint8Array([0xa1, 0x00, protocolSequence++]);
  return {
    id: crypto.randomUUID(),
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    formatVersion: 3,
    kind,
    canonicalBytes,
    digest: await sha384Digest(canonicalBytes),
    projectId,
    environmentId,
  };
};

const preparePublication = async (input: {
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly expectedHeadId: string | null;
  readonly parentHash?: Uint8Array;
  readonly mutation: "GENESIS" | "MANIFEST_UPDATE" | "ROLLBACK";
  readonly rollbackTargetId?: string;
  readonly label: string;
}): Promise<RevisionPublicationInput> => {
  const operationKind =
    input.mutation === "ROLLBACK" ? "ROLLBACK" : "REVISION_PUBLICATION";
  const operation = {
    ...(await createOperationInput(
      input.actorUserId,
      input.label,
      operationKind,
    )),
    actorDeviceId: input.actorDeviceId,
  };
  const revisionObject = await createProtocolObjectInput(
    16,
    input.projectId,
    input.environmentId,
  );
  const descriptorObject = await createProtocolObjectInput(
    15,
    input.projectId,
    input.environmentId,
  );
  const revisionId = crypto.randomUUID();
  const operations = new OperationRepository();
  const staging = new StagedObjectRepository();
  await operations.begin(database, operation);
  for (const protocolObject of [revisionObject, descriptorObject]) {
    const createdAt = new Date();
    await staging.put(database, {
      operationId: operation.id,
      objectId: protocolObject.id,
      actorDeviceId: input.actorDeviceId,
      canonicalBytes: protocolObject.canonicalBytes,
      digest: protocolObject.digest,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 60_000),
    });
  }
  return {
    operation,
    environmentId: input.environmentId,
    expectedHeadId: input.expectedHeadId,
    revision: {
      id: revisionId,
      protocolObjectId: revisionObject.id,
      ...(input.parentHash ? { parentHash: input.parentHash } : {}),
      projectEpoch: 1n,
      mutation: input.mutation,
      authoredAtMs: BigInt(Date.now()),
      ...(input.rollbackTargetId
        ? { rollbackTargetId: input.rollbackTargetId }
        : {}),
    },
    revisionObject,
    descriptor: {
      protocolObject: descriptorObject,
      schemaVersion: 1,
      descriptorHash: descriptorObject.digest,
      laneCount: 0,
    },
    lanes: [],
    commitments: [],
    audit: {
      kind:
        input.mutation === "ROLLBACK"
          ? "ROLLBACK_PUBLISHED"
          : "REVISION_PUBLISHED",
      entityKind: "ENVIRONMENT",
      entityId: input.environmentId,
    },
  };
};

const createAuthorizedDeviceFixture = async () => {
  const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
  const keyId = new Uint8Array(await sha384Digest(x25519PublicKey));
  const serverProfile = await database.serverProfile.create({
    data: {
      id: crypto.randomUUID(),
      origin: `https://${crypto.randomUUID()}.example.test`,
    },
  });
  const user = await database.user.create({
    data: {
      serverProfileId: serverProfile.id,
      authSubject: `auth:${crypto.randomUUID()}`,
      githubSubject: `github:${crypto.randomUUID()}`,
    },
  });
  const device = await database.device.create({
    data: {
      id: crypto.randomUUID(),
      userId: user.id,
      lifecycle: "ACTIVE",
      identityGeneration: 1n,
      keyId,
      x25519PublicKey,
      ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      activatedAt: new Date(),
    },
  });
  return { device, serverProfile, user };
};

const createUserAndDevice = async (serverProfileId: string) => {
  const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
  const user = await database.user.create({
    data: {
      serverProfileId,
      authSubject: `auth:${crypto.randomUUID()}`,
      githubSubject: `github:${crypto.randomUUID()}`,
    },
  });
  const device = await database.device.create({
    data: {
      id: crypto.randomUUID(),
      userId: user.id,
      lifecycle: "ACTIVE",
      identityGeneration: 1n,
      keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
      x25519PublicKey,
      ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      activatedAt: new Date(),
    },
  });
  return { device, user };
};

const createProjectFixture = async (label: string) => {
  const { device, serverProfile, user } = await createAuthorizedDeviceFixture();
  const teamId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await new AdministrationRepository().createTeamWithOwner(database, {
    teamId,
    serverProfileId: serverProfile.id,
    ownerUserId: user.id,
    name: label,
    operation: {
      ...(await createOperationInput(user.id, `${label}-team`)),
      actorDeviceId: device.id,
    },
  });
  await new ProjectRepository().create(database, {
    teamId,
    projectId,
    githubRepositoryId: BigInt(Date.now()),
    operation: {
      ...(await createOperationInput(user.id, `${label}-project`)),
      actorDeviceId: device.id,
    },
  });
  return { device, projectId, teamId, user };
};

integrationDescribe("PostgreSQL persistence integration", () => {
  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("DATABASE_URL is required");
    if (!testDatabaseUrl) throw new Error("DATABASE_URL is required");
    database = createDatabaseClient(testDatabaseUrl.toString());
    const admin = new Client({ connectionString: adminDatabaseUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`);
    } finally {
      await admin.end();
    }
    await runMigrations();
  });

  afterAll(async () => {
    await database.$disconnect();
    if (!adminDatabaseUrl) return;
    const admin = new Client({ connectionString: adminDatabaseUrl.toString() });
    await admin.connect();
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [testDatabaseName],
      );
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabaseName)}`,
      );
    } finally {
      await admin.end();
    }
  });

  test("handles concurrent operation retries and rejects conflicting bytes", async () => {
    const { device, user } = await createAuthorizedDeviceFixture();
    const repository = new OperationRepository();
    const input = await createOperationInput(user.id, "concurrent-operation");

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => repository.begin(database, input)),
    );

    expect(attempts.every(({ operation }) => operation.id === input.id)).toBe(
      true,
    );
    expect(
      await database.operation.count({ where: { actorUserId: user.id } }),
    ).toBe(1);

    await database.operation.update({
      where: { id: input.id },
      data: { status: "COMMITTED", committedAt: new Date() },
    });
    expect((await repository.begin(database, input)).idempotent).toBe(true);

    const conflictingBytes = textEncoder.encode("different-command");
    await expect(
      repository.begin(database, {
        ...input,
        commandBytes: conflictingBytes,
        commandDigest: await sha384Digest(conflictingBytes),
      }),
    ).rejects.toBeInstanceOf(OperationConflictError);
    await expect(
      repository.begin(database, { ...input, id: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(OperationConflictError);

    const staging = new StagedObjectRepository();
    const stagedOperation = await createOperationInput(
      user.id,
      "concurrent-staging",
    );
    await repository.begin(database, {
      ...stagedOperation,
      actorDeviceId: device.id,
    });
    const canonicalBytes = new Uint8Array([0xa0]);
    const stagedInput = {
      operationId: stagedOperation.id,
      objectId: crypto.randomUUID(),
      actorDeviceId: device.id,
      canonicalBytes,
      digest: await sha384Digest(canonicalBytes),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const stagedAttempts = await Promise.all(
      Array.from({ length: 8 }, () => staging.put(database, stagedInput)),
    );
    expect(
      stagedAttempts.every(({ objectId }) => objectId === stagedInput.objectId),
    ).toBe(true);
    expect(
      await database.stagedObject.count({
        where: { operationId: stagedOperation.id },
      }),
    ).toBe(1);
  });

  test("keeps Team administration atomic, auditable, and restore-safe", async () => {
    const { device, projectId, teamId, user } = await createProjectFixture(
      "persistence-integration",
    );
    const administration = new AdministrationRepository();
    await administration.archiveProject(database, {
      projectId,
      operation: {
        ...(await createOperationInput(user.id, "archive-project")),
        actorDeviceId: device.id,
      },
    });
    await administration.restoreProject(database, {
      projectId,
      operation: {
        ...(await createOperationInput(user.id, "restore-project")),
        actorDeviceId: device.id,
      },
    });

    expect(
      await database.project.findUnique({ where: { id: projectId } }),
    ).toMatchObject({ lifecycle: "ACTIVE", archivedAt: null });
    expect(
      await database.auditEvent.count({
        where: { entityId: { in: [teamId, projectId] } },
      }),
    ).toBe(4);
    await expect(
      database.$transaction(async (transaction) =>
        transaction.membership.updateMany({
          where: { teamId, userId: user.id },
          data: { role: "MEMBER" },
        }),
      ),
    ).rejects.toThrow("a Team must retain one active owner");
    expect(
      await database.membership.findFirst({
        where: { teamId, userId: user.id },
      }),
    ).toMatchObject({ role: "OWNER", lifecycle: "ACTIVE" });

    const rolledBackEndpoint = `/rollback/${crypto.randomUUID()}`;
    await expect(
      database.$transaction(async (transaction) => {
        const requestedAt = new Date();
        await transaction.securityRequestLog.create({
          data: {
            ipAddress: "192.0.2.1",
            endpointTemplate: rolledBackEndpoint,
            httpStatus: 200,
            transferBytes: 0n,
            requestedAt,
            expiresAt: new Date(requestedAt.getTime() + 60_000),
          },
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(
      await database.securityRequestLog.count({
        where: { endpointTemplate: rolledBackEndpoint },
      }),
    ).toBe(0);
  });

  test("enforces role policy and seven-day single-use GitHub identity invitations", async () => {
    const {
      device,
      serverProfile,
      user: owner,
    } = await createAuthorizedDeviceFixture();
    const teamId = crypto.randomUUID();
    const administration = new AdministrationRepository();
    const memberships = new MembershipAdministrationRepository();
    await administration.createTeamWithOwner(database, {
      teamId,
      serverProfileId: serverProfile.id,
      ownerUserId: owner.id,
      name: "administration-policy",
      operation: {
        ...(await createOperationInput(owner.id, "policy-team")),
        actorDeviceId: device.id,
      },
    });
    const admin = await createUserAndDevice(serverProfile.id);
    const member = await createUserAndDevice(serverProfile.id);
    const invited = await createUserAndDevice(serverProfile.id);
    const mismatch = await createUserAndDevice(serverProfile.id);
    const activatedAt = new Date();
    const [adminMembership, memberMembership] = await Promise.all([
      database.membership.create({
        data: {
          teamId,
          userId: admin.user.id,
          role: "ADMIN",
          lifecycle: "ACTIVE",
          activatedAt,
        },
      }),
      database.membership.create({
        data: {
          teamId,
          userId: member.user.id,
          role: "MEMBER",
          lifecycle: "ACTIVE",
          activatedAt,
        },
      }),
    ]);

    const invitedAt = new Date("2026-08-28T12:00:00.000Z");
    const invitation = await memberships.invite(database, {
      teamId,
      providerSubject: invited.user.githubSubject,
      now: invitedAt,
      operation: {
        ...(await createOperationInput(admin.user.id, "admin-invitation")),
        actorDeviceId: admin.device.id,
      },
    });
    if (!("invitation" in invitation))
      throw new Error("invitation creation was unexpectedly idempotent");
    expect(invitation.invitation.expiresAt.toISOString()).toBe(
      "2026-09-04T12:00:00.000Z",
    );
    await expect(
      memberships.invite(database, {
        teamId,
        providerSubject: crypto.randomUUID(),
        operation: {
          ...(await createOperationInput(member.user.id, "member-invitation")),
          actorDeviceId: member.device.id,
        },
      }),
    ).rejects.toThrow("insufficient_role");
    await expect(
      memberships.accept(database, {
        invitationId: invitation.invitation.id,
        userId: mismatch.user.id,
        operation: await createOperationInput(
          mismatch.user.id,
          "mismatched-acceptance",
          "INVITATION",
        ),
      }),
    ).rejects.toThrow("addressed to another User");
    const accepted = await memberships.accept(database, {
      invitationId: invitation.invitation.id,
      userId: invited.user.id,
      operation: {
        ...(await createOperationInput(
          invited.user.id,
          "accepted-invitation",
          "INVITATION",
        )),
        actorDeviceId: invited.device.id,
      },
    });
    if (!("membership" in accepted))
      throw new Error("invitation acceptance was unexpectedly idempotent");
    expect(accepted.membership).toMatchObject({
      lifecycle: "PENDING_KEY_GRANT",
      role: "MEMBER",
    });
    await expect(
      memberships.accept(database, {
        invitationId: invitation.invitation.id,
        userId: invited.user.id,
        operation: await createOperationInput(
          invited.user.id,
          "replayed-invitation",
          "INVITATION",
        ),
      }),
    ).rejects.toThrow("expired or already used");

    const expiring = await memberships.invite(database, {
      teamId,
      providerSubject: mismatch.user.githubSubject,
      now: invitedAt,
      operation: {
        ...(await createOperationInput(owner.id, "expiring-invitation")),
        actorDeviceId: device.id,
      },
    });
    if (!("invitation" in expiring))
      throw new Error("invitation creation was unexpectedly idempotent");
    await expect(
      memberships.accept(database, {
        invitationId: expiring.invitation.id,
        userId: mismatch.user.id,
        now: expiring.invitation.expiresAt,
        operation: await createOperationInput(
          mismatch.user.id,
          "expired-invitation",
          "INVITATION",
        ),
      }),
    ).rejects.toThrow("expired or already used");

    await expect(
      memberships.changeRole(database, {
        teamId,
        membershipId: memberMembership.id,
        role: "ADMIN",
        operation: {
          ...(await createOperationInput(admin.user.id, "admin-promotion")),
          actorDeviceId: admin.device.id,
        },
      }),
    ).rejects.toThrow("insufficient_role");
    await memberships.changeRole(database, {
      teamId,
      membershipId: memberMembership.id,
      role: "ADMIN",
      operation: {
        ...(await createOperationInput(owner.id, "owner-promotion")),
        actorDeviceId: device.id,
      },
    });
    await expect(
      memberships.remove(database, {
        teamId,
        membershipId: (
          await database.membership.findUniqueOrThrow({
            where: { teamId_userId: { teamId, userId: owner.id } },
          })
        ).id,
        operation: {
          ...(await createOperationInput(owner.id, "remove-last-owner")),
          actorDeviceId: device.id,
        },
      }),
    ).rejects.toThrow("a Team must retain one active owner");
    expect(adminMembership.role).toBe("ADMIN");
  });

  test("preserves Project identity and safely discloses Environment metadata and lanes", async () => {
    const {
      device,
      projectId,
      teamId,
      user: owner,
    } = await createProjectFixture("administration-disclosure");
    const team = await database.team.findUniqueOrThrow({
      where: { id: teamId },
    });
    const admin = await createUserAndDevice(team.serverProfileId);
    await database.membership.create({
      data: {
        teamId,
        userId: admin.user.id,
        role: "ADMIN",
        lifecycle: "ACTIVE",
        activatedAt: new Date(),
      },
    });
    const member = await createUserAndDevice(team.serverProfileId);
    await database.membership.create({
      data: {
        teamId,
        userId: member.user.id,
        role: "MEMBER",
        lifecycle: "ACTIVE",
        activatedAt: new Date(),
      },
    });
    const project = await database.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    const projects = new ProjectRepository();
    const administration = new AdministrationRepository();
    await expect(
      projects.create(database, {
        teamId,
        githubRepositoryId: 0n,
        operation: {
          ...(await createOperationInput(owner.id, "invalid-project-id")),
          actorDeviceId: device.id,
        },
      }),
    ).rejects.toThrow("must be positive");
    await expect(
      projects.create(database, {
        teamId,
        githubRepositoryId: project.githubRepositoryId,
        operation: {
          ...(await createOperationInput(owner.id, "duplicate-project")),
          actorDeviceId: device.id,
        },
      }),
    ).rejects.toThrow();
    await administration.archiveProject(database, {
      projectId,
      operation: {
        ...(await createOperationInput(owner.id, "archive-original-project")),
        actorDeviceId: device.id,
      },
    });
    const replacement = await projects.create(database, {
      teamId,
      githubRepositoryId: project.githubRepositoryId,
      operation: {
        ...(await createOperationInput(owner.id, "replacement-project")),
        actorDeviceId: device.id,
      },
    });
    if (!("project" in replacement))
      throw new Error("Project creation was unexpectedly idempotent");
    await expect(
      administration.restoreProject(database, {
        projectId,
        operation: {
          ...(await createOperationInput(owner.id, "conflicting-restore")),
          actorDeviceId: device.id,
        },
      }),
    ).rejects.toThrow();
    await administration.archiveProject(database, {
      projectId: replacement.project.id,
      operation: {
        ...(await createOperationInput(owner.id, "archive-replacement")),
        actorDeviceId: device.id,
      },
    });
    await administration.restoreProject(database, {
      projectId,
      operation: {
        ...(await createOperationInput(owner.id, "restore-original")),
        actorDeviceId: device.id,
      },
    });
    await expect(
      Promise.resolve(
        database.project.update({
          where: { id: projectId },
          data: { githubRepositoryId: project.githubRepositoryId + 1n },
        }),
      ),
    ).rejects.toThrow("identities are immutable");
    await expect(
      Promise.resolve(
        database.project.update({
          where: { id: projectId },
          data: { teamId: crypto.randomUUID() },
        }),
      ),
    ).rejects.toThrow("identities are immutable");

    const environmentId = crypto.randomUUID();
    const memberEnvironmentId = crypto.randomUUID();
    const memberGenesis = await preparePublication({
      actorUserId: member.user.id,
      actorDeviceId: member.device.id,
      projectId,
      environmentId: memberEnvironmentId,
      expectedHeadId: null,
      mutation: "GENESIS",
      label: "member-environment-genesis",
    });
    await expect(
      new EnvironmentRepository().createWithGenesis(database, {
        environmentId: memberEnvironmentId,
        projectId,
        createdByUserId: member.user.id,
        publication: memberGenesis,
      }),
    ).rejects.toThrow("insufficient_role");
    expect(
      await database.environment.findUnique({
        where: { id: memberEnvironmentId },
      }),
    ).toBeNull();
    await database.environment.create({
      data: {
        id: environmentId,
        projectId,
        createdByUserId: owner.id,
      },
    });
    const createLane = async (
      scope: "SHARED_VALUE" | "USER_DEFINED_VALUE",
      ownerUserId?: string,
    ) => {
      if (scope === "USER_DEFINED_VALUE" && !ownerUserId)
        throw new Error("User-defined Value test lane needs an owner");
      const protocolObject = await new ProtocolObjectRepository().create(
        database,
        await createProtocolObjectInput(11, projectId, environmentId),
      );
      return database.laneObject.create({
        data: {
          id: crypto.randomUUID(),
          protocolObjectId: protocolObject.id,
          projectId,
          environmentId,
          scope,
          ...(scope === "USER_DEFINED_VALUE"
            ? { ownerUserId: ownerUserId as string, valueGeneration: 1n }
            : { originalProviderUserId: owner.id }),
          projectEpoch: 1n,
          plaintextLength: 1,
          ciphertextLength: 17,
          ciphertextHash: crypto.getRandomValues(new Uint8Array(48)),
        },
      });
    };
    const shared = await createLane("SHARED_VALUE");
    const ownersValue = await createLane("USER_DEFINED_VALUE", owner.id);
    const adminsValue = await createLane("USER_DEFINED_VALUE", admin.user.id);
    const disclosure = new AdministrationDisclosureRepository();
    const visible = await disclosure.listEnvironmentLanes(database, {
      actorUserId: admin.user.id,
      actorDeviceId: admin.device.id,
      environmentId,
    });
    expect(visible.map(({ id }) => id).sort()).toEqual(
      [shared.id, adminsValue.id].sort(),
    );
    expect(visible.some(({ id }) => id === ownersValue.id)).toBe(false);
    const metadata = await disclosure.getEnvironmentMetadata(database, {
      actorUserId: admin.user.id,
      actorDeviceId: admin.device.id,
      environmentId,
    });
    expect(metadata).toEqual({
      id: environmentId,
      projectId,
      lifecycle: "ACTIVE",
      currentHeadId: null,
    });
    expect(Object.hasOwn(metadata, "name")).toBe(false);
    const admittedButPending = await createUserAndDevice(team.serverProfileId);
    await database.membership.create({
      data: {
        teamId,
        userId: admittedButPending.user.id,
        lifecycle: "PENDING_KEY_GRANT",
      },
    });
    await expect(
      disclosure.getEnvironmentMetadata(database, {
        actorUserId: admittedButPending.user.id,
        actorDeviceId: admittedButPending.device.id,
        environmentId,
      }),
    ).rejects.toThrow("Environment not found");
    const removed = await createUserAndDevice(team.serverProfileId);
    await database.membership.create({
      data: {
        teamId,
        userId: removed.user.id,
        lifecycle: "REMOVED",
        removedAt: new Date(),
      },
    });
    await expect(
      disclosure.getEnvironmentMetadata(database, {
        actorUserId: removed.user.id,
        actorDeviceId: removed.device.id,
        environmentId,
      }),
    ).rejects.toThrow("Environment not found");
    await expect(
      disclosure.getEnvironmentMetadata(database, {
        actorUserId: admittedButPending.user.id,
        actorDeviceId: admittedButPending.device.id,
        environmentId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Environment not found");
    await administration.archiveEnvironment(database, {
      environmentId,
      operation: {
        ...(await createOperationInput(admin.user.id, "archive-environment")),
        actorDeviceId: admin.device.id,
      },
    });
    await expect(
      disclosure.listEnvironmentLanes(database, {
        actorUserId: admin.user.id,
        actorDeviceId: admin.device.id,
        environmentId,
      }),
    ).rejects.toThrow("resource_not_active");
    await administration.restoreEnvironment(database, {
      environmentId,
      operation: {
        ...(await createOperationInput(admin.user.id, "restore-environment")),
        actorDeviceId: admin.device.id,
      },
    });
  });

  test("serializes competing publications and records Rollback as a new Revision", async () => {
    const { device, projectId, user } = await createProjectFixture(
      "concurrent-publication",
    );
    const environments = new EnvironmentRepository();
    const publications = new PublicationRepository();
    const environmentId = crypto.randomUUID();

    const genesis = await preparePublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      expectedHeadId: null,
      mutation: "GENESIS",
      label: "environment-genesis",
    });
    await environments.createWithGenesis(database, {
      environmentId,
      projectId,
      createdByUserId: user.id,
      publication: genesis,
    });

    const candidates = await Promise.all(
      ["publication-left", "publication-right"].map((label) =>
        preparePublication({
          actorUserId: user.id,
          actorDeviceId: device.id,
          projectId,
          environmentId,
          expectedHeadId: genesis.revision.id,
          parentHash: genesis.revisionObject.digest,
          mutation: "MANIFEST_UPDATE",
          label,
        }),
      ),
    );
    const results = await Promise.allSettled(
      candidates.map((candidate) =>
        publications.publishRevision(database, candidate),
      ),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StaleHeadError);

    const winningResult = fulfilled[0]?.value;
    if (!winningResult) throw new Error("publication race had no winner");
    const winningInput = candidates.find(
      ({ revision }) => revision.id === winningResult.revision.id,
    );
    if (!winningInput) throw new Error("publication winner was not prepared");
    const rollback = await preparePublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      expectedHeadId: winningInput.revision.id,
      parentHash: winningInput.revisionObject.digest,
      mutation: "ROLLBACK",
      rollbackTargetId: genesis.revision.id,
      label: "rollback-publication",
    });
    await publications.publishRevision(database, rollback);

    expect(
      await database.environment.findUnique({
        where: { id: environmentId },
      }),
    ).toMatchObject({ currentHeadId: rollback.revision.id });
    expect(
      await database.revision.findUnique({
        where: { id: rollback.revision.id },
      }),
    ).toMatchObject({
      parentId: winningInput.revision.id,
      rollbackTargetId: genesis.revision.id,
      mutation: "ROLLBACK",
    });
    expect(await database.revision.count({ where: { environmentId } })).toBe(3);
  });

  test("returns authorization-scoped synchronization pages after a trusted revision", async () => {
    const { device, projectId, user } = await createProjectFixture("sync-page");
    const environments = new EnvironmentRepository();
    const publications = new PublicationRepository();
    const synchronization = new SyncRepository();
    const environmentId = crypto.randomUUID();
    const genesis = await preparePublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      expectedHeadId: null,
      mutation: "GENESIS",
      label: "sync-genesis",
    });
    await environments.createWithGenesis(database, {
      environmentId,
      projectId,
      createdByUserId: user.id,
      publication: genesis,
    });
    const update = await preparePublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      expectedHeadId: genesis.revision.id,
      parentHash: genesis.revisionObject.digest,
      mutation: "MANIFEST_UPDATE",
      label: "sync-update",
    });
    await publications.publishRevision(database, update);
    const page = await synchronization.synchronize(database, {
      actorUserId: user.id,
      actorDeviceId: device.id,
      environmentId,
      trustedRevisionId: genesis.revision.id,
      trustedRevisionHash: genesis.revisionObject.digest,
      limit: 16,
    });
    expect(page.revisions).toHaveLength(1);
    expect(page.revisions[0]?.id).toBe(update.revision.id);
    expect(page.currentHeadId).toBe(update.revision.id);
    expect(page.nextCursor).toBeNull();
  });

  test("expires only disposable staging and Security Request Log rows", async () => {
    const { device, user } = await createAuthorizedDeviceFixture();
    const operations = new OperationRepository();
    const stagedObjects = new StagedObjectRepository();
    const securityLogs = new SecurityRequestLogRepository();
    const now = new Date();
    const expiredOperation = await createOperationInput(
      user.id,
      "expired-staging",
    );
    const currentOperation = await createOperationInput(
      user.id,
      "current-staging",
    );
    const canonicalBytes = new Uint8Array([0xa0]);
    const digest = await sha384Digest(canonicalBytes);

    for (const [operation, expiresAt] of [
      [expiredOperation, new Date(now.getTime() - 60_000)],
      [currentOperation, new Date(now.getTime() + 60_000)],
    ] as const) {
      await operations.begin(database, {
        ...operation,
        actorDeviceId: device.id,
        expiresAt,
      });
      await stagedObjects.put(database, {
        operationId: operation.id,
        objectId: crypto.randomUUID(),
        actorDeviceId: device.id,
        canonicalBytes,
        digest,
        createdAt: new Date(expiresAt.getTime() - 60_000),
        expiresAt,
      });
    }

    expect(await operations.expireStaging(database, now)).toBe(1);
    expect(
      await database.stagedObject.count({
        where: {
          operationId: { in: [expiredOperation.id, currentOperation.id] },
        },
      }),
    ).toBe(1);
    expect(
      await database.stagedObject.findFirst({
        where: { operationId: expiredOperation.id },
      }),
    ).toBeNull();
    expect(
      await database.operation.findUnique({
        where: { id: expiredOperation.id },
      }),
    ).toMatchObject({ status: "EXPIRED" });

    const endpointTemplate = `/expiration/${crypto.randomUUID()}`;
    for (const expiresAt of [
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() + 60_000),
    ]) {
      await securityLogs.append(database, {
        ipAddress: "192.0.2.1",
        endpointTemplate,
        httpStatus: 200,
        transferBytes: 128n,
        requestedAt: new Date(expiresAt.getTime() - 60_000),
        expiresAt,
      });
    }
    expect((await securityLogs.expire(database, now)).count).toBe(1);
    expect(
      await database.securityRequestLog.count({ where: { endpointTemplate } }),
    ).toBe(1);
  });

  test("keeps accepted protocol objects and Audit Facts append-only", async () => {
    const { user } = await createAuthorizedDeviceFixture();
    const operations = new OperationRepository();
    const operation = await createOperationInput(user.id, "append-only");
    await operations.begin(database, operation);
    await database.operation.update({
      where: { id: operation.id },
      data: { status: "COMMITTED", committedAt: new Date() },
    });
    const canonicalBytes = new Uint8Array([0xa0]);
    const protocolObject = await new ProtocolObjectRepository().create(
      database,
      {
        id: crypto.randomUUID(),
        suite: "dotrelay-e2ee-v3-classical-webcrypto",
        formatVersion: 3,
        kind: 1,
        canonicalBytes,
        digest: await sha384Digest(canonicalBytes),
      },
    );
    const audit = await database.auditEvent.create({
      data: {
        operationId: operation.id,
        kind: "TEAM_CREATED",
        entityKind: "PROTOCOL_OBJECT",
        entityId: protocolObject.id,
      },
    });

    await expect(
      Promise.resolve(
        database.protocolObject.update({
          where: { id: protocolObject.id },
          data: { canonicalBytes: new Uint8Array([0xa1, 0x00, 0x01]) },
        }),
      ),
    ).rejects.toThrow("immutable DotRelay row");
    await expect(
      Promise.resolve(database.auditEvent.delete({ where: { id: audit.id } })),
    ).rejects.toThrow("immutable DotRelay row");
  });
});
