import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createAccountKeyWrapper } from "@dotrelay/client";
import {
  type CborValue,
  canonicalEncode,
  encodeProtocolObject,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  isSignedField,
  protocolObjectFromFields,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  AdministrationRepository,
  createDatabaseClient,
  type DatabaseClient,
  ensureServerProfile,
  OperationRepository,
  ProjectRepository,
  sha384Digest,
} from "@dotrelay/database";
import type { DotRelayAuth } from "./auth";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

// A-1, A-2 and A-8 regression tests against the real API and PostgreSQL.
// Requests act with a User's session but, unless a test says otherwise,
// without any of the User's Device keys. Only the Better Auth session lookup
// is stubbed.
const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const HOOK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_proof_${crypto.randomUUID().replaceAll("-", "")}`;
const testDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (testDatabaseUrl) testDatabaseUrl.pathname = `/${testDatabaseName}`;
const adminDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (adminDatabaseUrl) adminDatabaseUrl.pathname = "/postgres";
const databasePackage = fileURLToPath(
  new URL("../../../packages/database", import.meta.url),
);

const profile = loadServerProfileConfig(process.env);
// Two sessions of the same User, and one of another User.
const USER_TOKEN = "token-user-session";
const SECOND_TOKEN = "token-second-session";
const OUTSIDER_TOKEN = "token-outsider-session";
const authSubject = `auth-user-${crypto.randomUUID()}`;
const outsiderSubject = `auth-outsider-${crypto.randomUUID()}`;
const sessions = new Map([
  [USER_TOKEN, { id: `session-${crypto.randomUUID()}`, user: authSubject }],
  [SECOND_TOKEN, { id: `session-${crypto.randomUUID()}`, user: authSubject }],
  [
    OUTSIDER_TOKEN,
    { id: `session-${crypto.randomUUID()}`, user: outsiderSubject },
  ],
]);

const createAuthStub = (): DotRelayAuth =>
  ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const authorization = headers.get("Authorization");
        if (!authorization?.startsWith("Bearer ")) return null;
        const session = sessions.get(authorization.slice("Bearer ".length));
        if (!session) return null;
        return {
          session: {
            id: session.id,
            userId: session.user,
            createdAt: new Date(),
          },
          user: { id: session.user, name: "User" },
        };
      },
    },
    $context: Promise.resolve({
      options: {},
      secretConfig: { secret: "test-secret" },
    }),
  }) as unknown as DotRelayAuth;

const runMigrations = async () => {
  if (!testDatabaseUrl) throw new Error("DATABASE_URL is required");
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "x",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      "prisma.config.ts",
    ],
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

type DeviceKeys = Readonly<{
  readonly signingKey: CryptoKey;
  readonly ed25519PublicKey: Uint8Array;
  readonly x25519PublicKey: Uint8Array;
  readonly keyId: Uint8Array;
}>;

const createDeviceKeys = async (): Promise<DeviceKeys> => {
  const signing = await generateSigningKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const ed25519PublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", signing.publicKey),
  );
  const x25519PublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", encryption.publicKey),
  );
  return {
    signingKey: signing.privateKey,
    ed25519PublicKey,
    x25519PublicKey,
    keyId: await sha384Digest(x25519PublicKey),
  };
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");
const fromBase64Url = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64url"));

const signedCertificate = async (
  userId: string,
  deviceId: string,
  keys: DeviceKeys,
): Promise<Uint8Array> => {
  const object = new Map<number, CborValue>(
    protocolObjectFromFields(
      2,
      new Map<number, CborValue>([
        [8, uuidToBytes(profile.id)],
        [9, uuidToBytes(userId)],
        [10, uuidToBytes(deviceId)],
        [17, crypto.getRandomValues(new Uint8Array(16))],
        [28, 1],
        [32, Date.now()],
        [39, keys.x25519PublicKey],
        [41, keys.ed25519PublicKey],
      ]),
    ).entries(),
  );
  object.set(
    3,
    canonicalEncode(
      new Map([...object.entries()].filter(([field]) => !isSignedField(field))),
    ),
  );
  object.set(4, new Uint8Array(64));
  object.set(4, await signProtocolObject(object, keys.signingKey));
  return encodeProtocolObject(object);
};

// The message a Device signs to exchange a challenge for a Device proof,
// built here from ADR 0018 rather than from the implementation, so the test
// also pins the wire layout.
const proofMessage = (
  userId: string,
  deviceId: string,
  challenge: Uint8Array,
): Uint8Array => {
  const prefix = new TextEncoder().encode("dotrelay-device-proof-v1\0");
  return new Uint8Array([
    ...prefix,
    ...uuidToBytes(profile.id),
    ...uuidToBytes(userId),
    ...uuidToBytes(deviceId),
    ...challenge,
  ]);
};

let database: DatabaseClient;
let app: ReturnType<typeof createApi>;
let adminSql: ReturnType<typeof postgres> | undefined;
let userId = "";
let outsiderId = "";
let deviceId = "";
let keys: DeviceKeys;
let outsiderDeviceId = "";
let outsiderKeys: DeviceKeys;
let teamId = "";
let passkeyWrapperId = "";

const request = (
  path: string,
  init: Readonly<{
    readonly method?: string;
    readonly token?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  }> = {},
) =>
  app.request(`${profile.origin}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${init.token ?? USER_TOKEN}`,
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const challenge = async (token = USER_TOKEN): Promise<Uint8Array> => {
  const response = await request("/api/v1/devices/proofs/challenges", {
    method: "POST",
    token,
    body: {},
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    challenge: string;
    expiresIn: number;
  };
  expect(body.expiresIn).toBeGreaterThan(0);
  return fromBase64Url(body.challenge);
};

const exchange = async (
  input: Readonly<{
    readonly token?: string;
    readonly deviceId: string;
    readonly userId: string;
    readonly signingKey: CryptoKey;
    readonly challenge?: Uint8Array;
  }>,
): Promise<Response> => {
  const issued = input.challenge ?? (await challenge(input.token));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      input.signingKey,
      proofMessage(input.userId, input.deviceId, issued).slice(),
    ),
  );
  return request("/api/v1/devices/proofs", {
    method: "POST",
    ...(input.token ? { token: input.token } : {}),
    body: {
      deviceId: input.deviceId,
      challenge: Buffer.from(issued).toString("base64url"),
      signature: toBase64(signature),
    },
  });
};

const proveDevice = async (token = USER_TOKEN): Promise<string> => {
  const response = await exchange({
    token,
    deviceId,
    userId,
    signingKey: keys.signingKey,
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    token: string;
    deviceId: string;
    expiresIn: number;
  };
  expect(body.deviceId).toBe(deviceId);
  expect(body.expiresIn).toBeGreaterThan(0);
  return body.token;
};

const deviceHeaders = (
  proof: string,
  claimedDeviceId = deviceId,
): Record<string, string> => ({
  "X-DotRelay-Device-Id": claimedDeviceId,
  "X-DotRelay-Device-Proof": proof,
});

const bootstrap = async (
  token: string,
  owner: string,
  device: string,
  deviceKeys: DeviceKeys,
) => {
  const response = await request("/api/v1/devices/bootstrap", {
    method: "POST",
    token,
    body: {
      operationId: crypto.randomUUID(),
      deviceId: device,
      certificateId: crypto.randomUUID(),
      identityGeneration: 1,
      x25519PublicKey: toHex(deviceKeys.x25519PublicKey),
      ed25519PublicKey: toHex(deviceKeys.ed25519PublicKey),
      keyId: toHex(deviceKeys.keyId),
      certificate: toBase64(await signedCertificate(owner, device, deviceKeys)),
    },
  });
  expect(response.status).toBe(201);
};

// Wrapper rows are inserted directly: the fixtures must not depend on the
// Device authorization these tests exercise.
const insertWrapper = async (kind: "passkey" | "recovery"): Promise<string> => {
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: profile.id,
    userId: uuidToBytes(userId),
    deviceId: uuidToBytes(deviceId),
    userIdentityGeneration: 1,
    createdAtMs: Date.now(),
    accountMasterKey: crypto.getRandomValues(new Uint8Array(32)),
    signingPrivateKey: keys.signingKey,
    kind:
      kind === "passkey"
        ? {
            type: "passkeyPrf",
            credentialId: crypto.getRandomValues(new Uint8Array(16)),
            prfInput: crypto.getRandomValues(new Uint8Array(32)),
            prfOutput: crypto.getRandomValues(new Uint8Array(32)),
          }
        : {
            type: "recoveryCode",
            recoveryCode: crypto.getRandomValues(new Uint8Array(32)),
          },
  });
  const bytes = new Uint8Array(encodeProtocolObject(wrapper.object));
  const protocolObject = await database.protocolObject.create({
    data: {
      id: crypto.randomUUID(),
      suite: profile.suite.name,
      formatVersion: 3,
      kind: 20,
      canonicalBytes: bytes,
      digest: new Uint8Array(await sha384Digest(bytes)),
    },
  });
  await database.accountKeyWrapperObject.create({
    data: {
      protocolObjectId: protocolObject.id,
      userId,
      identityGeneration: 1n,
      wrapperType: kind === "passkey" ? "PASSKEY_PRF" : "RECOVERY_CODE",
      wrapperId: new Uint8Array(wrapper.wrapperId),
      ...(wrapper.credentialId
        ? { credentialId: new Uint8Array(wrapper.credentialId) }
        : {}),
      ciphertextHash: new Uint8Array(await sha384Digest(wrapper.ciphertext)),
      ciphertextLength: wrapper.ciphertext.length,
    },
  });
  return toHex(wrapper.wrapperId);
};

const createUser = async (subject: string, githubSubject: string) => {
  const user = await database.user.create({
    data: { serverProfileId: profile.id, authSubject: subject, githubSubject },
  });
  await database.authUser.create({
    data: {
      id: subject,
      name: subject,
      email: `${subject}@example.test`,
    },
  });
  await database.authAccount.create({
    data: {
      id: crypto.randomUUID(),
      accountId: githubSubject,
      providerId: "github",
      userId: subject,
    },
  });
  return user.id;
};

integrationDescribe("Device proof of possession (PostgreSQL)", () => {
  beforeAll(async () => {
    if (!adminDatabaseUrl || !testDatabaseUrl)
      throw new Error("DATABASE_URL is required");
    database = createDatabaseClient(testDatabaseUrl.toString());
    adminSql = postgres(adminDatabaseUrl.toString(), { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${testDatabaseName}`);
    await runMigrations();
    await ensureServerProfile(database, {
      id: profile.id,
      origin: profile.origin,
      allowRebind: profile.allowRebind,
    });
    userId = await createUser(authSubject, "7001");
    outsiderId = await createUser(outsiderSubject, "7002");
    app = createApi({ database, profile, auth: createAuthStub() });
    keys = await createDeviceKeys();
    deviceId = crypto.randomUUID();
    await bootstrap(USER_TOKEN, userId, deviceId, keys);
    outsiderKeys = await createDeviceKeys();
    outsiderDeviceId = crypto.randomUUID();
    await bootstrap(OUTSIDER_TOKEN, outsiderId, outsiderDeviceId, outsiderKeys);
    await insertWrapper("recovery");
    passkeyWrapperId = await insertWrapper("passkey");
    const teamCommand = new TextEncoder().encode(crypto.randomUUID());
    const team = await new AdministrationRepository().createTeamWithOwner(
      database,
      {
        serverProfileId: profile.id,
        ownerUserId: userId,
        name: "First Team",
        operation: {
          id: crypto.randomUUID(),
          actorUserId: userId,
          actorDeviceId: deviceId,
          kind: "ADMINISTRATION",
          commandBytes: teamCommand,
          commandDigest: await sha384Digest(teamCommand),
        },
      },
    );
    if (!("team" in team)) throw new Error("team was not created");
    teamId = team.team.id;
    const commandBytes = new TextEncoder().encode(crypto.randomUUID());
    await new ProjectRepository().create(database, {
      teamId,
      githubRepositoryId: 424242n,
      operation: {
        id: crypto.randomUUID(),
        actorUserId: userId,
        actorDeviceId: deviceId,
        kind: "ADMINISTRATION",
        commandBytes,
        commandDigest: await sha384Digest(commandBytes),
      },
    });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await database?.$disconnect();
    if (!adminSql) return;
    try {
      await adminSql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${testDatabaseName} AND pid <> pg_backend_pid()
      `;
      await adminSql.unsafe(`DROP DATABASE IF EXISTS "${testDatabaseName}"`);
    } finally {
      await adminSql.end();
    }
  }, HOOK_TIMEOUT_MS);

  describe("a session without the Device key", () => {
    test(
      "learns no Device ids, keys or envelopes from the workspace boundary",
      async () => {
        const response = await request("/api/v1/workspace/boundary");
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(deviceId);
        expect(body.device).toMatchObject({ active: false });
        expect(body.peerDevices ?? []).toEqual([]);
        expect(body.signingTrustDevices ?? []).toEqual([]);
        expect(body.signingTrustKeys ?? []).toEqual([]);
        expect(body.accountKeyEnvelope).toBeUndefined();
        expect(body.userValueKeyEnvelope).toBeUndefined();
        expect(body.epochGrant).toBeUndefined();
        expect(body.activeDeviceCount).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "gets only the Recovery Code wrapper even when it names the Device",
      async () => {
        const response = await request("/api/v1/account-keys/wrappers", {
          headers: { "X-DotRelay-Device-Id": deviceId },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          wrappers: { type: string }[];
        };
        expect(body.wrappers.map((wrapper) => wrapper.type)).toEqual([
          "recovery-code",
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "cannot revoke Account Key Wrappers",
      async () => {
        const operationId = crypto.randomUUID();
        const response = await request("/api/v1/account-keys/wrappers/revoke", {
          method: "POST",
          headers: {
            "X-DotRelay-Device-Id": deviceId,
            "Idempotency-Key": operationId,
          },
          body: { operationId, wrapperId: passkeyWrapperId },
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          code: "device_proof_required",
        });
        const retired = await database.accountKeyWrapperObject.count({
          where: { userId, retiredAt: { not: null } },
        });
        expect(retired).toBe(0);
        expect(
          await database.operation.count({ where: { id: operationId } }),
        ).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "cannot create Teams or rename the Device",
      async () => {
        const operationId = crypto.randomUUID();
        const created = await request("/api/v1/teams", {
          method: "POST",
          headers: {
            "X-DotRelay-Device-Id": deviceId,
            "Idempotency-Key": operationId,
          },
          body: { name: "Unproven Team" },
        });
        expect(created.status).toBe(401);
        expect(
          await database.team.count({ where: { name: "Unproven Team" } }),
        ).toBe(0);
        const renamed = await request("/api/v1/devices/self", {
          method: "POST",
          headers: { "X-DotRelay-Device-Id": deviceId },
          body: { displayName: "owned" },
        });
        expect(renamed.status).toBe(401);
        const device = await database.device.findUnique({
          where: { id: deviceId },
          select: { displayName: true },
        });
        expect(device?.displayName).not.toBe("owned");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "cannot mint a proof with a key it chose",
      async () => {
        const impostor = await generateSigningKeyPair();
        const response = await exchange({
          deviceId,
          userId,
          signingKey: impostor.privateKey,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "invalid_crypto_object",
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "cannot present a made-up or tampered proof",
      async () => {
        const forged = Buffer.from(
          crypto.getRandomValues(new Uint8Array(73)),
        ).toString("base64url");
        const made = await request("/api/v1/account-keys/envelopes", {
          headers: deviceHeaders(forged),
        });
        expect(made.status).toBe(401);
        expect(await made.json()).toMatchObject({
          code: "device_proof_required",
        });
        const genuine = fromBase64Url(await proveDevice());
        const tampered = new Uint8Array(genuine);
        tampered[20] = (tampered[20] ?? 0) ^ 1;
        const response = await request("/api/v1/account-keys/envelopes", {
          headers: deviceHeaders(Buffer.from(tampered).toString("base64url")),
        });
        expect(response.status).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("a Device that proves possession of its key", () => {
    test(
      "reads every wrapper and its own Device view of the boundary",
      async () => {
        const proof = await proveDevice();
        const wrappers = await request("/api/v1/account-keys/wrappers", {
          headers: deviceHeaders(proof),
        });
        expect(wrappers.status).toBe(200);
        const listed = (await wrappers.json()) as {
          wrappers: { type: string }[];
        };
        expect(listed.wrappers.map((wrapper) => wrapper.type).sort()).toEqual([
          "passkey-prf",
          "recovery-code",
        ]);
        const boundary = await request("/api/v1/workspace/boundary", {
          headers: deviceHeaders(proof),
        });
        expect(boundary.status).toBe(200);
        const body = (await boundary.json()) as {
          device: { active: boolean; id?: string };
          signingTrustDevices: { deviceId: string }[];
        };
        expect(body.device).toMatchObject({ active: true, id: deviceId });
        expect(
          body.signingTrustDevices.map((entry) => entry.deviceId),
        ).toContain(deviceId);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "can make an unsigned administrative change",
      async () => {
        const proof = await proveDevice();
        const operationId = crypto.randomUUID();
        const response = await request("/api/v1/teams", {
          method: "POST",
          headers: { ...deviceHeaders(proof), "Idempotency-Key": operationId },
          body: { name: "Second Team" },
        });
        expect(response.status).toBe(201);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "proves itself without the optional Device id claim",
      async () => {
        const proof = await proveDevice();
        const response = await request("/api/v1/account-keys/envelopes", {
          headers: { "X-DotRelay-Device-Proof": proof },
        });
        expect(response.status).toBe(200);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "gets the same proof when an exchange is replayed",
      async () => {
        const issued = await challenge();
        const first = await exchange({
          deviceId,
          userId,
          signingKey: keys.signingKey,
          challenge: issued,
        });
        const second = await exchange({
          deviceId,
          userId,
          signingKey: keys.signingKey,
          challenge: issued,
        });
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        const firstToken = ((await first.json()) as { token: string }).token;
        const secondToken = ((await second.json()) as { token: string }).token;
        expect(secondToken).toBe(firstToken);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("a proof is bound", () => {
    test(
      "to the session that obtained it",
      async () => {
        const proof = await proveDevice(USER_TOKEN);
        const response = await request("/api/v1/account-keys/envelopes", {
          token: SECOND_TOKEN,
          headers: deviceHeaders(proof),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          code: "device_proof_required",
        });
        const outsider = await request("/api/v1/account-keys/envelopes", {
          token: OUTSIDER_TOKEN,
          headers: deviceHeaders(proof),
        });
        expect(outsider.status).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "to the challenge's session",
      async () => {
        const issued = await challenge(SECOND_TOKEN);
        const response = await exchange({
          token: USER_TOKEN,
          deviceId,
          userId,
          signingKey: keys.signingKey,
          challenge: issued,
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          code: "device_proof_required",
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "to its Device",
      async () => {
        const proof = await proveDevice();
        const response = await request("/api/v1/account-keys/envelopes", {
          headers: deviceHeaders(proof, outsiderDeviceId),
        });
        expect(response.status).toBe(400);
        // Another User's Device cannot be proven from this session.
        const foreign = await exchange({
          deviceId: outsiderDeviceId,
          userId,
          signingKey: outsiderKeys.signingKey,
        });
        expect(foreign.status).toBe(403);
        expect(await foreign.json()).toMatchObject({
          code: "device_not_active",
        });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("A-8: operations begun before an authorization failure", () => {
    test(
      "expire instead of staying STAGED forever",
      async () => {
        const proof = await proveDevice();
        const operationId = crypto.randomUUID();
        const response = await request("/api/v1/account-keys/wrappers/revoke", {
          method: "POST",
          headers: { ...deviceHeaders(proof), "Idempotency-Key": operationId },
          body: { operationId, wrapperId: toHex(new Uint8Array(16)) },
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        const operation = await database.operation.findUnique({
          where: { id: operationId },
        });
        if (operation) {
          expect(operation.status).toBe("STAGED");
          expect(operation.expiresAt).not.toBeNull();
          const later = new Date((operation.expiresAt?.getTime() ?? 0) + 1_000);
          await new OperationRepository().expireStaging(database, later);
          const expired = await database.operation.findUnique({
            where: { id: operationId },
          });
          expect(expired?.status).toBe("EXPIRED");
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("A-2: a revoked Device", () => {
    test(
      "cannot be reset to PENDING by a session-only enrollment",
      async () => {
        // A second Device of the User, revoked earlier.
        const revokedKeys = await createDeviceKeys();
        const revokedId = crypto.randomUUID();
        const activatedAt = new Date(Date.now() - 60_000);
        const revokedAt = new Date(Date.now() - 30_000);
        await database.device.create({
          data: {
            id: revokedId,
            userId,
            lifecycle: "REVOKED",
            identityGeneration: 1n,
            keyId: new Uint8Array(revokedKeys.keyId),
            x25519PublicKey: new Uint8Array(revokedKeys.x25519PublicKey),
            ed25519PublicKey: new Uint8Array(revokedKeys.ed25519PublicKey),
            activatedAt,
            revokedAt,
          },
        });
        // A request naming the revoked Device with its X25519 key and a
        // different Ed25519 key.
        const requestKeys = {
          ...(await createDeviceKeys()),
          x25519PublicKey: revokedKeys.x25519PublicKey,
          keyId: revokedKeys.keyId,
        };
        const operationId = crypto.randomUUID();
        const response = await request("/api/v1/devices/enrollments", {
          method: "POST",
          headers: { "Idempotency-Key": operationId },
          body: {
            operationId,
            userId,
            enrollmentId: crypto.randomUUID(),
            deviceId: revokedId,
            identityGeneration: "1",
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            transcriptHash: toHex(crypto.getRandomValues(new Uint8Array(48))),
            challengeHash: toHex(crypto.getRandomValues(new Uint8Array(48))),
            x25519PublicKey: toBase64(requestKeys.x25519PublicKey),
            ed25519PublicKey: toBase64(requestKeys.ed25519PublicKey),
            keyId: toBase64(requestKeys.keyId),
            certificateObjectId: crypto.randomUUID(),
            certificateObject: toBase64(
              await signedCertificate(userId, revokedId, requestKeys),
            ),
          },
        });
        expect(response.status).toBe(409);
        const row = await database.device.findUnique({
          where: { id: revokedId },
        });
        expect(row?.lifecycle).toBe("REVOKED");
        expect(row?.activatedAt?.getTime()).toBe(activatedAt.getTime());
        expect(row?.revokedAt?.getTime()).toBe(revokedAt.getTime());
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "stays revoked whatever writes the row",
      async () => {
        const revokedKeys = await createDeviceKeys();
        const revokedId = crypto.randomUUID();
        await database.device.create({
          data: {
            id: revokedId,
            userId,
            lifecycle: "REVOKED",
            identityGeneration: 1n,
            keyId: new Uint8Array(revokedKeys.keyId),
            x25519PublicKey: new Uint8Array(revokedKeys.x25519PublicKey),
            ed25519PublicKey: new Uint8Array(revokedKeys.ed25519PublicKey),
            activatedAt: new Date(Date.now() - 60_000),
            revokedAt: new Date(Date.now() - 30_000),
          },
        });
        const refused = async (
          data: Parameters<DatabaseClient["device"]["update"]>[0]["data"],
          id: string = revokedId,
        ) => {
          let failed = false;
          try {
            await database.device.update({ where: { id }, data });
          } catch {
            failed = true;
          }
          expect(failed).toBe(true);
        };
        await refused({
          lifecycle: "PENDING",
          activatedAt: null,
          revokedAt: null,
        });
        await refused({ lifecycle: "ACTIVE" });
        await refused({ revokedAt: new Date() });
        await refused({ activatedAt: new Date() }, deviceId);
        await refused({ ed25519PublicKey: new Uint8Array(32) }, deviceId);
        // Display metadata stays writable.
        await database.device.update({
          where: { id: revokedId },
          data: { displayName: "old laptop" },
        });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("revocation", () => {
    test(
      "ends the proofs of the revoked Device",
      async () => {
        const proof = await proveDevice();
        await database.device.update({
          where: { id: deviceId },
          data: { lifecycle: "REVOKED", revokedAt: new Date() },
        });
        const response = await request("/api/v1/account-keys/envelopes", {
          headers: deviceHeaders(proof),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: "device_not_active",
        });
        const fresh = await exchange({
          deviceId,
          userId,
          signingKey: keys.signingKey,
        });
        expect(fresh.status).toBe(403);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
