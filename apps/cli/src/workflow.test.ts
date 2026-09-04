import { afterEach, describe, expect, test } from "bun:test";
import {
  createCliDeviceStorage,
  createDeviceBootstrap,
  createMemoryCredentialStore,
  createMemoryDeviceRecordStore,
} from "@dotrelay/client";
import { encodeSyncPage } from "@dotrelay/contracts";
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

const setup = async (): Promise<{
  credentials: NativeCredentialStore;
  deviceStorage: ReturnType<typeof createCliDeviceStorage>;
  admin: StrictJsonClient;
  fetch: FetchFunction;
  profilePath: string;
}> => {
  const profilePath = `${import.meta.dir}/.tmp-workflow-profile-${crypto.randomUUID()}`;
  await Bun.write(
    profilePath,
    JSON.stringify({ version: 1, profiles: [profile] }),
  );
  const credentials = createMemoryCredentialStore();
  await createSessionStore(credentials).save(profile.pin, "session-token");
  const deviceStorage = createCliDeviceStorage(profile.pin, credentials, {
    recordStore: createMemoryDeviceRecordStore(),
  });
  const bootstrap = await createDeviceBootstrap({
    pin: profile.pin,
    userId: ids.user,
    deviceId: ids.device,
  });
  await deviceStorage.save(bootstrap.bundle);
  const admin: StrictJsonClient = {
    get: async (path) => {
      if (path === "/api/v1/session")
        return { authenticated: true, user: { id: ids.user } };
      return boundary;
    },
    post: async () => ({}),
  };
  const emptyPage = encodeSyncPage({
    environmentId: ids.environment,
    trustedRevisionId: ids.environment,
    trustedRevisionHash: new Uint8Array(48),
    currentHeadId: null,
    currentHeadHash: null,
    projectEpoch: 1n,
    revisions: [],
    nextCursor: null,
  });
  const fetcher: FetchFunction = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input as never, init);
    if (request.url.endsWith("/sync")) return new Response(emptyPage);
    if (request.url.endsWith("/begin"))
      return Response.json({
        operationId: crypto.randomUUID(),
        status: "STAGED",
        idempotent: false,
        expiresAt: "2026-09-02T00:00:00Z",
      });
    return Response.json({});
  };
  return { credentials, deviceStorage, admin, fetch: fetcher, profilePath };
};

afterEach(async () => {
  for (const file of [".tmp-workflow-input", ".tmp-workflow-output"])
    await (await import("node:fs/promises"))
      .unlink(`${import.meta.dir}/${file}`)
      .catch(() => undefined);
  for (const file of await (await import("node:fs/promises")).readdir(
    import.meta.dir,
  ))
    if (
      file.startsWith(".tmp-workflow-profile-") ||
      ((file.startsWith("device-") || file.startsWith("enrollment-")) &&
        file.endsWith(".json"))
    )
      await (await import("node:fs/promises"))
        .unlink(`${import.meta.dir}/${file}`)
        .catch(() => undefined);
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
