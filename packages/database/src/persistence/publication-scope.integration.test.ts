import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  createPublicationArtifacts,
  type PublicationArtifacts,
} from "@dotrelay/client";
import {
  type CborValue,
  bytesToUuid,
  canonicalEncode,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  protocolObjectFromFields,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import type {
  DatabaseClient,
  OperationInput,
  ProtocolObjectInput,
  RevisionPublicationInput,
} from "..";
import {
  AdministrationRepository,
  createDatabaseClient,
  EnvironmentRepository,
  OperationRepository,
  ProjectRepository,
  PublicationRepository,
  StagedObjectRepository,
  sha384Digest,
} from "..";

const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const INTEGRATION_HOOK_TIMEOUT_MS = 120_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_publication_scope_${crypto
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
const databasePackage = fileURLToPath(new URL("../..", import.meta.url));
const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;
// Must match COMMAND_STAGE_OBJECT_ID in @dotrelay/api's protocol routes.
const COMMAND_STAGE_OBJECT_ID = "00000000-0000-4000-8000-0000000000c0";

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
): Promise<OperationInput> => {
  const commandBytes = textEncoder.encode(label);
  return {
    id: crypto.randomUUID(),
    actorUserId,
    kind: "ADMINISTRATION",
    commandBytes,
    commandDigest: await sha384Digest(commandBytes),
  };
};

type ScopedActor = Readonly<{
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly valueRecipientPublicKey: CryptoKey;
  readonly sharedValueSecret: Uint8Array;
  readonly signing: CryptoKeyPair;
}>;

const createScopedActor = async (): Promise<ScopedActor> => {
  const signing = await generateSigningKeyPair();
  const valueRecipientPublicKey = (await generateEncryptionKeyPair()).publicKey;
  const sharedValueSecret = crypto.getRandomValues(new Uint8Array(32));
  const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
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
      keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
      x25519PublicKey,
      ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
      activatedAt: new Date(),
    },
  });
  const teamId = crypto.randomUUID();
  await new AdministrationRepository().createTeamWithOwner(database, {
    teamId,
    serverProfileId: serverProfile.id,
    ownerUserId: user.id,
    name: "publication-scope",
    operation: {
      ...(await createOperationInput(user.id, "publication-scope-team")),
      actorDeviceId: device.id,
    },
  });
  const projectId = crypto.randomUUID();
  await new ProjectRepository().create(database, {
    teamId,
    projectId,
    githubRepositoryId: BigInt(Date.now()),
    operation: {
      ...(await createOperationInput(user.id, "publication-scope-project")),
      actorDeviceId: device.id,
    },
  });
  return {
    serverProfileId: serverProfile.id,
    teamId,
    projectId,
    userId: user.id,
    deviceId: device.id,
    valueRecipientPublicKey,
    sharedValueSecret,
    signing,
  };
};

type ScopeFixtures = ScopedActor &
  Readonly<{
    readonly environmentIdA: string;
    readonly environmentIdB: string;
  }>;

const createScopeFixtures = async (): Promise<ScopeFixtures> => {
  const actor = await createScopedActor();
  const environments = new EnvironmentRepository();
  const environmentIdA = crypto.randomUUID();
  const environmentIdB = crypto.randomUUID();
  for (const [environmentId, label] of [
    [environmentIdA, "scope-a"],
    [environmentIdB, "scope-b"],
  ] as const) {
    await environments.create(database, {
      environmentId,
      projectId: actor.projectId,
      createdByUserId: actor.userId,
      label,
      operation: {
        ...(await createOperationInput(actor.userId, `${label}-environment`)),
        actorDeviceId: actor.deviceId,
      },
    });
  }
  return { ...actor, environmentIdA, environmentIdB };
};

const buildPublicationArtifacts = (
  fixtures: ScopedActor,
  environmentId: string,
): Promise<PublicationArtifacts> =>
  createPublicationArtifacts(
    [
      {
        id: crypto.randomUUID(),
        name: "scope_probe",
        description: "publication scope probe",
        ownership: "SHARED_VALUE",
        value: "scope",
        required: false,
        hasDraftChange: true,
      },
    ],
    {
      serverProfileId: fixtures.serverProfileId,
      teamId: fixtures.teamId,
      projectId: fixtures.projectId,
      environmentId,
      actorUserId: fixtures.userId,
      actorDeviceId: fixtures.deviceId,
      projectEpoch: 1,
      expectedHeadId: null,
      expectedHeadHash: null,
      valueRecipientPublicKey: fixtures.valueRecipientPublicKey,
      sharedValueSecret: fixtures.sharedValueSecret,
      signingPrivateKey: fixtures.signing.privateKey,
      mutation: "GENESIS",
    },
  );

type StagedObject = Readonly<{
  readonly objectId: string;
  readonly bytes: Uint8Array;
}>;

const stagedDigest = async (object: StagedObject): Promise<Uint8Array> =>
  sha384(object.bytes);

// Stamps the projection the same way the API's finalize route does: the
// route's Project and Environment ids go onto the projection while the
// signed canonical bytes keep whatever ids the client signed.
const stampProjection = (
  object: StagedObject,
  target: Readonly<{
    readonly projectId: string;
    readonly environmentId: string;
  }>,
  digest: Uint8Array,
): ProtocolObjectInput => ({
  id: object.objectId,
  suite: "dotrelay-e2ee-v3-classical-webcrypto",
  formatVersion: 3,
  kind: parseProtocolObject(object.bytes).get(1) as number,
  canonicalBytes: object.bytes,
  digest,
  projectId: target.projectId,
  environmentId: target.environmentId,
});

const drivePublication = async (
  fixtures: ScopeFixtures,
  input: Readonly<{
    readonly artifacts: PublicationArtifacts;
    readonly targetEnvironmentId: string;
    readonly retargetedLane?: StagedObject;
  }>,
): Promise<RevisionPublicationInput> => {
  const request = input.artifacts.request;
  const operation: OperationInput & { readonly actorDeviceId: string } = {
    id: crypto.randomUUID(),
    actorUserId: fixtures.userId,
    actorDeviceId: fixtures.deviceId,
    kind: "REVISION_PUBLICATION",
    commandBytes: input.artifacts.commandBytes,
    commandDigest: await sha384(input.artifacts.commandBytes),
  };
  await new OperationRepository().begin(database, operation);
  const staging = new StagedObjectRepository();
  const stagedCommand: StagedObject = {
    objectId: COMMAND_STAGE_OBJECT_ID,
    bytes: input.artifacts.commandBytes,
  };
  // When a lane is retargeted its re-signed bytes replace the staged object
  // for the same lane id (signed field 18 is unchanged), so the staged row
  // and the projection carry the new bytes and digest.
  const stagedObjects = [
    ...input.artifacts.stagedObjects.map((object) =>
      input.retargetedLane && input.retargetedLane.objectId === object.objectId
        ? input.retargetedLane
        : object,
    ),
    stagedCommand,
  ];
  const digestByObject = new Map<string, Uint8Array>();
  for (const object of stagedObjects) {
    digestByObject.set(object.objectId, await stagedDigest(object));
    const createdAt = new Date();
    await staging.put(database, {
      operationId: operation.id,
      objectId: object.objectId,
      actorDeviceId: fixtures.deviceId,
      canonicalBytes: object.bytes,
      digest: digestByObject.get(object.objectId) as Uint8Array,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 60_000),
    });
  }
  const target = {
    projectId: fixtures.projectId,
    environmentId: input.targetEnvironmentId,
  };
  const projectionOf = (objectId: string): ProtocolObjectInput => {
    const object = stagedObjects.find(
      (candidate) => candidate.objectId === objectId,
    );
    if (!object) throw new Error(`staged object ${objectId} is missing`);
    return stampProjection(
      object,
      target,
      digestByObject.get(objectId) as Uint8Array,
    );
  };
  return {
    operation: {
      id: operation.id,
      actorUserId: fixtures.userId,
      actorDeviceId: fixtures.deviceId,
      kind: "REVISION_PUBLICATION",
      commandBytes: input.artifacts.commandBytes,
      commandDigest: operation.commandDigest,
    },
    environmentId: input.targetEnvironmentId,
    expectedHeadId: request.expectedHeadId,
    revision: {
      id: request.revision.id,
      protocolObjectId: request.revision.protocolObjectId,
      projectEpoch: BigInt(request.revision.projectEpoch),
      mutation: request.revision.mutation,
      authoredAtMs: BigInt(request.revision.authoredAtMs),
    },
    revisionObject: projectionOf(request.revision.protocolObjectId),
    descriptor: {
      protocolObject: projectionOf(request.descriptor.protocolObjectId),
      schemaVersion: request.descriptor.schemaVersion,
      descriptorHash: request.descriptor.descriptorHash,
      laneCount: request.descriptor.laneCount,
    },
    lanes: request.lanes.map((lane) => ({
      lane: {
        id: lane.id,
        protocolObjectId: lane.protocolObjectId,
        projectId: target.projectId,
        environmentId: target.environmentId,
        scope: lane.scope,
        ...(lane.ownerUserId ? { ownerUserId: lane.ownerUserId } : {}),
        ...(lane.originalProviderUserId
          ? { originalProviderUserId: lane.originalProviderUserId }
          : {}),
        projectEpoch: BigInt(lane.projectEpoch),
        plaintextLength: lane.plaintextLength,
        ciphertextLength: lane.ciphertextLength,
        ciphertextHash: lane.ciphertextHash,
      },
      protocolObject: projectionOf(lane.protocolObjectId),
    })),
    commitments: request.commitments.map((commitment) => ({
      ordinal: commitment.ordinal,
      laneObjectId: commitment.laneObjectId,
      // A retargeted lane changes the committed object hash.
      objectHash: digestByObject.get(commitment.laneObjectId) as Uint8Array,
      projectEpoch: BigInt(commitment.projectEpoch),
      scope: commitment.scope,
      ...(commitment.ownerUserId
        ? { ownerUserId: commitment.ownerUserId }
        : {}),
      ...(commitment.originalProviderUserId
        ? { originalProviderUserId: commitment.originalProviderUserId }
        : {}),
      ciphertextLength: commitment.ciphertextLength,
    })),
    audit: {
      kind: "REVISION_PUBLISHED",
      entityKind: "ENVIRONMENT",
      entityId: input.targetEnvironmentId,
    },
  };
};

// Re-derives the signed envelope exactly as a client does: field 3 is the
// canonical encoding of every non-signed field and field 4 is an Ed25519
// signature over that encoding.
const signObject = async (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
  signingKey: CryptoKey,
): Promise<Uint8Array> => {
  const envelope = new Map<number, CborValue>(fields);
  envelope.set(4, new Uint8Array(64));
  // The unsigned body is the canonical encoding of the full object (suite,
  // kind, and schema version included) minus the signed fields.
  const candidate = protocolObjectFromFields(kind, envelope);
  const unsignedBytes = canonicalEncode(
    new Map(
      [...candidate.entries()].filter(([field]) => field !== 3 && field !== 4),
    ),
  );
  envelope.set(3, unsignedBytes);
  const signature = await signProtocolObject(
    protocolObjectFromFields(kind, envelope),
    signingKey,
  );
  envelope.set(4, signature);
  return canonicalEncode(protocolObjectFromFields(kind, envelope));
};

// Retargets a signed lane object at another Environment by re-signing it
// with the actor's key, keeping every other field intact.
const retargetLaneEnvironment = async (
  laneBytes: Uint8Array,
  environmentId: string,
  signingKey: CryptoKey,
): Promise<StagedObject> => {
  const parsed = parseProtocolObject(laneBytes);
  const fields = new Map<number, CborValue>(
    [...parsed.entries()].filter(
      ([field]) => field !== 0 && field !== 1 && field !== 2,
    ),
  );
  fields.set(14, uuidToBytes(environmentId));
  const objectId = parsed.get(18);
  if (!(objectId instanceof Uint8Array))
    throw new Error("lane object is missing its id");
  const bytes = await signObject(13, fields, signingKey);
  return { objectId: bytesToUuid(objectId), bytes };
};

integrationDescribe("publication signed-scope enforcement", () => {
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

  test("rejects a publication whose signed objects name a sibling Environment", async () => {
    const fixtures = await createScopeFixtures();
    const artifacts = await buildPublicationArtifacts(
      fixtures,
      fixtures.environmentIdA,
    );
    const input = await drivePublication(fixtures, {
      artifacts,
      targetEnvironmentId: fixtures.environmentIdB,
    });

    await expect(
      new PublicationRepository().publishRevision(database, input),
    ).rejects.toThrow(
      "names a different Environment than its publication target",
    );
    expect(
      await database.environment.findUnique({
        where: { id: fixtures.environmentIdB },
      }),
    ).toMatchObject({ currentHeadId: null });
    expect(
      await database.revision.count({
        where: { environmentId: fixtures.environmentIdB },
      }),
    ).toBe(0);
  });

  test("accepts a publication whose signed objects name the target Environment", async () => {
    const fixtures = await createScopeFixtures();
    const artifacts = await buildPublicationArtifacts(
      fixtures,
      fixtures.environmentIdB,
    );
    const input = await drivePublication(fixtures, {
      artifacts,
      targetEnvironmentId: fixtures.environmentIdB,
    });

    const published = await new PublicationRepository().publishRevision(
      database,
      input,
    );
    expect(published.revision.id).toBe(artifacts.request.revision.id);
    expect(
      await database.environment.findUnique({
        where: { id: fixtures.environmentIdB },
      }),
    ).toMatchObject({ currentHeadId: artifacts.request.revision.id });
    // The probe Variable publishes a definition lane and a Shared Value lane.
    expect(
      await database.laneObject.count({
        where: { environmentId: fixtures.environmentIdB },
      }),
    ).toBe(2);
  });

  test("rejects a lane object that names another Environment", async () => {
    const fixtures = await createScopeFixtures();
    const artifacts = await buildPublicationArtifacts(
      fixtures,
      fixtures.environmentIdB,
    );
    const lane = artifacts.stagedObjects.find((object) => {
      const kind = parseProtocolObject(object.bytes).get(1);
      return kind === 13;
    });
    if (!lane) throw new Error("publication has no lane object");
    const retargetedLane = await retargetLaneEnvironment(
      lane.bytes,
      fixtures.environmentIdA,
      fixtures.signing.privateKey,
    );
    const input = await drivePublication(fixtures, {
      artifacts,
      targetEnvironmentId: fixtures.environmentIdB,
      retargetedLane,
    });

    await expect(
      new PublicationRepository().publishRevision(database, input),
    ).rejects.toThrow(
      "lane object names a different Environment than its publication target",
    );
    expect(
      await database.environment.findUnique({
        where: { id: fixtures.environmentIdB },
      }),
    ).toMatchObject({ currentHeadId: null });
  });
});
