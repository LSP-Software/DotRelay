import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import {
  createCliDeviceStorage,
  createDeviceBootstrap,
  createMemoryCredentialStore,
  createMemoryDeviceRecordStore,
  createPublicationArtifacts,
  loadDeviceKeyMaterial,
} from "@dotrelay/client";
import {
  bytesToUuid,
  createProblem,
  encodeSyncPage,
  generateSigningKeyPair,
  parseProtocolObject,
  type SyncPageWire,
  sha384,
  uuidToBytes,
} from "@dotrelay/contracts";
import type { StrictJsonClient } from "./admin";
import { createSessionStore } from "./auth";
import type { NativeCredentialStore } from "./credentials";
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

const destinationLines = [
  `Profile: ${profile.name}`,
  "Team: Platform",
  `Project: ${ids.project}`,
  "Environment: development",
];

// The test checkout's own Git state must never steer a pull; these probes pin
// the repository state each scenario asserts on.
const gitOutside: GitTrackingProbe = async () => ({ state: "outside" });
const gitTracked: GitTrackingProbe = async () => ({ state: "tracked" });

const bytesToHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const rawSigningPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key)).slice(0, 32);

const setup = async (
  options: Readonly<{
    readonly signingTrustKeys?: readonly string[];
    readonly revisions?: SyncPageWire["revisions"];
    readonly bootstrap?: Awaited<ReturnType<typeof createDeviceBootstrap>>;
    readonly withoutBoundaryEnvironment?: boolean;
  }> = {},
): Promise<{
  credentials: NativeCredentialStore;
  deviceStorage: ReturnType<typeof createCliDeviceStorage>;
  admin: StrictJsonClient;
  fetch: FetchFunction;
  profilePath: string;
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
    bootstrap,
    createdEnvironments,
  };
};

afterEach(async () => {
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
    expect(rendered).toContain("variable from .env");
    expect(rendered).toContain("DATABASE_URL");
    expect(rendered).toContain("Team");
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
    expect(namesOnly.stdout).toContain("NEW  added");
    expect(namesOnly.stdout).toContain("CHANGED  shared  updated");
    expect(namesOnly.stdout).toContain("GONE  shared  removed");
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
    expect(unchanged.stdout).toContain("Local .env matches the Environment");
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
    expect(questions).toEqual([
      [
        "1 variable being updated",
        "  DATABASE_URL  shared  updated",
        "",
        ...destinationLines,
        "Publish?",
      ].join("\n"),
    ]);
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
    expect(questions).toEqual([
      [
        "1 variable being updated",
        "  DATABASE_URL  shared",
        "  -  postgres://secret",
        "  +  abc123x",
        "",
        ...destinationLines,
        "Publish?",
      ].join("\n"),
    ]);
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
    expect(declined.stderr).toContain("publication confirmation was declined");
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
    expect(questions).toEqual([
      [
        "1 variable being added, 1 variable being removed",
        "  NEW_TOKEN  shared  added",
        "  API_KEY  user-defined  removed",
        "",
        ...destinationLines,
        "Publish?",
      ].join("\n"),
    ]);
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
      [
        "1 variable being added, 1 variable being updated, 1 variable being removed",
        "  DATABASE_URL  shared  updated",
        "  GONE  removed",
        "  API_KEY  user-defined  added",
        "",
        ...destinationLines,
        `Replace ${input} with decrypted Values?`,
      ].join("\n"),
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
      [
        "1 variable being added, 1 variable being updated, 1 variable being removed",
        "  DATABASE_URL  shared",
        "  -  postgres://local",
        "  +  postgres://secret",
        "",
        "  GONE",
        "  -  old",
        "",
        "  API_KEY  user-defined",
        "  +  tok",
        "",
        ...destinationLines,
        `Replace ${input} with decrypted Values?`,
      ].join("\n"),
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
      "publication confirmation was declined",
    );
    expect(revealedDeclined.stderr).not.toContain("abc123x");
    expect(revealedDeclined.stderr).not.toContain("postgres://secret");
    expect(questions).toEqual([
      [
        "1 variable being updated",
        "  DATABASE_URL  shared",
        "  -  abc123x",
        "  +  postgres://secret",
        "",
        ...destinationLines,
        "Publish?",
      ].join("\n"),
    ]);
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
    expect(questions[1]).toBe(
      [
        "1 variable being updated",
        "  DATABASE_URL  shared  updated",
        "",
        ...destinationLines,
        "Publish?",
      ].join("\n"),
    );
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

  test("creates and restores a protected Recovery Kit", async () => {
    const runtime = await setup();
    const kitPath = `${import.meta.dir}/.tmp-recovery-kit`;
    await Bun.write(kitPath, "previous-recovery-kit\n");
    const backupAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        if (path === "/api/v1/recovery/envelopes/current")
          throw new CliError(
            "invocation",
            "not found",
            {},
            "resource_not_found",
          );
        return boundary;
      },
      post: async () => ({
        envelopeId: crypto.randomUUID(),
        recoveryGeneration: "1",
        idempotent: false,
      }),
    };
    const backup = await run(
      [
        "device",
        "backup",
        "--profile",
        "relay",
        "--output",
        kitPath,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin: backupAdmin },
    );
    expect(backup.exitCode).toBe(0);
    const artifact = await Bun.file(kitPath).json();
    expect(artifact.kind).toBe("dotrelay-recovery-kit");
    expect(artifact.kit).toBeString();
    expect(await Bun.file(`${kitPath}.previous`).text()).toBe(
      "previous-recovery-kit\n",
    );

    const recoveryPosts: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const recoverAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        return {
          ...boundary,
          device: { active: false },
        };
      },
      post: async (path, body) => {
        recoveryPosts.push({ path, body });
        return {
          deviceId: body.deviceId,
          active: true,
          recoveryGeneration: body.recoveryGeneration,
        };
      },
    };
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--from",
        kitPath,
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: recoverAdmin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(0);
    expect(recover.stdout).toContain('"active":true');
    expect(recoveryPosts).toHaveLength(1);
    expect(recoveryPosts[0]?.path).toBe("/api/v1/recovery/restore");
    expect(recoveryPosts[0]?.body.envelope).toBeString();
    expect(recoveryPosts[0]?.body.proof).toBeString();
    await (await import("node:fs/promises"))
      .unlink(kitPath)
      .catch(() => undefined);
    await (await import("node:fs/promises"))
      .unlink(`${kitPath}.previous`)
      .catch(() => undefined);
  });

  test("recovery is blocked while another of the User's Devices is active", async () => {
    const runtime = await setup();
    const kitPath = `${import.meta.dir}/.tmp-recovery-kit-blocked`;
    const backupAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        if (path === "/api/v1/recovery/envelopes/current")
          throw new CliError(
            "invocation",
            "not found",
            {},
            "resource_not_found",
          );
        return boundary;
      },
      post: async () => ({
        envelopeId: crypto.randomUUID(),
        recoveryGeneration: "1",
        idempotent: false,
      }),
    };
    const backup = await run(
      [
        "device",
        "backup",
        "--profile",
        "relay",
        "--output",
        kitPath,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin: backupAdmin },
    );
    expect(backup.exitCode).toBe(0);
    const recoveryPosts: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    // The recorded Device is gone, but another of this User's Devices is
    // still active, so a replacement Device must wait until the User has
    // resolved the surviving Device.
    const recoverAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        return {
          ...boundary,
          device: { active: false },
          activeDeviceCount: 2,
        };
      },
      post: async (path, body) => {
        recoveryPosts.push({ path, body });
        return {
          deviceId: body.deviceId,
          active: true,
          recoveryGeneration: body.recoveryGeneration,
        };
      },
    };
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--from",
        kitPath,
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: recoverAdmin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(4);
    const diagnostic = JSON.parse(recover.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      detail: "Recovery Kit restore requires no active Device",
      exitCode: 4,
    });
    expect(recoveryPosts).toHaveLength(0);
    await (await import("node:fs/promises"))
      .unlink(kitPath)
      .catch(() => undefined);
    await (await import("node:fs/promises"))
      .unlink(`${kitPath}.previous`)
      .catch(() => undefined);
  });

  test("a rejected recovery keeps the previous Device selection and usable keys", async () => {
    const runtime = await setup();
    const kitPath = `${import.meta.dir}/.tmp-recovery-kit-rejected`;
    const backupAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        if (path === "/api/v1/recovery/envelopes/current")
          throw new CliError(
            "invocation",
            "not found",
            {},
            "resource_not_found",
          );
        return boundary;
      },
      post: async () => ({
        envelopeId: crypto.randomUUID(),
        recoveryGeneration: "1",
        idempotent: false,
      }),
    };
    const backup = await run(
      [
        "device",
        "backup",
        "--profile",
        "relay",
        "--output",
        kitPath,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin: backupAdmin },
    );
    expect(backup.exitCode).toBe(0);
    const stateDirectory = runtime.profilePath.slice(0, -"profile.json".length);
    const { deviceMetadataPath, readDeviceId } = await import(
      "./device-storage"
    );
    const recoveryPosts: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    // The Server Profile definitively rejects the restore, so the pending
    // operation is discarded and the prior Device selection must survive.
    const rejectAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        return { ...boundary, device: { active: false } };
      },
      post: async (path, body) => {
        if (path === "/api/v1/recovery/restore") {
          recoveryPosts.push({ path, body });
          throw new CliError(
            "conflict",
            "the requested change conflicts with current Server Profile state",
            {},
            "stale_generation",
          );
        }
        return {};
      },
    };
    const reject = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--from",
        kitPath,
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: rejectAdmin,
        fetch: async () => Response.json({}),
      },
    );
    expect(reject.exitCode).toBe(4);
    const diagnostic = JSON.parse(reject.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "conflict",
      exitCode: 4,
    });
    expect(recoveryPosts).toHaveLength(1);
    // The prior selection and its usable keys are untouched by the rejection.
    expect(
      await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin)),
    ).toBe(ids.device);
    await runtime.deviceStorage.load({
      pin: profile.pin,
      deviceId: uuidToBytes(ids.device),
    });
    // A definitive rejection discards the pending operation.
    expect(
      await Bun.file(
        `${stateDirectory}/device-${profile.pin.serverProfileId}.recovery.json`,
      ).exists(),
    ).toBe(false);

    // A later attempt starts a fresh operation and may still recover.
    const acceptAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        return { ...boundary, device: { active: false } };
      },
      post: async (path, body) => {
        if (path === "/api/v1/recovery/restore")
          recoveryPosts.push({ path, body });
        return {
          deviceId: body.deviceId,
          active: true,
          recoveryGeneration: body.recoveryGeneration,
          idempotent: false,
        };
      },
    };
    const accept = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--from",
        kitPath,
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: acceptAdmin,
        fetch: async () => Response.json({}),
      },
    );
    expect(accept.exitCode).toBe(0);
    expect(recoveryPosts).toHaveLength(2);
    expect(recoveryPosts[1]?.body.operationId).not.toBe(
      recoveryPosts[0]?.body.operationId,
    );
    expect(
      await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin)),
    ).toBe(recoveryPosts[1]?.body.deviceId as string);
    await (await import("node:fs/promises"))
      .unlink(kitPath)
      .catch(() => undefined);
    await (await import("node:fs/promises"))
      .unlink(`${kitPath}.previous`)
      .catch(() => undefined);
  });

  test("an uncertain recovery response resumes the same logical operation", async () => {
    const runtime = await setup();
    const kitPath = `${import.meta.dir}/.tmp-recovery-kit-uncertain`;
    const backupAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        if (path === "/api/v1/recovery/envelopes/current")
          throw new CliError(
            "invocation",
            "not found",
            {},
            "resource_not_found",
          );
        return boundary;
      },
      post: async () => ({
        envelopeId: crypto.randomUUID(),
        recoveryGeneration: "1",
        idempotent: false,
      }),
    };
    const backup = await run(
      [
        "device",
        "backup",
        "--profile",
        "relay",
        "--output",
        kitPath,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin: backupAdmin },
    );
    expect(backup.exitCode).toBe(0);
    const stateDirectory = runtime.profilePath.slice(0, -"profile.json".length);
    const { deviceMetadataPath, readDeviceId } = await import(
      "./device-storage"
    );
    const pendingPath = `${stateDirectory}/device-${profile.pin.serverProfileId}.recovery.json`;
    const recoveryPosts: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    let restoreAttempts = 0;
    let replacementDeviceId: string | undefined;
    const recoverAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        // Once the restore may have been accepted, the replacement Device is
        // the User's only active Device, so a resume must not be blocked by
        // the no-active-Device check.
        return replacementDeviceId
          ? {
              ...boundary,
              device: { active: true, id: replacementDeviceId },
              activeDeviceCount: 1,
            }
          : { ...boundary, device: { active: false } };
      },
      post: async (path, body) => {
        if (path === "/api/v1/recovery/restore") {
          restoreAttempts += 1;
          recoveryPosts.push({ path, body });
          if (restoreAttempts === 1) {
            replacementDeviceId = body.deviceId as string;
            throw new CliError(
              "transient",
              "could not reach the Server Profile",
              {},
              "service_unavailable",
            );
          }
          return {
            deviceId: body.deviceId,
            active: true,
            recoveryGeneration: body.recoveryGeneration,
            idempotent: true,
          };
        }
        return {};
      },
    };
    const recoverArgs = [
      "device",
      "recover",
      "--profile",
      "relay",
      "--from",
      kitPath,
      "--no-input",
      "--json",
    ];
    const first = await run(recoverArgs, {
      ...runtime,
      admin: recoverAdmin,
      fetch: async () => Response.json({}),
    });
    expect(first.exitCode).toBe(7);
    expect(restoreAttempts).toBe(1);
    // The prior selection stands while the outcome is uncertain, and the
    // pending operation survives for resumption.
    expect(
      await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin)),
    ).toBe(ids.device);
    expect(await Bun.file(pendingPath).exists()).toBe(true);

    const second = await run(recoverArgs, {
      ...runtime,
      admin: recoverAdmin,
      fetch: async () => Response.json({}),
    });
    expect(second.exitCode).toBe(0);
    expect(restoreAttempts).toBe(2);
    expect(recoveryPosts).toHaveLength(2);
    // The retry re-posted the identical request: the same operation, the same
    // pending key material, and no second replacement Device.
    expect(recoveryPosts[1]?.body).toEqual(recoveryPosts[0]?.body);
    expect(
      await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin)),
    ).toBe(recoveryPosts[0]?.body.deviceId as string);
    expect(await Bun.file(pendingPath).exists()).toBe(false);
    // The committed selection holds the pending replacement's key material.
    const committed = await runtime.deviceStorage.load({
      pin: profile.pin,
      deviceId: uuidToBytes(recoveryPosts[0]?.body.deviceId as string),
    });
    const keys = await loadDeviceKeyMaterial(committed);
    const raw = async (key: CryptoKey | undefined): Promise<string> =>
      key
        ? Buffer.from(
            new Uint8Array(await crypto.subtle.exportKey("raw", key)),
          ).toString("base64")
        : "";
    expect(await raw(keys.encryptionPublicKey)).toBe(
      recoveryPosts[0]?.body.x25519PublicKey as string,
    );
    expect(await raw(keys.signingPublicKey)).toBe(
      recoveryPosts[0]?.body.ed25519PublicKey as string,
    );
    await (await import("node:fs/promises"))
      .unlink(kitPath)
      .catch(() => undefined);
    await (await import("node:fs/promises"))
      .unlink(`${kitPath}.previous`)
      .catch(() => undefined);
  });

  test("an approval naming another Device leaves the local selection unchanged", async () => {
    const runtime = await setup();
    const kitPath = `${import.meta.dir}/.tmp-recovery-kit-mismatch`;
    const backupAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        if (path === "/api/v1/recovery/envelopes/current")
          throw new CliError(
            "invocation",
            "not found",
            {},
            "resource_not_found",
          );
        return boundary;
      },
      post: async () => ({
        envelopeId: crypto.randomUUID(),
        recoveryGeneration: "1",
        idempotent: false,
      }),
    };
    const backup = await run(
      [
        "device",
        "backup",
        "--profile",
        "relay",
        "--output",
        kitPath,
        "--no-input",
        "--json",
      ],
      { ...runtime, admin: backupAdmin },
    );
    expect(backup.exitCode).toBe(0);
    const stateDirectory = runtime.profilePath.slice(0, -"profile.json".length);
    const { deviceMetadataPath, readDeviceId } = await import(
      "./device-storage"
    );
    const pendingPath = `${stateDirectory}/device-${profile.pin.serverProfileId}.recovery.json`;
    const recoveryPosts: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    // The approval identifies a Device that is not the pending replacement,
    // so the local selection must not switch to it.
    const mismatchAdmin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/session")
          return { authenticated: true, user: { id: ids.user } };
        return { ...boundary, device: { active: false } };
      },
      post: async (path, body) => {
        if (path === "/api/v1/recovery/restore")
          recoveryPosts.push({ path, body });
        return {
          deviceId: ids.approver,
          active: true,
          recoveryGeneration: body.recoveryGeneration,
          idempotent: false,
        };
      },
    };
    const recover = await run(
      [
        "device",
        "recover",
        "--profile",
        "relay",
        "--from",
        kitPath,
        "--no-input",
        "--json",
      ],
      {
        ...runtime,
        admin: mismatchAdmin,
        fetch: async () => Response.json({}),
      },
    );
    expect(recover.exitCode).toBe(7);
    const diagnostic = JSON.parse(recover.stderr) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "transient",
      code: "response_invalid",
      exitCode: 7,
    });
    expect(recoveryPosts).toHaveLength(1);
    // The prior selection stands and the pending operation survives so the
    // same logical operation can be reconciled again.
    expect(
      await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin)),
    ).toBe(ids.device);
    expect(await Bun.file(pendingPath).exists()).toBe(true);
    await (await import("node:fs/promises"))
      .unlink(kitPath)
      .catch(() => undefined);
    await (await import("node:fs/promises"))
      .unlink(`${kitPath}.previous`)
      .catch(() => undefined);
  });
});
