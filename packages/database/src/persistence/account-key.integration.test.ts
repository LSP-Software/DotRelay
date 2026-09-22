// Persistence invariants for Account Key Wrappers, Envelopes, and Transfers
// (ADR 0009). Integration-only: requires DATABASE_URL (otherwise skipped).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { DatabaseClient, OperationInput, ProtocolObjectInput } from "..";
import {
  AccountKeyRepository,
  AdministrationRepository,
  createDatabaseClient,
  OperationRepository,
  ProjectRepository,
  StagedObjectRepository,
  sha384Digest,
} from "..";

const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const INTEGRATION_HOOK_TIMEOUT_MS = 30_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_accountkey_${crypto
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

const createOperationInput = async (
  actorUserId: string,
  label: string,
  kind: OperationInput["kind"] = "ACCOUNT_KEY",
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
  const sequence = protocolSequence++;
  const canonicalBytes = new Uint8Array(
    sequence < 24
      ? [0xa1, 0x00, sequence]
      : [0xa1, 0x00, 0x18, sequence & 0xff],
  );
  return {
    id: crypto.randomUUID(),
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    formatVersion: 3,
    kind,
    canonicalBytes,
    digest: await sha384Digest(canonicalBytes),
  };
};

const createUserFixture = async () => {
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
  return { serverProfile, user };
};

const createActiveDevice = async (userId: string) => {
  const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
  const keyId = new Uint8Array(await sha384Digest(x25519PublicKey));
  return database.device.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      lifecycle: "ACTIVE",
      identityGeneration: 1n,
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
  const staging = new StagedObjectRepository();
  const operations = new OperationRepository();
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

const randomWrapperId = () => crypto.getRandomValues(new Uint8Array(16));

const addWrapper = async (input: {
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly label: string;
  readonly wrapperType: "RECOVERY_CODE" | "PASSWORD" | "PASSKEY_PRF";
  readonly wrapperId?: Uint8Array;
  readonly credentialId?: Uint8Array;
}) => {
  const accountKeys = new AccountKeyRepository();
  const protocolObject = await createProtocolObjectInput(20);
  const operation = {
    ...(await createOperationInput(input.actorUserId, input.label)),
    actorDeviceId: input.actorDeviceId,
  };
  await stageObject({
    operation,
    objectId: protocolObject.id,
    canonicalBytes: protocolObject.canonicalBytes,
    digest: protocolObject.digest,
  });
  return accountKeys.addWrapper(database, {
    operation,
    wrapper: {
      protocolObject,
      identityGeneration: 1n,
      wrapperType: input.wrapperType,
      wrapperId: input.wrapperId ?? randomWrapperId(),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      ...(input.wrapperType === "PASSWORD"
        ? {
            kdfName: 1,
            kdfMemoryKib: 65536n,
            kdfIterations: 3n,
            kdfParallelism: 1,
          }
        : {}),
      ciphertextHash: new Uint8Array(48),
      ciphertextLength: 128,
    },
  });
};

const revokeWrapperById = async (
  actorUserId: string,
  actorDeviceId: string,
  label: string,
  wrapperId: Uint8Array,
) => {
  const accountKeys = new AccountKeyRepository();
  return accountKeys.revokeWrapper(database, {
    operation: {
      ...(await createOperationInput(actorUserId, label)),
      actorDeviceId,
    },
    wrapperId,
  });
};

const activeWrapperRows = (userId: string) =>
  database.accountKeyWrapperObject.findMany({
    where: { userId, retiredAt: null },
  });

const publishEnvelope = async (input: {
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly label: string;
  readonly envelope: Readonly<{
    readonly envelopeType: "PROJECT_EPOCH_KEY" | "USER_VALUE_KEY";
    readonly projectId?: string;
    readonly projectEpoch?: bigint;
    readonly ownerUserId?: string;
    readonly valueGeneration?: bigint;
  }>;
}) => {
  const accountKeys = new AccountKeyRepository();
  const protocolObject = await createProtocolObjectInput(21);
  const operation = {
    ...(await createOperationInput(input.actorUserId, input.label)),
    actorDeviceId: input.actorDeviceId,
  };
  await stageObject({
    operation,
    objectId: protocolObject.id,
    canonicalBytes: protocolObject.canonicalBytes,
    digest: protocolObject.digest,
  });
  return accountKeys.publishEnvelope(database, {
    operation,
    envelope: {
      protocolObject,
      identityGeneration: 1n,
      ciphertextHash: new Uint8Array(48),
      ciphertextLength: 256,
      ...input.envelope,
    },
  });
};

// Creates a Team owned by `ownerUser` and a Project in that Team, returning
// ids needed to publish Project Epoch Key envelopes against it.
const createProjectFixture = async (input: {
  readonly serverProfileId: string;
  readonly ownerUserId: string;
  readonly actorDeviceId: string;
  readonly name: string;
  readonly operationLabel: string;
}) => {
  const teamId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const team = await new AdministrationRepository().createTeamWithOwner(
    database,
    {
      teamId,
      serverProfileId: input.serverProfileId,
      ownerUserId: input.ownerUserId,
      name: input.name,
      operation: {
        ...(await createOperationInput(
          input.ownerUserId,
          `${input.operationLabel}-team`,
          "ADMINISTRATION",
        )),
        actorDeviceId: input.actorDeviceId,
      },
    },
  );
  if ("existing" in team && team.existing)
    throw new Error("team already existed in fixture");
  await new ProjectRepository().create(database, {
    teamId,
    projectId,
    githubRepositoryId: BigInt(Date.now()),
    operation: {
      ...(await createOperationInput(
        input.ownerUserId,
        `${input.operationLabel}-project`,
        "ADMINISTRATION",
      )),
      actorDeviceId: input.actorDeviceId,
    },
  });
  return { teamId, projectId };
};

integrationDescribe("account key persistence invariants", () => {
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

  test("a non-recovery wrapper coexists with the active RECOVERY_CODE wrapper", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code",
      wrapperType: "RECOVERY_CODE",
    });
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "password",
      wrapperType: "PASSWORD",
    });
    const active = await activeWrapperRows(user.id);
    expect(active.map((row) => row.wrapperType).sort()).toEqual([
      "PASSWORD",
      "RECOVERY_CODE",
    ]);
  });

  test("rotating the RECOVERY_CODE wrapper retires only the prior RECOVERY_CODE wrapper", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const priorCodeId = randomWrapperId();
    const nextCodeId = randomWrapperId();
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code-v1",
      wrapperType: "RECOVERY_CODE",
      wrapperId: priorCodeId,
    });
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "password",
      wrapperType: "PASSWORD",
    });
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code-v2",
      wrapperType: "RECOVERY_CODE",
      wrapperId: nextCodeId,
    });
    const retired = await database.accountKeyWrapperObject.findMany({
      where: { userId: user.id, retiredAt: { not: null } },
    });
    const active = await activeWrapperRows(user.id);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.wrapperId).toEqual(priorCodeId);
    expect(active.map((row) => row.wrapperType).sort()).toEqual([
      "PASSWORD",
      "RECOVERY_CODE",
    ]);
    const activeCode = active.find(
      (row) => row.wrapperType === "RECOVERY_CODE",
    );
    expect(activeCode?.wrapperId).toEqual(nextCodeId);
  });

  test("a failed wrapper commit rolls back without retiring any wrapper", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code",
      wrapperType: "RECOVERY_CODE",
    });
    // The staged protocol object is valid; the digest handed to addWrapper
    // does not match its canonical bytes, so the commit fails inside the
    // transaction after the retire step and the whole transaction rolls
    // back.
    const poisonedObject = await createProtocolObjectInput(20);
    const operation = {
      ...(await createOperationInput(user.id, "poisoned-wrapper")),
      actorDeviceId: device.id,
    };
    await stageObject({
      operation,
      objectId: poisonedObject.id,
      canonicalBytes: poisonedObject.canonicalBytes,
      digest: poisonedObject.digest,
    });
    const accountKeys = new AccountKeyRepository();
    await expect(
      accountKeys.addWrapper(database, {
        operation,
        wrapper: {
          protocolObject: {
            ...poisonedObject,
            digest: new Uint8Array(poisonedObject.digest.length).fill(0xff),
          },
          identityGeneration: 1n,
          wrapperType: "RECOVERY_CODE",
          wrapperId: randomWrapperId(),
          ciphertextHash: new Uint8Array(48),
          ciphertextLength: 128,
        },
      }),
    ).rejects.toBeTruthy();
    const active = await activeWrapperRows(user.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.wrapperType).toBe("RECOVERY_CODE");
    expect(active[0]?.retiredAt).toBeNull();
  });

  test("concurrent RECOVERY_CODE rotations serialize on the user lock", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const initialCodeId = randomWrapperId();
    const firstCodeId = randomWrapperId();
    const secondCodeId = randomWrapperId();
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code-initial",
      wrapperType: "RECOVERY_CODE",
      wrapperId: initialCodeId,
    });
    const settled = await Promise.allSettled([
      addWrapper({
        actorUserId: user.id,
        actorDeviceId: device.id,
        label: "rotation-first",
        wrapperType: "RECOVERY_CODE",
        wrapperId: firstCodeId,
      }),
      addWrapper({
        actorUserId: user.id,
        actorDeviceId: device.id,
        label: "rotation-second",
        wrapperType: "RECOVERY_CODE",
        wrapperId: secondCodeId,
      }),
    ]);
    for (const outcome of settled)
      if (outcome.status === "rejected")
        throw new Error("concurrent rotation must not fail");
    const active = await activeWrapperRows(user.id);
    const activeCodes = active.filter(
      (row) => row.wrapperType === "RECOVERY_CODE",
    );
    expect(activeCodes).toHaveLength(1);
    expect(
      activeCodes[0]?.wrapperId,
      "the winner's new code must be the sole active RECOVERY_CODE wrapper",
    ).toBeInstanceOf(Uint8Array);
    const retired = await database.accountKeyWrapperObject.findMany({
      where: { userId: user.id, retiredAt: { not: null } },
    });
    const retiredIds = retired.map((row) =>
      Buffer.from(row.wrapperId).toString("hex"),
    );
    expect(
      retiredIds,
      "only the codes superseded by the winner may be retired",
    ).toHaveLength(2);
  });

  test("replaying a wrapper command is idempotent and does not retire the active code", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const codeId = randomWrapperId();
    const first = await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code-replay",
      wrapperType: "RECOVERY_CODE",
      wrapperId: codeId,
    });
    if (!("wrapper" in first))
      throw new Error("addWrapper did not return a wrapper");
    // Re-run the exact same operation (same command digest, fresh staging of
    // the same protocol object) and expect idempotent deduplication.
    const accountKeys = new AccountKeyRepository();
    const replayObject = await createProtocolObjectInput(20);
    const replayOperation = {
      ...(await createOperationInput(user.id, "recovery-code-replay")),
      actorDeviceId: device.id,
      id: first.operation.id,
    };
    await stageObject({
      operation: replayOperation,
      objectId: replayObject.id,
      canonicalBytes: replayObject.canonicalBytes,
      digest: replayObject.digest,
    });
    const replayed = await accountKeys.addWrapper(database, {
      operation: replayOperation,
      wrapper: {
        protocolObject: replayObject,
        identityGeneration: 1n,
        wrapperType: "RECOVERY_CODE",
        wrapperId: randomWrapperId(),
        ciphertextHash: new Uint8Array(48),
        ciphertextLength: 128,
      },
    });
    expect("idempotent" in replayed && replayed.idempotent).toBe(true);
    const active = await activeWrapperRows(user.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.wrapperId).toEqual(codeId);
  });

  test("refuses to revoke the last active RECOVERY_CODE wrapper", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const codeId = randomWrapperId();
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "sole-recovery-code",
      wrapperType: "RECOVERY_CODE",
      wrapperId: codeId,
    });
    await expect(
      revokeWrapperById(user.id, device.id, "revoke-sole-code", codeId),
    ).rejects.toThrow(/recovery/i);
    const active = await activeWrapperRows(user.id);
    expect(active).toHaveLength(1);
  });

  test("refuses to revoke the last RECOVERY_CODE wrapper even when other wrappers remain", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const codeId = randomWrapperId();
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "last-recovery-code",
      wrapperType: "RECOVERY_CODE",
      wrapperId: codeId,
    });
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "password-companion",
      wrapperType: "PASSWORD",
    });
    await expect(
      revokeWrapperById(user.id, device.id, "revoke-last-code", codeId),
    ).rejects.toThrow(/recovery/i);
    const active = await activeWrapperRows(user.id);
    expect(active).toHaveLength(2);
    expect(active.map((row) => row.wrapperType).sort()).toEqual([
      "PASSWORD",
      "RECOVERY_CODE",
    ]);
  });

  test("allows revoking non-recovery wrappers while a RECOVERY_CODE wrapper remains", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const codeId = randomWrapperId();
    const passkeyCredential = crypto.getRandomValues(new Uint8Array(32));
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code-for-passkey-revocation",
      wrapperType: "RECOVERY_CODE",
      wrapperId: codeId,
    });
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "passkey-to-revoke",
      wrapperType: "PASSKEY_PRF",
      credentialId: passkeyCredential,
    });
    const active = await activeWrapperRows(user.id);
    const passkeyRow = active.find((row) => row.wrapperType === "PASSKEY_PRF");
    if (!passkeyRow) throw new Error("passkey wrapper not found");
    await revokeWrapperById(
      user.id,
      device.id,
      "revoke-passkey",
      new Uint8Array(passkeyRow.wrapperId),
    );
    const survivors = await activeWrapperRows(user.id);
    expect(survivors.map((row) => row.wrapperType)).toEqual(["RECOVERY_CODE"]);
  });

  test("refuses Project Epoch Key envelopes for archived Projects", async () => {
    const { serverProfile, user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const { projectId } = await createProjectFixture({
      serverProfileId: serverProfile.id,
      ownerUserId: user.id,
      actorDeviceId: device.id,
      name: "envelope-archived",
      operationLabel: "envelope-archived",
    });
    await database.project.update({
      where: { id: projectId },
      data: { lifecycle: "ARCHIVED", archivedAt: new Date() },
    });
    await expect(
      publishEnvelope({
        actorUserId: user.id,
        actorDeviceId: device.id,
        label: "archived-project-envelope",
        envelope: {
          envelopeType: "PROJECT_EPOCH_KEY",
          projectId,
          projectEpoch: 1n,
        },
      }),
    ).rejects.toThrow(/archived|not reachable/i);
  });

  test("allows re-publication of a prior epoch and refuses future epochs", async () => {
    const { serverProfile, user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const { projectId } = await createProjectFixture({
      serverProfileId: serverProfile.id,
      ownerUserId: user.id,
      actorDeviceId: device.id,
      name: "envelope-epochs",
      operationLabel: "envelope-epochs",
    });
    await database.project.update({
      where: { id: projectId },
      data: { currentEpoch: 2n },
    });
    await publishEnvelope({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "epoch-1-envelope",
      envelope: {
        envelopeType: "PROJECT_EPOCH_KEY",
        projectId,
        projectEpoch: 1n,
      },
    });
    await publishEnvelope({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "epoch-2-envelope",
      envelope: {
        envelopeType: "PROJECT_EPOCH_KEY",
        projectId,
        projectEpoch: 2n,
      },
    });
    const published = await database.accountKeyEnvelopeObject.findMany({
      where: { userId: user.id },
    });
    const epochs = published.map((row) => row.projectEpoch);
    expect(epochs).toHaveLength(2);
    expect([...epochs].sort((a, b) => Number((a ?? 0n) - (b ?? 0n)))).toEqual([
      1n,
      2n,
    ]);
    await expect(
      publishEnvelope({
        actorUserId: user.id,
        actorDeviceId: device.id,
        label: "future-epoch-envelope",
        envelope: {
          envelopeType: "PROJECT_EPOCH_KEY",
          projectId,
          projectEpoch: 3n,
        },
      }),
    ).rejects.toThrow(/epoch/i);
  });

  test("refuses Project Epoch Key envelopes for removed memberships", async () => {
    const { serverProfile, user } = await createUserFixture();
    const ownerDevice = await createActiveDevice(user.id);
    const { projectId } = await createProjectFixture({
      serverProfileId: serverProfile.id,
      ownerUserId: user.id,
      actorDeviceId: ownerDevice.id,
      name: "envelope-removed",
      operationLabel: "envelope-removed",
    });
    const project = await database.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    // The owner membership must stay ACTIVE (the database refuses removing the
    // sole owner), so remove a non-owner member's membership instead and
    // publish the envelope as that removed member.
    const { user: memberUser } = await createUserFixture();
    const memberDevice = await createActiveDevice(memberUser.id);
    await database.membership.create({
      data: {
        teamId: project.teamId,
        userId: memberUser.id,
        role: "MEMBER",
        lifecycle: "ACTIVE",
        activatedAt: new Date(),
      },
    });
    await database.membership.updateMany({
      where: { teamId: project.teamId, userId: memberUser.id },
      data: { lifecycle: "REMOVED", removedAt: new Date() },
    });
    await expect(
      publishEnvelope({
        actorUserId: memberUser.id,
        actorDeviceId: memberDevice.id,
        label: "removed-membership-envelope",
        envelope: {
          envelopeType: "PROJECT_EPOCH_KEY",
          projectId,
          projectEpoch: 1n,
        },
      }),
    ).rejects.toThrow(/reachab|membership|active/i);
  });

  test("refuses Project Epoch Key envelopes from users without a membership", async () => {
    const { serverProfile, user } = await createUserFixture();
    const ownerDevice = await createActiveDevice(user.id);
    const outsider = await createUserFixture();
    const outsiderDevice = await createActiveDevice(outsider.user.id);
    const { projectId } = await createProjectFixture({
      serverProfileId: serverProfile.id,
      ownerUserId: user.id,
      actorDeviceId: ownerDevice.id,
      name: "envelope-outsider",
      operationLabel: "envelope-outsider",
    });
    await expect(
      publishEnvelope({
        actorUserId: outsider.user.id,
        actorDeviceId: outsiderDevice.id,
        label: "outsider-envelope",
        envelope: {
          envelopeType: "PROJECT_EPOCH_KEY",
          projectId,
          projectEpoch: 1n,
        },
      }),
    ).rejects.toThrow(/not reachable|reachab/i);
  });

  test("allows USER_VALUE_KEY envelopes only for the acting User", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const foreign = await createUserFixture();
    await publishEnvelope({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "own-value-envelope",
      envelope: {
        envelopeType: "USER_VALUE_KEY",
        ownerUserId: user.id,
        valueGeneration: 1n,
      },
    });
    await expect(
      publishEnvelope({
        actorUserId: user.id,
        actorDeviceId: device.id,
        label: "foreign-value-envelope",
        envelope: {
          envelopeType: "USER_VALUE_KEY",
          ownerUserId: foreign.user.id,
          valueGeneration: 1n,
        },
      }),
    ).rejects.toThrow(/owner|acting user/i);
    const envelopes = await database.accountKeyEnvelopeObject.findMany({
      where: { userId: user.id },
    });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.ownerUserId).toBe(user.id);
  });

  test("refuses a second ACTIVE wrapper with the same wrapper id", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const codeId = randomWrapperId();
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code-unique",
      wrapperType: "RECOVERY_CODE",
      wrapperId: codeId,
    });
    await expect(
      addWrapper({
        actorUserId: user.id,
        actorDeviceId: device.id,
        label: "password-unique-conflict",
        wrapperType: "PASSWORD",
        wrapperId: codeId,
      }),
    ).rejects.toThrow(/unique|violation/i);
    const active = await activeWrapperRows(user.id);
    expect(active.map((row) => row.wrapperType)).toEqual(["RECOVERY_CODE"]);
  });

  test("allows re-adding the same RECOVERY_CODE wrapper id as a rotation", async () => {
    const { user } = await createUserFixture();
    const device = await createActiveDevice(user.id);
    const codeId = randomWrapperId();
    await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code-rotation-same-id",
      wrapperType: "RECOVERY_CODE",
      wrapperId: codeId,
    });
    const readded = await addWrapper({
      actorUserId: user.id,
      actorDeviceId: device.id,
      label: "recovery-code-rotation-same-id-again",
      wrapperType: "RECOVERY_CODE",
      wrapperId: codeId,
    });
    if (!("wrapper" in readded))
      throw new Error("addWrapper did not return a wrapper");
    const active = await activeWrapperRows(user.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.wrapperId).toEqual(codeId);
    const retired = await database.accountKeyWrapperObject.findMany({
      where: { userId: user.id, retiredAt: { not: null } },
    });
    expect(retired).toHaveLength(1);
  });

  test("refuses a second transfer with the same transfer id", async () => {
    const { user } = await createUserFixture();
    const sender = await createActiveDevice(user.id);
    const recipient = await createActiveDevice(user.id);
    const accountKeys = new AccountKeyRepository();
    const transferId = crypto.getRandomValues(new Uint8Array(16));
    const firstObject = await createProtocolObjectInput(22);
    const firstOperation = {
      ...(await createOperationInput(user.id, "transfer-unique-first")),
      actorDeviceId: sender.id,
    };
    await stageObject({
      operation: firstOperation,
      objectId: firstObject.id,
      canonicalBytes: firstObject.canonicalBytes,
      digest: firstObject.digest,
    });
    await accountKeys.createTransfer(database, {
      operation: firstOperation,
      transfer: {
        protocolObject: firstObject,
        identityGeneration: 1n,
        recipientDeviceId: recipient.id,
        transferId,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const secondObject = await createProtocolObjectInput(22);
    const secondOperation = {
      ...(await createOperationInput(user.id, "transfer-unique-second")),
      actorDeviceId: sender.id,
    };
    await stageObject({
      operation: secondOperation,
      objectId: secondObject.id,
      canonicalBytes: secondObject.canonicalBytes,
      digest: secondObject.digest,
    });
    await expect(
      accountKeys.createTransfer(database, {
        operation: secondOperation,
        transfer: {
          protocolObject: secondObject,
          identityGeneration: 1n,
          recipientDeviceId: recipient.id,
          transferId,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      }),
    ).rejects.toThrow(/unique|violation/i);
    const transfers = await database.accountKeyTransferObject.findMany({
      where: { userId: user.id },
    });
    expect(transfers).toHaveLength(1);
  });

  test("creates, consumes, and refuses replayed Account Key Transfers", async () => {
    const { user } = await createUserFixture();
    const sender = await createActiveDevice(user.id);
    const recipient = await createActiveDevice(user.id);
    const accountKeys = new AccountKeyRepository();
    const transferId = crypto.getRandomValues(new Uint8Array(16));
    const protocolObject = await createProtocolObjectInput(22);
    const operation = {
      ...(await createOperationInput(user.id, "amk-transfer")),
      actorDeviceId: sender.id,
    };
    await stageObject({
      operation,
      objectId: protocolObject.id,
      canonicalBytes: protocolObject.canonicalBytes,
      digest: protocolObject.digest,
    });
    const expiresAt = new Date(Date.now() + 3600_000);
    const created = await accountKeys.createTransfer(database, {
      operation,
      transfer: {
        protocolObject,
        identityGeneration: 1n,
        recipientDeviceId: recipient.id,
        transferId,
        expiresAt,
      },
    });
    if (!("transfer" in created))
      throw new Error("createTransfer did not return a transfer");
    const accepted = await accountKeys.acceptTransfer(database, {
      userId: user.id,
      deviceId: recipient.id,
      transferId,
    });
    expect(accepted.protocolObjectId).toBe(protocolObject.id);
    const consumed = await database.accountKeyTransferObject.findUniqueOrThrow({
      where: { protocolObjectId: protocolObject.id },
    });
    expect(consumed.status).toBe("CONSUMED");
    await expect(
      accountKeys.acceptTransfer(database, {
        userId: user.id,
        deviceId: recipient.id,
        transferId,
      }),
    ).rejects.toThrow("account key transfer is not pending");
  });

  test("refuses Account Key Transfers whose recipient is not an active device of the User", async () => {
    const { user } = await createUserFixture();
    const sender = await createActiveDevice(user.id);
    const foreignUser = await createUserFixture();
    const foreignDevice = await createActiveDevice(foreignUser.user.id);
    const accountKeys = new AccountKeyRepository();
    const protocolObject = await createProtocolObjectInput(22);
    const operation = {
      ...(await createOperationInput(user.id, "cross-user-transfer")),
      actorDeviceId: sender.id,
    };
    await stageObject({
      operation,
      objectId: protocolObject.id,
      canonicalBytes: protocolObject.canonicalBytes,
      digest: protocolObject.digest,
    });
    await expect(
      accountKeys.createTransfer(database, {
        operation,
        transfer: {
          protocolObject,
          identityGeneration: 1n,
          recipientDeviceId: foreignDevice.id,
          transferId: crypto.getRandomValues(new Uint8Array(16)),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      }),
    ).rejects.toThrow("transfer recipient device is not active");
  });

  test("marks an expired Account Key Transfer EXPIRED and refuses it", async () => {
    const { user } = await createUserFixture();
    const sender = await createActiveDevice(user.id);
    const recipient = await createActiveDevice(user.id);
    const accountKeys = new AccountKeyRepository();
    const transferId = crypto.getRandomValues(new Uint8Array(16));
    const protocolObject = await createProtocolObjectInput(22);
    const operation = {
      ...(await createOperationInput(user.id, "expired-transfer")),
      actorDeviceId: sender.id,
    };
    await stageObject({
      operation,
      objectId: protocolObject.id,
      canonicalBytes: protocolObject.canonicalBytes,
      digest: protocolObject.digest,
    });
    const now = new Date();
    const created = await accountKeys.createTransfer(database, {
      operation,
      transfer: {
        protocolObject,
        identityGeneration: 1n,
        recipientDeviceId: recipient.id,
        transferId,
        expiresAt: new Date(now.getTime() - 1000),
      },
      now,
    });
    if (!("transfer" in created))
      throw new Error("createTransfer did not return a transfer");
    await expect(
      accountKeys.acceptTransfer(database, {
        userId: user.id,
        deviceId: recipient.id,
        transferId,
        now,
      }),
    ).rejects.toThrow("account key transfer expired");
    const expired = await database.accountKeyTransferObject.findUniqueOrThrow({
      where: { protocolObjectId: protocolObject.id },
    });
    expect(expired.status).toBe("EXPIRED");
  });
});
