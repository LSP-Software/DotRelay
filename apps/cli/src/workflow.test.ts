import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import {
  createAccountKeyEnvelope,
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  createCliDeviceStorage,
  createDeviceBootstrap,
  createMemoryCredentialStore,
  createMemoryDeviceRecordStore,
  createProjectEpochGrantBootstrap,
  createPublicationArtifacts,
  encodeRecoveryCode,
  generateAccountMasterKey,
  generateRecoveryCode,
  openAccountKeyTransfer,
  parseAccountKeyTransfer,
  resetMemoryCredentialStore,
} from "@dotrelay/client";
import {
  bytesToUuid,
  createProblem,
  encodeProtocolObject,
  encodeSyncPage,
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  type SyncPageWire,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import type { StrictJsonClient } from "./admin";
import { createSessionStore } from "./auth";
import type { CredentialStore } from "./credentials";
import { CliError } from "./errors";
import type { GitTrackingProbe } from "./git-tracking";
import { run } from "./index";
import type { FetchFunction } from "./profile";

const profile = {
  name: "relay",
  origin: "https://relay.example",
  pin: {
    origin: "https://relay.example",
    serverProfileId: "11111111-1111-4111-8111-111111111111",
  },
} as const;
const ids = {
  user: "22222222-2222-4222-8222-222222222222",
  device: "33333333-3333-4333-8333-333333333333",
  approver: "77777777-7777-4777-8777-777777777777",
  team: "44444444-4444-4444-8444-444444444444",
  project: "55555555-5555-4555-8555-555555555555",
  environment: "66666666-6666-4666-8666-666666666666",
} as const;

const boundary = {
  session: { active: true, userId: ids.user },
  environment: {
    headRevision: "empty-environment",
    id: ids.environment,
    projectId: ids.project,
    teamId: ids.team,
    headHash: null,
    projectEpoch: "1",
  },
  device: { active: true, id: ids.device },
  grantsReady: true,
  epochCurrent: true,
  rotationRequired: false,
  profile: { name: "relay", origin: profile.origin, pinned: true },
  crypto: { available: true },
} as const;

// The test checkout's own Git state must never steer a pull; these probes pin
// the repository state each scenario asserts on.
const gitOutside: GitTrackingProbe = async () => ({ state: "outside" });
const gitTracked: GitTrackingProbe = async () => ({ state: "tracked" });

// Builds the Account Key material a test needs to seed the fake service: an
// Account Master Key, a Recovery Code wrapper (or none), and a Project Epoch
// Key envelope sealed under the key. The CLI unwraps these locally, so the
// service only ever sees the service-visible, signed objects.
const accountKeyFixture = async (
  bootstrap: Awaited<ReturnType<typeof createDeviceBootstrap>>,
  options: Readonly<{
    readonly recoveryCode?: Uint8Array;
    readonly projectEpochKey?: Uint8Array;
    readonly accountMasterKey?: Uint8Array;
  }> = {},
): Promise<{
  accountMasterKey: Uint8Array;
  recoveryCode?: Uint8Array;
  recoveryWrapperObject?: string;
  recoveryWrapperId?: string;
  envelopeObject?: string;
  projectEpochKey?: Uint8Array;
}> => {
  const keyMaterial = bootstrap.keyMaterial;
  const signingPrivateKey = keyMaterial.signingPrivateKey;
  if (!signingPrivateKey)
    throw new Error("Device signing private key is missing");
  const accountMasterKey =
    options.accountMasterKey ?? generateAccountMasterKey();
  const result: {
    accountMasterKey: Uint8Array;
    recoveryCode?: Uint8Array;
    recoveryWrapperObject?: string;
    recoveryWrapperId?: string;
    envelopeObject?: string;
    projectEpochKey?: Uint8Array;
  } = { accountMasterKey };
  if (options.recoveryCode !== undefined) {
    const wrapper = await createAccountKeyWrapper({
      serverProfileId: profile.pin.serverProfileId,
      userId: uuidToBytes(ids.user),
      deviceId: uuidToBytes(ids.device),
      userIdentityGeneration: bootstrap.bundle.userIdentityGeneration,
      createdAtMs: Date.now(),
      accountMasterKey,
      signingPrivateKey,
      kind: { type: "recoveryCode", recoveryCode: options.recoveryCode },
    });
    result.recoveryCode = options.recoveryCode;
    result.recoveryWrapperObject = Buffer.from(
      encodeProtocolObject(wrapper.object),
    ).toString("base64");
    result.recoveryWrapperId = bytesToHex(wrapper.wrapperId);
  }
  if (options.projectEpochKey !== undefined) {
    const envelope = await createAccountKeyEnvelope({
      serverProfileId: profile.pin.serverProfileId,
      userId: uuidToBytes(ids.user),
      deviceId: uuidToBytes(ids.device),
      createdAtMs: Date.now(),
      accountMasterKey,
      signingPrivateKey,
      kind: {
        type: "projectEpochKey",
        projectId: uuidToBytes(ids.project),
        projectEpoch: 1,
        contentKey: options.projectEpochKey,
      },
    });
    result.envelopeObject = Buffer.from(
      encodeProtocolObject(envelope.object),
    ).toString("base64");
    result.projectEpochKey = options.projectEpochKey;
  }
  return result;
};

// A fake Account Key service layered over a test's admin: it serves the
// active wrappers a test seeded, accepts transfers by id, records envelope and
// wrapper publications, and delegates every other path (session, boundary,
// environments) to the wrapped admin so a test's boundary overrides still apply.
const accountKeyService = (
  baseAdmin: StrictJsonClient,
  seed: Readonly<{
    readonly recoveryWrapper?: Readonly<{
      readonly wrapperId: string;
      readonly object: string;
      readonly creatorDeviceId?: string;
      readonly creatorPublicKey?: string;
    }>;
    readonly transfer?: Readonly<{
      readonly id: string;
      readonly object: string;
    }>;
    readonly acceptBehavior?: "accepted" | "state-conflict";
  }> = {},
) => {
  const publishedWrappers: string[] = [];
  const publishedEnvelopes: string[] = [];
  const postedTransfers: Array<
    Record<string, unknown> & {
      readonly object: string;
    }
  > = [];
  const revokedWrappers: string[] = [];
  const admin: StrictJsonClient = {
    get: async (path, fields) => {
      if (path === "/api/v1/account-keys/wrappers") {
        const wrappers = seed.recoveryWrapper
          ? [
              {
                wrapperId: seed.recoveryWrapper.wrapperId,
                type: "recovery-code" as const,
                object: seed.recoveryWrapper.object,
                ...(seed.recoveryWrapper.creatorDeviceId
                  ? { creatorDeviceId: seed.recoveryWrapper.creatorDeviceId }
                  : {}),
                ...(seed.recoveryWrapper.creatorPublicKey
                  ? { creatorPublicKey: seed.recoveryWrapper.creatorPublicKey }
                  : {}),
              },
            ]
          : [];
        return { wrappers };
      }
      return baseAdmin.get(path, fields);
    },
    post: async (path, body, fields, options) => {
      if (path === "/api/v1/account-keys/wrappers") {
        publishedWrappers.push(String(body.wrapperId));
        return { wrapperId: body.wrapperId, idempotent: false };
      }
      if (path === "/api/v1/account-keys/wrappers/revoke") {
        revokedWrappers.push(String(body.wrapperId));
        return { revoked: true, idempotent: false };
      }
      if (path === "/api/v1/account-keys/transfers") {
        postedTransfers.push({ ...body } as (typeof postedTransfers)[number]);
        return {
          transferId: body.transferId,
          recipientDeviceId: body.recipientDeviceId,
          expiresAt: "2026-12-31T23:59:59.000Z",
          idempotent: false,
        };
      }
      if (path === "/api/v1/account-keys/envelopes") {
        publishedEnvelopes.push(String(body.objectId));
        return { objectId: body.objectId, idempotent: false };
      }
      const match =
        /^\/api\/v1\/account-keys\/transfers\/([^/]+)\/accept$/u.exec(path);
      if (match) {
        const transfer = seed.transfer;
        if (
          !transfer ||
          transfer.id !== match[1] ||
          seed.acceptBehavior === "state-conflict"
        )
          throw new CliError(
            "conflict",
            "the account key transfer is not pending or has expired",
            {},
            "state_conflict",
          );
        return { accepted: true, object: transfer.object };
      }
      return baseAdmin.post(path, body, fields, options);
    },
  };
  return {
    admin,
    publishedWrappers: () => publishedWrappers,
    publishedEnvelopes: () => publishedEnvelopes,
    postedTransfers: () => postedTransfers,
    revokedWrappers: () => revokedWrappers,
  };
};

const bytesToHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const rawSigningPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key)).slice(0, 32);
// A real peer Device key pair: the raw public key seeds the boundary so
// the CLI seals the transfer to a key it can actually find, and the
// private key lets a test prove the sealed AMK comes back unchanged.
const peerX25519 = async (): Promise<{
  readonly id: string;
  readonly encryptionPublicKey: string;
  readonly encryptionPrivateKey: CryptoKey;
}> => {
  const encryptionKeyPair = (await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  )) as unknown as CryptoKeyPair;
  const publicRaw = await crypto.subtle.exportKey(
    "raw",
    encryptionKeyPair.publicKey,
  );
  return {
    id: crypto.randomUUID(),
    encryptionPublicKey: bytesToHex(new Uint8Array(publicRaw)),
    encryptionPrivateKey: encryptionKeyPair.privateKey,
  };
};

type TestSigningTrustDevice = Readonly<{
  readonly signingPublicKey: string;
  readonly deviceId?: string;
  readonly userId?: string;
  readonly deviceActiveFromMs?: number | null;
  readonly deviceActiveUntilMs?: number | null;
  readonly memberSinceMs?: number | null;
  readonly memberUntilMs?: number | null;
}>;

const setup = async (
  options: Readonly<{
    readonly signingTrustKeys?: readonly string[];
    readonly signingTrustDevices?: readonly TestSigningTrustDevice[];
    readonly revisions?: SyncPageWire["revisions"];
    readonly bootstrap?: Awaited<ReturnType<typeof createDeviceBootstrap>>;
    readonly withoutBoundaryEnvironment?: boolean;
    readonly grantsReady?: boolean;
    readonly epochGrant?: string;
    readonly accountKeyEnvelope?: string;
    readonly peerDevices?: readonly Readonly<{
      readonly id: string;
      readonly encryptionPublicKey: string;
      readonly hasEpochGrant: boolean;
    }>[];
  }> = {},
): Promise<{
  credentials: CredentialStore;
  deviceStorage: ReturnType<typeof createCliDeviceStorage>;
  admin: StrictJsonClient;
  fetch: FetchFunction;
  profilePath: string;
  stateDirectory: string;
  bootstrap: Awaited<ReturnType<typeof createDeviceBootstrap>>;
  createdEnvironments: string[];
}> => {
  const { mkdir } = await import("node:fs/promises");
  const stateDirectory = `${import.meta.dir}/.tmp-workflow-state-${crypto.randomUUID()}`;
  await mkdir(stateDirectory, { recursive: true });
  const profilePath = `${stateDirectory}/profile.json`;
  await Bun.write(
    profilePath,
    JSON.stringify({ version: 1, profiles: [profile] }),
  );
  const credentials = createMemoryCredentialStore();
  await createSessionStore(credentials).save(profile.pin, "session-token");
  const deviceStorage = createCliDeviceStorage(profile.pin, credentials, {
    recordStore: createMemoryDeviceRecordStore(),
  });
  const bootstrap =
    options.bootstrap ??
    (await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    }));
  await deviceStorage.save(bootstrap.bundle);
  // A completed enrollment always records its Device id next to the bundle.
  const { writeDeviceId, deviceMetadataPath } = await import(
    "./device-storage"
  );
  await writeDeviceId(
    deviceMetadataPath(stateDirectory, profile.pin),
    profile.pin,
    bootstrap.deviceId,
  );
  const workspaceBoundary = {
    ...boundary,
    environment: {
      ...boundary.environment,
      id: options.withoutBoundaryEnvironment ? null : boundary.environment.id,
    },
    ...(options.signingTrustKeys
      ? { signingTrustKeys: options.signingTrustKeys }
      : {}),
    ...(options.signingTrustDevices
      ? { signingTrustDevices: options.signingTrustDevices }
      : {}),
    ...(options.epochGrant ? { epochGrant: options.epochGrant } : {}),
    ...(options.peerDevices ? { peerDevices: options.peerDevices } : {}),
    ...(options.accountKeyEnvelope
      ? { accountKeyEnvelope: options.accountKeyEnvelope }
      : {}),
    ...(options.grantsReady !== undefined
      ? { grantsReady: options.grantsReady }
      : {}),
  };
  const createdEnvironments: string[] = [];
  const admin: StrictJsonClient = {
    get: async (path) => {
      if (path === "/api/v1/session")
        return { authenticated: true, user: { id: ids.user } };
      if (path === `/api/v1/projects/${ids.project}/environments`)
        return {
          environments: [
            {
              id: ids.environment,
              projectId: ids.project,
              label: "development",
              lifecycle: "active",
              currentHeadId: null,
            },
          ],
        };
      if (path === "/api/v1/teams")
        return { teams: [{ id: ids.team, name: "Platform" }] };
      return workspaceBoundary;
    },
    post: async (path) => {
      if (path === `/api/v1/projects/${ids.project}/environments`) {
        createdEnvironments.push(ids.environment);
        return {
          id: ids.environment,
          projectId: ids.project,
          label: "development",
          lifecycle: "active",
          currentHeadId: null,
        };
      }
      return {};
    },
  };
  const stagedObjects = new Map<string, Uint8Array>();
  let revisions: SyncPageWire["revisions"] = options.revisions ?? [];
  const syncPage = () => {
    const previous = revisions.at(-1);
    return encodeSyncPage({
      environmentId: ids.environment,
      trustedRevisionId: ids.environment,
      trustedRevisionHash: new Uint8Array(48),
      currentHeadId: previous?.id ?? null,
      currentHeadHash: previous?.digest ?? null,
      projectEpoch: 1n,
      revisions,
      nextCursor: null,
    });
  };
  const fetcher: FetchFunction = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input as never, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/sync")) return new Response(syncPage());
    if (path.endsWith("/begin"))
      return Response.json({
        operationId: crypto.randomUUID(),
        status: "STAGED",
        idempotent: false,
        expiresAt: "2026-09-02T00:00:00Z",
      });
    const staging = /\/staging\/([^/]+)$/u.exec(path);
    if (staging?.[1] && request.method === "PUT") {
      stagedObjects.set(
        staging[1],
        new Uint8Array(await request.arrayBuffer()),
      );
      return Response.json({ staged: true }, { status: 201 });
    }
    if (path.endsWith("/finalize") && request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      const revisionBody = body.revision as Record<string, unknown>;
      const revisionObjectId = revisionBody.protocolObjectId;
      if (typeof revisionObjectId !== "string")
        return Response.json(
          { error: "revision object id missing" },
          { status: 400 },
        );
      const revisionBytes = stagedObjects.get(revisionObjectId);
      if (!revisionBytes)
        return Response.json(
          { error: "revision object was not staged" },
          { status: 400 },
        );
      const parsedRevision = parseProtocolObject(revisionBytes);
      const revisionId = parsedRevision.get(16);
      const mutation = parsedRevision.get(35);
      const authoredAtMs = parsedRevision.get(34);
      if (!(revisionId instanceof Uint8Array) || typeof mutation !== "number")
        return Response.json(
          { error: "staged revision is malformed" },
          { status: 400 },
        );
      const previous = revisions.at(-1);
      // Mirror the database revisions_parent_shape_check and the API's
      // genesis_exists guard so a permissive fake can never hide a mutation
      // that the real Server Profile would reject.
      if (mutation === 1 && previous)
        return Response.json(
          createProblem("genesis_exists", { headId: previous.id }),
          { status: 409 },
        );
      if (mutation !== 1 && !previous)
        return Response.json(createProblem("invalid_request"), { status: 400 });
      const objects = await Promise.all(
        [...stagedObjects.entries()].map(async ([objectId, bytes]) =>
          Object.freeze({
            objectId,
            canonicalBytes: bytes,
            digest: await sha384(bytes),
          }),
        ),
      );
      const digest = await sha384(revisionBytes);
      const revision = Object.freeze({
        id: bytesToUuid(revisionId),
        digest,
        parentId: previous?.id ?? null,
        parentHash: previous?.digest ?? null,
        mutation,
        projectEpoch: 1n,
        authoredAtMs:
          typeof authoredAtMs === "bigint"
            ? authoredAtMs
            : BigInt(typeof authoredAtMs === "number" ? authoredAtMs : 0),
        rollbackTargetId:
          typeof revisionBody.rollbackTargetId === "string"
            ? revisionBody.rollbackTargetId
            : null,
        objects: Object.freeze(objects),
      });
      revisions = Object.freeze([...revisions, revision]);
      stagedObjects.clear();
      return Response.json(
        { revisionId: revision.id, idempotent: false },
        { status: 201 },
      );
    }
    if (request.method === "DELETE") {
      stagedObjects.clear();
      return Response.json({ cancelled: true });
    }
    return Response.json({});
  };
  return {
    credentials,
    deviceStorage,
    admin,
    fetch: fetcher,
    profilePath,
    stateDirectory,
    bootstrap,
    createdEnvironments,
  };
};

afterEach(async () => {
  // The in-memory credential store is process-wide, so clear it to keep a
  // stored Account Master Key (or wrapping secret) from leaking across tests.
  resetMemoryCredentialStore();
  const { readdir, rm, unlink } = await import("node:fs/promises");
  for (const file of [
    ".tmp-workflow-input",
    ".tmp-workflow-input.previous",
    ".tmp-workflow-output",
    ".tmp-workflow-output.previous",
  ])
    await unlink(`${import.meta.dir}/${file}`).catch(() => undefined);
  for (const file of await readdir(import.meta.dir))
    if (
      file.startsWith(".tmp-workflow-git-") ||
      file.startsWith(".tmp-workflow-profile-") ||
      file.startsWith(".tmp-workflow-state-") ||
      file.startsWith("head-") ||
      ((file.startsWith("device-") || file.startsWith("enrollment-")) &&
        file.endsWith(".json"))
    )
      await rm(`${import.meta.dir}/${file}`, { recursive: true, force: true });
});

describe("protected CLI workflows", () => {
  test("pulls an empty Environment to stdout without requiring reveal", async () => {
    const runtime = await setup();
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--stdout",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\n");
    expect(result.stderr).toBe("");
  });

  test("pulls with an Environment label resolved to the stable id before the boundary", async () => {
    const runtime = await setup();
    const contextPath = `${runtime.stateDirectory}/context.json`;
    await Bun.write(
      contextPath,
      JSON.stringify({
        serverProfileId: profile.pin.serverProfileId,
        projectId: ids.project,
      }),
    );
    const boundaryRequests: string[] = [];
    const admin = {
      get: async (path: string, fields: readonly string[]) => {
        if (path.startsWith("/api/v1/workspace/boundary"))
          boundaryRequests.push(path);
        return runtime.admin.get(path, fields);
      },
      post: runtime.admin.post,
    };
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        "development",
        "--stdout",
      ],
      { ...runtime, admin, worktreeConfig: contextPath },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\n");
    expect(boundaryRequests).toEqual([
      `/api/v1/workspace/boundary?environment=${ids.environment}`,
    ]);
  });

  test("init accepts an Environment label as its positional argument", async () => {
    const runtime = await setup();
    const contextPath = `${runtime.stateDirectory}/context.json`;
    await Bun.write(
      contextPath,
      JSON.stringify({
        serverProfileId: profile.pin.serverProfileId,
        projectId: ids.project,
      }),
    );
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const boundaryRequests: string[] = [];
    const admin = {
      get: async (path: string, fields: readonly string[]) => {
        if (path.startsWith("/api/v1/workspace/boundary"))
          boundaryRequests.push(path);
        return runtime.admin.get(path, fields);
      },
      post: runtime.admin.post,
    };
    const result = await run(
      [
        "init",
        "development",
        "--profile",
        "relay",
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      { ...runtime, admin, worktreeConfig: contextPath },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"ok":true');
    expect(result.stdout).not.toContain("postgres://secret");
    expect(boundaryRequests.length).toBeGreaterThan(0);
    for (const request of boundaryRequests)
      expect(request).toBe(
        `/api/v1/workspace/boundary?environment=${ids.environment}`,
      );
  });

  test("pulls Values signed by a peer Device using workspace signing trust keys", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    if (!bootstrap.keyMaterial.encryptionPublicKey)
      throw new Error("Device encryption public key is missing");
    const peer = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts(
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://example",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: bootstrap.keyMaterial.encryptionPublicKey,
        signingPrivateKey: peer.privateKey,
        mutation: "GENESIS",
      },
    );
    const revisionObject = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === artifacts.request.revision.protocolObjectId,
    );
    if (!revisionObject) throw new Error("revision object is missing");
    const parsedRevision = parseProtocolObject(revisionObject.bytes);
    const digest = await sha384(revisionObject.bytes);
    const runtime = await setup({
      bootstrap,
      signingTrustKeys: [bytesToHex(await rawSigningPublicKey(peer.publicKey))],
      revisions: [
        {
          id: artifacts.request.revision.id,
          digest,
          parentId: ids.environment,
          parentHash: new Uint8Array(48),
          mutation: parsedRevision.get(35) as number,
          projectEpoch: 1n,
          authoredAtMs: BigInt(artifacts.request.revision.authoredAtMs),
          rollbackTargetId: null,
          objects: await Promise.all(
            artifacts.stagedObjects.map(async (object) =>
              Object.freeze({
                objectId: object.objectId,
                canonicalBytes: object.bytes,
                digest: await sha384(object.bytes),
              }),
            ),
          ),
        },
      ],
    });
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--stdout",
        "--no-input",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('DATABASE_URL="postgres://example"');
    expect(result.stderr).toBe("");
  });

  test("pulls Values signed by a peer Device through its trust entry windows", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    if (!bootstrap.keyMaterial.encryptionPublicKey)
      throw new Error("Device encryption public key is missing");
    const peer = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts(
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://example",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: bootstrap.keyMaterial.encryptionPublicKey,
        signingPrivateKey: peer.privateKey,
        mutation: "GENESIS",
      },
    );
    const revisionObject = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === artifacts.request.revision.protocolObjectId,
    );
    if (!revisionObject) throw new Error("revision object is missing");
    const parsedRevision = parseProtocolObject(revisionObject.bytes);
    const digest = await sha384(revisionObject.bytes);
    const runtime = await setup({
      bootstrap,
      signingTrustDevices: [
        {
          signingPublicKey: bytesToHex(
            await rawSigningPublicKey(peer.publicKey),
          ),
          deviceId: ids.device,
          userId: ids.user,
          deviceActiveFromMs: 0,
          deviceActiveUntilMs: null,
          memberSinceMs: 0,
          memberUntilMs: null,
        },
      ],
      revisions: [
        {
          id: artifacts.request.revision.id,
          digest,
          parentId: ids.environment,
          parentHash: new Uint8Array(48),
          mutation: parsedRevision.get(35) as number,
          projectEpoch: 1n,
          authoredAtMs: BigInt(artifacts.request.revision.authoredAtMs),
          rollbackTargetId: null,
          objects: await Promise.all(
            artifacts.stagedObjects.map(async (object) =>
              Object.freeze({
                objectId: object.objectId,
                canonicalBytes: object.bytes,
                digest: await sha384(object.bytes),
              }),
            ),
          ),
        },
      ],
    });
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--stdout",
        "--no-input",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('DATABASE_URL="postgres://example"');
    expect(result.stderr).toBe("");
  });

  test("rejects a Revision authored after its signing Device's window closed", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    if (!bootstrap.keyMaterial.encryptionPublicKey)
      throw new Error("Device encryption public key is missing");
    const peer = await generateSigningKeyPair();
    const closedAtMs = Date.now() - 60_000;
    const artifacts = await createPublicationArtifacts(
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://example",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: bootstrap.keyMaterial.encryptionPublicKey,
        signingPrivateKey: peer.privateKey,
        mutation: "GENESIS",
      },
    );
    const revisionObject = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === artifacts.request.revision.protocolObjectId,
    );
    if (!revisionObject) throw new Error("revision object is missing");
    const parsedRevision = parseProtocolObject(revisionObject.bytes);
    const digest = await sha384(revisionObject.bytes);
    const runtime = await setup({
      bootstrap,
      signingTrustDevices: [
        {
          signingPublicKey: bytesToHex(
            await rawSigningPublicKey(peer.publicKey),
          ),
          deviceId: ids.device,
          userId: ids.user,
          deviceActiveFromMs: 0,
          deviceActiveUntilMs: closedAtMs,
          memberSinceMs: 0,
          memberUntilMs: null,
        },
      ],
      revisions: [
        {
          id: artifacts.request.revision.id,
          digest,
          parentId: ids.environment,
          parentHash: new Uint8Array(48),
          mutation: parsedRevision.get(35) as number,
          projectEpoch: 1n,
          authoredAtMs: BigInt(artifacts.request.revision.authoredAtMs),
          rollbackTargetId: null,
          objects: await Promise.all(
            artifacts.stagedObjects.map(async (object) =>
              Object.freeze({
                objectId: object.objectId,
                canonicalBytes: object.bytes,
                digest: await sha384(object.bytes),
              }),
            ),
          ),
        },
      ],
    });
    const outputPath = `${runtime.stateDirectory}/pull-output`;
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        outputPath,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(8);
    let written = "";
    try {
      written = await Bun.file(outputPath).text();
    } catch {
      // A rejected pull must not materialize the Values file.
    }
    expect(written).not.toContain("postgres://example");
    expect(JSON.parse(result.stderr)).toMatchObject({
      category: "local-io",
      code: "unexpected_failure",
    });
  });

  test("stages and finalizes an encrypted genesis publication", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const result = await run(
      [
        "init",
        ids.environment,
        "--profile",
        "relay",
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"ok":true');
    expect(result.stdout).not.toContain("postgres://secret");
  });

  test("push into an empty Environment publishes exactly one genesis Revision", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(pushed.exitCode).toBe(0);
    expect(JSON.parse(pushed.stdout)).toMatchObject({
      ok: true,
      message: "Published",
    });
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    expect(JSON.parse(history.stdout)).toMatchObject({
      ok: true,
      revisions: [expect.objectContaining({ mutation: 1 })],
    });
  });

  test("retrying push after a published genesis resolves the head without a second Revision", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const publishArgs = [
      "push",
      "--profile",
      "relay",
      "--environment",
      ids.environment,
      "--from",
      input,
      "--classify",
      "DATABASE_URL=shared",
      "--no-input",
      "--json",
    ];
    const published = await run(publishArgs, runtime);
    expect(published.exitCode).toBe(0);
    const retried = await run(publishArgs, runtime);
    expect(retried.exitCode).toBe(0);
    expect(JSON.parse(retried.stdout)).toMatchObject({
      ok: true,
      lanes: 0,
      message: "Already published",
    });
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    expect(JSON.parse(history.stdout)).toMatchObject({
      ok: true,
      revisions: [expect.objectContaining({ mutation: 1 })],
    });
  });

  test("retrying push with changed content after a published genesis publishes an update against the verified head", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const publishArgs = [
      "push",
      "--profile",
      "relay",
      "--environment",
      ids.environment,
      "--from",
      input,
      "--classify",
      "DATABASE_URL=shared",
      "--no-input",
      "--json",
    ];
    const published = await run(publishArgs, runtime);
    expect(published.exitCode).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({
      ok: true,
      message: "Published",
    });
    await Bun.write(input, "DATABASE_URL=postgres://rotated\n");
    const retried = await run(publishArgs, runtime);
    expect(retried.exitCode).toBe(0);
    expect(JSON.parse(retried.stdout)).toMatchObject({
      ok: true,
      message: "Published",
    });
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    const historyBody = JSON.parse(history.stdout) as {
      ok: boolean;
      revisions: Array<{ mutation: number }>;
    };
    expect(historyBody.ok).toBe(true);
    expect(historyBody.revisions.map((revision) => revision.mutation)).toEqual([
      1, 2,
    ]);
  });

  test("init and push into a populated Environment publish manifest updates", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    if (!bootstrap.keyMaterial.encryptionPublicKey)
      throw new Error("Device encryption public key is missing");
    const seeded = await createPublicationArtifacts(
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://seeded",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: bootstrap.keyMaterial.encryptionPublicKey,
        signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
        mutation: "GENESIS",
      },
    );
    const seededRevisionObject = seeded.stagedObjects.find(
      (object) => object.objectId === seeded.request.revision.protocolObjectId,
    );
    if (!seededRevisionObject) throw new Error("revision object is missing");
    const runtime = await setup({
      bootstrap,
      revisions: [
        {
          id: seeded.request.revision.id,
          digest: await sha384(seededRevisionObject.bytes),
          parentId: ids.environment,
          parentHash: new Uint8Array(48),
          mutation: 1,
          projectEpoch: 1n,
          authoredAtMs: BigInt(seeded.request.revision.authoredAtMs),
          rollbackTargetId: null,
          objects: await Promise.all(
            seeded.stagedObjects.map(async (object) =>
              Object.freeze({
                objectId: object.objectId,
                canonicalBytes: object.bytes,
                digest: await sha384(object.bytes),
              }),
            ),
          ),
        },
      ],
    });
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://seeded\nNEW_TOKEN=fresh\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "NEW_TOKEN=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(
      input,
      "DATABASE_URL=postgres://updated\nNEW_TOKEN=fresh\n",
    );
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(pushed.exitCode).toBe(0);
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    const historyBody = JSON.parse(history.stdout) as {
      ok: boolean;
      revisions: Array<{ mutation: number }>;
    };
    expect(historyBody.ok).toBe(true);
    expect(historyBody.revisions).toHaveLength(3);
    for (const revision of historyBody.revisions.slice(1))
      expect(revision.mutation).toBe(2);
  });

  test("init persists the Environment it created for later invocations", async () => {
    const runtime = await setup({ withoutBoundaryEnvironment: true });
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    const contextPath = `${import.meta.dir}/.tmp-workflow-state-context-${crypto.randomUUID()}`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const result = await run(
      [
        "init",
        "--profile",
        "relay",
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      { ...runtime, worktreeConfig: contextPath },
    );
    expect(result.exitCode).toBe(0);
    expect(runtime.createdEnvironments).toEqual([ids.environment]);
    expect(JSON.parse(await Bun.file(contextPath).text())).toEqual({
      serverProfileId: profile.pin.serverProfileId,
      projectId: ids.project,
      environmentId: ids.environment,
    });
    const reuse = await run(
      ["pull", "--profile", "relay", "--stdout", "--no-input"],
      { ...runtime, worktreeConfig: contextPath },
    );
    expect(reuse.exitCode).toBe(0);
    expect(reuse.stdout).toContain('DATABASE_URL="postgres://secret"');
    expect(runtime.createdEnvironments).toEqual([ids.environment]);
  });

  test("classifies and confirms genesis publication from the terminal", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const terminalInput = new PassThrough();
    const terminalOutput = new PassThrough();
    const renderedChunks: string[] = [];
    terminalOutput.on("data", (chunk) => {
      renderedChunks.push(chunk.toString("utf8"));
    });
    terminalInput.write("\ny\n");
    terminalInput.end();
    const result = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--json",
      ],
      {
        ...runtime,
        terminal: { input: terminalInput, output: terminalOutput },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"ok":true');
    expect(result.stdout).not.toContain("postgres://secret");
    const rendered = renderedChunks.join("");
    expect(rendered).toContain("Classify 1 Variable from .env");
    expect(rendered).toContain("DATABASE_URL");
    expect(rendered).toContain("Team");
    expect(rendered).toContain("Publish? [y/N]");
  });

  test("toggles Variable ownership from the classification board", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const terminalInput = new PassThrough();
    const terminalOutput = new PassThrough();
    const renderedChunks: string[] = [];
    terminalOutput.on("data", (chunk) => {
      renderedChunks.push(chunk.toString("utf8"));
    });
    terminalInput.write("1\n\ny\n");
    terminalInput.end();
    const result = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--json",
      ],
      {
        ...runtime,
        terminal: { input: terminalInput, output: terminalOutput },
      },
    );
    expect(result.exitCode).toBe(0);
    const rendered = renderedChunks.join("");
    expect(rendered).toContain("API_KEY");
    expect(rendered).toContain("Only you");
  });

  test("push keeps existing Variable ownership and only classifies new names", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(
      input,
      "DATABASE_URL=postgres://secret\nAPI_KEY=tok\nNEW_TOKEN=fresh\n",
    );
    const terminalInput = new PassThrough();
    const terminalOutput = new PassThrough();
    const renderedChunks: string[] = [];
    terminalOutput.on("data", (chunk) => {
      renderedChunks.push(chunk.toString("utf8"));
    });
    terminalInput.write("\ny\n");
    terminalInput.end();
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--json",
      ],
      {
        ...runtime,
        terminal: { input: terminalInput, output: terminalOutput },
      },
    );
    expect(pushed.exitCode).toBe(0);
    const rendered = renderedChunks.join("");
    expect(rendered).toContain("NEW_TOKEN");
    expect(rendered).not.toContain("DATABASE_URL");
    expect(rendered).not.toContain("API_KEY");
  });

  test("push of existing Variables does not require --classify under --no-input", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://changed\n");
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(pushed.exitCode).toBe(0);
    expect(pushed.stdout).toContain('"ok":true');
  });

  test("push still requires --classify for new Variables under --no-input", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://secret\nNEW_TOKEN=fresh\n");
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(pushed.exitCode).toBe(2);
    expect(pushed.stderr).toContain("new Variables require --classify");
  });

  test("diffs local dotenv names against the Environment without Values", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "KEEP=same\nCHANGED=prev\nGONE=old\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "KEEP=shared",
        "--classify",
        "CHANGED=shared",
        "--classify",
        "GONE=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "KEEP=same\nCHANGED=next\nNEW=fresh\n");
    const result = await run(
      [
        "diff",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--reveal",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      added: ["NEW"],
      updated: ["CHANGED"],
      removed: ["GONE"],
      unchangedCount: 1,
    });
    expect(result.stdout).not.toContain("same");
    expect(result.stdout).not.toContain("next");
    expect(result.stdout).not.toContain("fresh");
    expect(result.stdout).not.toContain("old");
    expect(result.stdout).not.toContain("prev");
  });

  test("diff human output masks Values until --reveal", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "KEEP=same\nCHANGED=prev\nGONE=old\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "KEEP=shared",
        "--classify",
        "CHANGED=shared",
        "--classify",
        "GONE=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "KEEP=same\nCHANGED=next\nNEW=fresh\n");
    const namesOnly = await run(
      [
        "diff",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
      ],
      runtime,
    );
    expect(namesOnly.exitCode).toBe(0);
    expect(namesOnly.stdout).toContain("1 added, 1 updated, 1 removed");
    expect(namesOnly.stdout).toContain("NEW");
    expect(namesOnly.stdout).toContain("CHANGED");
    expect(namesOnly.stdout).toContain("GONE");
    expect(namesOnly.stdout).not.toContain("KEEP");
    expect(namesOnly.stdout).not.toContain("fresh");
    expect(namesOnly.stdout).not.toContain("next");
    expect(namesOnly.stdout).not.toContain("prev");
    expect(namesOnly.stdout).not.toContain("old");
    expect(namesOnly.stdout).not.toContain("••••••••");
    const revealed = await run(
      [
        "diff",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--reveal",
        "--no-input",
      ],
      runtime,
    );
    expect(revealed.exitCode).toBe(0);
    expect(revealed.stdout).toContain("NEW");
    expect(revealed.stdout).toContain("+  fresh");
    expect(revealed.stdout).toContain("CHANGED  shared");
    expect(revealed.stdout).toContain("-  prev");
    expect(revealed.stdout).toContain("+  next");
    expect(revealed.stdout).toContain("GONE  shared");
    expect(revealed.stdout).toContain("-  old");
    const matching = await run(
      [
        "diff",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        `${import.meta.dir}/.tmp-workflow-missing`,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(matching.exitCode).toBe(8);
    expect(JSON.parse(matching.stderr)).toMatchObject({
      code: "input_read_failed",
    });
    await Bun.write(input, "KEEP=same\nCHANGED=prev\nGONE=old\n");
    const unchanged = await run(
      [
        "diff",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
      ],
      runtime,
    );
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.stdout).toContain("Your .env matches the Environment");
  });

  test("push confirmation describes the changed Variable instead of the live count", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=abc123x\nAPI_KEY=tok\n");
    const questions: string[] = [];
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--json",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
      },
    );
    expect(pushed.exitCode).toBe(0);
    expect(questions).toEqual(["Publish? [y/N]"]);
    expect(questions[0]).not.toContain("abc123x");
    expect(questions[0]).not.toContain("postgres://secret");
    expect(pushed.stdout).not.toContain("abc123x");
    expect(pushed.stdout).not.toContain("postgres://secret");
  });

  test("push --reveal shows plaintext Values only in that confirmation", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=abc123x\nAPI_KEY=tok\n");
    const questions: string[] = [];
    const revealed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--reveal",
        "--json",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
      },
    );
    expect(revealed.exitCode).toBe(0);
    expect(questions).toEqual(["Publish? [y/N]"]);
    expect(revealed.stdout).not.toContain("abc123x");
    expect(revealed.stdout).not.toContain("postgres://secret");
    // The next review goes back to the masked default: reveal is scoped to
    // the single review it was requested for.
    await Bun.write(input, "DATABASE_URL=abc123x\nAPI_KEY=rotated\n");
    const masked = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--json",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return false;
        },
      },
    );
    expect(masked.exitCode).toBe(2);
    expect(questions[1]).not.toContain("rotated");
    expect(questions[1]).not.toContain("abc123x");
    expect(questions[1]).not.toContain("postgres://secret");
    expect(masked.stderr).toContain("publication confirmation was declined");
    expect(masked.stderr).not.toContain("rotated");
    expect(masked.stderr).not.toContain("abc123x");
    expect(masked.stderr).not.toContain("postgres://secret");
  });

  test("a declined or failed publication leaks no Values even with --debug", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    await Bun.write(input, "DATABASE_URL=abc123x\nAPI_KEY=tok\n");
    const declined = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--debug",
      ],
      {
        ...runtime,
        confirm: async () => false,
      },
    );
    expect(declined.exitCode).toBe(2);
    expect(declined.stderr).toContain("Publication confirmation was declined");
    expect(declined.stderr).not.toContain("abc123x");
    expect(declined.stderr).not.toContain("postgres://secret");
    expect(declined.stdout).not.toContain("abc123x");
  });

  test("push confirmation lists added and removed Variables", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://secret\nNEW_TOKEN=fresh\n");
    const questions: string[] = [];
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "NEW_TOKEN=shared",
        "--json",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
      },
    );
    expect(pushed.exitCode).toBe(0);
    expect(questions).toEqual(["Publish? [y/N]"]);
    expect(questions[0]).not.toContain("fresh");
    expect(questions[0]).not.toContain("tok");
    expect(pushed.stdout).not.toContain("fresh");
    expect(pushed.stdout).not.toContain("tok");
  });

  test("pull confirmation masks the Values that will replace the local file", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://local\nGONE=old\n");
    const questions: string[] = [];
    const pulled = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        input,
        "--json",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
        gitTrackingProbe: gitOutside,
      },
    );
    expect(pulled.exitCode).toBe(0);
    expect(questions).toEqual([
      `Replace ${input} with decrypted values? [y/N]`,
    ]);
    expect(questions[0]).not.toContain("postgres://local");
    expect(questions[0]).not.toContain("postgres://secret");
    expect(questions[0]).not.toContain("tok");
    expect(pulled.stdout).not.toContain("postgres://local");
    expect(pulled.stdout).not.toContain("postgres://secret");
  });

  test("pull --reveal shows plaintext Values in the replacement confirmation", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://local\nGONE=old\n");
    const questions: string[] = [];
    const pulled = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        input,
        "--reveal",
        "--json",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
        gitTrackingProbe: gitOutside,
      },
    );
    expect(pulled.exitCode).toBe(0);
    expect(questions).toEqual([
      `Replace ${input} with decrypted values? [y/N]`,
    ]);
    expect(pulled.stdout).not.toContain("postgres://local");
    expect(pulled.stdout).not.toContain("postgres://secret");
  });

  test("pull --stdout --reveal decline leaks no Values through the error", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    const declined = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--stdout",
        "--reveal",
        "--debug",
      ],
      {
        ...runtime,
        confirm: async () => false,
      },
    );
    expect(declined.exitCode).toBe(2);
    expect(declined.stderr).toContain("Value reveal confirmation was declined");
    expect(declined.stderr).not.toContain("postgres://secret");
    expect(declined.stderr).not.toContain("tok");
    expect(declined.stdout).not.toContain("postgres://secret");
  });

  test("pull reports no changes when the local file already matches", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    const questions: string[] = [];
    const pulled = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        input,
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return false;
        },
        gitTrackingProbe: gitOutside,
      },
    );
    expect(pulled.exitCode).toBe(0);
    expect(questions).toEqual([]);
    expect(pulled.stdout).toBe("No changes found\n");
    expect(await Bun.file(input).text()).toBe(
      "DATABASE_URL=postgres://secret\n",
    );
  });

  test("pull --no-input retains a differing existing file without --force", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://local\nLOCAL_ONLY=kept\n");
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        input,
        "--no-input",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(result.exitCode).toBe(4);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      code: "output_conflict",
      changedCount: 3,
      exitCode: 4,
    });
    expect(String(diagnostic.detail)).toContain("retained");
    expect(String(diagnostic.detail)).toContain("--force");
    expect(String(diagnostic.detail)).not.toContain("postgres://local");
    expect(await Bun.file(input).text()).toBe(
      "DATABASE_URL=postgres://local\nLOCAL_ONLY=kept\n",
    );
    expect(await Bun.file(`${input}.previous`).exists()).toBe(false);
  });

  test("pull --no-input --force replaces the file and retains the prior copy", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://local\nLOCAL_ONLY=kept\n");
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        input,
        "--no-input",
        "--force",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      output: input,
      previous: `${input}.previous`,
    });
    expect(await Bun.file(input).text()).toContain(
      'DATABASE_URL="postgres://secret"',
    );
    expect(await Bun.file(input).text()).toContain('API_KEY="tok"');
    expect(await Bun.file(`${input}.previous`).text()).toBe(
      "DATABASE_URL=postgres://local\nLOCAL_ONLY=kept\n",
    );
    const { stat } = await import("node:fs/promises");
    expect((await stat(`${input}.previous`)).mode & 0o777).toBe(0o600);
  });

  test("pull --no-input stays smooth for new files and matching files", async () => {
    const runtime = await setup();
    const output = `${import.meta.dir}/.tmp-workflow-output`;
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    const fresh = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        output,
        "--no-input",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(fresh.exitCode).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({ ok: true, output });
    const written = await Bun.file(output).text();
    expect(written).toContain('DATABASE_URL="postgres://secret"');
    expect(await Bun.file(`${output}.previous`).exists()).toBe(false);
    const unchanged = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        output,
        "--no-input",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.stdout).toBe("No changes found\n");
    expect(await Bun.file(output).text()).toBe(written);
  });

  test("interactive pull replacement retains a recoverable prior file", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://local\n");
    const pulled = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        input,
        "--json",
      ],
      { ...runtime, confirm: async () => true, gitTrackingProbe: gitOutside },
    );
    expect(pulled.exitCode).toBe(0);
    expect(await Bun.file(input).text()).toContain(
      'DATABASE_URL="postgres://secret"',
    );
    expect(await Bun.file(`${input}.previous`).text()).toBe(
      "DATABASE_URL=postgres://local\n",
    );
  });

  const seededEnvironment = async (
    runtime: Awaited<ReturnType<typeof setup>>,
    input: string,
  ): Promise<void> => {
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(initialized.exitCode).toBe(0);
  };

  test("pull establishes a repository-local Git exclusion for an untracked output", async () => {
    const runtime = await setup();
    const gitRoot = `${import.meta.dir}/.tmp-workflow-git-${crypto.randomUUID()}`;
    try {
      await seededEnvironment(
        runtime,
        `${import.meta.dir}/.tmp-workflow-input`,
      );
      const gitDirectory = `${gitRoot}/.git`;
      const output = `${gitRoot}/.env`;
      const probe: GitTrackingProbe = async () =>
        Object.freeze({
          state: "untracked",
          gitDirectory,
          topLevel: gitRoot,
          relativePath: ".env",
        });
      const result = await run(
        [
          "pull",
          "--profile",
          "relay",
          "--environment",
          ids.environment,
          "--output",
          output,
          "--no-input",
          "--json",
        ],
        { ...runtime, gitTrackingProbe: probe },
      );
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: true,
        output,
        gitExclusion: "established",
      });
      expect(String(body.message)).toContain(".git/info/exclude");
      expect(String(body.message)).toContain("excluded from Git");
      expect(await Bun.file(`${gitDirectory}/info/exclude`).text()).toBe(
        "/.env\n",
      );
    } finally {
      await rm(gitRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  });

  test("pull reports an already-established local Git exclusion as present", async () => {
    const runtime = await setup();
    const gitRoot = `${import.meta.dir}/.tmp-workflow-git-${crypto.randomUUID()}`;
    try {
      await mkdir(`${gitRoot}/.git/info`, { recursive: true });
      await Bun.write(`${gitRoot}/.git/info/exclude`, "/.env\n");
      await seededEnvironment(
        runtime,
        `${import.meta.dir}/.tmp-workflow-input`,
      );
      const output = `${gitRoot}/.env`;
      const probe: GitTrackingProbe = async () =>
        Object.freeze({
          state: "untracked",
          gitDirectory: `${gitRoot}/.git`,
          topLevel: gitRoot,
          relativePath: ".env",
        });
      const result = await run(
        [
          "pull",
          "--profile",
          "relay",
          "--environment",
          ids.environment,
          "--output",
          output,
          "--no-input",
          "--json",
        ],
        { ...runtime, gitTrackingProbe: probe },
      );
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, output, gitExclusion: "present" });
      expect(String(body.message)).not.toContain(".git/info/exclude");
      expect(await Bun.file(`${gitRoot}/.git/info/exclude`).text()).toBe(
        "/.env\n",
      );
    } finally {
      await rm(gitRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  });

  test("pull refuses a Git-tracked output and offers untrack or an alternate path", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://local\nGONE=old\n");
    const questions: string[] = [];
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        input,
        "--json",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
        gitTrackingProbe: gitTracked,
      },
    );
    expect(result.exitCode).toBe(4);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      code: "output_tracked",
      exitCode: 4,
    });
    expect(String(diagnostic.detail)).toContain(`${input} is tracked by Git`);
    expect(String(diagnostic.detail)).toContain(`git rm --cached ${input}`);
    expect(String(diagnostic.detail)).toContain(
      "dotrelay pull --output <path>",
    );
    expect(questions).toEqual([]);
    expect(await Bun.file(input).text()).toBe(
      "DATABASE_URL=postgres://local\nGONE=old\n",
    );
    expect(await Bun.file(`${input}.previous`).exists()).toBe(false);
    expect(result.stderr).not.toContain("postgres://local");
    expect(result.stderr).not.toContain("postgres://secret");
    expect(result.stderr).not.toContain("tok");
  });

  test("pull --no-input --force still refuses a Git-tracked output", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--no-input",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://local\n");
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        input,
        "--no-input",
        "--force",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitTracked },
    );
    expect(result.exitCode).toBe(4);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      code: "output_tracked",
      exitCode: 4,
    });
    expect(await Bun.file(input).text()).toBe(
      "DATABASE_URL=postgres://local\n",
    );
    expect(await Bun.file(`${input}.previous`).exists()).toBe(false);
  });

  test("pull writes to a Git-ignored output and reports it as present", async () => {
    const runtime = await setup();
    const gitRoot = `${import.meta.dir}/.tmp-workflow-git-${crypto.randomUUID()}`;
    try {
      await seededEnvironment(
        runtime,
        `${import.meta.dir}/.tmp-workflow-input`,
      );
      const output = `${gitRoot}/.env`;
      const probe: GitTrackingProbe = async () =>
        Object.freeze({ state: "ignored" });
      const result = await run(
        [
          "pull",
          "--profile",
          "relay",
          "--environment",
          ids.environment,
          "--output",
          output,
          "--no-input",
          "--json",
        ],
        { ...runtime, gitTrackingProbe: probe },
      );
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, output, gitExclusion: "present" });
      expect(await Bun.file(output).text()).toContain(
        'DATABASE_URL="postgres://secret"',
      );
    } finally {
      await rm(gitRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  });

  test("pull skips the Git exposure check for output outside a repository", async () => {
    const runtime = await setup();
    const gitRoot = `${import.meta.dir}/.tmp-workflow-git-${crypto.randomUUID()}`;
    try {
      await seededEnvironment(
        runtime,
        `${import.meta.dir}/.tmp-workflow-input`,
      );
      const output = `${gitRoot}/.env`;
      const result = await run(
        [
          "pull",
          "--profile",
          "relay",
          "--environment",
          ids.environment,
          "--output",
          output,
          "--no-input",
          "--json",
        ],
        { ...runtime, gitTrackingProbe: gitOutside },
      );
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, output });
      expect("gitExclusion" in body).toBe(false);
      expect(await Bun.file(output).text()).toContain(
        'DATABASE_URL="postgres://secret"',
      );
    } finally {
      await rm(gitRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  });

  test("push --no-input refuses to publish removed Variables without --force", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const result = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(2);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "invocation",
      code: "deletion_requires_approval",
      changedCount: 1,
      exitCode: 2,
    });
    expect(String(diagnostic.detail)).toContain("--force");
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    expect(
      (JSON.parse(history.stdout) as { revisions: unknown[] }).revisions,
    ).toHaveLength(1);
  });

  test("push --no-input --force publishes the removal", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--classify",
        "DATABASE_URL=shared",
        "--classify",
        "API_KEY=user-defined",
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(initialized.exitCode).toBe(0);
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const result = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
        "--force",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      message: "Published",
      tombstones: 1,
    });
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    const historyBody = JSON.parse(history.stdout) as {
      revisions: Array<{ mutation: number }>;
    };
    expect(historyBody.revisions.map((revision) => revision.mutation)).toEqual([
      1, 2,
    ]);
  });

  test("rollback confirmation masks Values until --reveal", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    if (!bootstrap.keyMaterial.encryptionPublicKey)
      throw new Error("Device encryption public key is missing");
    const variableId = "99999999-9999-4999-8999-999999999999";
    const seeded = await createPublicationArtifacts(
      [
        {
          id: variableId,
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://secret",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: bootstrap.keyMaterial.encryptionPublicKey,
        signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
        mutation: "GENESIS",
      },
    );
    const seededRevisionObject = seeded.stagedObjects.find(
      (object) => object.objectId === seeded.request.revision.protocolObjectId,
    );
    if (!seededRevisionObject) throw new Error("revision object is missing");
    const runtime = await setup({
      bootstrap,
      revisions: [
        {
          id: seeded.request.revision.id,
          digest: await sha384(seededRevisionObject.bytes),
          parentId: ids.environment,
          parentHash: new Uint8Array(48),
          mutation: 1,
          projectEpoch: 1n,
          authoredAtMs: BigInt(seeded.request.revision.authoredAtMs),
          rollbackTargetId: null,
          objects: await Promise.all(
            seeded.stagedObjects.map(async (object) =>
              Object.freeze({
                objectId: object.objectId,
                canonicalBytes: object.bytes,
                digest: await sha384(object.bytes),
              }),
            ),
          ),
        },
      ],
    });
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=abc123x\n");
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(pushed.exitCode).toBe(0);
    const questions: string[] = [];
    const revealedDeclined = await run(
      [
        "rollback",
        seeded.request.revision.id,
        "--variable",
        variableId,
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--reveal",
        "--debug",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return false;
        },
      },
    );
    expect(revealedDeclined.exitCode).toBe(2);
    expect(revealedDeclined.stderr).toContain(
      "Rollback confirmation was declined",
    );
    expect(revealedDeclined.stderr).not.toContain("abc123x");
    expect(revealedDeclined.stderr).not.toContain("postgres://secret");
    expect(questions).toEqual(["Roll back the selected Variables? [y/N]"]);
    const rolled = await run(
      [
        "rollback",
        seeded.request.revision.id,
        "--variable",
        variableId,
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--json",
      ],
      {
        ...runtime,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
      },
    );
    expect(rolled.exitCode).toBe(0);
    expect(questions[1]).toBe("Roll back the selected Variables? [y/N]");
    expect(questions[1]).not.toContain("abc123x");
    expect(questions[1]).not.toContain("postgres://secret");
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    const historyBody = JSON.parse(history.stdout) as {
      ok: boolean;
      revisions: Array<{ mutation: number }>;
    };
    expect(historyBody.ok).toBe(true);
    expect(historyBody.revisions).toHaveLength(3);
    expect(historyBody.revisions[2]?.mutation).toBe(3);
  });

  // Seeds a verified history the operator can read: a Genesis Revision with
  // a known Value, then an Update that changes it.
  const seededHistory = async (): Promise<{
    readonly runtime: Awaited<ReturnType<typeof setup>>;
    readonly genesis: Awaited<ReturnType<typeof createPublicationArtifacts>>;
    readonly variableId: string;
  }> => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    if (!bootstrap.keyMaterial.encryptionPublicKey)
      throw new Error("Device encryption public key is missing");
    const variableId = "99999999-9999-4999-8999-999999999999";
    const seeded = await createPublicationArtifacts(
      [
        {
          id: variableId,
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://secret",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: bootstrap.keyMaterial.encryptionPublicKey,
        signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
        mutation: "GENESIS",
      },
    );
    const seededRevisionObject = seeded.stagedObjects.find(
      (object) => object.objectId === seeded.request.revision.protocolObjectId,
    );
    if (!seededRevisionObject) throw new Error("revision object is missing");
    const runtime = await setup({
      bootstrap,
      revisions: [
        {
          id: seeded.request.revision.id,
          digest: await sha384(seededRevisionObject.bytes),
          parentId: ids.environment,
          parentHash: new Uint8Array(48),
          mutation: 1,
          projectEpoch: 1n,
          authoredAtMs: BigInt(seeded.request.revision.authoredAtMs),
          rollbackTargetId: null,
          objects: await Promise.all(
            seeded.stagedObjects.map(async (object) =>
              Object.freeze({
                objectId: object.objectId,
                canonicalBytes: object.bytes,
                digest: await sha384(object.bytes),
              }),
            ),
          ),
        },
      ],
    });
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=abc123x\n");
    const pushed = await run(
      [
        "push",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--from",
        input,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(pushed.exitCode).toBe(0);
    return { runtime, genesis: seeded, variableId };
  };

  test("human history renders readable dates and change context without Values", async () => {
    const { runtime, genesis } = await seededHistory();
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain(`Environment ${ids.environment}`);
    expect(history.stdout).toContain("#1");
    expect(history.stdout).toContain("#2");
    expect(history.stdout).toContain("Genesis");
    expect(history.stdout).toContain("Update");
    expect(history.stdout).toContain(genesis.request.revision.id);
    expect(history.stdout).toContain("DATABASE_URL");
    expect(history.stdout).toContain("shared");
    expect(history.stdout).toContain("value changed");
    expect(history.stdout).toContain("current");
    expect(history.stdout).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    // History output never carries Values, even the ones this Device can read.
    expect(history.stdout).not.toContain("postgres://secret");
    expect(history.stdout).not.toContain("abc123x");
  });

  test("rollback selects the target by ordinal and the Variable by name", async () => {
    const { runtime, genesis } = await seededHistory();
    const rolled = await run(
      [
        "rollback",
        "#1",
        "--variable",
        "DATABASE_URL",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--json",
      ],
      { ...runtime, confirm: async () => true },
    );
    expect(rolled.exitCode).toBe(0);
    const body = JSON.parse(rolled.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Rollback published");
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    const historyBody = JSON.parse(history.stdout) as {
      revisions: Array<{
        mutation: number;
        rollbackTargetId: string | null;
      }>;
    };
    expect(historyBody.revisions).toHaveLength(3);
    expect(historyBody.revisions[2]?.mutation).toBe(3);
    expect(historyBody.revisions[2]?.rollbackTargetId).toBe(
      genesis.request.revision.id,
    );
  });

  test("rollback --no-input accepts a Variable name and a bare ordinal", async () => {
    const { runtime } = await seededHistory();
    const rolled = await run(
      [
        "rollback",
        "1",
        "--variable",
        "DATABASE_URL",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(rolled.exitCode).toBe(0);
    const body = JSON.parse(rolled.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Rollback published");
  });

  test("a bare rollback chooses the target and Variables from the rendered history", async () => {
    const { runtime, genesis } = await seededHistory();
    const terminalInput = new PassThrough();
    terminalInput.end();
    const terminalOutput = new PassThrough();
    const rendered: string[] = [];
    terminalOutput.on("data", (chunk) => rendered.push(chunk.toString("utf8")));
    const rolled = await run(
      [
        "rollback",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--json",
      ],
      {
        ...runtime,
        terminal: { input: terminalInput, output: terminalOutput },
        prompt: async (question) => {
          if (question.startsWith("Roll back to which Revision")) return "#1";
          if (question.startsWith("Variables to roll back"))
            return "DATABASE_URL";
          throw new Error(`unexpected prompt: ${question}`);
        },
        confirm: async () => true,
      },
    );
    expect(rolled.exitCode).toBe(0);
    const body = JSON.parse(rolled.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Rollback published");
    // The rendered history carried the readable selection context: the
    // operator picked a target from it without touching a JSON dump.
    const terminalText = rendered.join("");
    expect(terminalText).toContain("Genesis");
    expect(terminalText).toContain(genesis.request.revision.id);
  });

  test("rollback rejects an unknown Variable name and names the live Manifest", async () => {
    const { runtime } = await seededHistory();
    const result = await run(
      [
        "rollback",
        "#1",
        "--variable",
        "NOT_IN_MANIFEST",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(2);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic.category).toBe("invocation");
    expect(String(diagnostic.detail)).toContain(
      "unknown Variable NOT_IN_MANIFEST",
    );
    expect(String(diagnostic.detail)).toContain("DATABASE_URL");
  });

  test("rollback rejects an ordinal outside the verified history", async () => {
    const { runtime } = await seededHistory();
    const result = await run(
      [
        "rollback",
        "#99",
        "--variable",
        "DATABASE_URL",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(2);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic.category).toBe("invocation");
    expect(String(diagnostic.detail)).toContain("not in the verified history");
  });

  test("rollback rejects a Variable that did not exist in the target Revision", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    if (!bootstrap.keyMaterial.encryptionPublicKey)
      throw new Error("Device encryption public key is missing");
    const genesisVariableId = "99999999-9999-4999-8999-999999999999";
    const laterVariableId = "99999999-9999-4999-8999-9999999999a0";
    const genesis = await createPublicationArtifacts(
      [
        {
          id: genesisVariableId,
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://secret",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: bootstrap.keyMaterial.encryptionPublicKey,
        signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
        mutation: "GENESIS",
      },
    );
    const genesisRevisionObject = genesis.stagedObjects.find(
      (object) => object.objectId === genesis.request.revision.protocolObjectId,
    );
    if (!genesisRevisionObject) throw new Error("revision object is missing");
    const genesisDigest = await sha384(genesisRevisionObject.bytes);
    // A later Revision adds NEW_FLAG, so the live Manifest carries it while
    // the Genesis Revision it was added in does not.
    const later = await createPublicationArtifacts(
      [
        {
          id: genesisVariableId,
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://secret",
          required: true,
          hasDraftChange: false,
        },
        {
          id: laterVariableId,
          name: "NEW_FLAG",
          description: "Flag added after the target Revision.",
          ownership: "SHARED_VALUE",
          value: "on",
          required: false,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: genesis.request.revision.id,
        expectedHeadHash: genesisDigest,
        valueRecipientPublicKey: bootstrap.keyMaterial.encryptionPublicKey,
        signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
        mutation: "MANIFEST_UPDATE",
      },
    );
    const laterRevisionObject = later.stagedObjects.find(
      (object) => object.objectId === later.request.revision.protocolObjectId,
    );
    if (!laterRevisionObject) throw new Error("revision object is missing");
    const runtime = await setup({
      bootstrap,
      revisions: [
        {
          id: genesis.request.revision.id,
          digest: genesisDigest,
          parentId: ids.environment,
          parentHash: new Uint8Array(48),
          mutation: 1,
          projectEpoch: 1n,
          authoredAtMs: BigInt(genesis.request.revision.authoredAtMs),
          rollbackTargetId: null,
          objects: await Promise.all(
            genesis.stagedObjects.map(async (object) =>
              Object.freeze({
                objectId: object.objectId,
                canonicalBytes: object.bytes,
                digest: await sha384(object.bytes),
              }),
            ),
          ),
        },
        {
          id: later.request.revision.id,
          digest: await sha384(laterRevisionObject.bytes),
          parentId: genesis.request.revision.id,
          parentHash: genesisDigest,
          mutation: 2,
          projectEpoch: 1n,
          authoredAtMs: BigInt(later.request.revision.authoredAtMs),
          rollbackTargetId: null,
          objects: await Promise.all(
            later.stagedObjects.map(async (object) =>
              Object.freeze({
                objectId: object.objectId,
                canonicalBytes: object.bytes,
                digest: await sha384(object.bytes),
              }),
            ),
          ),
        },
      ],
    });
    const result = await run(
      [
        "rollback",
        genesis.request.revision.id,
        "--variable",
        "NEW_FLAG",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(4);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic.category).toBe("conflict");
    expect(diagnostic.code).toBe("rollback_variable_absent");
    expect(String(diagnostic.detail)).toContain("NEW_FLAG");
    // The refusal happens before any publication: the history is untouched.
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(history.exitCode).toBe(0);
    const historyBody = JSON.parse(history.stdout) as {
      revisions: unknown[];
    };
    expect(historyBody.revisions).toHaveLength(2);
  });

  test("rolling back to the current head publishes nothing", async () => {
    const { runtime } = await seededHistory();
    const rolled = await run(
      [
        "rollback",
        "#2",
        "--variable",
        "DATABASE_URL",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(rolled.exitCode).toBe(0);
    const body = JSON.parse(rolled.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Already published");
  });

  test("a bare rollback refuses a Variable answer that names nothing", async () => {
    const { runtime } = await seededHistory();
    const terminalInput = new PassThrough();
    terminalInput.end();
    const terminalOutput = new PassThrough();
    const result = await run(
      [
        "rollback",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--json",
      ],
      {
        ...runtime,
        terminal: { input: terminalInput, output: terminalOutput },
        prompt: async (question) => {
          if (question.startsWith("Roll back to which Revision")) return "#1";
          if (question.startsWith("Variables to roll back")) return " , ";
          throw new Error(`unexpected prompt: ${question}`);
        },
      },
    );
    expect(result.exitCode).toBe(2);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic.category).toBe("invocation");
    expect(String(diagnostic.detail)).toContain(
      "rollback requires at least one Variable",
    );
  });

  test("completes a dual-control enrollment from a protected handoff", async () => {
    const runtime = await setup();
    const requestPath = `${import.meta.dir}/.tmp-enrollment-request`;
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const admin: StrictJsonClient = {
      get: runtime.admin.get,
      post: async (path, body) => {
        posts.push({ path, body });
        if (path === "/api/v1/devices/enrollments")
          return { enrollmentId: body.enrollmentId };
        if (path.endsWith("/complete"))
          return { deviceId: body.deviceId, active: true, idempotent: false };
        return { approved: true, idempotent: false };
      },
    };
    const begin = await run(
      [
        "device",
        "begin",
        "--profile",
        "relay",
        "--output",
        requestPath,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin },
    );
    expect(begin.exitCode).toBe(0);
    expect(begin.stdout).toContain('"active":false');
    const artifact = await Bun.file(requestPath).json();
    expect(artifact.kind).toBe("dotrelay-device-enrollment-request");
    expect(artifact).not.toHaveProperty("privateKey");

    const approverBootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.approver,
    });
    await runtime.deviceStorage.save(approverBootstrap.bundle);
    const approverPosts: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const approverAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        return { ...boundary, device: { active: true, id: ids.approver } };
      },
      post: async (path, body) => {
        approverPosts.push({ path, body });
        return { approved: true, idempotent: false };
      },
    };

    const approve = await run(
      [
        "device",
        "approve",
        "--profile",
        "relay",
        "--from",
        requestPath,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin: approverAdmin, deviceId: ids.approver },
    );
    expect(approve.exitCode).toBe(0);
    expect(approverPosts.some((post) => post.path.endsWith("/approve"))).toBe(
      true,
    );

    const complete = await run(
      [
        "device",
        "complete",
        "--profile",
        "relay",
        "--from",
        requestPath,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin },
    );
    expect(complete.exitCode).toBe(0);
    expect(posts.some((post) => post.path.endsWith("/complete"))).toBe(true);
    const completePost = posts.find((post) => post.path.endsWith("/complete"));
    expect(completePost?.body.enrollmentObjectId).toBe(
      artifact.enrollmentObjectId,
    );
    expect(completePost?.body.enrollmentObjectId).not.toBe(
      artifact.enrollmentId,
    );
    expect(completePost?.body.certificateObjectId).toBe(
      artifact.certificateObjectId,
    );
    await (await import("node:fs/promises"))
      .unlink(requestPath)
      .catch(() => undefined);
  });

  test("device backup creates a Recovery Code wrapper for an unlocked Device", async () => {
    const amk = generateAccountMasterKey();
    const runtime = await setup();
    await runtime.deviceStorage.saveAccountKey(
      { pin: profile.pin, deviceId: uuidToBytes(ids.device) },
      amk,
    );
    const service = accountKeyService(runtime.admin);
    const backup = await run(
      ["device", "backup", "--profile", "relay", "--no-input", "--json"],
      { ...runtime, admin: service.admin },
    );
    expect(backup.exitCode).toBe(0);
    const report = JSON.parse(backup.stdout) as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.recoveryCode).toBeString();
    expect(report.wrapperId).toBeString();
    // The wrapper is published once, and the code is the only credential a
    // headless machine needs.
    expect(service.publishedWrappers()).toHaveLength(1);
  });

  test("device backup on a locked Device reports that the account is not unlocked", async () => {
    const runtime = await setup();
    const service = accountKeyService(runtime.admin);
    const backup = await run(
      ["device", "backup", "--profile", "relay", "--no-input", "--json"],
      { ...runtime, admin: service.admin },
    );
    expect(backup.exitCode).toBe(6);
    const diagnostic = JSON.parse(backup.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "authentication",
      code: "account_key_not_unlocked",
      exitCode: 6,
    });
    expect(service.publishedWrappers()).toHaveLength(0);
  });

  test("device recover unlocks a Device with a valid Recovery Code", async () => {
    const amk = generateAccountMasterKey();
    const recoveryCode = generateRecoveryCode();
    const runtime = await setup();
    const fixture = await accountKeyFixture(runtime.bootstrap, {
      accountMasterKey: amk,
      recoveryCode,
    });
    const signingKey = runtime.bootstrap.keyMaterial.signingPublicKey;
    if (!signingKey) throw new Error("Device signing public key is missing");
    const service = accountKeyService(runtime.admin, {
      recoveryWrapper: {
        wrapperId: fixture.recoveryWrapperId as string,
        object: fixture.recoveryWrapperObject as string,
        creatorDeviceId: ids.device,
        creatorPublicKey: bytesToHex(await exportSigningPublicKey(signingKey)),
      },
    });
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--recovery-code",
        encodeRecoveryCode(recoveryCode),
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(0);
    const report = JSON.parse(recover.stdout) as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.via).toBe("recovery-code");
    // The Account Master Key is now stored on the Device, keyed to it.
    const stored = await runtime.deviceStorage.loadAccountKey({
      pin: profile.pin,
      deviceId: uuidToBytes(ids.device),
    });
    expect(stored).toBeDefined();
    expect(new Uint8Array(stored as Uint8Array).length).toBe(32);
  });

  test("device recover rejects a malformed Recovery Code", async () => {
    const runtime = await setup();
    const service = accountKeyService(runtime.admin);
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--recovery-code",
        "not-a-valid-code",
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(2);
    const diagnostic = JSON.parse(recover.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "invocation",
      code: "recovery_code_malformed",
      exitCode: 2,
    });
  });

  test("device recover rejects a Recovery Code that does not match the wrapper", async () => {
    const amk = generateAccountMasterKey();
    const code = generateRecoveryCode();
    const runtime = await setup();
    const fixture = await accountKeyFixture(runtime.bootstrap, {
      accountMasterKey: amk,
      recoveryCode: code,
    });
    const service = accountKeyService(runtime.admin, {
      recoveryWrapper: {
        wrapperId: fixture.recoveryWrapperId as string,
        object: fixture.recoveryWrapperObject as string,
      },
    });
    const wrongCode = generateRecoveryCode();
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--recovery-code",
        encodeRecoveryCode(wrongCode),
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(6);
    const diagnostic = JSON.parse(recover.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "authentication",
      code: "account_key_unlock_failed",
      exitCode: 6,
    });
  });

  test("device recover reports when the account has no active Recovery Code wrapper", async () => {
    const code = generateRecoveryCode();
    const runtime = await setup();
    const service = accountKeyService(runtime.admin);
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--recovery-code",
        encodeRecoveryCode(code),
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(4);
    const diagnostic = JSON.parse(recover.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      code: "recovery_wrapper_missing",
      exitCode: 4,
    });
  });

  test("device recover unlocks a Device from an Account Key Transfer", async () => {
    const amk = generateAccountMasterKey();
    const runtime = await setup();
    const keyMaterial = runtime.bootstrap.keyMaterial;
    const signingPrivateKey = keyMaterial.signingPrivateKey;
    const encryptionPublicKey = keyMaterial.encryptionPublicKey;
    if (!encryptionPublicKey)
      throw new Error("Device encryption public key is missing");
    const now = Date.now();
    const transfer = await createAccountKeyTransfer({
      serverProfileId: profile.pin.serverProfileId,
      userId: uuidToBytes(ids.user),
      deviceId: uuidToBytes(ids.device),
      createdAtMs: now,
      expiresAtMs: now + 3_600_000,
      accountMasterKey: amk,
      recipientDeviceId: ids.device,
      recipientEncryptionPublicKey: encryptionPublicKey,
      signingPrivateKey,
    });
    const transferIdHex = bytesToHex(transfer.transferId);
    const objectB64 = Buffer.from(
      encodeProtocolObject(transfer.object),
    ).toString("base64");
    const service = accountKeyService(runtime.admin, {
      transfer: { id: transferIdHex, object: objectB64 },
    });
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--transfer",
        transferIdHex,
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(0);
    const report = JSON.parse(recover.stdout) as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.via).toBe("transfer");
    const stored = await runtime.deviceStorage.loadAccountKey({
      pin: profile.pin,
      deviceId: uuidToBytes(ids.device),
    });
    expect(stored).toBeDefined();
    expect(new Uint8Array(stored as Uint8Array).length).toBe(32);
  });

  test("device recover reports when a transfer is no longer pending", async () => {
    const runtime = await setup();
    const service = accountKeyService(runtime.admin, {
      transfer: { id: "deadbeefdeadbeefdeadbeefdeadbeef", object: "unused" },
      acceptBehavior: "state-conflict",
    });
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--transfer",
        "deadbeefdeadbeefdeadbeefdeadbeef",
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(4);
    const diagnostic = JSON.parse(recover.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      code: "state_conflict",
      exitCode: 4,
    });
  });

  test("device setup establishes the account key and its Recovery Code on a fresh Device", async () => {
    const runtime = await setup();
    const service = accountKeyService(runtime.admin);
    const result = await run(
      ["device", "setup", "--profile", "relay", "--no-input", "--json"],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.deviceId).toBe(ids.device);
    expect(report.recoveryCode).toBeString();
    expect(report.wrapperId).toBeString();
    // The mandatory Recovery Code wrapper is published once and the key is
    // now persisted on the Device, scoped to it.
    expect(service.publishedWrappers()).toHaveLength(1);
    const stored = await runtime.deviceStorage.loadAccountKey({
      pin: profile.pin,
      deviceId: uuidToBytes(ids.device),
    });
    expect(stored).toBeDefined();
    expect(new Uint8Array(stored as Uint8Array).length).toBe(32);
  });

  test("device setup is a no-op when this Device already holds the account key", async () => {
    const amk = generateAccountMasterKey();
    const runtime = await setup();
    await runtime.deviceStorage.saveAccountKey(
      { pin: profile.pin, deviceId: uuidToBytes(ids.device) },
      amk,
    );
    const service = accountKeyService(runtime.admin);
    const result = await run(
      ["device", "setup", "--profile", "relay", "--no-input", "--json"],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.deviceId).toBe(ids.device);
    expect(report.message).toContain("already holds");
    // It short-circuits before minting anything, so no wrapper is published.
    expect(service.publishedWrappers()).toHaveLength(0);
  });

  test("device setup refuses to mint a second key when the account already has one", async () => {
    const amk = generateAccountMasterKey();
    const code = generateRecoveryCode();
    const runtime = await setup();
    const fixture = await accountKeyFixture(runtime.bootstrap, {
      accountMasterKey: amk,
      recoveryCode: code,
    });
    const service = accountKeyService(runtime.admin, {
      recoveryWrapper: {
        wrapperId: fixture.recoveryWrapperId as string,
        object: fixture.recoveryWrapperObject as string,
      },
    });
    const result = await run(
      ["device", "setup", "--profile", "relay", "--no-input", "--json"],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(result.exitCode).toBe(4);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      code: "account_key_already_exists",
      exitCode: 4,
    });
    expect(service.publishedWrappers()).toHaveLength(0);
  });

  test("device transfer seals the account key to the receiving Device and it opens back to the same key", async () => {
    const amk = generateAccountMasterKey();
    const peer = await peerX25519();
    const runtime = await setup({
      peerDevices: [
        {
          id: peer.id,
          encryptionPublicKey: peer.encryptionPublicKey,
          hasEpochGrant: false,
        },
      ],
    });
    await runtime.deviceStorage.saveAccountKey(
      { pin: profile.pin, deviceId: uuidToBytes(ids.device) },
      amk,
    );
    const service = accountKeyService(runtime.admin);
    const result = await run(
      [
        "device",
        "transfer",
        "--profile",
        "relay",
        "--to",
        peer.id,
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.deviceId).toBe(ids.device);
    expect(report.transferId).toBeString();
    expect(report.recipientDeviceId).toBe(peer.id);
    expect(report.expiresAt).toBeString();
    const posted = service.postedTransfers();
    expect(posted).toHaveLength(1);
    const transferBody = posted[0];
    expect(transferBody).toBeDefined();
    if (!transferBody) throw new Error("no transfer was posted");
    expect(transferBody.recipientDeviceId).toBe(peer.id);
    // The published object, opened with the receiver's X25519 key, yields the
    // very Account Master Key the sender sealed — proving the handoff is intact.
    const parsed = parseAccountKeyTransfer(
      new Uint8Array(Buffer.from(String(transferBody.object), "base64")),
    );
    expect(bytesToHex(parsed.recipientDeviceId)).toBe(
      peer.id.replaceAll("-", ""),
    );
    // The receiving Device opens the transfer as itself: the sender's (creator's)
    // Ed25519 key is the only trusted signer, and the ownDeviceId/nowMs bindings
    // assert the transfer is addressed to the receiver and still valid.
    const senderSigningKey = runtime.bootstrap.keyMaterial.signingPublicKey;
    if (!senderSigningKey)
      throw new Error("Device signing public key is missing");
    const senderSigningPublicKey =
      await exportSigningPublicKey(senderSigningKey);
    const opened = await openAccountKeyTransfer(
      parsed,
      peer.encryptionPrivateKey,
      {
        trustedKeys: { keys: [senderSigningPublicKey] },
        context: {
          ownDeviceId: uuidToBytes(peer.id),
          nowMs: Date.now(),
        },
      },
    );
    expect(new Uint8Array(opened)).toEqual(new Uint8Array(amk));
  });

  test("device transfer refuses a recipient that is not an active Device", async () => {
    const amk = generateAccountMasterKey();
    const runtime = await setup();
    await runtime.deviceStorage.saveAccountKey(
      { pin: profile.pin, deviceId: uuidToBytes(ids.device) },
      amk,
    );
    const service = accountKeyService(runtime.admin);
    const result = await run(
      [
        "device",
        "transfer",
        "--profile",
        "relay",
        "--to",
        "88888888-8888-4888-8888-888888888888",
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(result.exitCode).toBe(4);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      code: "transfer_recipient_unknown",
      exitCode: 4,
    });
    expect(service.postedTransfers()).toHaveLength(0);
  });

  test("device transfer reports when this Device is not unlocked", async () => {
    const runtime = await setup();
    const service = accountKeyService(runtime.admin);
    const result = await run(
      [
        "device",
        "transfer",
        "--profile",
        "relay",
        "--to",
        "88888888-8888-4888-8888-888888888888",
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(result.exitCode).toBe(6);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "authentication",
      code: "account_key_not_unlocked",
      exitCode: 6,
    });
    expect(service.postedTransfers()).toHaveLength(0);
  });

  test("device revoke-wrapper retires the named account-key wrapper", async () => {
    const amk = generateAccountMasterKey();
    const wrapperId = bytesToHex(new Uint8Array(16));
    const runtime = await setup();
    await runtime.deviceStorage.saveAccountKey(
      { pin: profile.pin, deviceId: uuidToBytes(ids.device) },
      amk,
    );
    const service = accountKeyService(runtime.admin);
    const result = await run(
      [
        "device",
        "revoke-wrapper",
        "--profile",
        "relay",
        "--wrapper-id",
        wrapperId,
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: service.admin,
        fetch: async () => Response.json({}),
      },
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.ok).toBe(true);
    expect(report.wrapperId).toBe(wrapperId);
    expect(report.revoked).toBe(true);
    expect(report.idempotent).toBe(false);
    expect(service.revokedWrappers()).toEqual([wrapperId]);
  });

  test("an unlocked Device opens the Project epoch key from its Account Key Envelope", async () => {
    const amk = generateAccountMasterKey();
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const fixture = await accountKeyFixture(bootstrap, {
      accountMasterKey: amk,
      projectEpochKey: epochKey,
    });
    const runtime = await setup({
      bootstrap,
      grantsReady: true,
      accountKeyEnvelope: fixture.envelopeObject as string,
    });
    await runtime.deviceStorage.saveAccountKey(
      { pin: profile.pin, deviceId: uuidToBytes(ids.device) },
      amk,
    );
    const service = accountKeyService(runtime.admin);
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin: service.admin },
    );
    expect(history.exitCode).toBe(0);
    // The Device opened the existing envelope instead of establishing a new
    // epoch key, so it published no envelope of its own.
    expect(service.publishedEnvelopes()).toHaveLength(0);
  });

  test("an unlocked Device without an envelope establishes the epoch key as an Account Key Envelope", async () => {
    const amk = generateAccountMasterKey();
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const runtime = await setup({ bootstrap, grantsReady: false });
    await runtime.deviceStorage.saveAccountKey(
      { pin: profile.pin, deviceId: uuidToBytes(ids.device) },
      amk,
    );
    const service = accountKeyService(runtime.admin);
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin: service.admin },
    );
    expect(history.exitCode).toBe(0);
    // No Device holds this epoch's key, so this unlocked Device mints a fresh
    // Project Epoch Key and wraps it by the Account Master Key.
    expect(service.publishedEnvelopes()).toHaveLength(1);
  });
});

describe("peer grant provisioning during ordinary reads", () => {
  const peerDeviceId = "88888888-8888-4888-8888-888888888888";

  type TestPeer = Readonly<{
    readonly id: string;
    readonly encryptionPublicKey: string;
    readonly hasEpochGrant: boolean;
  }>;

  // Seals a known Project epoch key into the grant the service returns for
  // the presented Device, so the CLI exercises the reuse-and-wrap path.
  const sealEpochGrant = async (
    bootstrap: Awaited<ReturnType<typeof createDeviceBootstrap>>,
    plaintextKey: Uint8Array,
  ): Promise<string> => {
    const publicKey = bootstrap.keyMaterial.encryptionPublicKey;
    if (!publicKey) throw new Error("Device encryption public key is missing");
    const grant = await createProjectEpochGrantBootstrap({
      serverProfileId: profile.pin.serverProfileId,
      teamId: ids.team,
      projectId: ids.project,
      projectEpoch: 1,
      senderDeviceId: ids.device,
      recipientDeviceId: ids.device,
      recipientX25519PublicKey: new Uint8Array(
        await crypto.subtle.exportKey("raw", publicKey),
      ),
      recipientEncryptionPublicKey: publicKey,
      signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
      plaintextKey,
    });
    return Buffer.from(grant.canonicalBytes).toString("base64");
  };

  const makePeer = async (hasEpochGrant: boolean): Promise<TestPeer> => {
    const peer = await generateEncryptionKeyPair();
    return {
      id: peerDeviceId,
      encryptionPublicKey: bytesToHex(
        new Uint8Array(await crypto.subtle.exportKey("raw", peer.publicKey)),
      ),
      hasEpochGrant,
    };
  };

  // Records and scripts the Project grant bootstrap endpoint the CLI posts
  // to while provisioning peer Devices.
  const scriptGrantBootstrap = (
    runtime: Awaited<ReturnType<typeof setup>>,
    respond: () => Response,
  ) => {
    const calls: unknown[] = [];
    const fetcher: FetchFunction = async (input, init) => {
      const request = new Request(input as never, init);
      if (new URL(request.url).pathname.endsWith("/grants/bootstrap")) {
        calls.push(
          await request
            .clone()
            .json()
            .catch(() => null),
        );
        return respond();
      }
      return runtime.fetch(input, init);
    };
    return { fetch: fetcher, calls };
  };

  test("repeated reads never re-provision a peer that holds the epoch grant", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const peer = await makePeer(true);
    const runtime = await setup({
      bootstrap,
      epochGrant: await sealEpochGrant(
        bootstrap,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      peerDevices: [peer],
    });
    const scripted = scriptGrantBootstrap(runtime, () => Response.json({}));
    for (let read = 0; read < 2; read += 1) {
      const history = await run(
        [
          "history",
          "--profile",
          "relay",
          "--environment",
          ids.environment,
          "--no-input",
          "--json",
        ],
        { ...runtime, fetch: scripted.fetch },
      );
      expect(history.exitCode).toBe(0);
      const body = JSON.parse(history.stdout) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.revisions).toEqual([]);
      expect(body).not.toHaveProperty("pendingActions");
    }
    const pull = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--stdout",
        "--no-input",
      ],
      { ...runtime, fetch: scripted.fetch },
    );
    expect(pull.exitCode).toBe(0);
    expect(pull.stdout).toBe("\n");
    // Three verified reads, zero grant writes: the confirmed peer grant is
    // reused instead of being re-published on every invocation.
    expect(scripted.calls).toHaveLength(0);
  });

  test("a rejected peer provisioning leaves the verified read intact", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const peer = await makePeer(false);
    const runtime = await setup({
      bootstrap,
      epochGrant: await sealEpochGrant(
        bootstrap,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      peerDevices: [peer],
    });
    // The service enforces the project-administration authority, so an
    // ordinary Member's repair attempt is rejected; on a live deployment the
    // read must still complete.
    const respond = () =>
      Response.json(createProblem("forbidden"), { status: 403 });
    const scripted = scriptGrantBootstrap(runtime, respond);
    const terminalInput = new PassThrough();
    terminalInput.end();
    const terminalOutput = new PassThrough();
    const rendered: string[] = [];
    terminalOutput.on("data", (chunk) => rendered.push(chunk.toString("utf8")));
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
      ],
      {
        ...runtime,
        fetch: scripted.fetch,
        terminal: { input: terminalInput, output: terminalOutput },
      },
    );
    expect(history.exitCode).toBe(0);
    // The original read result stands: the human history still renders the
    // (empty) verified Revisions, and the pending action is surfaced
    // truthfully on the terminal instead of aborting or hiding it.
    expect(history.stdout).toContain(`Environment ${ids.environment}`);
    expect(history.stdout).toContain("No Revisions have been published yet");
    expect(rendered.join("")).toContain(
      `Device ${peerDeviceId} is missing the Project epoch grant`,
    );
    const scriptedJson = scriptGrantBootstrap(runtime, respond);
    const jsonHistory = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      { ...runtime, fetch: scriptedJson.fetch },
    );
    expect(jsonHistory.exitCode).toBe(0);
    const body = JSON.parse(jsonHistory.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.revisions).toEqual([]);
    expect(body.pendingActions).toEqual([
      `Device ${peerDeviceId} is missing the Project epoch grant; an owner or admin can provision it by running dotrelay pull from their own Device`,
    ]);
    expect(scripted.calls).toHaveLength(1);
    expect(scriptedJson.calls).toHaveLength(1);
  });

  test("an authorized actor provisions a missing peer grant", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const peer = await makePeer(false);
    const runtime = await setup({
      bootstrap,
      epochGrant: await sealEpochGrant(
        bootstrap,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      peerDevices: [peer],
    });
    const scripted = scriptGrantBootstrap(runtime, () =>
      Response.json(
        {
          grantObjectId: "99999999-9999-4999-8999-999999999999",
          idempotent: false,
        },
        { status: 201 },
      ),
    );
    const history = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      { ...runtime, fetch: scripted.fetch },
    );
    expect(history.exitCode).toBe(0);
    const body = JSON.parse(history.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("pendingActions");
    expect(scripted.calls).toHaveLength(1);
    const call = scripted.calls[0] as Record<string, unknown>;
    expect(call.teamId).toBe(ids.team);
    expect(call.projectId).toBe(ids.project);
  });

  test("repeated reads after the peer is provisioned perform no grant writes", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const peer = await makePeer(false);
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await setup({
      bootstrap,
      epochGrant: await sealEpochGrant(bootstrap, epochKey),
      peerDevices: [{ ...peer, hasEpochGrant: false }],
    });
    const firstScripted = scriptGrantBootstrap(first, () =>
      Response.json(
        {
          grantObjectId: "99999999-9999-4999-8999-999999999999",
          idempotent: false,
        },
        { status: 201 },
      ),
    );
    const initial = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      { ...first, fetch: firstScripted.fetch },
    );
    expect(initial.exitCode).toBe(0);
    expect(firstScripted.calls).toHaveLength(1);
    // The service now reports the peer as holding the epoch grant; the next
    // read must reuse it and write nothing.
    const second = await setup({
      bootstrap,
      epochGrant: await sealEpochGrant(bootstrap, epochKey),
      peerDevices: [{ ...peer, hasEpochGrant: true }],
    });
    const secondScripted = scriptGrantBootstrap(second, () =>
      Response.json({}),
    );
    const repeat = await run(
      [
        "history",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      { ...second, fetch: secondScripted.fetch },
    );
    expect(repeat.exitCode).toBe(0);
    const body = JSON.parse(repeat.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("pendingActions");
    expect(secondScripted.calls).toHaveLength(0);
  });
  test("pull does not mint a spurious key when a peer holds the epoch key", async () => {
    // The Device is enrolled but holds no Project epoch grant, while another
    // Device (or a CLI run) already holds the current key. Minting a fresh
    // random key here can never decrypt the existing content and would
    // permanently block a peer re-share, so pull must report the missing
    // grant instead of self-minting one.
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const peer = await makePeer(true);
    const runtime = await setup({
      bootstrap,
      peerDevices: [peer],
      grantsReady: false,
    });
    const scripted = scriptGrantBootstrap(runtime, () => Response.json({}));
    const pull = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        `${import.meta.dir}/.tmp-workflow-output`,
        "--no-input",
        "--json",
      ],
      { ...runtime, fetch: scripted.fetch, gitTrackingProbe: gitOutside },
    );
    expect(pull.exitCode).toBe(0);
    const body = JSON.parse(pull.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.pendingActions).toEqual([
      "This Device is missing the Project epoch grant; an owner or admin can provision it by running dotrelay pull from their own Device",
    ]);
    // A matching Environment reports "no changes"; the missing-grant
    // remediation must survive that output variant as well, so the
    // second, unchanged run is the one that pins the regression.
    const unchanged = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        `${import.meta.dir}/.tmp-workflow-output`,
        "--no-input",
        "--json",
      ],
      { ...runtime, fetch: scripted.fetch, gitTrackingProbe: gitOutside },
    );
    expect(unchanged.exitCode).toBe(0);
    const unchangedBody = JSON.parse(unchanged.stdout) as Record<
      string,
      unknown
    >;
    expect(unchangedBody.ok).toBe(true);
    expect(unchangedBody.unchanged).toBe(true);
    expect(unchangedBody.pendingActions).toEqual([
      "This Device is missing the Project epoch grant; an owner or admin can provision it by running dotrelay pull from their own Device",
    ]);
    // The read must not have minted or re-provisioned any Project epoch
    // grant: the peer already holds the key, so a grant write is both
    // pointless and destructive.
    expect(scripted.calls).toHaveLength(0);
  });
});

describe("pull against an unreadable Manifest", () => {
  // Seals a known Project epoch key into the grant the service returns for
  // the presented Device, so the CLI's held key differs from the key the
  // page's lanes were sealed with.
  const sealEpochGrant = async (
    bootstrap: Awaited<ReturnType<typeof createDeviceBootstrap>>,
    plaintextKey: Uint8Array,
  ): Promise<string> => {
    const publicKey = bootstrap.keyMaterial.encryptionPublicKey;
    if (!publicKey) throw new Error("Device encryption public key is missing");
    const grant = await createProjectEpochGrantBootstrap({
      serverProfileId: profile.pin.serverProfileId,
      teamId: ids.team,
      projectId: ids.project,
      projectEpoch: 1,
      senderDeviceId: ids.device,
      recipientDeviceId: ids.device,
      recipientX25519PublicKey: new Uint8Array(
        await crypto.subtle.exportKey("raw", publicKey),
      ),
      recipientEncryptionPublicKey: publicKey,
      signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
      plaintextKey,
    });
    return Buffer.from(grant.canonicalBytes).toString("base64");
  };

  const revisionWireFor = async (
    artifacts: Awaited<ReturnType<typeof createPublicationArtifacts>>,
    parentId: string | null,
    parentHash: Uint8Array | null,
  ) => {
    const revisionObject = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === artifacts.request.revision.protocolObjectId,
    );
    if (!revisionObject) throw new Error("revision object is missing");
    const parsedRevision = parseProtocolObject(revisionObject.bytes);
    const digest = await sha384(revisionObject.bytes);
    return {
      id: artifacts.request.revision.id,
      digest,
      parentId,
      parentHash,
      mutation: parsedRevision.get(35) as number,
      projectEpoch: 1n,
      authoredAtMs: BigInt(artifacts.request.revision.authoredAtMs),
      rollbackTargetId: null,
      objects: await Promise.all(
        artifacts.stagedObjects.map(async (object) => ({
          objectId: object.objectId,
          canonicalBytes: object.bytes,
          digest: await sha384(object.bytes),
        })),
      ),
    };
  };

  // Serves one scripted sync page for the next invocation, mirroring how a
  // later Revision reaches a Device that already verified earlier ones.
  const scriptSyncPage = (
    runtime: Awaited<ReturnType<typeof setup>>,
    page: Parameters<typeof encodeSyncPage>[0],
  ) => {
    const fetcher: FetchFunction = async (input, init) => {
      const request = new Request(input as never, init);
      if (new URL(request.url).pathname.endsWith("/sync"))
        return new Response(encodeSyncPage(page));
      return runtime.fetch(input, init);
    };
    return fetcher;
  };

  test("a wrong Project key grant fails the pull instead of exporting an empty Manifest", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const encryption = bootstrap.keyMaterial.encryptionPublicKey;
    if (!encryption) throw new Error("Device encryption public key is missing");
    const signing = await generateSigningKeyPair();
    const heldKey = crypto.getRandomValues(new Uint8Array(32));
    const laneKey = crypto.getRandomValues(new Uint8Array(32));
    const artifacts = await createPublicationArtifacts(
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://example",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: ids.environment,
        expectedHeadHash: new Uint8Array(48),
        valueRecipientPublicKey: encryption,
        signingPrivateKey: signing.privateKey,
        sharedValueSecret: laneKey,
      },
    );
    const output = `${import.meta.dir}/.tmp-workflow-output`;
    await Bun.write(output, "DATABASE_URL=postgres://local\n");
    const runtime = await setup({
      bootstrap,
      signingTrustKeys: [
        bytesToHex(await rawSigningPublicKey(signing.publicKey)),
      ],
      epochGrant: await sealEpochGrant(bootstrap, heldKey),
      revisions: [
        await revisionWireFor(artifacts, ids.environment, new Uint8Array(48)),
      ],
    });
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        output,
        "--no-input",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(result.exitCode).toBe(3);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "incomplete-export",
      code: "unreadable_manifest",
    });
    expect(String(diagnostic.detail)).toContain("Project key grant");
    expect(result.stdout).not.toContain("postgres://example");
    // The local file and the trusted head are preserved.
    expect(await Bun.file(output).text()).toBe(
      "DATABASE_URL=postgres://local\n",
    );
    expect(await Bun.file(`${output}.previous`).exists()).toBe(false);
    expect(
      await Bun.file(
        `${runtime.stateDirectory}/head-${ids.environment}.json`,
      ).exists(),
    ).toBe(false);
  });

  test("an unreadable newer Value is not exported as the verified older Value", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const encryption = bootstrap.keyMaterial.encryptionPublicKey;
    if (!encryption) throw new Error("Device encryption public key is missing");
    const signing = await generateSigningKeyPair();
    const heldKey = crypto.getRandomValues(new Uint8Array(32));
    const laneKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await createPublicationArtifacts(
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://old",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: ids.environment,
        expectedHeadHash: new Uint8Array(48),
        valueRecipientPublicKey: encryption,
        signingPrivateKey: signing.privateKey,
        sharedValueSecret: heldKey,
      },
    );
    const firstWire = await revisionWireFor(
      first,
      ids.environment,
      new Uint8Array(48),
    );
    const firstRevision = first.stagedObjects.find(
      (object) => object.objectId === first.request.revision.protocolObjectId,
    );
    if (!firstRevision) throw new Error("revision object is missing");
    // The newer Revision the Device cannot decrypt, sealed with a key it
    // does not hold, chained against the verified first Revision.
    const chained = await createPublicationArtifacts(
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "DATABASE_URL",
          description: "Connection string",
          ownership: "SHARED_VALUE",
          value: "postgres://new",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: first.request.revision.id,
        expectedHeadHash: await sha384(firstRevision.bytes),
        valueRecipientPublicKey: encryption,
        signingPrivateKey: signing.privateKey,
        sharedValueSecret: laneKey,
        mutation: "MANIFEST_UPDATE",
      },
    );
    const secondWire = await revisionWireFor(
      chained,
      first.request.revision.id,
      firstWire.digest,
    );
    const output = `${import.meta.dir}/.tmp-workflow-output`;
    // No local file yet: the first pull exports the verified older Value.
    const runtime = await setup({
      bootstrap,
      signingTrustKeys: [
        bytesToHex(await rawSigningPublicKey(signing.publicKey)),
      ],
      epochGrant: await sealEpochGrant(bootstrap, heldKey),
      revisions: [firstWire],
    });
    const ok = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        output,
        "--no-input",
        "--json",
      ],
      { ...runtime, gitTrackingProbe: gitOutside },
    );
    expect(ok.exitCode).toBe(0);
    expect(await Bun.file(output).text()).toContain(
      'DATABASE_URL="postgres://old"',
    );
    const headAfterFirst = await Bun.file(
      `${runtime.stateDirectory}/head-${ids.environment}.json`,
    ).text();
    // The head Revision the Device cannot decrypt arrives next.
    const fetcher = scriptSyncPage(runtime, {
      environmentId: ids.environment,
      trustedRevisionId: ids.environment,
      trustedRevisionHash: new Uint8Array(48),
      currentHeadId: secondWire.id,
      currentHeadHash: secondWire.digest,
      projectEpoch: 1n,
      revisions: [firstWire, secondWire],
      nextCursor: null,
    });
    const blocked = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--output",
        output,
        "--no-input",
        "--json",
      ],
      { ...runtime, fetch: fetcher, gitTrackingProbe: gitOutside },
    );
    expect(blocked.exitCode).toBe(3);
    const diagnostic = JSON.parse(blocked.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "incomplete-export",
      code: "unreadable_manifest",
    });
    // The file keeps the verified older Value and the trusted head does not
    // advance past the last Revision this Device could verify.
    expect(await Bun.file(output).text()).toContain(
      'DATABASE_URL="postgres://old"',
    );
    expect(await Bun.file(output).text()).not.toContain("postgres://new");
    expect(
      await Bun.file(
        `${runtime.stateDirectory}/head-${ids.environment}.json`,
      ).text(),
    ).toBe(headAfterFirst);
  });

  test("an unreadable own User-defined Value names the Device key repair", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: profile.pin,
      userId: ids.user,
      deviceId: ids.device,
    });
    const encryption = bootstrap.keyMaterial.encryptionPublicKey;
    if (!encryption) throw new Error("Device encryption public key is missing");
    const stale = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts(
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "MY_TOKEN",
          description: "Owned by this User.",
          ownership: "USER_DEFINED_VALUE",
          value: "actor-secret",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId: profile.pin.serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.user,
        actorDeviceId: ids.device,
        projectEpoch: 1,
        expectedHeadId: ids.environment,
        expectedHeadHash: new Uint8Array(48),
        valueRecipientPublicKey: encryption,
        userDefinedValueRecipientPublicKey: stale.publicKey,
        signingPrivateKey: signing.privateKey,
      },
    );
    const runtime = await setup({
      bootstrap,
      signingTrustKeys: [
        bytesToHex(await rawSigningPublicKey(signing.publicKey)),
      ],
      revisions: [
        await revisionWireFor(artifacts, ids.environment, new Uint8Array(48)),
      ],
    });
    const result = await run(
      [
        "pull",
        "--profile",
        "relay",
        "--environment",
        ids.environment,
        "--no-input",
        "--json",
      ],
      runtime,
    );
    expect(result.exitCode).toBe(3);
    const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "incomplete-export",
      code: "unreadable_manifest",
    });
    expect(String(diagnostic.detail)).toContain("device enroll");
    expect(result.stdout).not.toContain("actor-secret");
  });
});
