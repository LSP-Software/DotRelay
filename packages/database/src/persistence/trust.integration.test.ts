import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { DatabaseClient, OperationInput, ProtocolObjectInput } from "..";
import {
  AdministrationRepository,
  createDatabaseClient,
  DeviceRepository,
  GrantRepository,
  MembershipAdministrationRepository,
  MembershipRepository,
  OperationConflictError,
  OperationRepository,
  ProjectEpochRepository,
  ProjectRepository,
  PublicationRepository,
  RecoveryRepository,
  StagedObjectRepository,
  StaleEpochError,
  StaleHeadError,
  sha384Digest,
} from "..";

const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const INTEGRATION_HOOK_TIMEOUT_MS = 30_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_trust_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const testDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (testDatabaseUrl) testDatabaseUrl.pathname = `/${testDatabaseName}`;
const adminDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (adminDatabaseUrl) adminDatabaseUrl.pathname = "/postgres";
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

const createOperationInput = async <
  Kind extends OperationInput["kind"] = "ADMINISTRATION",
>(
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
): Promise<ProtocolObjectInput> => {
  const canonicalBytes = new Uint8Array([0xa1, 0x00, protocolSequence++]);
  return {
    id: crypto.randomUUID(),
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    formatVersion: 3,
    kind,
    canonicalBytes,
    digest: await sha384Digest(canonicalBytes),
  };
};

// Like createProtocolObjectInput, but binds the object to a Project and
// Environment (required when the object is published in a revision) and
// encodes the sequence with full CBOR length prefixes.
const createBoundProtocolObject = async (
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

const createUserFixture = async (serverProfileId?: string) => {
  const serverProfile =
    serverProfileId === undefined
      ? await database.serverProfile.create({
          data: {
            id: crypto.randomUUID(),
            origin: `https://${crypto.randomUUID()}.example.test`,
          },
        })
      : await database.serverProfile.findUniqueOrThrow({
          where: { id: serverProfileId },
        });
  return database.user.create({
    data: {
      serverProfileId: serverProfile.id,
      authSubject: `auth:${crypto.randomUUID()}`,
      githubSubject: `github:${crypto.randomUUID()}`,
    },
  });
};

const createActiveDevice = async (userId: string, identityGeneration = 1n) => {
  const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
  const keyId = new Uint8Array(await sha384Digest(x25519PublicKey));
  return database.device.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      lifecycle: "ACTIVE",
      identityGeneration,
      keyId,
      x25519PublicKey,
      ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      activatedAt: new Date(),
    },
  });
};
const stageObject = async (input: {
  readonly operation: OperationInput & {
    readonly actorDeviceId: string;
  };
  readonly objectId: string;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
}) => {
  const operations = new OperationRepository();
  const staging = new StagedObjectRepository();
  await operations.begin(database, input.operation);
  const createdAt = new Date();
  await staging.put(database, {
    operationId: input.operation.id,
    objectId: input.objectId,
    actorDeviceId: input.operation.actorDeviceId,
    canonicalBytes: input.canonicalBytes,
    digest: input.digest,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 60_000),
  });
};

// Publishes a GENESIS revision onto an existing headless Environment (such
// as the default one that ProjectRepository.create provisions).
const prepareGenesisPublication = async (input: {
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly label: string;
}): Promise<{
  readonly revisionId: string;
  readonly revisionDigest: Uint8Array;
}> => {
  const operation = {
    ...(await createOperationInput(
      input.actorUserId,
      input.label,
      "REVISION_PUBLICATION",
    )),
    actorDeviceId: input.actorDeviceId,
  };
  const revisionObject = await createBoundProtocolObject(
    16,
    input.projectId,
    input.environmentId,
  );
  const descriptorObject = await createBoundProtocolObject(
    15,
    input.projectId,
    input.environmentId,
  );
  const revisionId = crypto.randomUUID();
  await stageObject({
    operation,
    objectId: revisionObject.id,
    canonicalBytes: revisionObject.canonicalBytes,
    digest: revisionObject.digest,
  });
  await stageObject({
    operation,
    objectId: descriptorObject.id,
    canonicalBytes: descriptorObject.canonicalBytes,
    digest: descriptorObject.digest,
  });
  const publication = {
    operation,
    environmentId: input.environmentId,
    expectedHeadId: null,
    revision: {
      id: revisionId,
      protocolObjectId: revisionObject.id,
      projectEpoch: 1n,
      mutation: "GENESIS" as const,
      authoredAtMs: BigInt(Date.now()),
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
      kind: "REVISION_PUBLISHED" as const,
      entityKind: "ENVIRONMENT" as const,
      entityId: input.environmentId,
    },
  };
  await new PublicationRepository().publishRevision(database, publication);
  return { revisionId, revisionDigest: revisionObject.digest };
};

integrationDescribe("trust workflow integration", () => {
  beforeAll(async () => {
    if (!adminDatabaseUrl || !testDatabaseUrl)
      throw new Error("DATABASE_URL is required");
    database = createDatabaseClient(testDatabaseUrl.toString());
    const admin = new Client({ connectionString: adminDatabaseUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`);
    } finally {
      await admin.end();
    }
    await runMigrations();
  }, INTEGRATION_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await database.$disconnect();
    if (!adminDatabaseUrl) return;
    const admin = new Client({ connectionString: adminDatabaseUrl.toString() });
    await admin.connect();
    try {
      await admin.query(
        `DROP DATABASE ${quoteIdentifier(testDatabaseName)} WITH (FORCE)`,
      );
    } finally {
      await admin.end();
    }
  }, INTEGRATION_HOOK_TIMEOUT_MS);

  test("bootstraps the first Device for a User", async () => {
    const user = await createUserFixture();
    const devices = new DeviceRepository();
    const deviceId = crypto.randomUUID();
    const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
    const certificateObject = await createProtocolObjectInput(2);
    const operation = await createOperationInput(
      user.id,
      "bootstrap-device",
      "DEVICE_ENROLLMENT",
    );
    const result = await devices.completeBootstrap(database, {
      operation,
      device: {
        id: deviceId,
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
        x25519PublicKey,
        ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      },
      certificateObject,
    });
    if (!("device" in result))
      throw new Error("bootstrap did not return a device");
    expect(result.device.lifecycle).toBe("ACTIVE");
    expect(await database.device.count({ where: { userId: user.id } })).toBe(1);
  });

  test("bootstraps an additional Device when one is already active", async () => {
    const user = await createUserFixture();
    await createActiveDevice(user.id);
    const devices = new DeviceRepository();
    const deviceId = crypto.randomUUID();
    const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
    const result = await devices.completeBootstrap(database, {
      operation: await createOperationInput(
        user.id,
        "additional-bootstrap",
        "DEVICE_ENROLLMENT",
      ),
      device: {
        id: deviceId,
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
        x25519PublicKey,
        ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      },
      certificateObject: await createProtocolObjectInput(2),
    });
    if (!("device" in result))
      throw new Error("bootstrap did not return a device");
    expect(result.device.lifecycle).toBe("ACTIVE");
    expect(await database.device.count({ where: { userId: user.id } })).toBe(2);
  });

  test("completes dual-control enrollment with approval", async () => {
    const user = await createUserFixture();
    const initiator = await createActiveDevice(user.id);
    const approver = await createActiveDevice(user.id);
    const devices = new DeviceRepository();
    const enrollmentId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const beginOperation = {
      ...(await createOperationInput(
        user.id,
        "begin-enrollment",
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: initiator.id,
    };
    await devices.beginEnrollment(database, {
      operation: beginOperation,
      enrollmentId,
      userId: user.id,
      initiatorDeviceId: initiator.id,
      transcriptHash: new Uint8Array(48),
      challengeHash: new Uint8Array(48),
      expiresAt,
    });
    expect(
      await database.auditEvent.count({
        where: {
          operationId: beginOperation.id,
          kind: "DEVICE_ENROLLMENT_STARTED",
        },
      }),
    ).toBe(1);
    const approvalObject = await createProtocolObjectInput(5);
    const approveOperation = {
      ...(await createOperationInput(
        user.id,
        "approve-enrollment",
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: approver.id,
    };
    await stageObject({
      operation: approveOperation,
      objectId: approvalObject.id,
      canonicalBytes: approvalObject.canonicalBytes,
      digest: approvalObject.digest,
    });
    await devices.approveEnrollment(database, {
      operation: approveOperation,
      enrollmentId,
      approvalObject,
    });
    expect(
      await database.auditEvent.count({
        where: {
          operationId: approveOperation.id,
          kind: "DEVICE_ENROLLMENT_APPROVED",
        },
      }),
    ).toBe(1);
    const newDeviceId = crypto.randomUUID();
    const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
    const enrollmentObject = await createProtocolObjectInput(4);
    const certificateObject = await createProtocolObjectInput(2);
    const completeOperation = {
      ...(await createOperationInput(
        user.id,
        "complete-enrollment",
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: initiator.id,
    };
    await stageObject({
      operation: completeOperation,
      objectId: enrollmentObject.id,
      canonicalBytes: enrollmentObject.canonicalBytes,
      digest: enrollmentObject.digest,
    });
    await stageObject({
      operation: completeOperation,
      objectId: certificateObject.id,
      canonicalBytes: certificateObject.canonicalBytes,
      digest: certificateObject.digest,
    });
    const completed = await devices.completeEnrollment(database, {
      operation: completeOperation,
      enrollmentId,
      device: {
        id: newDeviceId,
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
        x25519PublicKey,
        ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      },
      enrollmentObject,
      certificateObject,
    });
    if (!("device" in completed))
      throw new Error("enrollment did not return a device");
    expect(completed.device.lifecycle).toBe("ACTIVE");
  });

  test("provisions grants and activates a pending Membership", async () => {
    const owner = await createUserFixture();
    const ownerDevice = await createActiveDevice(owner.id);
    const serverProfile = await database.serverProfile.findFirstOrThrow({
      where: { users: { some: { id: owner.id } } },
    });
    const teamId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    await new AdministrationRepository().createTeamWithOwner(database, {
      teamId,
      serverProfileId: serverProfile.id,
      ownerUserId: owner.id,
      name: "trust-team",
      operation: {
        ...(await createOperationInput(owner.id, "trust-team")),
        actorDeviceId: ownerDevice.id,
      },
    });
    await new ProjectRepository().create(database, {
      teamId,
      projectId,
      githubRepositoryId: BigInt(Date.now()),
      operation: {
        ...(await createOperationInput(owner.id, "trust-project")),
        actorDeviceId: ownerDevice.id,
      },
    });
    const invitee = await createUserFixture(serverProfile.id);
    const inviteeDevice = await createActiveDevice(invitee.id);
    const invitationId = crypto.randomUUID();
    await new MembershipAdministrationRepository().invite(database, {
      teamId,
      invitationId,
      providerSubject: invitee.githubSubject,
      operation: {
        ...(await createOperationInput(owner.id, "trust-invite")),
        actorDeviceId: ownerDevice.id,
      },
    });
    const accepted = await new MembershipAdministrationRepository().accept(
      database,
      {
        invitationId,
        userId: invitee.id,
        operation: await createOperationInput(invitee.id, "trust-accept"),
      },
    );
    if (!("membership" in accepted))
      throw new Error("invitation acceptance did not return a membership");
    const membershipId = accepted.membership.id;
    const grants = new GrantRepository();
    const grantObject = await createProtocolObjectInput(7);
    const grantOperation = {
      ...(await createOperationInput(owner.id, "trust-grant")),
      actorDeviceId: ownerDevice.id,
    };
    await stageObject({
      operation: grantOperation,
      objectId: grantObject.id,
      canonicalBytes: grantObject.canonicalBytes,
      digest: grantObject.digest,
    });
    await grants.create(database, {
      operation: grantOperation,
      grant: {
        protocolObject: grantObject,
        projectId,
        teamId,
        membershipId,
        senderDeviceId: ownerDevice.id,
        recipientDeviceId: inviteeDevice.id,
        ownerUserId: invitee.id,
        keyKind: "PROJECT_EPOCH",
        grantKind: "CURRENT_PROJECT_EPOCH",
        projectEpoch: 1n,
        plaintextLength: 32,
        ciphertextLength: 48,
        ciphertextHash: new Uint8Array(48),
        recipientDeviceIds: [inviteeDevice.id],
      },
    });
    expect(
      await database.auditEvent.count({
        where: { operationId: grantOperation.id, kind: "GRANT_CREATED" },
      }),
    ).toBe(1);

    const rejectedGrantObject = await createProtocolObjectInput(8);
    const rejectedGrantOperation = {
      ...(await createOperationInput(owner.id, "trust-grant-audit-failure")),
      actorDeviceId: ownerDevice.id,
    };
    await stageObject({
      operation: rejectedGrantOperation,
      objectId: rejectedGrantObject.id,
      canonicalBytes: rejectedGrantObject.canonicalBytes,
      digest: rejectedGrantObject.digest,
    });
    await database.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION dotrelay_fail_grant_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."kind" = 'GRANT_CREATED' THEN
          RAISE EXCEPTION 'audit sink unavailable';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER dotrelay_fail_grant_audit_trigger
      BEFORE INSERT ON "audit_events"
      FOR EACH ROW EXECUTE FUNCTION dotrelay_fail_grant_audit();
    `);
    try {
      await expect(
        grants.create(database, {
          operation: rejectedGrantOperation,
          grant: {
            protocolObject: rejectedGrantObject,
            projectId,
            teamId,
            membershipId,
            senderDeviceId: ownerDevice.id,
            recipientDeviceId: inviteeDevice.id,
            ownerUserId: invitee.id,
            keyKind: "PROJECT_EPOCH",
            grantKind: "CURRENT_PROJECT_EPOCH",
            projectEpoch: 1n,
            plaintextLength: 32,
            ciphertextLength: 48,
            ciphertextHash: new Uint8Array(48),
            recipientDeviceIds: [inviteeDevice.id],
          },
        }),
      ).rejects.toThrow("audit sink unavailable");
      expect(
        await database.operation.findUnique({
          where: { id: rejectedGrantOperation.id },
        }),
      ).toMatchObject({ status: "STAGED", committedAt: null });
      expect(
        await database.stagedObject.findUnique({
          where: {
            operationId_objectId: {
              operationId: rejectedGrantOperation.id,
              objectId: rejectedGrantObject.id,
            },
          },
        }),
      ).toMatchObject({ committedAt: null });
      expect(
        await database.protocolObject.findUnique({
          where: { id: rejectedGrantObject.id },
        }),
      ).toBeNull();
    } finally {
      await database.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS dotrelay_fail_grant_audit_trigger ON "audit_events"; DROP FUNCTION IF EXISTS dotrelay_fail_grant_audit();',
      );
    }
    const activationObject = await createProtocolObjectInput(6);
    const activateOperation = {
      ...(await createOperationInput(owner.id, "trust-activate")),
      actorDeviceId: ownerDevice.id,
    };
    await stageObject({
      operation: activateOperation,
      objectId: activationObject.id,
      canonicalBytes: activationObject.canonicalBytes,
      digest: activationObject.digest,
    });
    const activated = await new MembershipRepository().activate(database, {
      operation: activateOperation,
      teamId,
      membershipId,
      requiredGrantCount: 1,
      activationObject,
    });
    if (!("membership" in activated))
      throw new Error("activation did not return a membership");
    expect(activated.membership.lifecycle).toBe("ACTIVE");
  });

  test("revokes a Device and replaces a Recovery envelope", async () => {
    const user = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const target = await createActiveDevice(user.id);
    const devices = new DeviceRepository();
    const revokeOperation = {
      ...(await createOperationInput(
        user.id,
        "revoke-device",
        "ADMINISTRATION",
      )),
      actorDeviceId: device.id,
    };
    const revoked = await devices.revoke(database, {
      operation: revokeOperation,
      deviceId: target.id,
    });
    if (!("device" in revoked))
      throw new Error("revoke did not return a device");
    expect(revoked.device.lifecycle).toBe("REVOKED");

    const recovery = new RecoveryRepository();
    const envelopeObject = await createProtocolObjectInput(10);
    const recoveryOperation = {
      ...(await createOperationInput(user.id, "recovery-envelope", "RECOVERY")),
      actorDeviceId: device.id,
    };
    await stageObject({
      operation: recoveryOperation,
      objectId: envelopeObject.id,
      canonicalBytes: envelopeObject.canonicalBytes,
      digest: envelopeObject.digest,
    });
    const envelope = await recovery.replaceEnvelope(database, {
      operation: recoveryOperation,
      envelope: {
        id: crypto.randomUUID(),
        protocolObject: envelopeObject,
        identityGeneration: 1n,
        recoveryGeneration: 2n,
        ciphertextHash: new Uint8Array(48),
        ciphertextLength: 128,
      },
    });
    if (!("envelope" in envelope))
      throw new Error("recovery did not return an envelope");
    expect(envelope.envelope.recoveryGeneration).toBe(2n);
    await recovery.recordAttempt(database, {
      userId: user.id,
      deviceId: device.id,
      envelopeId: envelope.envelope.id,
      challengeHash: new Uint8Array(48),
      succeeded: false,
    });
  });

  test("refuses stale epoch rotation and duplicate operation bytes", async () => {
    const user = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const serverProfile = await database.serverProfile.findFirstOrThrow({
      where: { users: { some: { id: user.id } } },
    });
    const teamId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    await new AdministrationRepository().createTeamWithOwner(database, {
      teamId,
      serverProfileId: serverProfile.id,
      ownerUserId: user.id,
      name: "epoch-team",
      operation: {
        ...(await createOperationInput(user.id, "epoch-team")),
        actorDeviceId: device.id,
      },
    });
    await new ProjectRepository().create(database, {
      teamId,
      projectId,
      githubRepositoryId: BigInt(Date.now() + 1),
      operation: {
        ...(await createOperationInput(user.id, "epoch-project")),
        actorDeviceId: device.id,
      },
    });
    const epochRotation = new ProjectEpochRepository();
    const staleOperation = {
      ...(await createOperationInput(user.id, "stale-epoch", "EPOCH_ROTATION")),
      actorDeviceId: device.id,
    };
    await expect(
      epochRotation.rotate(database, {
        operation: staleOperation,
        projectId,
        expectedEpoch: 2n,
        newEpoch: 3n,
        transitions: [],
      }),
    ).rejects.toBeInstanceOf(StaleEpochError);

    const operations = new OperationRepository();
    const operation = await createOperationInput(user.id, "idempotent-trust");
    await operations.begin(database, {
      ...operation,
      actorDeviceId: device.id,
    });
    await expect(
      operations.begin(database, {
        ...operation,
        id: crypto.randomUUID(),
        actorDeviceId: device.id,
      }),
    ).rejects.toBeInstanceOf(OperationConflictError);
  });
  test("rotates the Project epoch, re-anchors Environment heads, and refuses stale or replayed transitions", async () => {
    const user = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const serverProfile = await database.serverProfile.findFirstOrThrow({
      where: { users: { some: { id: user.id } } },
    });
    const teamId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    await new AdministrationRepository().createTeamWithOwner(database, {
      teamId,
      serverProfileId: serverProfile.id,
      ownerUserId: user.id,
      name: "rotation-team",
      operation: {
        ...(await createOperationInput(user.id, "rotation-team")),
        actorDeviceId: device.id,
      },
    });
    const createdProject = await new ProjectRepository().create(database, {
      teamId,
      projectId,
      githubRepositoryId: BigInt(Date.now() + 2),
      operation: {
        ...(await createOperationInput(user.id, "rotation-project")),
        actorDeviceId: device.id,
      },
    });
    if (!("environment" in createdProject))
      throw new Error("project creation did not provision an environment");
    const environmentId = createdProject.environment.id;
    const genesis = await prepareGenesisPublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId,
      label: "rotation-genesis",
    });
    const genesisHead = genesis.revisionId;

    const epochRotation = new ProjectEpochRepository();
    const operations = new OperationRepository();
    const rotationOperation = {
      ...(await createOperationInput(
        user.id,
        "rotate-epoch-1-to-2",
        "EPOCH_ROTATION",
      )),
      actorDeviceId: device.id,
    };
    await operations.begin(database, rotationOperation);
    const transitionRevisionId = crypto.randomUUID();
    const transitionObject = await createProtocolObjectInput(12);
    const transitionRevisionObject = await createBoundProtocolObject(
      16,
      projectId,
      environmentId,
    );
    const transitionDescriptorObject = await createBoundProtocolObject(
      15,
      projectId,
      environmentId,
    );
    for (const protocolObject of [
      transitionObject,
      transitionRevisionObject,
      transitionDescriptorObject,
    ]) {
      await stageObject({
        operation: rotationOperation,
        objectId: protocolObject.id,
        canonicalBytes: protocolObject.canonicalBytes,
        digest: protocolObject.digest,
      });
    }
    const transitionPublication = {
      operation: {
        id: rotationOperation.id,
        actorUserId: user.id,
        actorDeviceId: device.id,
        kind: "REVISION_PUBLICATION" as const,
        commandBytes: rotationOperation.commandBytes,
        commandDigest: rotationOperation.commandDigest,
      },
      environmentId,
      expectedHeadId: genesisHead,
      revision: {
        id: transitionRevisionId,
        protocolObjectId: transitionRevisionObject.id,
        parentHash: genesis.revisionDigest,
        projectEpoch: 2n,
        mutation: "EPOCH_TRANSITION" as const,
        authoredAtMs: BigInt(Date.now()),
      },
      revisionObject: transitionRevisionObject,
      descriptor: {
        protocolObject: transitionDescriptorObject,
        schemaVersion: 1,
        descriptorHash: transitionDescriptorObject.digest,
        laneCount: 0,
      },
      lanes: [],
      commitments: [],
      audit: {
        kind: "REVISION_PUBLISHED" as const,
        entityKind: "ENVIRONMENT" as const,
        entityId: environmentId,
      },
    };
    const rotateInput = {
      operation: rotationOperation,
      projectId,
      expectedEpoch: 1n,
      newEpoch: 2n,
      transitions: [
        {
          environmentId,
          expectedHeadId: genesisHead,
          newHeadId: transitionRevisionId,
          protocolObject: transitionObject,
          publication: transitionPublication,
        },
      ],
    };
    const result = await epochRotation.rotate(database, rotateInput);
    if (!("projectEpoch" in result))
      throw new Error("rotation reported an idempotent replay");
    expect(result.projectEpoch).toBe(2n);

    const project = await database.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    expect(project.currentEpoch).toBe(2n);
    const rotatedEnvironment = await database.environment.findUniqueOrThrow({
      where: { id: environmentId },
    });
    expect(rotatedEnvironment.currentHeadId).toBe(transitionRevisionId);
    const transitionRevision = await database.revision.findUniqueOrThrow({
      where: { id: transitionRevisionId },
    });
    expect(transitionRevision.parentId).toBe(genesisHead);
    expect(transitionRevision.projectEpoch).toBe(2n);
    expect(transitionRevision.mutation).toBe("EPOCH_TRANSITION");
    const epochTransition =
      await database.epochTransitionObject.findUniqueOrThrow({
        where: { protocolObjectId: transitionObject.id },
      });
    expect(epochTransition.previousEpoch).toBe(1n);
    expect(epochTransition.newEpoch).toBe(2n);
    expect(epochTransition.expectedHeadId).toBe(genesisHead);
    expect(epochTransition.newHeadId).toBe(transitionRevisionId);
    const rotationRow = await database.operation.findUniqueOrThrow({
      where: { id: rotationOperation.id },
    });
    expect(rotationRow.status).toBe("COMMITTED");
    expect(
      await database.auditEvent.count({
        where: {
          operationId: rotationOperation.id,
          kind: "EPOCH_ROTATED",
        },
      }),
    ).toBe(1);

    // A replay of the committed rotation is a no-op that keeps the new epoch.
    const replay = await epochRotation.rotate(database, rotateInput);
    if (!("idempotent" in replay) || !replay.idempotent)
      throw new Error("committed rotation replay was not idempotent");
    expect(
      (await database.project.findUniqueOrThrow({ where: { id: projectId } }))
        .currentEpoch,
    ).toBe(2n);

    // A transition that still names the old epoch is stale.
    const staleEpochRotation = {
      ...(await createOperationInput(
        user.id,
        "rotate-stale-epoch",
        "EPOCH_ROTATION",
      )),
      actorDeviceId: device.id,
    };
    await operations.begin(database, staleEpochRotation);
    await expect(
      epochRotation.rotate(database, {
        operation: staleEpochRotation,
        projectId,
        expectedEpoch: 1n,
        newEpoch: 2n,
        transitions: [],
      }),
    ).rejects.toBeInstanceOf(StaleEpochError);

    // A transition that anchors on the pre-rotation head is stale: each
    // Environment's trust history re-anchors at the EPOCH_TRANSITION revision.
    const staleHeadRotation = {
      ...(await createOperationInput(
        user.id,
        "rotate-stale-head",
        "EPOCH_ROTATION",
      )),
      actorDeviceId: device.id,
    };
    await operations.begin(database, staleHeadRotation);
    const staleHeadObject = await createProtocolObjectInput(12);
    const staleHeadRevisionObject = await createBoundProtocolObject(
      16,
      projectId,
      environmentId,
    );
    const staleHeadDescriptorObject = await createBoundProtocolObject(
      15,
      projectId,
      environmentId,
    );
    await expect(
      epochRotation.rotate(database, {
        operation: staleHeadRotation,
        projectId,
        expectedEpoch: 2n,
        newEpoch: 3n,
        transitions: [
          {
            environmentId,
            expectedHeadId: genesisHead,
            newHeadId: crypto.randomUUID(),
            protocolObject: staleHeadObject,
            publication: {
              operation: {
                id: staleHeadRotation.id,
                actorUserId: user.id,
                actorDeviceId: device.id,
                kind: "REVISION_PUBLICATION" as const,
                commandBytes: staleHeadRotation.commandBytes,
                commandDigest: staleHeadRotation.commandDigest,
              },
              environmentId,
              expectedHeadId: genesisHead,
              revision: {
                id: crypto.randomUUID(),
                protocolObjectId: staleHeadRevisionObject.id,
                parentHash: genesis.revisionDigest,
                projectEpoch: 3n,
                mutation: "EPOCH_TRANSITION" as const,
                authoredAtMs: 0n,
              },
              revisionObject: staleHeadRevisionObject,
              descriptor: {
                protocolObject: staleHeadDescriptorObject,
                schemaVersion: 1,
                descriptorHash: staleHeadDescriptorObject.digest,
                laneCount: 0,
              },
              lanes: [],
              commitments: [],
              audit: {
                kind: "REVISION_PUBLISHED" as const,
                entityKind: "ENVIRONMENT" as const,
                entityId: environmentId,
              },
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(StaleHeadError);
  });
});
