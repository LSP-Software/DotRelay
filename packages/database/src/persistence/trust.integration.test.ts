import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  type CborValue,
  canonicalEncode,
  encodeProtocolObject,
  protocolObjectFromFields,
  uuidToBytes,
} from "@dotrelay/contracts";
import type {
  DatabaseClient,
  OperationInput,
  ProtocolObjectInput,
  RevisionPublicationInput,
} from "..";
import {
  AccountKeyRepository,
  AdministrationRepository,
  createDatabaseClient,
  DeviceRepository,
  EnvironmentRepository,
  GrantRepository,
  MembershipAdministrationRepository,
  MembershipRepository,
  OperationConflictError,
  OperationRepository,
  ProjectEpochRepository,
  ProjectRepository,
  PublicationRepository,
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

const PUBLICATION_PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const PUBLICATION_TEAM_ID = "00000000-0000-4000-8000-000000000002";

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

const boundProtocolInput = async (
  kind: number,
  canonicalBytes: Uint8Array,
  projectId: string,
  environmentId: string,
): Promise<ProtocolObjectInput> => ({
  id: crypto.randomUUID(),
  suite: "dotrelay-e2ee-v3-classical-webcrypto",
  formatVersion: 3,
  kind,
  canonicalBytes,
  digest: await sha384Digest(canonicalBytes),
  projectId,
  environmentId,
});

type PublicationObjectContext = Readonly<{
  readonly projectId: string;
  readonly environmentId: string;
  readonly revisionId: string;
  readonly projectEpoch: bigint;
}>;

const createDescriptorObjectInput = (
  context: PublicationObjectContext,
): Promise<ProtocolObjectInput> =>
  boundProtocolInput(
    15,
    signedProtocolBytes(
      15,
      new Map<number, CborValue>([
        [8, uuidToBytes(PUBLICATION_PROFILE_ID)],
        [11, uuidToBytes(PUBLICATION_TEAM_ID)],
        [13, uuidToBytes(context.projectId)],
        [14, uuidToBytes(context.environmentId)],
        [16, uuidToBytes(context.revisionId)],
        [30, context.projectEpoch],
        [50, 1],
        [53, []],
      ]),
    ),
    context.projectId,
    context.environmentId,
  );

const createRevisionObjectInput = (
  input: PublicationObjectContext &
    Readonly<{
      readonly actorUserId: string;
      readonly actorDeviceId: string;
      readonly mutationKind: number;
      readonly expectedHeadId?: string | null;
      readonly parentHash?: Uint8Array;
      readonly rollbackTargetId?: string;
      readonly descriptorBytes: Uint8Array;
      readonly descriptorDigest: Uint8Array;
    }>,
): Promise<ProtocolObjectInput> => {
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(PUBLICATION_PROFILE_ID)],
    [11, uuidToBytes(PUBLICATION_TEAM_ID)],
    [13, uuidToBytes(input.projectId)],
    [14, uuidToBytes(input.environmentId)],
    [16, uuidToBytes(input.revisionId)],
    [17, uuidToBytes(crypto.randomUUID())],
    [19, uuidToBytes(input.expectedHeadId ?? input.environmentId)],
    [20, input.parentHash ?? new Uint8Array(48)],
    [22, uuidToBytes(input.actorUserId)],
    [23, uuidToBytes(input.actorDeviceId)],
    [30, input.projectEpoch],
    [34, Date.now()],
    [35, input.mutationKind],
    [50, 1],
    [51, input.descriptorBytes],
    [52, input.descriptorDigest],
    [53, []],
    [54, []],
  ]);
  if (input.mutationKind === 3) {
    fields.set(21, uuidToBytes(input.rollbackTargetId ?? input.environmentId));
    fields.set(68, []);
  }
  return boundProtocolInput(
    16,
    signedProtocolBytes(16, fields),
    input.projectId,
    input.environmentId,
  );
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

// Builds a GENESIS revision publication for an existing headless Environment
// (such as the default one that ProjectRepository.create provisions) without
// publishing it, so callers can also hand it to createWithGenesis.
const buildGenesisPublication = async (input: {
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly label: string;
}): Promise<RevisionPublicationInput> => {
  const operation = {
    ...(await createOperationInput(
      input.actorUserId,
      input.label,
      "REVISION_PUBLICATION",
    )),
    actorDeviceId: input.actorDeviceId,
  };
  const revisionId = crypto.randomUUID();
  const descriptorObject = await createDescriptorObjectInput({
    projectId: input.projectId,
    environmentId: input.environmentId,
    revisionId,
    projectEpoch: 1n,
  });
  const revisionObject = await createRevisionObjectInput({
    projectId: input.projectId,
    environmentId: input.environmentId,
    revisionId,
    projectEpoch: 1n,
    actorUserId: input.actorUserId,
    actorDeviceId: input.actorDeviceId,
    mutationKind: 1,
    expectedHeadId: null,
    descriptorBytes: descriptorObject.canonicalBytes,
    descriptorDigest: descriptorObject.digest,
  });
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
  return {
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
};

// Publishes a GENESIS revision onto an existing headless Environment.
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
  const publication = await buildGenesisPublication(input);
  await new PublicationRepository().publishRevision(database, publication);
  return {
    revisionId: publication.revision.id,
    revisionDigest: publication.revisionObject.digest,
  };
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

  // ADR 0010: a Device created by initial trust bootstrap is fully ACTIVE.
  // It may perform device-level authorization on its own behalf, including
  // approving an enrollment that a different Device initiated. The
  // lifecycle gate is "active", not "enrolled through dual control".
  test("a session-bootstrapped Device is ACTIVE and can approve an enrollment", async () => {
    const user = await createUserFixture();
    const devices = new DeviceRepository();
    const bootstrapKey = crypto.getRandomValues(new Uint8Array(32));
    const bootstrap = await devices.completeBootstrap(database, {
      operation: await createOperationInput(
        user.id,
        "bootstrap-approver",
        "DEVICE_ENROLLMENT",
      ),
      device: {
        id: crypto.randomUUID(),
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(bootstrapKey)),
        x25519PublicKey: bootstrapKey,
        ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      },
      certificateObject: await createProtocolObjectInput(2),
    });
    if (!("device" in bootstrap))
      throw new Error("bootstrap did not return a device");
    expect(bootstrap.device.lifecycle).toBe("ACTIVE");
    const initiator = await createActiveDevice(user.id);
    const enrollmentId = crypto.randomUUID();
    const beginOperation = {
      ...(await createOperationInput(
        user.id,
        "begin-bootstrap-approval",
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
      expiresAt: new Date(Date.now() + 60_000),
    });
    const approvalObject = await createProtocolObjectInput(5);
    const approveOperation = {
      ...(await createOperationInput(
        user.id,
        "approve-bootstrap-approval",
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: bootstrap.device.id,
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

  test("revokes a Device and manages Account Key wrappers", async () => {
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

    const accountKeys = new AccountKeyRepository();
    const recoveryCodeObject = await createProtocolObjectInput(20);
    const recoveryCodeOperation = {
      ...(await createOperationInput(
        user.id,
        "recovery-code-wrapper",
        "ACCOUNT_KEY",
      )),
      actorDeviceId: device.id,
    };
    await stageObject({
      operation: recoveryCodeOperation,
      objectId: recoveryCodeObject.id,
      canonicalBytes: recoveryCodeObject.canonicalBytes,
      digest: recoveryCodeObject.digest,
    });
    const recoveryCodeResult = await accountKeys.addWrapper(database, {
      operation: recoveryCodeOperation,
      wrapper: {
        protocolObject: recoveryCodeObject,
        identityGeneration: 1n,
        wrapperType: "RECOVERY_CODE",
        wrapperId: crypto.getRandomValues(new Uint8Array(16)),
        ciphertextHash: new Uint8Array(48),
        ciphertextLength: 128,
      },
    });
    if (!("wrapper" in recoveryCodeResult))
      throw new Error("addWrapper did not return a wrapper");
    const passwordObject = await createProtocolObjectInput(20);
    const passwordOperation = {
      ...(await createOperationInput(
        user.id,
        "password-wrapper",
        "ACCOUNT_KEY",
      )),
      actorDeviceId: device.id,
    };
    await stageObject({
      operation: passwordOperation,
      objectId: passwordObject.id,
      canonicalBytes: passwordObject.canonicalBytes,
      digest: passwordObject.digest,
    });
    await accountKeys.addWrapper(database, {
      operation: passwordOperation,
      wrapper: {
        protocolObject: passwordObject,
        identityGeneration: 1n,
        wrapperType: "PASSWORD",
        wrapperId: crypto.getRandomValues(new Uint8Array(16)),
        kdfName: 1,
        kdfMemoryKib: 65536n,
        kdfIterations: 3n,
        kdfParallelism: 1,
        ciphertextHash: new Uint8Array(48),
        ciphertextLength: 128,
      },
    });
    const retiredRecoveryCode =
      await database.accountKeyWrapperObject.findUniqueOrThrow({
        where: {
          protocolObjectId: recoveryCodeResult.wrapper.protocolObjectId,
        },
      });
    expect(retiredRecoveryCode.retiredAt).toBeNull();

    await expect(
      accountKeys.revokeWrapper(database, {
        operation: {
          ...(await createOperationInput(
            user.id,
            "revoke-unknown-wrapper",
            "ACCOUNT_KEY",
          )),
          actorDeviceId: device.id,
        },
        wrapperId: crypto.getRandomValues(new Uint8Array(16)),
      }),
    ).rejects.toThrow("account key wrapper is not active for this user");
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
    const transitionDescriptorObject = await createDescriptorObjectInput({
      projectId,
      environmentId,
      revisionId: transitionRevisionId,
      projectEpoch: 2n,
    });
    const transitionRevisionObject = await createRevisionObjectInput({
      projectId,
      environmentId,
      revisionId: transitionRevisionId,
      projectEpoch: 2n,
      actorUserId: user.id,
      actorDeviceId: device.id,
      mutationKind: 4,
      expectedHeadId: genesisHead,
      parentHash: genesis.revisionDigest,
      descriptorBytes: transitionDescriptorObject.canonicalBytes,
      descriptorDigest: transitionDescriptorObject.digest,
    });
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
    const staleHeadRevisionId = crypto.randomUUID();
    const staleHeadDescriptorObject = await createDescriptorObjectInput({
      projectId,
      environmentId,
      revisionId: staleHeadRevisionId,
      projectEpoch: 3n,
    });
    const staleHeadRevisionObject = await createRevisionObjectInput({
      projectId,
      environmentId,
      revisionId: staleHeadRevisionId,
      projectEpoch: 3n,
      actorUserId: user.id,
      actorDeviceId: device.id,
      mutationKind: 4,
      expectedHeadId: genesisHead,
      parentHash: genesis.revisionDigest,
      descriptorBytes: staleHeadDescriptorObject.canonicalBytes,
      descriptorDigest: staleHeadDescriptorObject.digest,
    });
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
                id: staleHeadRevisionId,
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

  test("rotates the Project epoch across multiple Environments under one shared operation", async () => {
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
      name: "multi-environment-team",
      operation: {
        ...(await createOperationInput(user.id, "multi-environment-team")),
        actorDeviceId: device.id,
      },
    });
    const createdProject = await new ProjectRepository().create(database, {
      teamId,
      projectId,
      githubRepositoryId: BigInt(Date.now() + 100),
      operation: {
        ...(await createOperationInput(user.id, "multi-environment-project")),
        actorDeviceId: device.id,
      },
    });
    if (!("environment" in createdProject))
      throw new Error("project creation did not provision an environment");
    const defaultEnvironmentId = createdProject.environment.id;
    const defaultGenesis = await prepareGenesisPublication({
      actorUserId: user.id,
      actorDeviceId: device.id,
      projectId,
      environmentId: defaultEnvironmentId,
      label: "multi-environment-genesis",
    });
    const environmentsRepository = new EnvironmentRepository();
    const environmentIds = [defaultEnvironmentId];
    const currentHeads: Record<
      string,
      { revisionId: string; revisionDigest: Uint8Array }
    > = {
      [defaultEnvironmentId]: {
        revisionId: defaultGenesis.revisionId,
        revisionDigest: defaultGenesis.revisionDigest,
      },
    };
    for (const label of ["staging", "production"]) {
      const environmentId = crypto.randomUUID();
      const publication = await buildGenesisPublication({
        actorUserId: user.id,
        actorDeviceId: device.id,
        projectId,
        environmentId,
        label: `${label}-genesis`,
      });
      const created = await environmentsRepository.createWithGenesis(database, {
        environmentId,
        projectId,
        createdByUserId: user.id,
        label,
        publication,
      });
      if (created.idempotent)
        throw new Error("genesis publication was unexpectedly idempotent");
      environmentIds.push(environmentId);
      currentHeads[environmentId] = {
        revisionId: created.revision.id,
        revisionDigest: publication.revisionObject.digest,
      };
    }

    const epochRotation = new ProjectEpochRepository();
    const operations = new OperationRepository();
    const buildTransition = async (input: {
      readonly operation: OperationInput & { readonly actorDeviceId: string };
      readonly environmentId: string;
      readonly expectedHeadId: string;
      readonly parentHash: Uint8Array;
      readonly projectEpoch: bigint;
    }) => {
      // The EPOCH_TRANSITION metadata object is staged but never parsed by
      // the publication checks, which only inspect the signed revision and
      // descriptor bytes, so it can stay minimal.
      const transitionObject = await createProtocolObjectInput(12);
      const revisionId = crypto.randomUUID();
      const descriptorObject = await createDescriptorObjectInput({
        projectId,
        environmentId: input.environmentId,
        revisionId,
        projectEpoch: input.projectEpoch,
      });
      const revisionObject = await createRevisionObjectInput({
        projectId,
        environmentId: input.environmentId,
        revisionId,
        projectEpoch: input.projectEpoch,
        actorUserId: user.id,
        actorDeviceId: device.id,
        mutationKind: 4,
        expectedHeadId: input.expectedHeadId,
        parentHash: input.parentHash,
        descriptorBytes: descriptorObject.canonicalBytes,
        descriptorDigest: descriptorObject.digest,
      });
      for (const protocolObject of [
        transitionObject,
        revisionObject,
        descriptorObject,
      ]) {
        await stageObject({
          operation: input.operation,
          objectId: protocolObject.id,
          canonicalBytes: protocolObject.canonicalBytes,
          digest: protocolObject.digest,
        });
      }
      const publication = {
        operation: {
          id: input.operation.id,
          actorUserId: user.id,
          actorDeviceId: device.id,
          kind: "REVISION_PUBLICATION" as const,
          commandBytes: input.operation.commandBytes,
          commandDigest: input.operation.commandDigest,
        },
        environmentId: input.environmentId,
        expectedHeadId: input.expectedHeadId,
        revision: {
          id: revisionId,
          protocolObjectId: revisionObject.id,
          parentHash: input.parentHash,
          projectEpoch: input.projectEpoch,
          mutation: "EPOCH_TRANSITION" as const,
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
      return { transitionObject, revisionId, publication };
    };

    // One shared EPOCH_ROTATION operation drives a publication into every
    // Environment; the first publication alone used to commit it and make
    // the remaining Environments short-circuit as idempotent replays.
    const rotationOperation = {
      ...(await createOperationInput(
        user.id,
        "rotate-multi-epoch-1-to-2",
        "EPOCH_ROTATION",
      )),
      actorDeviceId: device.id,
    };
    await operations.begin(database, rotationOperation);
    type RotationTransition = Readonly<{
      environmentId: string;
      expectedHeadId: string;
      newHeadId: string;
      protocolObject: ProtocolObjectInput;
      publication: RevisionPublicationInput;
    }>;
    const rotatedHeadIds: Record<string, string> = {};
    const epoch2HeadDigests: Record<string, Uint8Array> = {};
    const rotateTransitions: RotationTransition[] = [];
    for (const environmentId of environmentIds) {
      const head = currentHeads[environmentId]!;
      const transition = await buildTransition({
        operation: rotationOperation,
        environmentId,
        expectedHeadId: head.revisionId,
        parentHash: head.revisionDigest,
        projectEpoch: 2n,
      });
      rotateTransitions.push({
        environmentId,
        expectedHeadId: head.revisionId,
        newHeadId: transition.revisionId,
        protocolObject: transition.transitionObject,
        publication: transition.publication,
      });
      rotatedHeadIds[environmentId] = transition.revisionId;
      epoch2HeadDigests[environmentId] =
        transition.publication.revisionObject.digest;
    }
    const rotateInput = {
      operation: rotationOperation,
      projectId,
      expectedEpoch: 1n,
      newEpoch: 2n,
      transitions: rotateTransitions,
    };

    const result = await epochRotation.rotate(database, rotateInput);
    if (!("projectEpoch" in result))
      throw new Error("rotation reported an idempotent replay");
    expect(result.projectEpoch).toBe(2n);
    expect(
      (await database.project.findUniqueOrThrow({ where: { id: projectId } }))
        .currentEpoch,
    ).toBe(2n);
    const rotatedOperation = await database.operation.findUniqueOrThrow({
      where: { id: rotationOperation.id },
      include: { revisions: true },
    });
    expect(rotatedOperation.status).toBe("COMMITTED");
    // The one shared operation owns exactly one revision per Environment.
    expect(rotatedOperation.revisions).toHaveLength(environmentIds.length);
    expect(
      rotatedOperation.revisions
        .map(({ environmentId }) => environmentId)
        .sort(),
    ).toEqual([...environmentIds].sort());
    for (const environmentId of environmentIds) {
      const environment = await database.environment.findUniqueOrThrow({
        where: { id: environmentId },
      });
      expect(environment.currentHeadId).toBe(rotatedHeadIds[environmentId]!);
      const revision = await database.revision.findUniqueOrThrow({
        where: { id: rotatedHeadIds[environmentId]! },
      });
      expect(revision.parentId).toBe(currentHeads[environmentId]!.revisionId);
      expect(revision.projectEpoch).toBe(2n);
      expect(revision.mutation).toBe("EPOCH_TRANSITION");
      expect(revision.operationId).toBe(rotationOperation.id);
    }
    expect(
      await database.epochTransitionObject.count({
        where: { projectId, newEpoch: 2n },
      }),
    ).toBe(environmentIds.length);
    expect(
      await database.auditEvent.count({
        where: {
          operationId: rotationOperation.id,
          kind: "EPOCH_ROTATED",
        },
      }),
    ).toBe(1);

    // A replay of the committed multi-Environment rotation is a no-op.
    const replay = await epochRotation.rotate(database, rotateInput);
    if (!("idempotent" in replay) || !replay.idempotent)
      throw new Error("committed rotation replay was not idempotent");
    expect(
      (await database.project.findUniqueOrThrow({ where: { id: projectId } }))
        .currentEpoch,
    ).toBe(2n);
    expect(
      await database.revision.count({
        where: { operationId: rotationOperation.id },
      }),
    ).toBe(environmentIds.length);
    for (const environmentId of environmentIds) {
      const environment = await database.environment.findUniqueOrThrow({
        where: { id: environmentId },
      });
      expect(environment.currentHeadId).toBe(rotatedHeadIds[environmentId]!);
    }

    // A later Environment's transition failing (wrong parent hash) rolls the
    // whole rotation back: earlier Environments already published inside the
    // same transaction, so the rollback must undo them too.
    const failureOperation = {
      ...(await createOperationInput(
        user.id,
        "rotate-multi-epoch-2-to-3",
        "EPOCH_ROTATION",
      )),
      actorDeviceId: device.id,
    };
    await operations.begin(database, failureOperation);
    const sortedEnvironmentIds = [...environmentIds].sort();
    const failingEnvironmentId = sortedEnvironmentIds.at(-1)!;
    for (const environmentId of environmentIds)
      currentHeads[environmentId] = {
        revisionId: rotatedHeadIds[environmentId]!,
        revisionDigest: epoch2HeadDigests[environmentId]!,
      };
    const failureInput = {
      operation: failureOperation,
      projectId,
      expectedEpoch: 2n,
      newEpoch: 3n,
      transitions: [] as typeof rotateInput.transitions,
    };
    for (const environmentId of environmentIds) {
      const isFailingEnvironment = environmentId === failingEnvironmentId;
      const transition = await buildTransition({
        operation: failureOperation,
        environmentId,
        expectedHeadId: currentHeads[environmentId]!.revisionId,
        // defaultGenesis.revisionDigest belongs to another Environment, so
        // the parent-hash check fails after the earlier Environments
        // published successfully.
        parentHash: isFailingEnvironment
          ? defaultGenesis.revisionDigest
          : epoch2HeadDigests[environmentId]!,
        projectEpoch: 3n,
      });
      failureInput.transitions.push({
        environmentId,
        expectedHeadId: currentHeads[environmentId]!.revisionId,
        newHeadId: transition.revisionId,
        protocolObject: transition.transitionObject,
        publication: transition.publication,
      });
    }
    await expect(
      epochRotation.rotate(database, failureInput),
    ).rejects.toBeInstanceOf(StaleHeadError);
    expect(
      (await database.project.findUniqueOrThrow({ where: { id: projectId } }))
        .currentEpoch,
    ).toBe(2n);
    expect(
      await database.operation.findUniqueOrThrow({
        where: { id: failureOperation.id },
      }),
    ).toMatchObject({ status: "STAGED", committedAt: null });
    expect(
      await database.revision.count({
        where: { operationId: failureOperation.id },
      }),
    ).toBe(0);
    for (const environmentId of environmentIds) {
      const environment = await database.environment.findUniqueOrThrow({
        where: { id: environmentId },
      });
      expect(environment.currentHeadId).toBe(rotatedHeadIds[environmentId]!);
    }
    expect(
      await database.epochTransitionObject.count({
        where: { projectId, newEpoch: 3n },
      }),
    ).toBe(0);
  });

  test("a committed publication operation cannot publish a second revision", async () => {
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
      name: "publication-idempotency-team",
      operation: {
        ...(await createOperationInput(
          user.id,
          "publication-idempotency-team",
        )),
        actorDeviceId: device.id,
      },
    });
    const createdProject = await new ProjectRepository().create(database, {
      teamId,
      projectId,
      githubRepositoryId: BigInt(Date.now() + 200),
      operation: {
        ...(await createOperationInput(
          user.id,
          "publication-idempotency-project",
        )),
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
      label: "publication-idempotency-genesis",
    });

    const publications = new PublicationRepository();
    const operations = new OperationRepository();
    const publicationOperation = {
      ...(await createOperationInput(
        user.id,
        "committed-publication",
        "REVISION_PUBLICATION",
      )),
      actorDeviceId: device.id,
    };
    await operations.begin(database, publicationOperation);

    // Stage the objects of two consecutive manifest updates on the one
    // operation while it is still STAGED, before either is published. The
    // signed revision names its own id, its expected head, and the parent
    // it will chain onto, so all of that is fixed when the objects are
    // staged.
    const stageUpdateObjects = async (input: {
      readonly expectedHeadId: string;
      readonly parentHash: Uint8Array;
    }) => {
      const revisionId = crypto.randomUUID();
      const descriptorObject = await createDescriptorObjectInput({
        projectId,
        environmentId,
        revisionId,
        projectEpoch: 1n,
      });
      const revisionObject = await createRevisionObjectInput({
        projectId,
        environmentId,
        revisionId,
        projectEpoch: 1n,
        actorUserId: user.id,
        actorDeviceId: device.id,
        mutationKind: 2,
        expectedHeadId: input.expectedHeadId,
        parentHash: input.parentHash,
        descriptorBytes: descriptorObject.canonicalBytes,
        descriptorDigest: descriptorObject.digest,
      });
      for (const protocolObject of [revisionObject, descriptorObject]) {
        await stageObject({
          operation: publicationOperation,
          objectId: protocolObject.id,
          canonicalBytes: protocolObject.canonicalBytes,
          digest: protocolObject.digest,
        });
      }
      return { revisionId, revisionObject, descriptorObject };
    };
    const buildPublication = (
      staged: {
        readonly revisionId: string;
        readonly revisionObject: ProtocolObjectInput;
        readonly descriptorObject: ProtocolObjectInput;
      },
      input: {
        readonly expectedHeadId: string;
        readonly parentHash: Uint8Array;
      },
    ) => ({
      operation: {
        id: publicationOperation.id,
        actorUserId: user.id,
        actorDeviceId: device.id,
        kind: "REVISION_PUBLICATION" as const,
        commandBytes: publicationOperation.commandBytes,
        commandDigest: publicationOperation.commandDigest,
      },
      environmentId,
      expectedHeadId: input.expectedHeadId,
      revision: {
        id: staged.revisionId,
        protocolObjectId: staged.revisionObject.id,
        parentHash: input.parentHash,
        projectEpoch: 1n,
        mutation: "MANIFEST_UPDATE" as const,
        authoredAtMs: BigInt(Date.now()),
      },
      revisionObject: staged.revisionObject,
      descriptor: {
        protocolObject: staged.descriptorObject,
        schemaVersion: 1,
        descriptorHash: staged.descriptorObject.digest,
        laneCount: 0,
      },
      lanes: [],
      commitments: [],
      audit: {
        kind: "REVISION_PUBLISHED" as const,
        entityKind: "ENVIRONMENT" as const,
        entityId: environmentId,
      },
    });
    const firstStaged = await stageUpdateObjects({
      expectedHeadId: genesis.revisionId,
      parentHash: genesis.revisionDigest,
    });
    const secondStaged = await stageUpdateObjects({
      expectedHeadId: firstStaged.revisionId,
      parentHash: firstStaged.revisionObject.digest,
    });

    const published = await publications.publishRevision(
      database,
      buildPublication(firstStaged, {
        expectedHeadId: genesis.revisionId,
        parentHash: genesis.revisionDigest,
      }),
    );
    if (published.idempotent)
      throw new Error("first publication was unexpectedly idempotent");
    expect(
      (
        await database.environment.findUniqueOrThrow({
          where: { id: environmentId },
        })
      ).currentHeadId,
    ).toBe(firstStaged.revisionId);
    expect(
      await database.operation.findUniqueOrThrow({
        where: { id: publicationOperation.id },
      }),
    ).toMatchObject({ status: "COMMITTED" });

    // Re-publishing the committed update is an idempotent replay.
    const replay = await publications.publishRevision(
      database,
      buildPublication(firstStaged, {
        expectedHeadId: genesis.revisionId,
        parentHash: genesis.revisionDigest,
      }),
    );
    if (!replay.idempotent)
      throw new Error("replay of the committed publication was not idempotent");
    expect(replay.revision.id).toBe(firstStaged.revisionId);
    expect(
      await database.revision.count({
        where: { operationId: publicationOperation.id },
      }),
    ).toBe(1);

    // A different second update under the same, already-committed operation
    // must be rejected instead of becoming a second committed outcome.
    await expect(
      publications.publishRevision(
        database,
        buildPublication(secondStaged, {
          expectedHeadId: firstStaged.revisionId,
          parentHash: firstStaged.revisionObject.digest,
        }),
      ),
    ).rejects.toBeInstanceOf(OperationConflictError);
    expect(
      (
        await database.environment.findUniqueOrThrow({
          where: { id: environmentId },
        })
      ).currentHeadId,
    ).toBe(firstStaged.revisionId);
    expect(
      await database.revision.findUnique({
        where: { id: secondStaged.revisionId },
      }),
    ).toBeNull();
    expect(
      await database.revision.count({
        where: { operationId: publicationOperation.id },
      }),
    ).toBe(1);
  });
});
