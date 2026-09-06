import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createCliDeviceStorage,
  createDeviceBootstrap,
  createMemoryCredentialStore,
  createMemoryDeviceRecordStore,
  createPublicationArtifacts,
} from "@dotrelay/client";
import {
  bytesToUuid,
  encodeSyncPage,
  generateSigningKeyPair,
  parseProtocolObject,
  type SyncPageWire,
  sha384,
} from "@dotrelay/contracts";
import type { StrictJsonClient } from "./admin";
import { createSessionStore } from "./auth";
import type { NativeCredentialStore } from "./credentials";
import { CliError } from "./errors";
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

const bytesToHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const rawSigningPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key)).slice(0, 32);

const setup = async (
  options: Readonly<{
    readonly signingTrustKeys?: readonly string[];
    readonly revisions?: SyncPageWire["revisions"];
    readonly bootstrap?: Awaited<ReturnType<typeof createDeviceBootstrap>>;
  }> = {},
): Promise<{
  credentials: NativeCredentialStore;
  deviceStorage: ReturnType<typeof createCliDeviceStorage>;
  admin: StrictJsonClient;
  fetch: FetchFunction;
  profilePath: string;
  bootstrap: Awaited<ReturnType<typeof createDeviceBootstrap>>;
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
  const workspaceBoundary = {
    ...boundary,
    ...(options.signingTrustKeys
      ? { signingTrustKeys: options.signingTrustKeys }
      : {}),
  };
  const admin: StrictJsonClient = {
    get: async (path) => {
      if (path === "/api/v1/session")
        return { authenticated: true, user: { id: ids.user } };
      return workspaceBoundary;
    },
    post: async () => ({}),
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
  };
};

afterEach(async () => {
  const { readdir, rm, unlink } = await import("node:fs/promises");
  for (const file of [".tmp-workflow-input", ".tmp-workflow-output"])
    await unlink(`${import.meta.dir}/${file}`).catch(() => undefined);
  for (const file of await readdir(import.meta.dir))
    if (
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
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"ok":true');
    expect(result.stdout).not.toContain("postgres://secret");
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
        ids.environment,
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
        ids.environment,
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
        ids.environment,
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
        ids.environment,
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
        ids.environment,
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
        ids.environment,
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

  test("diff human output prints a unified Value diff", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "KEEP=same\nCHANGED=prev\nGONE=old\n");
    const initialized = await run(
      [
        "init",
        ids.environment,
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
    expect(namesOnly.stdout).toContain("+  fresh");
    expect(namesOnly.stdout).toContain("CHANGED");
    expect(namesOnly.stdout).toContain("-  prev");
    expect(namesOnly.stdout).toContain("+  next");
    expect(namesOnly.stdout).toContain("GONE");
    expect(namesOnly.stdout).toContain("-  old");
    expect(namesOnly.stdout).not.toContain("KEEP");
    expect(namesOnly.stdout).not.toContain("••••••••");
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
        ids.environment,
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
    await Bun.write(input, "DATABASE_URL=abc\nAPI_KEY=tok\n");
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
        "  DATABASE_URL",
        "  -  postgres://secret",
        "  +  abc",
        "Publish?",
      ].join("\n"),
    ]);
    expect(pushed.stdout).not.toContain("abc");
    expect(pushed.stdout).not.toContain("postgres://secret");
  });

  test("push confirmation lists added and removed Variables", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        ids.environment,
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
        "  NEW_TOKEN",
        "  +  fresh",
        "",
        "  API_KEY",
        "  -  tok",
        "Publish?",
      ].join("\n"),
    ]);
    expect(pushed.stdout).not.toContain("fresh");
    expect(pushed.stdout).not.toContain("tok");
  });

  test("pull confirmation shows the Values that will replace the local file", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\nAPI_KEY=tok\n");
    const initialized = await run(
      [
        "init",
        ids.environment,
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
      },
    );
    expect(pulled.exitCode).toBe(0);
    expect(questions).toEqual([
      [
        "1 variable being added, 1 variable being updated, 1 variable being removed",
        "  DATABASE_URL",
        "  -  postgres://local",
        "  +  postgres://secret",
        "",
        "  GONE",
        "  -  old",
        "",
        "  API_KEY",
        "  +  tok",
        `Replace ${input} with decrypted Values?`,
      ].join("\n"),
    ]);
    expect(pulled.stdout).not.toContain("postgres://local");
    expect(pulled.stdout).not.toContain("postgres://secret");
  });

  test("pull reports no changes when the local file already matches", async () => {
    const runtime = await setup();
    const input = `${import.meta.dir}/.tmp-workflow-input`;
    await Bun.write(input, "DATABASE_URL=postgres://secret\n");
    const initialized = await run(
      [
        "init",
        ids.environment,
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
      },
    );
    expect(pulled.exitCode).toBe(0);
    expect(questions).toEqual([]);
    expect(pulled.stdout).toBe("No changes found\n");
    expect(await Bun.file(input).text()).toBe("DATABASE_URL=postgres://secret\n");
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
});
