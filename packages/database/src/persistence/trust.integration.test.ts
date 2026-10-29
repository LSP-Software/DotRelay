import {
  createDeviceBootstrap,
  createAccountKeyWrapper,
  generateAccountMasterKey,
  generateRecoveryCode,
  prepareDeviceRecovery,
} from "@dotrelay/client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  canonicalEncode,
  type CborValue,
  encodeProtocolObject,
  protocolObjectFromFields,
  uuidToBytes,
} from "@dotrelay/contracts";
import { Client } from "pg";
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

// Encodes the shared sequence as a canonical CBOR unsigned integer, with
// length prefixes once the suite generates more than 23 objects.
const sequenceBytes = (sequence: number): number[] =>
  sequence < 24
    ? [sequence]
    : sequence < 256
      ? [0x18, sequence]
      : [0x19, sequence >> 8, sequence & 0xff];

const createProtocolObjectInput = async (
  kind: number,
): Promise<ProtocolObjectInput> => {
  const sequence = protocolSequence++;
  const canonicalBytes = new Uint8Array([
    0xa1,
    0x00,
    ...sequenceBytes(sequence),
  ]);
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

const pollUntilTrue = async (
  probe: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const check = probe();
    check.catch(() => undefined);
    if (await check) return;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

  test("Recovery Code authorizes a replacement while the lost Device remains active, with replay and retirement checks", async () => {
    const user = await createUserFixture();
    const serverProfile = await database.serverProfile.findUniqueOrThrow({
      where: { id: user.serverProfileId },
    });
    const pin = {
      serverProfileId: serverProfile.id,
      origin: serverProfile.origin,
    };
    const devices = new DeviceRepository();
    const lost = await createDeviceBootstrap({ pin, userId: user.id });
    const deviceInput = (bootstrap: typeof lost) => ({
      id: bootstrap.deviceId,
      identityGeneration: 1n,
      keyId: bootstrap.keyId,
      x25519PublicKey: bootstrap.x25519PublicKey,
      ed25519PublicKey: bootstrap.ed25519PublicKey,
    });
    await devices.completeBootstrap(database, {
      operation: {
        ...(await createOperationInput(
          user.id,
          "initial recovery device",
          "DEVICE_ENROLLMENT",
        )),
      },
      device: deviceInput(lost),
      certificateObject: lost.certificate,
    });
    const code = generateRecoveryCode();
    const wrapper = await createAccountKeyWrapper({
      serverProfileId: pin.serverProfileId,
      userId: lost.bundle.userId,
      deviceId: lost.bundle.deviceId,
      userIdentityGeneration: 1,
      createdAtMs: Date.now(),
      accountMasterKey: generateAccountMasterKey(),
      signingPrivateKey: lost.keyMaterial.signingPrivateKey,
      kind: { type: "recoveryCode", recoveryCode: code },
    });
    const canonicalBytes = encodeProtocolObject(wrapper.object);
    const object = await database.protocolObject.create({
      data: {
        id: crypto.randomUUID(),
        suite: lost.certificate.suite,
        formatVersion: 3,
        kind: 20,
        canonicalBytes: new Uint8Array(canonicalBytes),
        digest: new Uint8Array(await sha384Digest(canonicalBytes)),
      },
    });
    await database.accountKeyWrapperObject.create({
      data: {
        protocolObjectId: object.id,
        userId: user.id,
        identityGeneration: 1n,
        wrapperType: "RECOVERY_CODE",
        wrapperId: new Uint8Array(wrapper.wrapperId),
        ciphertextHash: new Uint8Array(await sha384Digest(wrapper.ciphertext)),
        ciphertextLength: wrapper.ciphertext.length,
      },
    });
    const prepare = () =>
      prepareDeviceRecovery({
        pin,
        userId: user.id,
        recoveryCode: code,
        wrapperBytes: canonicalBytes,
        creatorPublicKey: lost.ed25519PublicKey,
      });
    const inputFor = (prepared: Awaited<ReturnType<typeof prepare>>) => ({
      operation: {
        id: prepared.request.operationId,
        actorUserId: user.id,
        kind: "DEVICE_ENROLLMENT" as const,
        commandBytes: prepared.bootstrap.certificate.canonicalBytes,
        commandDigest: prepared.bootstrap.certificate.digest,
      },
      device: deviceInput(prepared.bootstrap),
      certificateObject: prepared.bootstrap.certificate,
      recovery: {
        profileId: pin.serverProfileId,
        wrapperId: wrapper.wrapperId,
        signature: new Uint8Array(
          Buffer.from(prepared.request.recovery.signature, "base64"),
        ),
      },
    });
    const prepared = await prepare();
    const input = inputFor(prepared);
    const tampered = {
      ...input,
      operation: { ...input.operation, id: crypto.randomUUID() },
    };
    await expect(devices.completeBootstrap(database, tampered)).rejects.toThrow(
      "recovery authorization",
    );
    expect(await database.device.count({ where: { userId: user.id } })).toBe(1);
    await devices.completeBootstrap(database, input);
    expect(
      await database.device.count({
        where: { userId: user.id, lifecycle: "ACTIVE" },
      }),
    ).toBe(2);
    const replay = await devices.completeBootstrap(database, input);
    expect("idempotent" in replay && replay.idempotent).toBe(true);
    await database.accountKeyWrapperObject.update({
      where: { protocolObjectId: object.id },
      data: { retiredAt: new Date() },
    });
    await expect(
      devices.completeBootstrap(database, inputFor(await prepare())),
    ).rejects.toThrow("recovery authorization");
    expect(await database.device.count({ where: { userId: user.id } })).toBe(2);
  });

  // Bootstrap is first-Device-only (ADR 0010): a User with an ACTIVE Device
  // cannot bootstrap a second one, but a byte-identical retry of the
  // committed first bootstrap still returns idempotent.
  test("rejects a second bootstrap but replays the first idempotently", async () => {
    const user = await createUserFixture();
    const devices = new DeviceRepository();
    const firstKey = crypto.getRandomValues(new Uint8Array(32));
    const firstDevice = {
      id: crypto.randomUUID(),
      identityGeneration: 1n,
      keyId: new Uint8Array(await sha384Digest(firstKey)),
      x25519PublicKey: firstKey,
      ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
    };
    const firstOperation = await createOperationInput(
      user.id,
      "bootstrap-first-device",
      "DEVICE_ENROLLMENT",
    );
    const first = await devices.completeBootstrap(database, {
      operation: firstOperation,
      device: firstDevice,
      certificateObject: await createProtocolObjectInput(2),
    });
    if (!("device" in first))
      throw new Error("bootstrap did not return a device");
    expect(first.device.lifecycle).toBe("ACTIVE");
    expect(
      await database.device.count({
        where: { userId: user.id, lifecycle: "ACTIVE" },
      }),
    ).toBe(1);

    const secondKey = crypto.getRandomValues(new Uint8Array(32));
    await expect(
      devices.completeBootstrap(database, {
        operation: await createOperationInput(
          user.id,
          "bootstrap-second-device",
          "DEVICE_ENROLLMENT",
        ),
        device: {
          id: crypto.randomUUID(),
          identityGeneration: 1n,
          keyId: new Uint8Array(await sha384Digest(secondKey)),
          x25519PublicKey: secondKey,
          ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
        },
        certificateObject: await createProtocolObjectInput(2),
      }),
    ).rejects.toThrow(
      "a device has already been bootstrapped; use enrollment to add another device",
    );
    expect(
      await database.device.count({
        where: { userId: user.id, lifecycle: "ACTIVE" },
      }),
    ).toBe(1);

    const replay = await devices.completeBootstrap(database, {
      operation: firstOperation,
      device: firstDevice,
      certificateObject: await createProtocolObjectInput(2),
    });
    if (!("idempotent" in replay) || !replay.idempotent)
      throw new Error("committed bootstrap replay was not idempotent");
    expect(await database.device.count({ where: { userId: user.id } })).toBe(1);
  });

  // Runs the full prospective-Device enrollment cycle: the prospective
  // Device self-starts the enrollment, an existing ACTIVE Device approves
  // it (which activates the prospective Device), and the now-active
  // prospective Device completes it.
  const completeEnrollmentCycle = async (input: {
    readonly user: Readonly<{ readonly id: string }>;
    readonly devices: DeviceRepository;
    readonly prospectiveId: string;
    readonly x25519PublicKey: Uint8Array;
    readonly ed25519PublicKey: Uint8Array;
    readonly approverDeviceId: string;
    readonly labelPrefix: string;
  }) => {
    const enrollmentId = crypto.randomUUID();
    const beginOperation = {
      ...(await createOperationInput(
        input.user.id,
        `${input.labelPrefix}-begin`,
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: input.prospectiveId,
    };
    await input.devices.beginEnrollment(database, {
      operation: beginOperation,
      enrollmentId,
      userId: input.user.id,
      initiatorDeviceId: input.prospectiveId,
      transcriptHash: new Uint8Array(48),
      challengeHash: new Uint8Array(48),
      expiresAt: new Date(Date.now() + 60_000),
      device: {
        id: input.prospectiveId,
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(input.x25519PublicKey)),
        x25519PublicKey: input.x25519PublicKey,
        ed25519PublicKey: input.ed25519PublicKey,
      },
    });
    const approvalObject = await createProtocolObjectInput(5);
    const certificateObject = await createProtocolObjectInput(2);
    const approveOperation = {
      ...(await createOperationInput(
        input.user.id,
        `${input.labelPrefix}-approve`,
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: input.approverDeviceId,
    };
    for (const protocolObject of [approvalObject, certificateObject]) {
      await stageObject({
        operation: approveOperation,
        objectId: protocolObject.id,
        canonicalBytes: protocolObject.canonicalBytes,
        digest: protocolObject.digest,
      });
    }
    await input.devices.approveEnrollment(database, {
      operation: approveOperation,
      enrollmentId,
      approvalObject,
      certificateObject,
    });
    const enrollmentObject = await createProtocolObjectInput(4);
    const completeOperation = {
      ...(await createOperationInput(
        input.user.id,
        `${input.labelPrefix}-complete`,
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: input.prospectiveId,
    };
    await stageObject({
      operation: completeOperation,
      objectId: enrollmentObject.id,
      canonicalBytes: enrollmentObject.canonicalBytes,
      digest: enrollmentObject.digest,
    });
    await input.devices.completeEnrollment(database, {
      operation: completeOperation,
      enrollmentId,
      enrollmentObject,
    });
  };

  // A User with exactly one Device adds a second: the prospective Device
  // self-starts the enrollment, the single existing Device approves it, and
  // the prospective Device completes it. Both end ACTIVE.
  test("a single Device approves the second Device's self-enrollment", async () => {
    const user = await createUserFixture();
    const devices = new DeviceRepository();
    const firstKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await devices.completeBootstrap(database, {
      operation: await createOperationInput(
        user.id,
        "bootstrap-first-device",
        "DEVICE_ENROLLMENT",
      ),
      device: {
        id: crypto.randomUUID(),
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(firstKey)),
        x25519PublicKey: firstKey,
        ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      },
      certificateObject: await createProtocolObjectInput(2),
    });
    if (!("device" in first))
      throw new Error("bootstrap did not return a device");
    const prospectiveId = crypto.randomUUID();
    const secondKey = crypto.getRandomValues(new Uint8Array(32));
    const secondSigningKey = crypto.getRandomValues(new Uint8Array(32));
    const enrollmentId = crypto.randomUUID();
    const beginOperation = {
      ...(await createOperationInput(
        user.id,
        "enroll-second-device",
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: prospectiveId,
    };
    const begin = await devices.beginEnrollment(database, {
      operation: beginOperation,
      enrollmentId,
      userId: user.id,
      initiatorDeviceId: prospectiveId,
      transcriptHash: new Uint8Array(48),
      challengeHash: new Uint8Array(48),
      expiresAt: new Date(Date.now() + 60_000),
      device: {
        id: prospectiveId,
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(secondKey)),
        x25519PublicKey: secondKey,
        ed25519PublicKey: secondSigningKey,
      },
    });
    if ("idempotent" in begin && begin.idempotent)
      throw new Error("fresh enrollment begin was a replay");
    // The prospective Device exists but is pending until approval.
    const pending = await database.device.findUnique({
      where: { id: prospectiveId },
    });
    expect(pending?.lifecycle).toBe("PENDING");
    expect(
      await database.auditEvent.count({
        where: {
          operationId: beginOperation.id,
          kind: "DEVICE_ENROLLMENT_STARTED",
        },
      }),
    ).toBe(1);
    const approvalObject = await createProtocolObjectInput(5);
    const secondCertificateObject = await createProtocolObjectInput(2);
    const approveOperation = {
      ...(await createOperationInput(
        user.id,
        "approve-second-device",
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: first.device.id,
    };
    for (const protocolObject of [approvalObject, secondCertificateObject]) {
      await stageObject({
        operation: approveOperation,
        objectId: protocolObject.id,
        canonicalBytes: protocolObject.canonicalBytes,
        digest: protocolObject.digest,
      });
    }
    await devices.approveEnrollment(database, {
      operation: approveOperation,
      enrollmentId,
      approvalObject,
      certificateObject: secondCertificateObject,
    });
    // Approval activates the prospective Device.
    const approved = await database.device.findUnique({
      where: { id: prospectiveId },
    });
    expect(approved?.lifecycle).toBe("ACTIVE");
    expect(
      await database.auditEvent.count({
        where: {
          operationId: approveOperation.id,
          kind: "DEVICE_ENROLLMENT_APPROVED",
        },
      }),
    ).toBe(1);
    const enrollmentObject = await createProtocolObjectInput(4);
    const completeOperation = {
      ...(await createOperationInput(
        user.id,
        "complete-second-device",
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: prospectiveId,
    };
    await stageObject({
      operation: completeOperation,
      objectId: enrollmentObject.id,
      canonicalBytes: enrollmentObject.canonicalBytes,
      digest: enrollmentObject.digest,
    });
    await devices.completeEnrollment(database, {
      operation: completeOperation,
      enrollmentId,
      enrollmentObject,
    });
    const completed = await database.deviceEnrollment.findUniqueOrThrow({
      where: { id: enrollmentId },
    });
    expect(completed.completedAt).not.toBeNull();
    expect(approved?.lifecycle).toBe("ACTIVE");
    const firstAfter = await database.device.findUniqueOrThrow({
      where: { id: first.device.id },
    });
    expect(firstAfter.lifecycle).toBe("ACTIVE");
    expect(
      await database.device.count({
        where: { userId: user.id, lifecycle: "ACTIVE" },
      }),
    ).toBe(2);
  });

  // Once the User has two Devices, a third joins the same way: it
  // self-starts, and one of the two existing Devices approves.
  test("a third Device enrolls with approval from an existing Device", async () => {
    const user = await createUserFixture();
    const devices = new DeviceRepository();
    const firstKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await devices.completeBootstrap(database, {
      operation: await createOperationInput(
        user.id,
        "bootstrap-third-test-first",
        "DEVICE_ENROLLMENT",
      ),
      device: {
        id: crypto.randomUUID(),
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(firstKey)),
        x25519PublicKey: firstKey,
        ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      },
      certificateObject: await createProtocolObjectInput(2),
    });
    if (!("device" in first))
      throw new Error("bootstrap did not return a device");
    await completeEnrollmentCycle({
      user,
      devices,
      prospectiveId: crypto.randomUUID(),
      x25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      approverDeviceId: first.device.id,
      labelPrefix: "enroll-second",
    });
    expect(
      await database.device.count({
        where: { userId: user.id, lifecycle: "ACTIVE" },
      }),
    ).toBe(2);
    const second = (
      await database.device.findMany({
        where: { userId: user.id, lifecycle: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      })
    ).find((device) => device.id !== first.device.id);
    if (!second) throw new Error("second Device was not created");
    await completeEnrollmentCycle({
      user,
      devices,
      prospectiveId: crypto.randomUUID(),
      x25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      approverDeviceId: second.id,
      labelPrefix: "enroll-third",
    });
    expect(
      await database.device.count({
        where: { userId: user.id, lifecycle: "ACTIVE" },
      }),
    ).toBe(3);
  });

  // Enrollment needs an existing ACTIVE Device to approve the request; a
  // User with none must use initial trust bootstrap for the first Device.
  test("rejects an enrollment nobody can approve", async () => {
    const user = await createUserFixture();
    const devices = new DeviceRepository();
    const prospectiveId = crypto.randomUUID();
    const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
    await expect(
      devices.beginEnrollment(database, {
        operation: {
          ...(await createOperationInput(
            user.id,
            "enroll-without-approver",
            "DEVICE_ENROLLMENT",
          )),
          actorDeviceId: prospectiveId,
        },
        enrollmentId: crypto.randomUUID(),
        userId: user.id,
        initiatorDeviceId: prospectiveId,
        transcriptHash: new Uint8Array(48),
        challengeHash: new Uint8Array(48),
        expiresAt: new Date(Date.now() + 60_000),
        device: {
          id: prospectiveId,
          identityGeneration: 1n,
          keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
          x25519PublicKey,
          ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
        },
      }),
    ).rejects.toThrow("use initial trust bootstrap");
  });

  // ADR 0010: a Device created by initial trust bootstrap is fully ACTIVE.
  // It may approve an enrollment on its own behalf — here the prospective
  // Device's self-started request, which activates it. The lifecycle gate
  // is "active", not "enrolled through dual control".
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
    const prospectiveId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();
    const prospectiveKey = crypto.getRandomValues(new Uint8Array(32));
    await devices.beginEnrollment(database, {
      operation: {
        ...(await createOperationInput(
          user.id,
          "begin-bootstrap-approval",
          "DEVICE_ENROLLMENT",
        )),
        actorDeviceId: prospectiveId,
      },
      enrollmentId,
      userId: user.id,
      initiatorDeviceId: prospectiveId,
      transcriptHash: new Uint8Array(48),
      challengeHash: new Uint8Array(48),
      expiresAt: new Date(Date.now() + 60_000),
      device: {
        id: prospectiveId,
        identityGeneration: 1n,
        keyId: new Uint8Array(await sha384Digest(prospectiveKey)),
        x25519PublicKey: prospectiveKey,
        ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      },
    });
    const approvalObject = await createProtocolObjectInput(5);
    const prospectiveCertificateObject = await createProtocolObjectInput(2);
    const approveOperation = {
      ...(await createOperationInput(
        user.id,
        "approve-bootstrap-approval",
        "DEVICE_ENROLLMENT",
      )),
      actorDeviceId: bootstrap.device.id,
    };
    for (const protocolObject of [
      approvalObject,
      prospectiveCertificateObject,
    ]) {
      await stageObject({
        operation: approveOperation,
        objectId: protocolObject.id,
        canonicalBytes: protocolObject.canonicalBytes,
        digest: protocolObject.digest,
      });
    }
    await devices.approveEnrollment(database, {
      operation: approveOperation,
      enrollmentId,
      approvalObject,
      certificateObject: prospectiveCertificateObject,
    });
    expect(
      await database.auditEvent.count({
        where: {
          operationId: approveOperation.id,
          kind: "DEVICE_ENROLLMENT_APPROVED",
        },
      }),
    ).toBe(1);
    const activated = await database.device.findUnique({
      where: { id: prospectiveId },
    });
    expect(activated?.lifecycle).toBe("ACTIVE");
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

  // Acceptance and membership activation must take row locks in the same
  // Team-then-User order. This test pins the previously deadlocking
  // interleaving: the acceptance transaction has performed its operation
  // insert (holding a key share on the accepting User row) and is paused by
  // a trigger barrier, while a second transaction runs the activation
  // path's lock sequence (Team row FOR UPDATE, then target User row
  // FOR UPDATE). With matching lock order neither can deadlock; with the
  // old order Postgres aborts one side with 40P01.
  test("concurrent acceptance and activation lock orders cannot deadlock", async () => {
    const owner = await createUserFixture();
    const ownerDevice = await createActiveDevice(owner.id);
    const serverProfile = await database.serverProfile.findFirstOrThrow({
      where: { users: { some: { id: owner.id } } },
    });
    const teamId = crypto.randomUUID();
    await new AdministrationRepository().createTeamWithOwner(database, {
      teamId,
      serverProfileId: serverProfile.id,
      ownerUserId: owner.id,
      name: "deadlock-team",
      operation: {
        ...(await createOperationInput(owner.id, "deadlock-team")),
        actorDeviceId: ownerDevice.id,
      },
    });
    const invitee = await createUserFixture(serverProfile.id);
    const invitationId = crypto.randomUUID();
    await new MembershipAdministrationRepository().invite(database, {
      teamId,
      invitationId,
      providerSubject: invitee.githubSubject,
      operation: {
        ...(await createOperationInput(owner.id, "deadlock-invite")),
        actorDeviceId: ownerDevice.id,
      },
    });
    const signalLock = 8842;
    const acceptOperation = await createOperationInput(
      invitee.id,
      "deadlock-accept",
    );
    await database.$executeRawUnsafe(`
      CREATE TABLE dotrelay_barrier_flags (key text primary key);
      CREATE OR REPLACE FUNCTION dotrelay_accept_barrier()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."id" = '${acceptOperation.id}'::uuid THEN
          PERFORM pg_advisory_lock(${signalLock}::bigint);
          FOR barrier_pass IN 1..160 LOOP
            EXIT WHEN EXISTS (
              SELECT 1 FROM dotrelay_barrier_flags WHERE key = 'release'
            );
            PERFORM pg_sleep(0.05);
          END LOOP;
          IF NOT EXISTS (
            SELECT 1 FROM dotrelay_barrier_flags WHERE key = 'release'
          ) THEN
            RAISE EXCEPTION 'accept barrier timed out';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS dotrelay_accept_barrier_trigger ON "operations";
      CREATE TRIGGER dotrelay_accept_barrier_trigger
      AFTER INSERT ON "operations"
      FOR EACH ROW EXECUTE FUNCTION dotrelay_accept_barrier();
    `);
    const connectionString = testDatabaseUrl?.toString();
    if (!connectionString) throw new Error("DATABASE_URL is required");
    const release = new Client({ connectionString });
    await release.connect();
    const probe = new Client({ connectionString });
    await probe.connect();
    const acceptPromise = new MembershipAdministrationRepository().accept(
      database,
      {
        invitationId,
        userId: invitee.id,
        operation: acceptOperation,
      },
    );
    let activationDone: Promise<void> | undefined;
    try {
      await pollUntilTrue(
        async () => {
          const { rows } = await probe.query(
            `SELECT EXISTS(
               SELECT 1 FROM pg_locks
               WHERE classid = 0
                 AND objid = ${signalLock} AND objsubid = 1
                 AND mode = 'ExclusiveLock'
             ) AS "signaled"`,
          );
          return rows[0].signaled === true;
        },
        10_000,
        "the acceptance transaction to reach the operation insert",
      );
      // Runs the activation path's lock sequence: Team row FOR UPDATE,
      // then target User row FOR UPDATE.
      const activation = new Client({ connectionString });
      await activation.connect();
      const { rows: pidRows } = await activation.query(
        "SELECT pg_backend_pid() AS pid",
      );
      const activationPid = Number(pidRows[0].pid);
      activationDone = (async () => {
        try {
          await activation.query(`BEGIN`);
          await activation.query(
            `SELECT "id" FROM "teams" WHERE "id" = $1 FOR UPDATE`,
            [teamId],
          );
          await activation.query(
            `SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE`,
            [invitee.id],
          );
          await activation.query(`COMMIT`);
        } catch (error) {
          await activation.query(`ROLLBACK`).catch(() => undefined);
          throw error;
        } finally {
          await activation.end().catch(() => undefined);
        }
      })();
      // A FOR UPDATE blocked on a row locked by an open transaction is
      // recorded in pg_locks as an ungranted wait on that transaction's id
      // (wait_event "transactionid"), not as a row lock, so any ungranted
      // lock held by the activation backend means it is parked on a lock
      // the acceptance transaction holds.
      await pollUntilTrue(
        async () => {
          const { rows } = await probe.query(
            `SELECT EXISTS(
               SELECT 1 FROM pg_locks
               WHERE pid = $1 AND granted = false
             ) AS "waiting"`,
            [activationPid],
          );
          return rows[0].waiting === true;
        },
        10_000,
        "the activation transaction to block on an acceptance-held lock",
      );
      await release.query(
        `INSERT INTO dotrelay_barrier_flags (key) VALUES ('release')`,
      );
      const accepted = await withTimeout(
        acceptPromise,
        15_000,
        "invitation acceptance",
      );
      await withTimeout(activationDone, 15_000, "the activation lock sequence");
      if (!("membership" in accepted))
        throw new Error("acceptance did not return a membership");
      const membership = await database.membership.findUniqueOrThrow({
        where: { id: accepted.membership.id },
      });
      expect(membership.lifecycle).toBe("PENDING_KEY_GRANT");
      expect(membership.invitationId).toBe(invitationId);
      const invitation = await database.membershipInvitation.findUniqueOrThrow({
        where: { id: invitationId },
      });
      expect(invitation.acceptedByUserId).toBe(invitee.id);
      expect(invitation.acceptedAt).not.toBeNull();
    } finally {
      acceptPromise.catch(() => undefined);
      activationDone?.catch(() => undefined);
      await database.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS dotrelay_accept_barrier_trigger ON "operations"; DROP FUNCTION IF EXISTS dotrelay_accept_barrier(); DROP TABLE IF EXISTS dotrelay_barrier_flags;',
      );
      await probe.end().catch(() => undefined);
      await release.end().catch(() => undefined);
    }
  }, 30_000);

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

  test("blocks a concurrent environment restore behind a rotation's project lock", async () => {
    const user = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const serverProfile = await database.serverProfile.findFirstOrThrow({
      where: { users: { some: { id: user.id } } },
    });
    const teamId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const administration = new AdministrationRepository();
    await administration.createTeamWithOwner(database, {
      teamId,
      serverProfileId: serverProfile.id,
      ownerUserId: user.id,
      name: "rotation-lock-team",
      operation: {
        ...(await createOperationInput(user.id, "rotation-lock-team")),
        actorDeviceId: device.id,
      },
    });
    const createdProject = await new ProjectRepository().create(database, {
      teamId,
      projectId,
      githubRepositoryId: BigInt(Date.now() + 50),
      operation: {
        ...(await createOperationInput(user.id, "rotation-lock-project")),
        actorDeviceId: device.id,
      },
    });
    if (!("environment" in createdProject))
      throw new Error("project creation did not provision an environment");
    const environmentId = createdProject.environment.id;

    // Archive the environment so a rotation's active-environment read omits it
    // from the transition set.
    await administration.archiveEnvironment(database, {
      environmentId,
      operation: {
        ...(await createOperationInput(user.id, "archive-rotation-lock-env")),
        actorDeviceId: device.id,
      },
    });
    const archived = await database.environment.findUniqueOrThrow({
      where: { id: environmentId },
    });
    expect(archived.lifecycle).toBe("ARCHIVED");

    // A separate transaction models an epoch rotation's critical section: it
    // locks the project row and holds it while working, as ProjectEpochRepository
    // .rotate does before it commits.
    let releaseRotation: () => void = () => undefined;
    const rotationHoldsProjectLock = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const rotation = database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE`;
      await rotationHoldsProjectLock;
    });

    // The restore takes the owning project lock before the environment lock, so
    // while the rotation holds the project lock it cannot commit and the
    // environment stays ARCHIVED rather than escaping the rotation's set.
    const restoreEnvironment = administration.restoreEnvironment(database, {
      environmentId,
      operation: {
        ...(await createOperationInput(user.id, "restore-rotation-lock-env")),
        actorDeviceId: device.id,
      },
    });
    const settledBeforeRelease = await Promise.race([
      restoreEnvironment.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    expect(settledBeforeRelease).toBe(false);
    const whileRotationHoldsLock = await database.environment.findUniqueOrThrow(
      {
        where: { id: environmentId },
      },
    );
    expect(whileRotationHoldsLock.lifecycle).toBe("ARCHIVED");

    releaseRotation();
    await rotation;
    const restored = await restoreEnvironment;
    if (!("environment" in restored))
      throw new Error("restore did not return the updated environment");
    expect(restored.environment.lifecycle).toBe("ACTIVE");
    const finalEnvironment = await database.environment.findUniqueOrThrow({
      where: { id: environmentId },
    });
    expect(finalEnvironment.lifecycle).toBe("ACTIVE");
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
