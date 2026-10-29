import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  canonicalEncode,
  encodeProtocolObject,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  isSignedField,
  protocolObjectFromFields,
  signProtocolObject,
  sha384ToHex,
  type CborValue,
  type ProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  createDatabaseClient,
  ensureServerProfile,
  sha384Digest,
  type DatabaseClient,
} from "@dotrelay/database";
import type { DotRelayAuth } from "./auth";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

// Real-Postgres regression test for the sole-Device enrollment fix: the
// prospective Device's enrollment must be approvable by the User's single
// ACTIVE Device through the real route handlers (session-only begin,
// Device-actor approve and complete), not just via DeviceRepository calls.
const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const INTEGRATION_HOOK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_enroll_${crypto
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
const databasePackage = fileURLToPath(
  new URL("../../../packages/database", import.meta.url),
);
const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const profile = loadServerProfileConfig(process.env);
const USER1_TOKEN = "token-sole-device-owner";
const USER2_TOKEN = "token-deviceless-user";
const authSubject1 = `auth-sole-${crypto.randomUUID()}`;
const authSubject2 = `auth-deviceless-${crypto.randomUUID()}`;

const createAuthStub = (): DotRelayAuth =>
  ({
    api: {
      getSession: async ({
        headers,
      }: {
        headers: Headers;
      }): Promise<null | { user: { id: string } }> => {
        const authorization = headers.get("Authorization");
        if (!authorization?.startsWith("Bearer ")) return null;
        const token = authorization.slice("Bearer ".length);
        if (token === USER1_TOKEN) return { user: { id: authSubject1 } };
        if (token === USER2_TOKEN) return { user: { id: authSubject2 } };
        return null;
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
  const signingKeyPair = await generateSigningKeyPair();
  const encryptionKeyPair = await generateEncryptionKeyPair();
  const ed25519PublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", signingKeyPair.publicKey),
  );
  const x25519PublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", encryptionKeyPair.publicKey),
  );
  return {
    signingKey: signingKeyPair.privateKey,
    ed25519PublicKey,
    x25519PublicKey,
    keyId: await sha384Digest(x25519PublicKey),
  };
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

type BuiltObject = Readonly<{
  readonly object: ProtocolObject;
  readonly canonicalBytes: Uint8Array;
}>;

// Builds a closed protocol body, binds it to the canonical unsigned body
// (field 3), and signs it (field 4) with the Device's Ed25519 key, so the
// route handlers' signature verification runs against a real signature.
const buildSignedObject = async (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
  signingKey: CryptoKey,
): Promise<BuiltObject> => {
  const built = protocolObjectFromFields(kind, fields);
  const object = new Map<number, CborValue>(built.entries());
  const unsignedBody = new Map(
    [...object.entries()].filter(([field]) => !isSignedField(field)),
  );
  object.set(3, canonicalEncode(unsignedBody));
  object.set(4, new Uint8Array(64));
  const signature = await signProtocolObject(object, signingKey);
  object.set(4, signature);
  return { object, canonicalBytes: encodeProtocolObject(object) };
};

const buildDeviceCertificate = (
  params: Readonly<{
    readonly deviceId: string;
    readonly userId: string;
    readonly keys: DeviceKeys;
    readonly nowMs: number;
  }>,
) =>
  buildSignedObject(
    2,
    new Map<number, CborValue>([
      [8, uuidToBytes(profile.id)],
      [9, uuidToBytes(params.userId)],
      [10, uuidToBytes(params.deviceId)],
      [17, crypto.getRandomValues(new Uint8Array(16))],
      [28, 1],
      [32, params.nowMs],
      [39, params.keys.x25519PublicKey],
      [41, params.keys.ed25519PublicKey],
    ]),
    params.keys.signingKey,
  );

let database: DatabaseClient;
let testApp: ReturnType<typeof createApi>;
let adminSql: ReturnType<typeof postgres> | undefined;
let user1: { readonly id: string };
let user2: { readonly id: string };
let deviceAId = "";
let keysA: DeviceKeys;

const bootstrapRequest = (
  token: string,
  params: Readonly<{
    readonly operationId: string;
    readonly certificateId: string;
    readonly deviceId: string;
    readonly keys: DeviceKeys;
    readonly certificate: Uint8Array;
  }>,
) =>
  testApp.request(`${profile.origin}/api/v1/devices/bootstrap`, {
    method: "POST",
    headers: {
      Origin: profile.origin,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      operationId: params.operationId,
      deviceId: params.deviceId,
      certificateId: params.certificateId,
      identityGeneration: 1,
      x25519PublicKey: toHex(params.keys.x25519PublicKey),
      ed25519PublicKey: toHex(params.keys.ed25519PublicKey),
      keyId: toHex(params.keys.keyId),
      certificate: toBase64(params.certificate),
    }),
  });

const beginEnrollmentRequest = (
  token: string,
  params: Readonly<{
    readonly operationId: string;
    readonly enrollmentId: string;
    readonly deviceId: string;
    readonly userId: string;
    readonly expiresAt: Date;
    readonly transcriptHashHex: string;
    readonly challengeHashHex: string;
    readonly keys: DeviceKeys;
    readonly certificateId: string;
    readonly certificateBytes: Uint8Array;
  }>,
) =>
  // No X-DotRelay-Device-Id header: the prospective Device is not active yet,
  // so it authenticates with the User's session alone.
  testApp.request(`${profile.origin}/api/v1/devices/enrollments`, {
    method: "POST",
    headers: {
      Origin: profile.origin,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": params.operationId,
    },
    body: JSON.stringify({
      operationId: params.operationId,
      userId: params.userId,
      enrollmentId: params.enrollmentId,
      deviceId: params.deviceId,
      identityGeneration: "1",
      expiresAt: params.expiresAt.toISOString(),
      transcriptHash: params.transcriptHashHex,
      challengeHash: params.challengeHashHex,
      x25519PublicKey: toBase64(params.keys.x25519PublicKey),
      ed25519PublicKey: toBase64(params.keys.ed25519PublicKey),
      keyId: toBase64(params.keys.keyId),
      certificateObjectId: params.certificateId,
      certificateObject: toBase64(params.certificateBytes),
    }),
  });

const approveEnrollmentRequest = (
  token: string,
  params: Readonly<{
    readonly operationId: string;
    readonly enrollmentId: string;
    readonly approverDeviceId: string;
    readonly approvalObjectId: string;
    readonly approvalBytes: Uint8Array;
    readonly enrolledDeviceId: string;
    readonly certificateId: string;
    readonly certificateBytes: Uint8Array;
  }>,
) =>
  testApp.request(
    `${profile.origin}/api/v1/devices/enrollments/${params.enrollmentId}/approve`,
    {
      method: "POST",
      headers: {
        Origin: profile.origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-DotRelay-Device-Id": params.approverDeviceId,
        "Idempotency-Key": params.operationId,
      },
      body: JSON.stringify({
        operationId: params.operationId,
        objectId: params.approvalObjectId,
        object: toBase64(params.approvalBytes),
        enrolledDeviceId: params.enrolledDeviceId,
        certificateObjectId: params.certificateId,
        certificateObject: toBase64(params.certificateBytes),
      }),
    },
  );

const completeEnrollmentRequest = (
  token: string,
  params: Readonly<{
    readonly operationId: string;
    readonly enrollmentId: string;
    readonly initiatorDeviceId: string;
    readonly enrollmentObjectId: string;
    readonly enrollmentBytes: Uint8Array;
  }>,
) =>
  testApp.request(
    `${profile.origin}/api/v1/devices/enrollments/${params.enrollmentId}/complete`,
    {
      method: "POST",
      headers: {
        Origin: profile.origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-DotRelay-Device-Id": params.initiatorDeviceId,
        "Idempotency-Key": params.operationId,
      },
      body: JSON.stringify({
        operationId: params.operationId,
        enrollmentObjectId: params.enrollmentObjectId,
        enrollmentObject: toBase64(params.enrollmentBytes),
      }),
    },
  );

integrationDescribe(
  "sole-Device enrollment through the API (PostgreSQL)",
  () => {
    beforeAll(async () => {
      if (!adminDatabaseUrl) throw new Error("DATABASE_URL is required");
      if (!testDatabaseUrl) throw new Error("DATABASE_URL is required");
      database = createDatabaseClient(testDatabaseUrl.toString());
      adminSql = postgres(adminDatabaseUrl.toString(), { max: 1 });
      await adminSql.unsafe(`CREATE DATABASE ${testDatabaseName}`);
      await runMigrations();
      await ensureServerProfile(database, {
        id: profile.id,
        origin: profile.origin,
        allowRebind: profile.allowRebind,
      });
      user1 = await database.user.create({
        data: {
          serverProfileId: profile.id,
          authSubject: authSubject1,
          githubSubject: "9001",
        },
      });
      await database.authUser.create({
        data: {
          id: authSubject1,
          name: "Sole Device Owner",
          email: `sole-${crypto.randomUUID()}@example.test`,
        },
      });
      await database.authAccount.create({
        data: {
          id: crypto.randomUUID(),
          accountId: "9001",
          providerId: "github",
          userId: authSubject1,
        },
      });
      user2 = await database.user.create({
        data: {
          serverProfileId: profile.id,
          authSubject: authSubject2,
          githubSubject: "9002",
        },
      });
      await database.authUser.create({
        data: {
          id: authSubject2,
          name: "Deviceless User",
          email: `deviceless-${crypto.randomUUID()}@example.test`,
        },
      });
      await database.authAccount.create({
        data: {
          id: crypto.randomUUID(),
          accountId: "9002",
          providerId: "github",
          userId: authSubject2,
        },
      });
      testApp = createApi({
        database,
        profile,
        auth: createAuthStub(),
      });
    }, INTEGRATION_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await database.$disconnect();
      if (!adminSql) return;
      try {
        await adminSql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${testDatabaseName} AND pid <> pg_backend_pid()
      `;
        await adminSql.unsafe(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabaseName)}`,
        );
      } finally {
        await adminSql.end();
      }
    }, INTEGRATION_HOOK_TIMEOUT_MS);

    test(
      "the first Device bootstraps straight to ACTIVE",
      async () => {
        keysA = await createDeviceKeys();
        deviceAId = crypto.randomUUID();
        const certificateA = await buildDeviceCertificate({
          deviceId: deviceAId,
          userId: user1.id,
          keys: keysA,
          nowMs: Date.now(),
        });
        const operationId = crypto.randomUUID();
        const response = await bootstrapRequest(USER1_TOKEN, {
          operationId,
          certificateId: crypto.randomUUID(),
          deviceId: deviceAId,
          keys: keysA,
          certificate: certificateA.canonicalBytes,
        });
        expect(response.status).toBe(201);
        const body = (await response.json()) as {
          deviceId: string;
          active: boolean;
        };
        expect(body.deviceId).toBe(deviceAId);
        expect(body.active).toBe(true);
        const device = await database.device.findUnique({
          where: { id: deviceAId },
        });
        expect(device?.lifecycle).toBe("ACTIVE");
        expect(device?.activatedAt).not.toBeNull();
        expect(
          await database.deviceCertificateObject.count({
            where: { deviceId: deviceAId },
          }),
        ).toBe(1);
        const bootstrapOperation = await database.operation.findUnique({
          where: { id: operationId },
        });
        expect(bootstrapOperation?.status).toBe("COMMITTED");
        // Initial trust bootstrap is first-Device-only: the User now has
        // exactly one, fully ACTIVE Device.
        expect(
          await database.device.count({
            where: { userId: user1.id, lifecycle: "ACTIVE" },
          }),
        ).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a zero-Device User is refused enrollment and must bootstrap first",
      async () => {
        const keys = await createDeviceKeys();
        const deviceId = crypto.randomUUID();
        const certificate = await buildDeviceCertificate({
          deviceId,
          userId: user2.id,
          keys,
          nowMs: Date.now(),
        });
        const transcriptHash = await sha384Digest(
          crypto.getRandomValues(new Uint8Array(48)),
        );
        const challengeHash = await sha384Digest(
          crypto.getRandomValues(new Uint8Array(48)),
        );
        const response = await beginEnrollmentRequest(USER2_TOKEN, {
          operationId: crypto.randomUUID(),
          enrollmentId: crypto.randomUUID(),
          deviceId,
          userId: user2.id,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          transcriptHashHex: sha384ToHex(transcriptHash),
          challengeHashHex: sha384ToHex(challengeHash),
          keys,
          certificateId: crypto.randomUUID(),
          certificateBytes: certificate.canonicalBytes,
        });
        // The begin route authenticates with the session only, so the rejection
        // comes from the repository's "no active device can approve" gate.
        expect(response.status).toBe(409);
        expect(((await response.json()) as { code: string }).code).toBe(
          "state_conflict",
        );
        // The rolled-back transaction leaves no prospective Device or
        // enrollment behind: the User still must bootstrap a first Device.
        expect(
          await database.device.count({ where: { userId: user2.id } }),
        ).toBe(0);
        expect(
          await database.deviceEnrollment.count({
            where: { userId: user2.id },
          }),
        ).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a User with an ACTIVE Device cannot bootstrap a second one",
      async () => {
        const keys = await createDeviceKeys();
        const deviceId = crypto.randomUUID();
        const certificate = await buildDeviceCertificate({
          deviceId,
          userId: user1.id,
          keys,
          nowMs: Date.now(),
        });
        const response = await bootstrapRequest(USER1_TOKEN, {
          operationId: crypto.randomUUID(),
          certificateId: crypto.randomUUID(),
          deviceId,
          keys,
          certificate: certificate.canonicalBytes,
        });
        // Bootstrap is first-Device-only; additional Devices enroll through a
        // Device-approved enrollment instead.
        expect(response.status).toBe(409);
        expect(((await response.json()) as { code: string }).code).toBe(
          "state_conflict",
        );
        expect(
          await database.device.findUnique({ where: { id: deviceId } }),
        ).toBeNull();
        expect(
          await database.device.count({
            where: { userId: user1.id, lifecycle: "ACTIVE" },
          }),
        ).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the sole ACTIVE Device approves the second Device's session-only enrollment",
      async () => {
        const keysB = await createDeviceKeys();
        const deviceIdB = crypto.randomUUID();
        const enrollmentId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const enrollmentObject = await buildSignedObject(
          4,
          new Map<number, CborValue>([
            [8, uuidToBytes(profile.id)],
            [9, uuidToBytes(user1.id)],
            [10, uuidToBytes(deviceIdB)],
            [17, uuidToBytes(enrollmentId)],
            [32, Date.now()],
            [33, expiresAt.getTime()],
            [39, keysB.x25519PublicKey],
            [41, keysB.ed25519PublicKey],
            [57, challenge],
          ]),
          keysB.signingKey,
        );
        const transcriptHash = await sha384Digest(
          enrollmentObject.canonicalBytes,
        );
        const challengeHash = await sha384Digest(challenge);
        const certificateB = await buildDeviceCertificate({
          deviceId: deviceIdB,
          userId: user1.id,
          keys: keysB,
          nowMs: Date.now(),
        });

        // 1. The prospective Device starts its own enrollment with a session
        // only — no device header, because it is not active yet.
        const beginResponse = await beginEnrollmentRequest(USER1_TOKEN, {
          operationId: crypto.randomUUID(),
          enrollmentId,
          deviceId: deviceIdB,
          userId: user1.id,
          expiresAt,
          transcriptHashHex: sha384ToHex(transcriptHash),
          challengeHashHex: sha384ToHex(challengeHash),
          keys: keysB,
          certificateId: crypto.randomUUID(),
          certificateBytes: certificateB.canonicalBytes,
        });
        expect(beginResponse.status).toBe(201);
        const beginBody = (await beginResponse.json()) as {
          enrollmentId: string;
          idempotent: boolean;
        };
        expect(beginBody.enrollmentId).toBe(enrollmentId);
        expect(beginBody.idempotent).toBe(false);
        const pending = await database.device.findUnique({
          where: { id: deviceIdB },
        });
        expect(pending?.lifecycle).toBe("PENDING");
        expect(pending?.activatedAt).toBeNull();
        const enrollmentRow = await database.deviceEnrollment.findUnique({
          where: { id: enrollmentId },
        });
        expect(enrollmentRow).not.toBeNull();
        expect(toHex(new Uint8Array(enrollmentRow?.transcriptHash ?? []))).toBe(
          sha384ToHex(transcriptHash),
        );
        expect(toHex(new Uint8Array(enrollmentRow?.challengeHash ?? []))).toBe(
          sha384ToHex(challengeHash),
        );

        // 2. The sole existing ACTIVE Device (the one that bootstrapped)
        // approves through requireProtocolActor with its device header.
        const approvalObject = await buildSignedObject(
          5,
          new Map<number, CborValue>([
            [8, uuidToBytes(profile.id)],
            [9, uuidToBytes(user1.id)],
            [10, uuidToBytes(deviceIdB)],
            [17, uuidToBytes(enrollmentId)],
            [32, Date.now()],
            [76, transcriptHash],
            [77, uuidToBytes(deviceAId)],
          ]),
          keysA.signingKey,
        );
        const approveOperationId = crypto.randomUUID();
        const approveResponse = await approveEnrollmentRequest(USER1_TOKEN, {
          operationId: approveOperationId,
          enrollmentId,
          approverDeviceId: deviceAId,
          approvalObjectId: crypto.randomUUID(),
          approvalBytes: approvalObject.canonicalBytes,
          enrolledDeviceId: deviceIdB,
          certificateId: crypto.randomUUID(),
          certificateBytes: certificateB.canonicalBytes,
        });
        expect(approveResponse.status).toBe(200);
        const approveBody = (await approveResponse.json()) as {
          approved: boolean;
          idempotent: boolean;
        };
        expect(approveBody.approved).toBe(true);
        expect(approveBody.idempotent).toBe(false);
        const activated = await database.device.findUnique({
          where: { id: deviceIdB },
        });
        expect(activated?.lifecycle).toBe("ACTIVE");
        expect(activated?.activatedAt).not.toBeNull();
        // The prospective Device's self-signed certificate is persisted when
        // the approval activates it.
        expect(
          await database.deviceCertificateObject.count({
            where: { deviceId: deviceIdB },
          }),
        ).toBe(1);
        expect(
          await database.enrollmentApprovalObject.count({
            where: { enrollmentId, approvalDeviceId: deviceAId },
          }),
        ).toBe(1);
        expect(
          await database.auditEvent.count({
            where: { operationId: approveOperationId },
          }),
        ).toBe(2);
        expect(
          await database.auditEvent.count({
            where: {
              operationId: approveOperationId,
              kind: "DEVICE_ENROLLMENT_APPROVED",
            },
          }),
        ).toBe(1);
        const approveOperation = await database.operation.findUnique({
          where: { id: approveOperationId },
        });
        expect(approveOperation?.status).toBe("COMMITTED");

        // 3. The prospective Device completes as itself: it is ACTIVE now, so
        // requireProtocolActor admits it and the enrollment closes.
        const completeOperationId = crypto.randomUUID();
        const completeResponse = await completeEnrollmentRequest(USER1_TOKEN, {
          operationId: completeOperationId,
          enrollmentId,
          initiatorDeviceId: deviceIdB,
          enrollmentObjectId: crypto.randomUUID(),
          enrollmentBytes: enrollmentObject.canonicalBytes,
        });
        expect(completeResponse.status).toBe(201);
        const completeBody = (await completeResponse.json()) as {
          deviceId: string;
          active: boolean;
          idempotent: boolean;
        };
        expect(completeBody.deviceId).toBe(deviceIdB);
        expect(completeBody.active).toBe(true);
        expect(completeBody.idempotent).toBe(false);
        const completed = await database.deviceEnrollment.findUniqueOrThrow({
          where: { id: enrollmentId },
        });
        expect(completed.completedAt).not.toBeNull();
        expect(completed.approverDeviceId).toBe(deviceAId);
        expect(
          await database.enrollmentObject.count({ where: { enrollmentId } }),
        ).toBe(1);
        const finalB = await database.device.findUniqueOrThrow({
          where: { id: deviceIdB },
        });
        expect(finalB.lifecycle).toBe("ACTIVE");
        const firstAfter = await database.device.findUniqueOrThrow({
          where: { id: deviceAId },
        });
        expect(firstAfter.lifecycle).toBe("ACTIVE");
        expect(
          await database.device.count({
            where: { userId: user1.id, lifecycle: "ACTIVE" },
          }),
        ).toBe(2);
        const completeOperation = await database.operation.findUnique({
          where: { id: completeOperationId },
        });
        expect(completeOperation?.status).toBe("COMMITTED");
      },
      TEST_TIMEOUT_MS,
    );
  },
);
