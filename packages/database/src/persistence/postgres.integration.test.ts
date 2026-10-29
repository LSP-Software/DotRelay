import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  canonicalEncode,
  type CborValue,
  encodeProtocolObject,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  protocolObjectFromFields,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  createPublicationArtifacts,
  type PublicationVariable,
} from "@dotrelay/client";
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
  GenesisExistsError,
  GrantRepository,
  MembershipAdministrationRepository,
  MembershipRepository,
  OperationConflictError,
  OperationRepository,
  ProjectRepository,
  ProtocolObjectRepository,
  PublicationRepository,
  SecurityRequestLogRepository,
  StagedObjectRepository,
  StagingQuotaExceededError,
  StaleHeadError,
  SyncRepository,
  sha384Digest,
} from "..";

const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const INTEGRATION_HOOK_TIMEOUT_MS = 30_000;
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
  const sequence = protocolSequence++;
  const canonicalBytes = new Uint8Array([
    0xa1,
    0x00,
    ...(sequence < 24
      ? [sequence]
      : sequence < 256
        ? [0x18, sequence]
        : [0x19, sequence >> 8, sequence & 0xff]),
  ]);
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

// Encodes a registry-valid signed protocol object: field 3 carries the
// canonical unsigned body and field 4 a 64-byte signature placeholder, the
// same envelope shape the client signs (the server never re-verifies the
// Ed25519 signature on the write path).
const signedProtocolBytes = (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
): Uint8Array => {
  const body = protocolObjectFromFields(kind, fields);
  const signed = new Map<number, CborValue>(fields);
  signed.set(3, canonicalEncode(body));
  signed.set(4, new Uint8Array(64));
  return encodeProtocolObject(protocolObjectFromFields(kind, signed));
};

// Re-encodes a signed revision with a few fields replaced (keeping the
// registry-valid envelope), so tests can publish a revision that commits to
// a manifest different from the one the client paired with it.
const rebuiltRevisionBytes = (
  baseBytes: Uint8Array,
  overrides: ReadonlyMap<number, CborValue>,
): Uint8Array => {
  const fields = new Map<number, CborValue>();
  for (const [field, value] of parseProtocolObject(baseBytes)) {
    if (field === 0 || field === 1 || field === 2 || field === 3 || field === 4)
      continue;
    fields.set(field, value);
  }
  for (const [field, value] of overrides) fields.set(field, value);
  return signedProtocolBytes(16, fields);
};

const manifestBindingVariable = (name: string): PublicationVariable =>
  Object.freeze({
    id: crypto.randomUUID(),
    name,
    description: "manifest binding fixture variable",
    ownership: "SHARED_VALUE",
    value: `value-for-${name}`,
    required: true,
    hasDraftChange: true,
  });

// Maps real client publication artifact sets onto a persistence input, the
// same way the API maps staged objects for the finalize route. The revision
// comes from baseArtifacts; the descriptor and lanes/commitments may be
// sourced from different artifact sets, which is exactly the mismatch the
// write path must now reject. Every input begins its own operation and
// stages exactly the objects the publication will promote.
const publicationFromArtifacts = async (
  baseArtifacts: Awaited<ReturnType<typeof createPublicationArtifacts>>,
  input: {
    readonly actorUserId: string;
    readonly actorDeviceId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly revisionBytes?: Uint8Array;
    readonly descriptorSource?: Awaited<
      ReturnType<typeof createPublicationArtifacts>
    >;
    readonly lanesSource?: Awaited<
      ReturnType<typeof createPublicationArtifacts>
    >;
  },
): Promise<RevisionPublicationInput> => {
  const request = baseArtifacts.request;
  const descriptorArtifacts = input.descriptorSource ?? baseArtifacts;
  const lanesArtifacts = input.lanesSource ?? baseArtifacts;
  const revisionBytes = input.revisionBytes ?? baseArtifacts.commandBytes;
  const descriptorStaged = descriptorArtifacts.stagedObjects.find(
    (object) =>
      object.objectId ===
      descriptorArtifacts.request.descriptor.protocolObjectId,
  );
  if (!descriptorStaged) throw new Error("descriptor object is not staged");
  const laneBytesById = new Map<string, Uint8Array>();
  for (const object of lanesArtifacts.stagedObjects)
    laneBytesById.set(object.objectId, object.bytes);
  const buildObject = async (
    objectId: string,
    kind: number,
    bytes: Uint8Array,
  ): Promise<ProtocolObjectInput> => ({
    id: objectId,
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    formatVersion: 3,
    kind,
    canonicalBytes: bytes,
    digest: await sha384Digest(bytes),
    projectId: input.projectId,
    environmentId: input.environmentId,
  });
  const laneRequests = lanesArtifacts.request.lanes;
  const revisionObject = await buildObject(
    request.revision.protocolObjectId,
    16,
    revisionBytes,
  );
  const descriptorObject = await buildObject(
    descriptorArtifacts.request.descriptor.protocolObjectId,
    15,
    descriptorStaged.bytes,
  );
  const lanes = await Promise.all(
    laneRequests.map(async (lane) => {
      const bytes = laneBytesById.get(lane.protocolObjectId);
      if (!bytes)
        throw new Error(`staged lane object ${lane.protocolObjectId} missing`);
      return {
        lane: {
          id: lane.id,
          protocolObjectId: lane.protocolObjectId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          scope: lane.scope,
          ...(lane.ownerUserId ? { ownerUserId: lane.ownerUserId } : {}),
          ...(lane.originalProviderUserId
            ? { originalProviderUserId: lane.originalProviderUserId }
            : {}),
          projectEpoch: BigInt(lane.projectEpoch),
          ...(lane.valueGeneration !== undefined
            ? { valueGeneration: BigInt(lane.valueGeneration) }
            : {}),
          plaintextLength: lane.plaintextLength,
          ciphertextLength: lane.ciphertextLength,
          ciphertextHash: lane.ciphertextHash,
        },
        protocolObject: await buildObject(lane.protocolObjectId, 13, bytes),
      };
    }),
  );
  const operationKind =
    request.revision.mutation === "ROLLBACK"
      ? ("ROLLBACK" as const)
      : ("REVISION_PUBLICATION" as const);
  // Operations are unique per (actor, command digest), so each scenario
  // carries a distinct nonce-prefixed command around the same revision
  // bytes, the way separate client operations would.
  const commandNonce = uuidToBytes(crypto.randomUUID());
  const commandBytes = new Uint8Array(
    commandNonce.length + revisionBytes.length,
  );
  commandBytes.set(commandNonce);
  commandBytes.set(revisionBytes, commandNonce.length);
  const operation = {
    id: crypto.randomUUID(),
    actorUserId: input.actorUserId,
    actorDeviceId: input.actorDeviceId,
    kind: operationKind,
    commandBytes,
    commandDigest: await sha384Digest(commandBytes),
  };
  await new OperationRepository().begin(database, operation);
  const staging = new StagedObjectRepository();
  for (const object of [
    { objectId: revisionObject.id, bytes: revisionObject.canonicalBytes },
    {
      objectId: descriptorObject.id,
      bytes: descriptorObject.canonicalBytes,
    },
    ...lanes.map(({ protocolObject }) => ({
      objectId: protocolObject.id,
      bytes: protocolObject.canonicalBytes,
    })),
  ]) {
    const createdAt = new Date();
    await staging.put(database, {
      operationId: operation.id,
      objectId: object.objectId,
      actorDeviceId: input.actorDeviceId,
      canonicalBytes: object.bytes,
      digest: await sha384Digest(object.bytes),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 60_000),
    });
  }
  return {
    operation,
    environmentId: input.environmentId,
    expectedHeadId: request.expectedHeadId,
    revision: {
      id: request.revision.id,
      protocolObjectId: request.revision.protocolObjectId,
      ...(request.revision.parentHash
        ? { parentHash: request.revision.parentHash }
        : {}),
      projectEpoch: BigInt(request.revision.projectEpoch),
      mutation: request.revision.mutation,
      authoredAtMs: BigInt(request.revision.authoredAtMs),
      ...(request.revision.rollbackTargetId
        ? { rollbackTargetId: request.revision.rollbackTargetId }
        : {}),
    },
    revisionObject,
    descriptor: {
      protocolObject: descriptorObject,
      schemaVersion: descriptorArtifacts.request.descriptor.schemaVersion,
      descriptorHash: descriptorArtifacts.request.descriptor.descriptorHash,
      laneCount: descriptorArtifacts.request.descriptor.laneCount,
    },
    lanes,
    commitments: lanesArtifacts.request.commitments.map((commitment) => ({
      ordinal: commitment.ordinal,
      laneObjectId: commitment.laneObjectId,
      objectHash: commitment.objectHash,
      projectEpoch: BigInt(commitment.projectEpoch),
      scope: commitment.scope,
      ...(commitment.valueGeneration !== undefined
        ? { valueGeneration: BigInt(commitment.valueGeneration) }
        : {}),
      ...(commitment.ownerUserId
        ? { ownerUserId: commitment.ownerUserId }
        : {}),
      ...(commitment.originalProviderUserId
        ? { originalProviderUserId: commitment.originalProviderUserId }
        : {}),
      ciphertextLength: commitment.ciphertextLength,
    })),
    audit: {
      kind:
        request.revision.mutation === "ROLLBACK"
          ? ("ROLLBACK_PUBLISHED" as const)
          : ("REVISION_PUBLISHED" as const),
      entityKind: "ENVIRONMENT",
      entityId: input.environmentId,
    },
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
  const revisionId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const teamId = crypto.randomUUID();
  const authoredAtMs = Date.now();
  const descriptorBytes = signedProtocolBytes(
    15,
    new Map<number, CborValue>([
      [8, uuidToBytes(profileId)],
      [11, uuidToBytes(teamId)],
      [13, uuidToBytes(input.projectId)],
      [14, uuidToBytes(input.environmentId)],
      [16, uuidToBytes(revisionId)],
      [30, 1],
      [50, 1],
      [53, []],
    ]),
  );
  const descriptorDigest = await sha384Digest(descriptorBytes);
  const revisionFields = new Map<number, CborValue>([
    [8, uuidToBytes(profileId)],
    [11, uuidToBytes(teamId)],
    [13, uuidToBytes(input.projectId)],
    [14, uuidToBytes(input.environmentId)],
    [16, uuidToBytes(revisionId)],
    [17, uuidToBytes(crypto.randomUUID())],
    [
      19,
      input.expectedHeadId
        ? uuidToBytes(input.expectedHeadId)
        : uuidToBytes(input.environmentId),
    ],
    [20, input.parentHash ?? new Uint8Array(48)],
    [22, uuidToBytes(input.actorUserId)],
    [23, uuidToBytes(input.actorDeviceId)],
    [30, 1],
    [34, authoredAtMs],
    [
      35,
      input.mutation === "GENESIS" ? 1 : input.mutation === "ROLLBACK" ? 3 : 2,
    ],
    [50, 1],
    [51, descriptorBytes],
    [52, descriptorDigest],
    [53, []],
    [54, []],
  ]);
  if (input.mutation === "ROLLBACK") {
    revisionFields.set(
      21,
      uuidToBytes(input.rollbackTargetId ?? input.environmentId),
    );
    revisionFields.set(68, [uuidToBytes(crypto.randomUUID())]);
  }
  const revisionBytes = signedProtocolBytes(16, revisionFields);
  const revisionObject: ProtocolObjectInput = {
    id: crypto.randomUUID(),
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    formatVersion: 3,
    kind: 16,
    canonicalBytes: revisionBytes,
    digest: await sha384Digest(revisionBytes),
    projectId: input.projectId,
    environmentId: input.environmentId,
  };
  const descriptorObject: ProtocolObjectInput = {
    id: crypto.randomUUID(),
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    formatVersion: 3,
    kind: 15,
    canonicalBytes: descriptorBytes,
    digest: descriptorDigest,
    projectId: input.projectId,
    environmentId: input.environmentId,
  };
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
      authoredAtMs: BigInt(authoredAtMs),
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
    await database.$executeRawUnsafe(
      "GRANT dotrelay_security_response TO CURRENT_USER",
    );
  }, INTEGRATION_HOOK_TIMEOUT_MS);

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
  }, INTEGRATION_HOOK_TIMEOUT_MS);

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

  test("serializes staging quotas across concurrent operations and Devices of one User", async () => {
    const { device, user } = await createAuthorizedDeviceFixture();
    const peerKey = crypto.getRandomValues(new Uint8Array(32));
    const peer = await database.device.create({
      data: {
        id: crypto.randomUUID(),
        userId: user.id,
        lifecycle: "ACTIVE",
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(peerKey)),
        x25519PublicKey: peerKey,
        ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
        activatedAt: new Date(),
      },
    });
    const operations = new OperationRepository();
    const staging = new StagedObjectRepository();
    const inputs = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const actorDeviceId = index % 2 === 0 ? device.id : peer.id;
        const operation = {
          ...(await createOperationInput(user.id, `quota-${index}`)),
          actorDeviceId,
        };
        await operations.begin(database, operation);
        const canonicalBytes = new Uint8Array([0xa0]);
        const createdAt = new Date();
        return {
          operationId: operation.id,
          objectId: crypto.randomUUID(),
          actorDeviceId,
          canonicalBytes,
          digest: await sha384Digest(canonicalBytes),
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 60000),
          limits: { stagingObjects: 2, stagingBytes: 2 },
        };
      }),
    );
    const outcomes = await Promise.allSettled(
      inputs.map((input) => staging.put(database, input)),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(2);
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(outcome.reason).toBeInstanceOf(StagingQuotaExceededError);
    const accepted =
      inputs[outcomes.findIndex((outcome) => outcome.status === "fulfilled")];
    if (!accepted) throw new Error("no staged object accepted");
    // A retry at the limit consumes no extra quota.
    await expect(staging.put(database, accepted)).resolves.toMatchObject({
      objectId: accepted.objectId,
    });
    expect(
      await database.stagedObject.count({
        where: { actorDevice: { userId: user.id } },
      }),
    ).toBe(2);
  });

  test("records operation cancellation as an unsampled Audit Fact", async () => {
    const { device, user } = await createAuthorizedDeviceFixture();
    const operation = {
      ...(await createOperationInput(user.id, "cancelled-operation")),
      actorDeviceId: device.id,
    };
    const operations = new OperationRepository();
    await operations.begin(database, operation);

    const cancelled = await operations.cancel(database, {
      operationId: operation.id,
      actorUserId: user.id,
      actorDeviceId: device.id,
    });

    expect(cancelled.operation.status).toBe("CANCELLED");
    expect(
      await database.auditEvent.count({
        where: { operationId: operation.id, kind: "OPERATION_CANCELLED" },
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

    const rolledBackEndpoint = "/health";
    const rollbackRequestedAt = new Date();
    await expect(
      database.$transaction(async (transaction) => {
        await transaction.securityRequestLog.create({
          data: {
            ipAddress: "192.0.2.1",
            endpointTemplate: rolledBackEndpoint,
            httpStatus: 200,
            transferBytes: 0n,
            requestedAt: rollbackRequestedAt,
            expiresAt: new Date(rollbackRequestedAt.getTime() + 60_000),
          },
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(
      await database.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('dotrelay.security_request_log_access', 'security-response', true)`;
        return transaction.securityRequestLog.count({
          where: {
            endpointTemplate: rolledBackEndpoint,
            requestedAt: rollbackRequestedAt,
          },
        });
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
        now: invitedAt,
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
      now: invitedAt,
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

  test("revives a removed membership via re-acceptance, re-activates it, and rejects an existing member", async () => {
    const {
      device,
      projectId,
      teamId,
      user: owner,
    } = await createProjectFixture("rejoin-activation");
    const team = await database.team.findUniqueOrThrow({
      where: { id: teamId },
    });
    const environment = await database.environment.findFirstOrThrow({
      where: { projectId, lifecycle: "ACTIVE" },
    });
    const memberships = new MembershipAdministrationRepository();
    const grants = new GrantRepository();
    const activations = new MembershipRepository();
    const staging = new StagedObjectRepository();
    const invitee = await createUserAndDevice(team.serverProfileId);
    const invitedAt = new Date("2026-08-28T12:00:00.000Z");
    const invitation = await memberships.invite(database, {
      teamId,
      providerSubject: invitee.user.githubSubject,
      now: invitedAt,
      operation: {
        ...(await createOperationInput(owner.id, "rejoin-invitation")),
        actorDeviceId: device.id,
      },
    });
    if (!("invitation" in invitation))
      throw new Error("invitation creation was unexpectedly idempotent");
    const accepted = await memberships.accept(database, {
      invitationId: invitation.invitation.id,
      userId: invitee.user.id,
      operation: {
        ...(await createOperationInput(
          invitee.user.id,
          "rejoin-acceptance",
          "INVITATION",
        )),
        actorDeviceId: invitee.device.id,
      },
      now: invitedAt,
    });
    if (!("membership" in accepted))
      throw new Error("invitation acceptance was unexpectedly idempotent");
    expect(accepted.membership).toMatchObject({
      lifecycle: "PENDING_KEY_GRANT",
      role: "MEMBER",
    });
    const provisionGrant = async (label: string, membershipId: string) => {
      const grantObject = await createProtocolObjectInput(
        7,
        projectId,
        environment.id,
      );
      const grantOperation = {
        ...(await createOperationInput(owner.id, label)),
        actorDeviceId: device.id,
      };
      await new OperationRepository().begin(database, grantOperation);
      const stagedAt = new Date();
      await staging.put(database, {
        operationId: grantOperation.id,
        objectId: grantObject.id,
        actorDeviceId: device.id,
        canonicalBytes: grantObject.canonicalBytes,
        digest: grantObject.digest,
        createdAt: stagedAt,
        expiresAt: new Date(stagedAt.getTime() + 60_000),
      });
      await grants.create(database, {
        operation: grantOperation,
        grant: {
          protocolObject: grantObject,
          projectId,
          teamId,
          membershipId,
          senderDeviceId: device.id,
          recipientDeviceId: invitee.device.id,
          ownerUserId: invitee.user.id,
          keyKind: "PROJECT_EPOCH",
          grantKind: "CURRENT_PROJECT_EPOCH",
          projectEpoch: 1n,
          plaintextLength: 32,
          ciphertextLength: 48,
          ciphertextHash: new Uint8Array(48),
          recipientDeviceIds: [invitee.device.id],
        },
      });
    };
    const activateMembership = async (
      label: string,
      requiredGrantCount: number,
    ) => {
      const activationObject = await createProtocolObjectInput(
        6,
        projectId,
        environment.id,
      );
      const activateOperation = {
        ...(await createOperationInput(owner.id, label)),
        actorDeviceId: device.id,
      };
      await new OperationRepository().begin(database, activateOperation);
      const stagedAt = new Date();
      await staging.put(database, {
        operationId: activateOperation.id,
        objectId: activationObject.id,
        actorDeviceId: device.id,
        canonicalBytes: activationObject.canonicalBytes,
        digest: activationObject.digest,
        createdAt: stagedAt,
        expiresAt: new Date(stagedAt.getTime() + 60_000),
      });
      const result = await activations.activate(database, {
        operation: activateOperation,
        teamId,
        membershipId: accepted.membership.id,
        requiredGrantCount,
        activationObject,
      });
      if (!("membership" in result))
        throw new Error("activation was unexpectedly idempotent");
      return { result, activationObject };
    };

    await provisionGrant("rejoin-grant", accepted.membership.id);
    const { result: activated, activationObject: firstActivationObject } =
      await activateMembership("rejoin-activation", 1);
    expect(activated.membership.lifecycle).toBe("ACTIVE");
    expect(
      await database.membershipActivationObject.findMany({
        where: { membershipId: accepted.membership.id },
      }),
    ).toHaveLength(1);
    expect(
      await database.membershipActivationObject.findFirst({
        where: { membershipId: accepted.membership.id },
      }),
    ).toMatchObject({ protocolObjectId: firstActivationObject.id });

    const activeInvitation = await memberships.invite(database, {
      teamId,
      providerSubject: invitee.user.githubSubject,
      now: invitedAt,
      operation: {
        ...(await createOperationInput(owner.id, "rejoin-active-invitation")),
        actorDeviceId: device.id,
      },
    });
    if (!("invitation" in activeInvitation))
      throw new Error("invitation creation was unexpectedly idempotent");
    await expect(
      memberships.accept(database, {
        invitationId: activeInvitation.invitation.id,
        userId: invitee.user.id,
        operation: await createOperationInput(
          invitee.user.id,
          "rejoin-active-acceptance",
          "INVITATION",
        ),
        now: invitedAt,
      }),
    ).rejects.toThrow("already a member");

    const removed = await memberships.remove(database, {
      teamId,
      membershipId: accepted.membership.id,
      operation: {
        ...(await createOperationInput(owner.id, "rejoin-removal")),
        actorDeviceId: device.id,
      },
    });
    if (!("membership" in removed))
      throw new Error("membership removal was unexpectedly idempotent");
    const rejoinedAt = new Date("2026-09-01T12:00:00.000Z");
    const reinvitation = await memberships.invite(database, {
      teamId,
      providerSubject: invitee.user.githubSubject,
      now: rejoinedAt,
      operation: {
        ...(await createOperationInput(owner.id, "rejoin-second-invitation")),
        actorDeviceId: device.id,
      },
    });
    if (!("invitation" in reinvitation))
      throw new Error("invitation creation was unexpectedly idempotent");
    const rejoined = await memberships.accept(database, {
      invitationId: reinvitation.invitation.id,
      userId: invitee.user.id,
      operation: {
        ...(await createOperationInput(
          invitee.user.id,
          "rejoin-second-acceptance",
          "INVITATION",
        )),
        actorDeviceId: invitee.device.id,
      },
      now: rejoinedAt,
    });
    if (!("membership" in rejoined))
      throw new Error("rejoined acceptance was unexpectedly idempotent");
    expect(rejoined.membership).toMatchObject({
      id: accepted.membership.id,
      teamId,
      userId: invitee.user.id,
      lifecycle: "PENDING_KEY_GRANT",
      role: "MEMBER",
      invitationId: reinvitation.invitation.id,
      activatedAt: null,
      removedAt: null,
    });

    await provisionGrant("rejoin-second-grant", rejoined.membership.id);
    const { result: reactivated, activationObject: secondActivationObject } =
      await activateMembership("rejoin-second-activation", 2);
    expect(reactivated.membership).toMatchObject({
      id: rejoined.membership.id,
      lifecycle: "ACTIVE",
    });
    const activationHistory =
      await database.membershipActivationObject.findMany({
        where: { membershipId: rejoined.membership.id },
      });
    expect(activationHistory).toHaveLength(2);
    expect(activationHistory.map((row) => row.protocolObjectId)).toEqual(
      expect.arrayContaining([
        firstActivationObject.id,
        secondActivationObject.id,
      ]),
    );
    expect(
      await database.membership.count({
        where: { teamId, userId: invitee.user.id },
      }),
    ).toBe(1);
  });

  test("serializes concurrent revivals of one removed membership on the Team row", async () => {
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
      name: "concurrent-revival",
      operation: {
        ...(await createOperationInput(owner.id, "concurrent-revival-team")),
        actorDeviceId: device.id,
      },
    });
    const invitee = await createUserAndDevice(serverProfile.id);
    const invitedAt = new Date("2026-08-28T12:00:00.000Z");
    const seedInvitation = await memberships.invite(database, {
      teamId,
      providerSubject: invitee.user.githubSubject,
      now: invitedAt,
      operation: {
        ...(await createOperationInput(
          owner.id,
          "concurrent-revival-invitation",
        )),
        actorDeviceId: device.id,
      },
    });
    if (!("invitation" in seedInvitation))
      throw new Error("invitation creation was unexpectedly idempotent");
    const seeded = await memberships.accept(database, {
      invitationId: seedInvitation.invitation.id,
      userId: invitee.user.id,
      operation: {
        ...(await createOperationInput(
          invitee.user.id,
          "concurrent-revival-acceptance",
          "INVITATION",
        )),
        actorDeviceId: invitee.device.id,
      },
      now: invitedAt,
    });
    if (!("membership" in seeded))
      throw new Error("invitation acceptance was unexpectedly idempotent");
    await database.membership.update({
      where: { id: seeded.membership.id },
      data: { lifecycle: "ACTIVE", activatedAt: invitedAt },
    });
    const removed = await memberships.remove(database, {
      teamId,
      membershipId: seeded.membership.id,
      operation: {
        ...(await createOperationInput(owner.id, "concurrent-revival-removal")),
        actorDeviceId: device.id,
      },
    });
    if (!("membership" in removed))
      throw new Error("membership removal was unexpectedly idempotent");
    const concurrentInvitations = await Promise.all(
      [1, 2].map(async (index) =>
        memberships.invite(database, {
          teamId,
          providerSubject: invitee.user.githubSubject,
          now: invitedAt,
          operation: {
            ...(await createOperationInput(
              owner.id,
              `concurrent-revival-invitation-${index}`,
            )),
            actorDeviceId: device.id,
          },
        }),
      ),
    );
    const [firstConcurrent, secondConcurrent] = concurrentInvitations;
    if (!firstConcurrent || !secondConcurrent)
      throw new Error("expected two concurrent invitations");
    if (
      !("invitation" in firstConcurrent) ||
      !("invitation" in secondConcurrent)
    )
      throw new Error("invitation creation was unexpectedly idempotent");
    const race = async (invitationId: string, label: string) => {
      try {
        const result = await memberships.accept(database, {
          invitationId,
          userId: invitee.user.id,
          operation: {
            ...(await createOperationInput(
              invitee.user.id,
              label,
              "INVITATION",
            )),
            actorDeviceId: invitee.device.id,
          },
          now: invitedAt,
        });
        return "membership" in result
          ? {
              outcome: "revived" as const,
              membershipId: result.membership.id,
              invitationId: result.membership.invitationId,
            }
          : ({ outcome: "idempotent" } as const);
      } catch (error) {
        return {
          outcome: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    };
    const results = await Promise.all([
      race(
        firstConcurrent.invitation.id,
        "concurrent-revival-first-acceptance",
      ),
      race(
        secondConcurrent.invitation.id,
        "concurrent-revival-second-acceptance",
      ),
    ]);
    expect(
      results.filter((result) => result.outcome === "revived"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "rejected"),
    ).toHaveLength(1);
    expect(
      (
        results.find((result) => result.outcome === "rejected") as {
          message: string;
        }
      ).message,
    ).toBe("User is already a member of the Team");
    const revived = await database.membership.findUniqueOrThrow({
      where: { teamId_userId: { teamId, userId: invitee.user.id } },
    });
    const winner = results.find((result) => result.outcome === "revived") as {
      membershipId: string;
      invitationId: string;
    };
    expect(revived.id).toBe(winner.membershipId);
    expect(revived.invitationId).toBe(winner.invitationId);
    expect(revived.lifecycle).toBe("PENDING_KEY_GRANT");
    expect(
      await database.membershipInvitation.count({
        where: {
          id: {
            in: [firstConcurrent.invitation.id, secondConcurrent.invitation.id],
          },
          acceptedAt: { not: null },
        },
      }),
    ).toBe(1);
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
    const duplicate = await projects.create(database, {
      teamId,
      githubRepositoryId: project.githubRepositoryId,
      operation: {
        ...(await createOperationInput(owner.id, "duplicate-project")),
        actorDeviceId: device.id,
      },
    });
    if (!("existing" in duplicate) || !duplicate.existing)
      throw new Error(
        "duplicate Project create should return the existing Project",
      );
    expect(duplicate.project.id).toBe(project.id);
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
        label: "disclosure",
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
      label: "disclosure",
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

  test("rejects accepting an invitation after its team is archived", async () => {
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
      name: "archived-invitation",
      operation: {
        ...(await createOperationInput(owner.id, "archived-invitation-team")),
        actorDeviceId: device.id,
      },
    });
    const invited = await createUserAndDevice(serverProfile.id);
    const invitedAt = new Date();
    const invitation = await memberships.invite(database, {
      teamId,
      providerSubject: invited.user.githubSubject,
      now: invitedAt,
      operation: {
        ...(await createOperationInput(owner.id, "owner-invitation")),
        actorDeviceId: device.id,
      },
    });
    if (!("invitation" in invitation))
      throw new Error("invitation creation was unexpectedly idempotent");

    await database.team.update({
      where: { id: teamId },
      data: { lifecycle: "ARCHIVED", archivedAt: new Date() },
    });

    await expect(
      memberships.accept(database, {
        invitationId: invitation.invitation.id,
        userId: invited.user.id,
        operation: {
          ...(await createOperationInput(
            invited.user.id,
            "accept-after-archival",
            "INVITATION",
          )),
          actorDeviceId: invited.device.id,
        },
        now: invitedAt,
      }),
    ).rejects.toThrow("Team is not active");

    expect(
      await database.membership.count({
        where: { teamId, userId: invited.user.id },
      }),
    ).toBe(0);
    expect(
      await database.membershipInvitation.findUnique({
        where: { id: invitation.invitation.id },
        select: { acceptedAt: true, acceptedByUserId: true },
      }),
    ).toMatchObject({ acceptedAt: null, acceptedByUserId: null });

    await expect(
      memberships.invite(database, {
        teamId,
        providerSubject: invited.user.githubSubject,
        operation: {
          ...(await createOperationInput(owner.id, "invite-archived-team")),
          actorDeviceId: device.id,
        },
      }),
    ).rejects.toThrow("Team is not active");
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
    const duplicate = await projects.create(database, {
      teamId,
      githubRepositoryId: project.githubRepositoryId,
      operation: {
        ...(await createOperationInput(owner.id, "duplicate-project")),
        actorDeviceId: device.id,
      },
    });
    if (!("existing" in duplicate) || !duplicate.existing)
      throw new Error(
        "duplicate Project create should return the existing Project",
      );
    expect(duplicate.project.id).toBe(project.id);
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
        label: "disclosure",
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
      label: "disclosure",
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

  test("rejects a repeat GENESIS and accepts a MANIFEST_UPDATE on the second publication", async () => {
    const { device, projectId, user } = await createProjectFixture(
      "genesis-then-update",
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
      label: "genesis-then-update-genesis",
    });
    await environments.createWithGenesis(database, {
      environmentId,
      projectId,
      createdByUserId: user.id,
      publication: genesis,
    });

    const staleGenesis = await preparePublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      expectedHeadId: genesis.revision.id,
      parentHash: genesis.revisionObject.digest,
      mutation: "GENESIS",
      label: "genesis-then-update-stale-genesis",
    });
    await expect(
      publications.publishRevision(database, staleGenesis),
    ).rejects.toBeInstanceOf(GenesisExistsError);

    const update = await preparePublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      expectedHeadId: genesis.revision.id,
      parentHash: genesis.revisionObject.digest,
      mutation: "MANIFEST_UPDATE",
      label: "genesis-then-update-second-publication",
    });
    await publications.publishRevision(database, update);

    expect(
      await database.environment.findUnique({
        where: { id: environmentId },
      }),
    ).toMatchObject({ currentHeadId: update.revision.id });
    expect(
      await database.revision.findUnique({
        where: { id: update.revision.id },
      }),
    ).toMatchObject({
      parentId: genesis.revision.id,
      mutation: "MANIFEST_UPDATE",
    });
  });

  test("exercises revisions_parent_shape_check by rejecting an orphan MANIFEST_UPDATE", async () => {
    const { device, projectId, user } =
      await createProjectFixture("parent-shape-check");
    const environments = new EnvironmentRepository();
    const publications = new PublicationRepository();
    const environmentId = crypto.randomUUID();
    await environments.create(database, {
      environmentId,
      projectId,
      createdByUserId: user.id,
      label: "empty-environment",
      operation: {
        ...(await createOperationInput(user.id, "parent-shape-environment")),
        actorDeviceId: device.id,
      },
    });

    const orphan = await preparePublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      expectedHeadId: null,
      mutation: "MANIFEST_UPDATE",
      label: "parent-shape-orphan-update",
    });
    await expect(
      publications.publishRevision(database, orphan),
    ).rejects.toThrow(/revisions_parent_shape_check|check constraint/i);
    expect(
      await database.environment.findUnique({ where: { id: environmentId } }),
    ).toMatchObject({ currentHeadId: null });
    expect(await database.revision.count({ where: { environmentId } })).toBe(0);

    const genesis = await preparePublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      expectedHeadId: null,
      mutation: "GENESIS",
      label: "parent-shape-genesis",
    });
    const published = await publications.publishRevision(database, genesis);
    expect(published.revision.id).toBe(genesis.revision.id);
    expect(
      await database.revision.findUnique({
        where: { id: genesis.revision.id },
      }),
    ).toMatchObject({
      parentId: null,
      mutation: "GENESIS",
    });
    expect(
      await database.environment.findUnique({ where: { id: environmentId } }),
    ).toMatchObject({ currentHeadId: genesis.revision.id });
  });

  test("binds the published descriptor and lanes to the signed revision", async () => {
    const { device, projectId, teamId, user } =
      await createProjectFixture("manifest-binding");
    const environments = new EnvironmentRepository();
    const publications = new PublicationRepository();
    const environmentId = crypto.randomUUID();
    const serverProfile = await database.serverProfile.findFirstOrThrow({
      where: { users: { some: { id: user.id } } },
    });
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const context = {
      serverProfileId: serverProfile.id,
      teamId,
      projectId,
      environmentId,
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectEpoch: 1,
      expectedHeadId: null,
      expectedHeadHash: null,
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: signing.privateKey,
    };
    const fixtureContext = {
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
    };
    const genesisArtifacts = await createPublicationArtifacts(
      [manifestBindingVariable("MANIFEST_BINDING_GENESIS")],
      { ...context, mutation: "GENESIS" },
    );
    const genesis = await publicationFromArtifacts(
      genesisArtifacts,
      fixtureContext,
    );
    await environments.createWithGenesis(database, {
      environmentId,
      projectId,
      createdByUserId: user.id,
      publication: genesis,
    });
    const headId = genesis.revision.id;
    const updateContext = {
      ...context,
      expectedHeadId: headId,
      expectedHeadHash: genesis.revisionObject.digest,
      mutation: "MANIFEST_UPDATE" as const,
    };
    // Two valid artifact sets against the same genesis head: A's signed
    // revision commits to descriptor A (hash M1), B's to descriptor B (M2).
    const artifactsA = await createPublicationArtifacts(
      [manifestBindingVariable("MANIFEST_BINDING_A")],
      updateContext,
    );
    const artifactsB = await createPublicationArtifacts(
      [manifestBindingVariable("MANIFEST_BINDING_B")],
      updateContext,
    );
    // A's signed revision (field 52 = M1) paired with B's descriptor (M2)
    // and B's lanes/commitments: the pairing is internally consistent, so
    // only the revision's own manifest binding rejects it.
    const mismatchedDescriptor = await publicationFromArtifacts(artifactsA, {
      ...fixtureContext,
      descriptorSource: artifactsB,
      lanesSource: artifactsB,
    });
    await expect(
      publications.publishRevision(database, mismatchedDescriptor),
    ).rejects.toThrow(
      "submitted descriptor hash differs from the signed revision's manifest",
    );
    expect(
      await database.environment.findUnique({ where: { id: environmentId } }),
    ).toMatchObject({ currentHeadId: headId });

    // A revision that commits (field 53) to B's lane commitments while A's
    // descriptor still commits to A's lanes.
    const committedLanesB = parseProtocolObject(artifactsB.commandBytes).get(
      53,
    );
    if (!Array.isArray(committedLanesB))
      throw new Error("fixture B has no committed lanes");
    const mismatchedCommitments = await publicationFromArtifacts(artifactsA, {
      ...fixtureContext,
      revisionBytes: rebuiltRevisionBytes(
        artifactsA.commandBytes,
        new Map<number, CborValue>([[53, committedLanesB]]),
      ),
      lanesSource: artifactsB,
    });
    await expect(
      publications.publishRevision(database, mismatchedCommitments),
    ).rejects.toThrow(
      "signed revision lane commitments differ from its descriptor",
    );
    expect(
      await database.environment.findUnique({ where: { id: environmentId } }),
    ).toMatchObject({ currentHeadId: headId });

    // A revision that commits to A's lanes, paired with A's descriptor but
    // B's lane projections: the request no longer represents the committed
    // list.
    const mismatchedProjection = await publicationFromArtifacts(artifactsA, {
      ...fixtureContext,
      lanesSource: artifactsB,
    });
    await expect(
      publications.publishRevision(database, mismatchedProjection),
    ).rejects.toThrow(
      "request commitment projection differs from the signed revision's committed lanes",
    );
    expect(
      await database.environment.findUnique({ where: { id: environmentId } }),
    ).toMatchObject({ currentHeadId: headId });

    // The correctly paired publication still succeeds and advances the head.
    const paired = await publicationFromArtifacts(artifactsA, fixtureContext);
    const published = await publications.publishRevision(database, paired);
    expect(published.revision.id).toBe(artifactsA.request.revision.id);
    expect(published.idempotent).toBe(false);
    expect(
      await database.environment.findUnique({ where: { id: environmentId } }),
    ).toMatchObject({ currentHeadId: artifactsA.request.revision.id });
    expect(await database.revision.count({ where: { environmentId } })).toBe(2);
    expect(
      await database.manifestDescriptor.count({ where: { environmentId } }),
    ).toBe(2);
    expect(await database.laneObject.count({ where: { environmentId } })).toBe(
      4,
    );
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
      await database.auditEvent.count({
        where: { operationId: expiredOperation.id, kind: "OPERATION_EXPIRED" },
      }),
    ).toBe(1);
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

    const endpointTemplate = "/health";
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
      await database.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('dotrelay.security_request_log_access', 'security-response', true)`;
        return transaction.securityRequestLog.count({
          where: { endpointTemplate },
        });
      }),
    ).toBe(1);
  });

  test("denies Security Request Log reads to an ordinary role", async () => {
    const ordinaryRole = "dotrelay_security_request_test_ordinary";
    const requestedAt = new Date();
    await new SecurityRequestLogRepository().append(database, {
      ipAddress: "192.0.2.55",
      endpointTemplate: "/health",
      httpStatus: 401,
      transferBytes: 0n,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 60_000),
    });
    await database.$executeRawUnsafe(
      `CREATE ROLE ${ordinaryRole} NOLOGIN; GRANT SELECT ON TABLE "security_request_logs" TO ${ordinaryRole}; GRANT ${ordinaryRole} TO CURRENT_USER;`,
    );
    try {
      const visibleRows = await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `SET LOCAL ROLE ${ordinaryRole}; SET LOCAL dotrelay.security_request_log_access = 'security-response';`,
        );
        return transaction.securityRequestLog.count({
          where: { requestedAt },
        });
      });
      expect(visibleRows).toBe(0);
    } finally {
      await database.$executeRawUnsafe(
        `REVOKE ${ordinaryRole} FROM CURRENT_USER; REVOKE SELECT ON TABLE "security_request_logs" FROM ${ordinaryRole}; DROP ROLE ${ordinaryRole};`,
      );
    }
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
