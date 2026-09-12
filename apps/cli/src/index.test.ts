import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createCliDeviceStorage,
  createDeviceBootstrap,
  createMemoryDeviceRecordStore,
} from "@dotrelay/client";
import {
  createCapabilitiesDocument,
  createProblem,
  DEVICE_ID_HEADER,
  encodeSyncPage,
  PROTOCOL_MEDIA_TYPE,
  type ProblemCode,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import { createSessionStore } from "./auth";
import type { NativeCredentialStore } from "./credentials";
import { deviceMetadataPath, writeDeviceId } from "./device-storage";
import { main, renderHelp, run, version } from "./index";
import type { FetchFunction } from "./profile";
import type { TerminalIo } from "./terminal";

describe("CLI foundation", () => {
  test("renders everyday help by default and power commands under help", async () => {
    expect(main(["--help"])).toBe(renderHelp());
    expect(renderHelp()).toContain("setup <origin>");
    expect(renderHelp()).toContain("diff");
    expect(renderHelp()).not.toContain("device begin");
    const result = await run(["help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("device begin");
  });

  test("reports its foundation version", () => {
    expect(main(["--version"])).toBe(version);
  });

  test("verifies the stored session with the Server Profile instead of trusting it", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    try {
      await Bun.write(
        profilePath,
        JSON.stringify({
          version: 1,
          selected: "relay",
          profiles: [
            {
              name: "relay",
              origin: "https://relay.example",
              pin: {
                origin: "https://relay.example",
                serverProfileId: "00000000-0000-4000-8000-000000000042",
              },
            },
          ],
        }),
      );
      const requested: string[] = [];
      const result = await run(["status", "--json"], {
        profilePath,
        credentials: {
          get: async () => new TextEncoder().encode("session-token"),
          set: async () => undefined,
          delete: async () => undefined,
        },
        fetch: async (input) => {
          const url = String(input);
          requested.push(url);
          if (url.endsWith("/api/v1/session"))
            return Response.json({
              authenticated: true,
              user: { id: "22222222-2222-4222-8222-222222222222" },
            });
          return Response.json(createProblem("resource_not_found"), {
            status: 404,
          });
        },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: "relay",
        origin: "https://relay.example",
        service: "verified",
        session: "verified",
        device: "not-enrolled",
        nextAction: "run dotrelay device enroll",
      });
      expect(requested).toEqual(["https://relay.example/api/v1/session"]);
      expect(result.stdout).not.toContain("session-token");
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
    }
  });

  test("honors a status profile override", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    try {
      await Bun.write(
        profilePath,
        JSON.stringify({
          version: 1,
          selected: "relay",
          profiles: [
            {
              name: "relay",
              origin: "https://relay.example",
              pin: {
                origin: "https://relay.example",
                serverProfileId: "00000000-0000-4000-8000-000000000042",
              },
            },
            {
              name: "other",
              origin: "https://other.example",
              pin: {
                origin: "https://other.example",
                serverProfileId: "00000000-0000-4000-8000-000000000043",
              },
            },
          ],
        }),
      );
      const requested: string[] = [];
      const result = await run(["status", "--profile", "other", "--json"], {
        profilePath,
        credentials: {
          get: async (_service, account) =>
            account.includes("000000000043")
              ? new TextEncoder().encode("session-token")
              : null,
          set: async () => undefined,
          delete: async () => undefined,
        },
        fetch: async (input) => {
          const url = String(input);
          requested.push(url);
          if (url.endsWith("/api/v1/session"))
            return Response.json({
              authenticated: true,
              user: { id: "22222222-2222-4222-8222-222222222222" },
            });
          return Response.json(createProblem("resource_not_found"), {
            status: 404,
          });
        },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: "other",
        origin: "https://other.example",
        service: "verified",
        session: "verified",
        device: "not-enrolled",
      });
      expect(requested).toEqual(["https://other.example/api/v1/session"]);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
    }
  });

  test("rejects forbidden flags even when help is requested", async () => {
    const result = await run(["--insecure", "--help"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("--insecure is not supported\n");
  });

  test("maps an empty Git remote result to repository_missing", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    try {
      await Bun.write(
        profilePath,
        JSON.stringify({
          version: 1,
          profiles: [
            {
              name: "relay",
              origin: "https://relay.example",
              pin: {
                origin: "https://relay.example",
                serverProfileId: "00000000-0000-4000-8000-000000000042",
              },
            },
          ],
        }),
      );
      const result = await run(["context", "--profile", "relay", "--json"], {
        profilePath,
        readGitRemotes: async () => [],
      });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "repository_missing",
      });
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
    }
  });

  test("links a Project and writes only opaque worktree context", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    const contextPath = `${import.meta.dir}/.tmp-context-${crypto.randomUUID()}`;
    try {
      await Bun.write(
        profilePath,
        JSON.stringify({
          version: 1,
          selected: "relay",
          profiles: [
            {
              name: "relay",
              origin: "https://relay.example",
              pin: {
                origin: "https://relay.example",
                serverProfileId: "00000000-0000-4000-8000-000000000042",
              },
            },
          ],
        }),
      );
      const result = await run(
        [
          "project",
          "link",
          "--team",
          "00000000-0000-4000-8000-000000000001",
          "--json",
        ],
        {
          profilePath,
          worktreeConfig: contextPath,
          readGitRemotes: async () => [
            { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
          ],
          githubFetch: async () => Response.json({ id: 1311418611 }),
          admin: {
            post: async () => ({
              id: "00000000-0000-4000-8000-000000000002",
              teamId: "00000000-0000-4000-8000-000000000001",
              githubRepositoryId: "1311418611",
              lifecycle: "active",
            }),
            get: async () => ({}) as never,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        projectId: "00000000-0000-4000-8000-000000000002",
      });
      expect(await Bun.file(contextPath).text()).toBe(
        '{"serverProfileId":"00000000-0000-4000-8000-000000000042","projectId":"00000000-0000-4000-8000-000000000002"}\n',
      );
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
      await (await import("node:fs/promises"))
        .unlink(contextPath)
        .catch(() => undefined);
    }
  });

  test("selects an Environment with command-level precedence and preserves context", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    const contextPath = `${import.meta.dir}/.tmp-context-${crypto.randomUUID()}`;
    try {
      await Bun.write(
        profilePath,
        JSON.stringify({
          version: 1,
          selected: "relay",
          profiles: [
            {
              name: "relay",
              origin: "https://relay.example",
              pin: {
                origin: "https://relay.example",
                serverProfileId: "00000000-0000-4000-8000-000000000042",
              },
            },
          ],
        }),
      );
      await Bun.write(
        contextPath,
        JSON.stringify({
          serverProfileId: "00000000-0000-4000-8000-000000000042",
          projectId: "00000000-0000-4000-8000-000000000002",
        }),
      );
      const result = await run(
        [
          "env",
          "use",
          "--environment",
          "00000000-0000-4000-8000-000000000003",
          "--profile",
          "relay",
          "--json",
        ],
        {
          profilePath,
          worktreeConfig: contextPath,
          admin: {
            get: async () => ({
              environments: [
                {
                  id: "00000000-0000-4000-8000-000000000003",
                  projectId: "00000000-0000-4000-8000-000000000002",
                  lifecycle: "active",
                  currentHeadId: null,
                },
              ],
            }),
            post: async () => ({}) as never,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        environmentId: "00000000-0000-4000-8000-000000000003",
      });
      expect(JSON.parse(await Bun.file(contextPath).text())).toEqual({
        serverProfileId: "00000000-0000-4000-8000-000000000042",
        projectId: "00000000-0000-4000-8000-000000000002",
        environmentId: "00000000-0000-4000-8000-000000000003",
      });
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
      await (await import("node:fs/promises"))
        .unlink(contextPath)
        .catch(() => undefined);
    }
  });
});

const serverProfileId = "00000000-0000-4000-8000-000000000042";
const teamId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const environmentId = "00000000-0000-4000-8000-000000000003";
const deviceId = "00000000-0000-4000-8000-000000000004";
const otherDeviceId = "00000000-0000-4000-8000-000000000005";
const sessionToken = "session-token";

type AdminRequest = Readonly<{
  readonly method: string;
  readonly path: string;
  readonly deviceIdHeader: string | null;
  readonly authorization: string | null;
}>;

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });

const problemResponse = (code: ProblemCode): Response => {
  const problem = createProblem(code);
  return jsonResponse(problem, problem.status);
};

// Mirrors the Server Profile's protocol actor resolution: an authenticated
// request must present an active Device id, otherwise the service rejects it
// before any administration logic runs.
const createAdminHttpFixture = (
  activeDevices: Iterable<string>,
): Readonly<{
  readonly origin: string;
  readonly pin: ServerProfilePin;
  readonly requests: AdminRequest[];
  readonly stop: () => void;
}> => {
  const requests: AdminRequest[] = [];
  const active = new Set(activeDevices);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/v1/projects"))
        return problemResponse("resource_not_found");
      requests.push({
        method: request.method,
        path: url.pathname,
        deviceIdHeader: request.headers.get(DEVICE_ID_HEADER),
        authorization: request.headers.get("Authorization"),
      });
      if (request.headers.get("Authorization") !== `Bearer ${sessionToken}`)
        return problemResponse("authentication_required");
      const presented = request.headers.get(DEVICE_ID_HEADER);
      if (!presented) return problemResponse("invalid_request");
      if (!active.has(presented)) return problemResponse("device_not_active");
      if (request.method === "POST" && url.pathname === "/api/v1/projects")
        return jsonResponse(
          {
            id: projectId,
            teamId,
            githubRepositoryId: "1311418611",
            lifecycle: "active",
            environment: {
              id: environmentId,
              projectId,
              label: "default",
              lifecycle: "active",
              currentHeadId: null,
            },
          },
          201,
        );
      if (
        request.method === "GET" &&
        url.pathname === `/api/v1/projects/${projectId}/environments`
      )
        return jsonResponse({
          environments: [
            {
              id: environmentId,
              projectId,
              label: "default",
              lifecycle: "active",
              currentHeadId: null,
            },
          ],
        });
      return problemResponse("resource_not_found");
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    pin: Object.freeze({ origin, serverProfileId }),
    requests,
    stop: () => server.stop(true),
  };
};

const seedCommandState = async (
  fixture: Readonly<{ origin: string; pin: ServerProfilePin }>,
  options: Readonly<{ withDevice: boolean }>,
): Promise<{
  profilePath: string;
  stateDirectory: string;
  contextPath: string;
  credentials: NativeCredentialStore;
  cleanup: () => Promise<void>;
}> => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "dotrelay-admin-http-"));
  const profilePath = join(stateDirectory, "profiles.json");
  const contextPath = join(stateDirectory, "context.json");
  await Bun.write(
    profilePath,
    JSON.stringify({
      version: 1,
      selected: "relay",
      profiles: [
        {
          name: "relay",
          origin: fixture.origin,
          pin: {
            origin: fixture.origin,
            serverProfileId: fixture.pin.serverProfileId,
          },
        },
      ],
    }),
  );
  if (options.withDevice)
    await writeDeviceId(
      deviceMetadataPath(stateDirectory, fixture.pin),
      fixture.pin,
      deviceId,
    );
  const credentials: NativeCredentialStore = Object.freeze({
    get: async () => new TextEncoder().encode(sessionToken),
    set: async () => undefined,
    delete: async () => undefined,
  });
  return {
    profilePath,
    stateDirectory,
    contextPath,
    credentials,
    cleanup: async () =>
      rm(stateDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      ),
  };
};

// Real command dispatch: no admin client, no fetch, and no Device id are
// injected, so the command must load the persisted Device and speak HTTP to
// the fixture Server Profile.
const runtimeForCommandState = (state: {
  profilePath: string;
  stateDirectory: string;
  contextPath: string;
  credentials: NativeCredentialStore;
}) => ({
  profilePath: state.profilePath,
  stateDirectory: state.stateDirectory,
  worktreeConfig: state.contextPath,
  credentials: state.credentials,
  readGitRemotes: async () => [
    { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
  ],
  githubFetch: async () => Response.json({ id: 1311418611 }),
});

describe("command-to-HTTP administration", () => {
  test("project link sends the persisted Device id with the administration request", async () => {
    const fixture = createAdminHttpFixture([deviceId]);
    const state = await seedCommandState(fixture, { withDevice: true });
    try {
      const result = await run(
        ["project", "link", "--team", teamId, "--json"],
        runtimeForCommandState(state),
      );
      expect(result.exitCode).toBe(0);
      const body: unknown = JSON.parse(result.stdout);
      expect(body).toMatchObject({
        ok: true,
        projectId,
        environmentId,
      });
      expect(fixture.requests).toHaveLength(1);
      const request = fixture.requests[0];
      expect(request?.method).toBe("POST");
      expect(request?.path).toBe("/api/v1/projects");
      expect(request?.deviceIdHeader).toBe(deviceId);
      expect(request?.authorization).toBe(`Bearer ${sessionToken}`);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("env use sends the persisted Device id with the administration request", async () => {
    const fixture = createAdminHttpFixture([deviceId]);
    const state = await seedCommandState(fixture, { withDevice: true });
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({ serverProfileId, projectId }),
      );
      const result = await run(
        ["env", "use", environmentId, "--json"],
        runtimeForCommandState(state),
      );
      expect(result.exitCode).toBe(0);
      const body: unknown = JSON.parse(result.stdout);
      expect(body).toMatchObject({ ok: true, environmentId });
      expect(fixture.requests).toHaveLength(1);
      const request = fixture.requests[0];
      expect(request?.method).toBe("GET");
      expect(request?.path).toBe(`/api/v1/projects/${projectId}/environments`);
      expect(request?.deviceIdHeader).toBe(deviceId);
      expect(request?.authorization).toBe(`Bearer ${sessionToken}`);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("project link prompts enrollment when no Device is enrolled locally", async () => {
    const fixture = createAdminHttpFixture([deviceId]);
    const state = await seedCommandState(fixture, { withDevice: false });
    try {
      const json = await run(
        ["project", "link", "--team", teamId, "--json"],
        runtimeForCommandState(state),
      );
      expect(json.exitCode).toBe(6);
      const diagnostic = JSON.parse(json.stderr) as Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        ok: false,
        category: "authentication",
        code: "device_bundle_missing",
        exitCode: 6,
      });
      expect(String(diagnostic.detail)).toContain("device enroll");
      const human = await run(
        ["project", "link", "--team", teamId],
        runtimeForCommandState(state),
      );
      expect(human.exitCode).toBe(6);
      expect(human.stderr).toContain(
        "no Device is enrolled for this Server Profile; run dotrelay login or dotrelay device enroll",
      );
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("protected commands prompt enrollment when no Device is enrolled locally", async () => {
    const fixture = createAdminHttpFixture([deviceId]);
    const state = await seedCommandState(fixture, { withDevice: false });
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({ serverProfileId, projectId, environmentId }),
      );
      const result = await run(
        [
          "history",
          "--profile",
          "relay",
          "--environment",
          environmentId,
          "--no-input",
          "--json",
        ],
        runtimeForCommandState(state),
      );
      expect(result.exitCode).toBe(6);
      const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        ok: false,
        category: "authentication",
        code: "device_bundle_missing",
        exitCode: 6,
      });
      expect(String(diagnostic.detail)).toContain("device enroll");
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("env use reports a revoked Device with a reauthorization action", async () => {
    const fixture = createAdminHttpFixture([otherDeviceId]);
    const state = await seedCommandState(fixture, { withDevice: true });
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({ serverProfileId, projectId }),
      );
      const result = await run(
        ["env", "use", environmentId, "--json"],
        runtimeForCommandState(state),
      );
      expect(result.exitCode).toBe(6);
      const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        ok: false,
        category: "authentication",
        code: "device_not_active",
        exitCode: 6,
      });
      expect(String(diagnostic.detail)).toContain("device enroll");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.deviceIdHeader).toBe(deviceId);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });
});

const developmentEnvironmentId = "00000000-0000-4000-8000-0000000000a1";
const productionEnvironmentId = "00000000-0000-4000-8000-0000000000a2";
const archivedEnvironmentId = "00000000-0000-4000-8000-0000000000a3";
const protocolUserId = "22222222-2222-4222-8222-222222222222";

type EnvironmentFixture = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly lifecycle: "active" | "archived";
}>;

// Serves the project administration surface plus the workspace boundary and
// protocol sync surface a protected command exercises. Every Environment
// offers an empty verified history, so a pull completes end to end.
const createProtocolHttpFixture = (
  environments: readonly EnvironmentFixture[],
): Readonly<{
  readonly origin: string;
  readonly pin: ServerProfilePin;
  readonly requests: Array<
    Readonly<{ readonly method: string; readonly path: string }>
  >;
  readonly stop: () => void;
}> => {
  const requests: Array<Readonly<{ method: string; path: string }>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
      });
      if (request.method === "GET" && url.pathname === "/api/v1/projects")
        return jsonResponse({
          project: {
            id: projectId,
            teamId,
            githubRepositoryId: "1311418611",
            lifecycle: "active",
          },
        });
      if (
        request.method === "GET" &&
        url.pathname === `/api/v1/projects/${projectId}/environments`
      )
        return jsonResponse({
          environments: environments.map((entry) => ({
            id: entry.id,
            projectId,
            label: entry.label,
            lifecycle: entry.lifecycle,
            currentHeadId: null,
          })),
        });
      if (request.method === "GET" && url.pathname === "/api/v1/teams")
        return jsonResponse({ teams: [{ id: teamId, name: "Platform" }] });
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/workspace/boundary"
      ) {
        const environmentId = url.searchParams.get("environment");
        return jsonResponse({
          environment: {
            id: environmentId,
            projectId,
            teamId,
            headRevision: environmentId ?? "none",
            headHash: null,
            projectEpoch: "1",
          },
          session: { active: true, userId: protocolUserId },
          device: { active: true, id: deviceId },
          grantsReady: true,
          epochCurrent: true,
          rotationRequired: false,
          crypto: { available: true },
        });
      }
      const sync = /\/api\/v1\/environments\/([^/]+)\/sync$/u.exec(
        url.pathname,
      );
      if (sync?.[1] && request.method === "POST") {
        const environmentId = sync[1];
        if (!environments.some((entry) => entry.id === environmentId))
          return problemResponse("resource_not_found");
        return new Response(
          encodeSyncPage({
            environmentId,
            trustedRevisionId: environmentId,
            trustedRevisionHash: new Uint8Array(48),
            currentHeadId: null,
            currentHeadHash: null,
            projectEpoch: 1n,
            revisions: [],
            nextCursor: null,
          }),
          {
            status: 200,
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": PROTOCOL_MEDIA_TYPE,
            },
          },
        );
      }
      return problemResponse("resource_not_found");
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    pin: Object.freeze({ origin, serverProfileId }),
    requests,
    stop: () => server.stop(true),
  };
};

const seedProtocolCommandState = async (
  fixture: Readonly<{ origin: string; pin: ServerProfilePin }>,
): Promise<{
  profilePath: string;
  stateDirectory: string;
  contextPath: string;
  credentials: NativeCredentialStore;
  deviceStorage: ReturnType<typeof createCliDeviceStorage>;
  cleanup: () => Promise<void>;
}> => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "dotrelay-protocol-"));
  const profilePath = join(stateDirectory, "profiles.json");
  const contextPath = join(stateDirectory, "context.json");
  await Bun.write(
    profilePath,
    JSON.stringify({
      version: 1,
      selected: "relay",
      profiles: [
        {
          name: "relay",
          origin: fixture.origin,
          pin: {
            origin: fixture.origin,
            serverProfileId: fixture.pin.serverProfileId,
          },
        },
      ],
    }),
  );
  await writeDeviceId(
    deviceMetadataPath(stateDirectory, fixture.pin),
    fixture.pin,
    deviceId,
  );
  const secrets = new Map<string, Uint8Array>();
  const credentials: NativeCredentialStore = Object.freeze({
    get: async (_service, account) => {
      const value = secrets.get(account);
      return value ? new Uint8Array(value) : null;
    },
    set: async (_service, account, secret) => {
      secrets.set(account, new Uint8Array(secret));
    },
    delete: async (_service, account) => {
      secrets.delete(account);
    },
  });
  await createSessionStore(credentials).save(fixture.pin, sessionToken);
  const bootstrap = await createDeviceBootstrap({
    pin: fixture.pin,
    userId: protocolUserId,
    deviceId,
  });
  const deviceStorage = createCliDeviceStorage(fixture.pin, credentials, {
    recordStore: createMemoryDeviceRecordStore(),
  });
  await deviceStorage.save(bootstrap.bundle);
  return {
    profilePath,
    stateDirectory,
    contextPath,
    credentials,
    deviceStorage,
    cleanup: async () =>
      rm(stateDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      ),
  };
};

const runtimeForProtocolState = (state: {
  profilePath: string;
  stateDirectory: string;
  contextPath: string;
  credentials: NativeCredentialStore;
  deviceStorage: ReturnType<typeof createCliDeviceStorage>;
}) => ({
  profilePath: state.profilePath,
  stateDirectory: state.stateDirectory,
  worktreeConfig: state.contextPath,
  credentials: state.credentials,
  deviceStorage: state.deviceStorage,
  readGitRemotes: async () => [
    { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
  ],
  githubFetch: async () => Response.json({ id: 1311418611 }),
});

describe("protected command Environment selection", () => {
  test("asks which Environment to use and persists the choice only after success", async () => {
    const fixture = createProtocolHttpFixture([
      {
        id: developmentEnvironmentId,
        label: "development",
        lifecycle: "active",
      },
      {
        id: productionEnvironmentId,
        label: "production",
        lifecycle: "active",
      },
    ]);
    const state = await seedProtocolCommandState(fixture);
    try {
      const saved = JSON.stringify({ serverProfileId, projectId });
      await Bun.write(state.contextPath, saved);
      const input = new PassThrough();
      const output = new PassThrough();
      const renderedChunks: string[] = [];
      output.on("data", (chunk) => {
        renderedChunks.push(
          typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
      });
      input.write("2\n");
      input.end();
      const result = await run(["pull", "--profile", "relay", "--stdout"], {
        ...runtimeForProtocolState(state),
        terminal: { input, output },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("\n");
      const rendered = renderedChunks.join("");
      expect(rendered).toContain("development");
      expect(rendered).toContain("production");
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${productionEnvironmentId}`,
        ),
      ).toBe(true);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId: productionEnvironmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("an empty reply to the Environment prompt is rejected, not a guess", async () => {
    const fixture = createProtocolHttpFixture([
      {
        id: developmentEnvironmentId,
        label: "development",
        lifecycle: "active",
      },
      {
        id: productionEnvironmentId,
        label: "production",
        lifecycle: "active",
      },
    ]);
    const state = await seedProtocolCommandState(fixture);
    try {
      const saved = JSON.stringify({ serverProfileId, projectId });
      await Bun.write(state.contextPath, saved);
      const input = new PassThrough();
      const output = new PassThrough();
      input.write("\n");
      input.end();
      const result = await run(["pull", "--profile", "relay", "--stdout"], {
        ...runtimeForProtocolState(state),
        terminal: { input, output },
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("choose an option from the list");
      expect(
        fixture.requests.some((request) =>
          request.path.includes("/workspace/boundary"),
        ),
      ).toBe(false);
      expect(await Bun.file(state.contextPath).text()).toBe(saved);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("auto-selects the only active Environment and never offers archived ones", async () => {
    const fixture = createProtocolHttpFixture([
      { id: archivedEnvironmentId, label: "legacy", lifecycle: "archived" },
      {
        id: productionEnvironmentId,
        label: "production",
        lifecycle: "active",
      },
    ]);
    const state = await seedProtocolCommandState(fixture);
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({ serverProfileId, projectId }),
      );
      const input = new PassThrough();
      const output = new PassThrough();
      const renderedChunks: string[] = [];
      output.on("data", (chunk) => {
        renderedChunks.push(
          typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
      });
      input.end();
      const result = await run(["pull", "--profile", "relay", "--stdout"], {
        ...runtimeForProtocolState(state),
        terminal: { input, output },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("\n");
      expect(renderedChunks.join("")).toBe("");
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${productionEnvironmentId}`,
        ),
      ).toBe(true);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId: productionEnvironmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("an archived saved Environment is skipped and an active one is resolved", async () => {
    const fixture = createProtocolHttpFixture([
      { id: archivedEnvironmentId, label: "legacy", lifecycle: "archived" },
      {
        id: productionEnvironmentId,
        label: "production",
        lifecycle: "active",
      },
    ]);
    const state = await seedProtocolCommandState(fixture);
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({
          serverProfileId,
          projectId,
          environmentId: archivedEnvironmentId,
        }),
      );
      const input = new PassThrough();
      const output = new PassThrough();
      input.end();
      const result = await run(["pull", "--profile", "relay", "--stdout"], {
        ...runtimeForProtocolState(state),
        terminal: { input, output },
      });
      expect(result.exitCode).toBe(0);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${productionEnvironmentId}`,
        ),
      ).toBe(true);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${archivedEnvironmentId}`,
        ),
      ).toBe(false);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId: productionEnvironmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("--no-input refuses a stale saved Environment instead of guessing", async () => {
    const fixture = createProtocolHttpFixture([
      { id: archivedEnvironmentId, label: "legacy", lifecycle: "archived" },
      {
        id: productionEnvironmentId,
        label: "production",
        lifecycle: "active",
      },
    ]);
    const state = await seedProtocolCommandState(fixture);
    try {
      const saved = JSON.stringify({
        serverProfileId,
        projectId,
        environmentId: archivedEnvironmentId,
      });
      await Bun.write(state.contextPath, saved);
      const result = await run(
        ["pull", "--profile", "relay", "--stdout", "--no-input"],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "--no-input requires explicit --environment context",
      );
      expect(
        fixture.requests.some((request) =>
          request.path.includes("/workspace/boundary"),
        ),
      ).toBe(false);
      expect(await Bun.file(state.contextPath).text()).toBe(saved);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("--no-input refuses to guess an Environment and keeps the saved context", async () => {
    const fixture = createProtocolHttpFixture([
      {
        id: developmentEnvironmentId,
        label: "development",
        lifecycle: "active",
      },
      {
        id: productionEnvironmentId,
        label: "production",
        lifecycle: "active",
      },
    ]);
    const state = await seedProtocolCommandState(fixture);
    try {
      const saved = JSON.stringify({ serverProfileId, projectId });
      await Bun.write(state.contextPath, saved);
      const result = await run(
        ["pull", "--profile", "relay", "--stdout", "--no-input"],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "--no-input requires explicit --environment context",
      );
      expect(fixture.requests).toHaveLength(0);
      expect(await Bun.file(state.contextPath).text()).toBe(saved);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("--no-input reports ambiguous Environments without changing the saved context", async () => {
    const fixture = createProtocolHttpFixture([
      {
        id: developmentEnvironmentId,
        label: "development",
        lifecycle: "active",
      },
      {
        id: productionEnvironmentId,
        label: "production",
        lifecycle: "active",
      },
    ]);
    const state = await seedProtocolCommandState(fixture);
    try {
      const saved = JSON.stringify({ serverProfileId, projectId });
      await Bun.write(state.contextPath, saved);
      const result = await run(
        ["push", "--profile", "relay", "--no-input"],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "multiple Environments are available; pass --environment",
      );
      expect(
        fixture.requests.some((request) =>
          request.path.includes("/workspace/boundary"),
        ),
      ).toBe(false);
      expect(await Bun.file(state.contextPath).text()).toBe(saved);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("a declined pull confirmation leaves the saved selection untouched", async () => {
    const fixture = createProtocolHttpFixture([
      {
        id: developmentEnvironmentId,
        label: "development",
        lifecycle: "active",
      },
    ]);
    const state = await seedProtocolCommandState(fixture);
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({
          serverProfileId,
          projectId,
          environmentId: developmentEnvironmentId,
        }),
      );
      const outputPath = join(state.stateDirectory, "dotenv");
      await Bun.write(outputPath, "DATABASE_URL=old\n");
      const result = await run(
        [
          "pull",
          "--profile",
          "relay",
          "--environment",
          developmentEnvironmentId,
          "--output",
          outputPath,
        ],
        { ...runtimeForProtocolState(state), confirm: async () => false },
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("pull confirmation was declined");
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId: developmentEnvironmentId,
      });
      expect(await Bun.file(outputPath).text()).toBe("DATABASE_URL=old\n");
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });
});

const secondTeamId = "00000000-0000-4000-8000-000000000006";
const archivedLinkedProjectId = "00000000-0000-4000-8000-0000000000a4";
const secondTeamProjectId = "00000000-0000-4000-8000-0000000000a5";
const secondTeamEnvironmentId = "00000000-0000-4000-8000-0000000000a6";

type MultiProjectTeamFixture = Readonly<{
  readonly id: string;
  readonly name: string;
}>;

type MultiProjectProjectFixture = Readonly<{
  readonly id: string;
  readonly teamId: string;
  readonly lifecycle: "active" | "archived";
}>;

type MultiProjectEnvironmentFixture = Readonly<{
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly lifecycle: "active" | "archived";
}>;

type MultiProjectFixtureSpec = Readonly<{
  readonly teams: readonly MultiProjectTeamFixture[];
  readonly projects: readonly MultiProjectProjectFixture[];
  readonly environments: readonly MultiProjectEnvironmentFixture[];
}>;

// Serves the administration surface for one GitHub Repository linked from
// several Teams, mirroring the service: only active Projects in Teams the
// User joins are eligible, a Team scope is Membership-checked, and every
// remaining candidate is returned for a labelled choice.
const createMultiProjectProtocolHttpFixture = (
  spec: MultiProjectFixtureSpec,
): Readonly<{
  readonly origin: string;
  readonly pin: ServerProfilePin;
  readonly requests: Array<
    Readonly<{ readonly method: string; readonly path: string }>
  >;
  readonly stop: () => void;
}> => {
  const requests: Array<Readonly<{ method: string; path: string }>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
      });
      if (request.method === "GET" && url.pathname === "/api/v1/projects") {
        const teamId = url.searchParams.get("teamId");
        const eligible = spec.projects.filter(
          (entry) =>
            entry.lifecycle === "active" &&
            (teamId === null || entry.teamId === teamId),
        );
        const summarize = (entry: MultiProjectProjectFixture) => ({
          id: entry.id,
          teamId: entry.teamId,
          githubRepositoryId: "1311418611",
          lifecycle: entry.lifecycle,
        });
        const sole = eligible.length === 1 ? eligible[0] : undefined;
        return jsonResponse({
          project: sole ? summarize(sole) : null,
          projects: eligible.map(summarize),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/teams")
        return jsonResponse({ teams: spec.teams });
      const environments = /\/api\/v1\/projects\/([^/]+)\/environments$/u.exec(
        url.pathname,
      );
      if (environments?.[1] && request.method === "GET")
        return jsonResponse({
          environments: spec.environments
            .filter((entry) => entry.projectId === environments[1])
            .map((entry) => ({
              id: entry.id,
              projectId: entry.projectId,
              label: entry.label,
              lifecycle: entry.lifecycle,
              currentHeadId: null,
            })),
        });
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/workspace/boundary"
      ) {
        const environmentId = url.searchParams.get("environment");
        const environment = environmentId
          ? spec.environments.find((entry) => entry.id === environmentId)
          : undefined;
        const project = environment
          ? spec.projects.find((entry) => entry.id === environment.projectId)
          : undefined;
        return jsonResponse({
          environment: {
            id: environment?.id ?? null,
            projectId: project?.id ?? null,
            teamId: project?.teamId ?? null,
            headRevision: environment?.id ?? "none",
            headHash: null,
            projectEpoch: "1",
          },
          session: { active: true, userId: protocolUserId },
          device: { active: true, id: deviceId },
          grantsReady: true,
          epochCurrent: true,
          rotationRequired: false,
          crypto: { available: true },
        });
      }
      const sync = /\/api\/v1\/environments\/([^/]+)\/sync$/u.exec(
        url.pathname,
      );
      if (sync?.[1] && request.method === "POST") {
        const environmentId = sync[1];
        if (!spec.environments.some((entry) => entry.id === environmentId))
          return problemResponse("resource_not_found");
        return new Response(
          encodeSyncPage({
            environmentId,
            trustedRevisionId: environmentId,
            trustedRevisionHash: new Uint8Array(48),
            currentHeadId: null,
            currentHeadHash: null,
            projectEpoch: 1n,
            revisions: [],
            nextCursor: null,
          }),
          {
            status: 200,
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": PROTOCOL_MEDIA_TYPE,
            },
          },
        );
      }
      return problemResponse("resource_not_found");
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    pin: Object.freeze({ origin, serverProfileId }),
    requests,
    stop: () => server.stop(true),
  };
};

describe("Project resolution across Teams and lifecycles", () => {
  const relinkedTeamSpec: MultiProjectFixtureSpec = {
    teams: [{ id: teamId, name: "Platform" }],
    projects: [
      { id: archivedLinkedProjectId, teamId, lifecycle: "archived" },
      { id: projectId, teamId, lifecycle: "active" },
    ],
    environments: [
      {
        id: archivedEnvironmentId,
        projectId: archivedLinkedProjectId,
        label: "legacy",
        lifecycle: "active",
      },
      { id: environmentId, projectId, label: "default", lifecycle: "active" },
    ],
  };

  const sharedRepositorySpec: MultiProjectFixtureSpec = {
    teams: [
      { id: teamId, name: "Platform" },
      { id: secondTeamId, name: "Acme" },
    ],
    projects: [
      { id: projectId, teamId, lifecycle: "active" },
      { id: secondTeamProjectId, teamId: secondTeamId, lifecycle: "active" },
    ],
    environments: [
      { id: environmentId, projectId, label: "default", lifecycle: "active" },
      {
        id: secondTeamEnvironmentId,
        projectId: secondTeamProjectId,
        label: "default",
        lifecycle: "active",
      },
    ],
  };

  test("archive and relink in one Team keeps discovery working from a stale saved Project", async () => {
    const fixture = createMultiProjectProtocolHttpFixture(relinkedTeamSpec);
    const state = await seedProtocolCommandState(fixture);
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({
          serverProfileId,
          projectId: archivedLinkedProjectId,
          environmentId: archivedEnvironmentId,
        }),
      );
      const result = await run(
        ["pull", "--profile", "relay", "--stdout"],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(0);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${environmentId}`,
        ),
      ).toBe(true);
      expect(
        fixture.requests.some((request) =>
          request.path.includes(`/api/v1/workspace/boundary`),
        ),
      ).toBe(true);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${archivedEnvironmentId}`,
        ),
      ).toBe(false);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("archive and relink in one Team resolves the active Project for a fresh worktree", async () => {
    const fixture = createMultiProjectProtocolHttpFixture(relinkedTeamSpec);
    const state = await seedProtocolCommandState(fixture);
    try {
      const result = await run(
        ["pull", "--profile", "relay", "--stdout"],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(0);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${environmentId}`,
        ),
      ).toBe(true);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("--team steers a shared repository to that Team's Project", async () => {
    const fixture = createMultiProjectProtocolHttpFixture(sharedRepositorySpec);
    const state = await seedProtocolCommandState(fixture);
    try {
      const result = await run(
        ["pull", "--profile", "relay", "--team", secondTeamId, "--stdout"],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(0);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${secondTeamEnvironmentId}`,
        ),
      ).toBe(true);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${environmentId}`,
        ),
      ).toBe(false);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId: secondTeamProjectId,
        environmentId: secondTeamEnvironmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("--team matches Team UUIDs case-insensitively", async () => {
    const fixture = createMultiProjectProtocolHttpFixture(sharedRepositorySpec);
    const state = await seedProtocolCommandState(fixture);
    try {
      const result = await run(
        [
          "pull",
          "--profile",
          "relay",
          "--team",
          secondTeamId.toUpperCase(),
          "--stdout",
        ],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(0);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/projects?githubRepositoryId=1311418611&teamId=${secondTeamId}`,
        ),
      ).toBe(true);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${secondTeamEnvironmentId}`,
        ),
      ).toBe(true);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId: secondTeamProjectId,
        environmentId: secondTeamEnvironmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("a saved Project choice wins over another eligible Team's Project", async () => {
    const fixture = createMultiProjectProtocolHttpFixture(sharedRepositorySpec);
    const state = await seedProtocolCommandState(fixture);
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({
          serverProfileId,
          projectId,
          environmentId,
        }),
      );
      const result = await run(
        ["pull", "--profile", "relay", "--stdout"],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(0);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${environmentId}`,
        ),
      ).toBe(true);
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${secondTeamEnvironmentId}`,
        ),
      ).toBe(false);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId,
        environmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("--team names a Team the User does not join before any Project lookup", async () => {
    const fixture = createMultiProjectProtocolHttpFixture({
      teams: [{ id: teamId, name: "Platform" }],
      projects: [{ id: projectId, teamId, lifecycle: "active" }],
      environments: [
        { id: environmentId, projectId, label: "default", lifecycle: "active" },
      ],
    });
    const state = await seedProtocolCommandState(fixture);
    try {
      const result = await run(
        ["pull", "--profile", "relay", "--team", secondTeamId, "--json"],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        category: "invocation",
        exitCode: 2,
      });
      expect(result.stderr).toContain("the specified Team is not available");
      expect(fixture.requests.map((request) => request.path)).toEqual([
        "/api/v1/teams",
      ]);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("--no-input reports labelled Projects instead of a bare conflict", async () => {
    const fixture = createMultiProjectProtocolHttpFixture(sharedRepositorySpec);
    const state = await seedProtocolCommandState(fixture);
    try {
      const result = await run(
        [
          "pull",
          "--profile",
          "relay",
          "--no-input",
          "--environment",
          environmentId,
          "--json",
        ],
        runtimeForProtocolState(state),
      );
      expect(result.exitCode).toBe(2);
      const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        ok: false,
        category: "invocation",
        code: "project_ambiguous",
        exitCode: 2,
      });
      const detail = String(diagnostic.detail);
      expect(detail).toContain(
        "multiple Projects are linked to this GitHub Repository",
      );
      expect(detail).toContain("Platform");
      expect(detail).toContain("Acme");
      expect(detail).toContain("LSP-Software/DotRelay");
      expect(
        fixture.requests.some((request) =>
          request.path.includes("/workspace/boundary"),
        ),
      ).toBe(false);
      expect(await Bun.file(state.contextPath).exists()).toBe(false);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("an operator chooses among labelled Projects from other Teams", async () => {
    const fixture = createMultiProjectProtocolHttpFixture(sharedRepositorySpec);
    const state = await seedProtocolCommandState(fixture);
    const input = new PassThrough();
    const output = new PassThrough();
    const renderedChunks: string[] = [];
    output.on("data", (chunk) => {
      renderedChunks.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      );
    });
    try {
      input.write("2\n");
      input.end();
      const result = await run(["pull", "--profile", "relay", "--stdout"], {
        ...runtimeForProtocolState(state),
        terminal: { input, output },
      });
      const rendered = renderedChunks.join("");
      expect(result.exitCode).toBe(0);
      expect(rendered).toContain("Platform");
      expect(rendered).toContain("Acme");
      expect(rendered).toContain("LSP-Software/DotRelay");
      expect(
        fixture.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${secondTeamEnvironmentId}`,
        ),
      ).toBe(true);
      expect(JSON.parse(await Bun.file(state.contextPath).text())).toEqual({
        serverProfileId,
        projectId: secondTeamProjectId,
        environmentId: secondTeamEnvironmentId,
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });
});

const loginOrigin = "https://relay.example";
const loginProfileId = "00000000-0000-4000-8000-000000000042";
const loginUserId = "22222222-2222-4222-8222-222222222222";
const loginDeviceId = "33333333-3333-4333-8333-333333333333";

const createLoginFixture = async (
  options: Readonly<{
    readonly token?: (poll: number) => Response;
    readonly emptyCatalog?: boolean;
    readonly remoteDeviceId?: string;
  }> = {},
): Promise<
  Readonly<{
    readonly profilePath: string;
    readonly stateDirectory: string;
    readonly credentials: NativeCredentialStore;
    readonly deviceStorage: ReturnType<typeof createCliDeviceStorage>;
    readonly fetch: FetchFunction;
    readonly runtime: Readonly<{
      readonly profilePath: string;
      readonly stateDirectory: string;
      readonly credentials: NativeCredentialStore;
      readonly deviceStorage: ReturnType<typeof createCliDeviceStorage>;
      readonly fetch: FetchFunction;
    }>;
    readonly bootstrapCount: () => number;
    readonly enrolledDeviceId: () => string | null;
    readonly revokeLocalDevice: () => void;
    readonly cleanup: () => Promise<void>;
  }>
> => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "dotrelay-login-"));
  const profilePath = join(stateDirectory, "profiles.json");
  const catalog = options.emptyCatalog
    ? { version: 1, profiles: [] }
    : {
        version: 1,
        selected: "relay",
        profiles: [
          {
            name: "relay",
            origin: loginOrigin,
            pin: { origin: loginOrigin, serverProfileId: loginProfileId },
          },
        ],
      };
  await Bun.write(profilePath, JSON.stringify(catalog));
  const secrets = new Map<string, Uint8Array>();
  const credentials: NativeCredentialStore = Object.freeze({
    get: async (_service, account) => {
      const value = secrets.get(account);
      return value ? new Uint8Array(value) : null;
    },
    set: async (_service, account, secret) => {
      secrets.set(account, new Uint8Array(secret));
    },
    delete: async (_service, account) => {
      secrets.delete(account);
    },
  });
  const pin = Object.freeze({
    origin: loginOrigin,
    serverProfileId: loginProfileId,
  });
  const deviceStorage = createCliDeviceStorage(pin, credentials, {
    recordStore: createMemoryDeviceRecordStore(),
  });
  // The Server Profile's fleet: a pre-existing Device on another installation
  // plus any Device this client bootstraps.
  const remoteDevices = new Set<string>([
    ...(options.remoteDeviceId ? [options.remoteDeviceId] : []),
  ]);
  const revokedDevices = new Set<string>();
  let localDeviceId: string | null = null;
  let bootstrapCalls = 0;
  let poll = 0;
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input as never, init);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/capabilities")
      return Response.json(
        createCapabilitiesDocument({
          serverProfileId: loginProfileId,
          origin: loginOrigin,
        }),
      );
    if (request.method === "POST" && url.pathname === "/api/auth/device/code")
      return Response.json({
        device_code: "device-code",
        user_code: "KITE-MOSS",
        verification_uri: `${loginOrigin}/device`,
        interval: 1,
        expires_in: 600,
      });
    if (
      request.method === "POST" &&
      url.pathname === "/api/auth/device/token"
    ) {
      poll += 1;
      return options.token
        ? options.token(poll)
        : Response.json({ access_token: "session-token" });
    }
    if (url.pathname === "/api/v1/session")
      return Response.json({ authenticated: true, user: { id: loginUserId } });
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/devices/bootstrap"
    ) {
      const body = (await request.json()) as Record<string, unknown>;
      if (
        typeof body.deviceId !== "string" ||
        body.deviceId.length === 0 ||
        typeof body.certificate !== "string" ||
        body.certificate.length === 0
      )
        return Response.json({ detail: "invalid bootstrap" }, { status: 400 });
      bootstrapCalls += 1;
      localDeviceId = body.deviceId;
      return Response.json(
        { deviceId: body.deviceId, identityGeneration: 1, active: true },
        { status: 201 },
      );
    }
    if (url.pathname === "/api/v1/workspace/boundary") {
      const presented = request.headers.get("X-DotRelay-Device-Id");
      const fleet = [
        ...remoteDevices,
        ...(localDeviceId && !revokedDevices.has(localDeviceId)
          ? [localDeviceId]
          : []),
      ];
      const active = presented && fleet.includes(presented) ? presented : null;
      return Response.json({
        environment: { headRevision: "empty-environment" },
        session: { active: true, userId: loginUserId },
        device: active
          ? { active: true, label: "Active Device", id: active }
          : { active: false, label: "No active Device" },
        activeDeviceCount: fleet.length,
      });
    }
    return Response.json({ detail: "unhandled" }, { status: 404 });
  };
  return {
    profilePath,
    stateDirectory,
    credentials,
    deviceStorage,
    fetch,
    runtime: Object.freeze({
      profilePath,
      stateDirectory,
      credentials,
      deviceStorage,
      fetch,
    }),
    bootstrapCount: () => bootstrapCalls,
    enrolledDeviceId: () => localDeviceId,
    revokeLocalDevice: () => {
      if (localDeviceId) revokedDevices.add(localDeviceId);
    },
    cleanup: async () => {
      await rm(stateDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };
};

const captureTerminal = (): Readonly<{
  readonly terminal: TerminalIo;
  readonly text: () => string;
}> => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  return {
    terminal: { input, output },
    text: () => text,
  };
};

const stderrEvents = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("CLI sign-in display", () => {
  test("no-open human login shows a copyable URL, code, and expiry before waiting", async () => {
    const fixture = await createLoginFixture();
    const captured = captureTerminal();
    const opened: string[] = [];
    try {
      const result = await run(["login", "--profile", "relay", "--no-open"], {
        ...fixture.runtime,
        open: async (url) => {
          opened.push(url);
        },
        terminal: captured.terminal,
      });
      expect(result.exitCode).toBe(0);
      expect(opened).toEqual([]);
      const output = captured.text();
      expect(output).toContain(`${loginOrigin}/device?user_code=KITE-MOSS`);
      expect(output).toContain("Code: KITE-MOSS");
      expect(output).toContain("Expires in 10 minutes");
      expect(output).toContain("Open the URL above to complete sign-in");
      expect(result.stdout).toContain("Signed in. Device enrolled.");
      expect(fixture.bootstrapCount()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a fresh install enrolls itself instead of claiming the remote Device", async () => {
    const fixture = await createLoginFixture({
      remoteDeviceId: loginDeviceId,
    });
    const captured = captureTerminal();
    try {
      const result = await run(
        ["login", "--profile", "relay", "--no-open", "--no-input"],
        {
          ...fixture.runtime,
          open: async (url) => {
            throw new Error(`unexpected browser open: ${url}`);
          },
          terminal: captured.terminal,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Signed in. Device enrolled.");
      expect(fixture.bootstrapCount()).toBe(1);
      const enrolled = fixture.enrolledDeviceId();
      expect(enrolled).not.toBe(loginDeviceId);
      expect(enrolled).not.toBe(null);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a repeat login verifies the saved Device without re-enrolling", async () => {
    const fixture = await createLoginFixture({
      remoteDeviceId: loginDeviceId,
    });
    const captured = captureTerminal();
    const runtime = {
      ...fixture.runtime,
      open: async (url: string) => {
        throw new Error(`unexpected browser open: ${url}`);
      },
      terminal: captured.terminal,
    };
    try {
      const first = await run(
        ["login", "--profile", "relay", "--no-open", "--no-input"],
        runtime,
      );
      expect(first.exitCode).toBe(0);
      const firstDeviceId = fixture.enrolledDeviceId();
      expect(firstDeviceId).not.toBe(loginDeviceId);
      const second = await run(
        ["login", "--profile", "relay", "--no-open", "--no-input"],
        runtime,
      );
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("Signed in. Device already enrolled.");
      expect(fixture.bootstrapCount()).toBe(1);
      expect(fixture.enrolledDeviceId()).toBe(firstDeviceId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("an installation whose Device was deactivated enrolls a replacement", async () => {
    const fixture = await createLoginFixture({
      remoteDeviceId: loginDeviceId,
    });
    const captured = captureTerminal();
    const runtime = {
      ...fixture.runtime,
      open: async (url: string) => {
        throw new Error(`unexpected browser open: ${url}`);
      },
      terminal: captured.terminal,
    };
    try {
      const first = await run(
        ["login", "--profile", "relay", "--no-open", "--no-input"],
        runtime,
      );
      expect(first.exitCode).toBe(0);
      const firstDeviceId = fixture.enrolledDeviceId();
      expect(firstDeviceId).not.toBe(loginDeviceId);
      fixture.revokeLocalDevice();
      const second = await run(
        ["login", "--profile", "relay", "--no-open", "--no-input"],
        runtime,
      );
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("Signed in. Device enrolled.");
      expect(fixture.bootstrapCount()).toBe(2);
      const replacementDeviceId = fixture.enrolledDeviceId();
      expect(replacementDeviceId).not.toBe(firstDeviceId);
      expect(replacementDeviceId).not.toBe(loginDeviceId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("JSON login emits the authorization event and a browser_open_failed diagnostic", async () => {
    const fixture = await createLoginFixture();
    const captured = captureTerminal();
    try {
      const result = await run(["login", "--profile", "relay", "--json"], {
        ...fixture.runtime,
        open: async () => {
          throw new Error("no browser on this host");
        },
        terminal: captured.terminal,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        userCode: "KITE-MOSS",
        verificationUri: `${loginOrigin}/device?user_code=KITE-MOSS`,
        device: "enrolled",
      });
      const events = stderrEvents(captured.text());
      expect(events[0]).toMatchObject({
        ok: true,
        event: "device_authorization",
        userCode: "KITE-MOSS",
        verificationUri: `${loginOrigin}/device?user_code=KITE-MOSS`,
        intervalSeconds: 1,
        expiresInSeconds: 600,
      });
      expect(events[1]).toMatchObject({
        ok: false,
        category: "local-io",
        code: "browser_open_failed",
        exitCode: 8,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("human login falls back to the manual path when the launcher fails", async () => {
    const fixture = await createLoginFixture();
    const captured = captureTerminal();
    try {
      const result = await run(["login", "--profile", "relay"], {
        ...fixture.runtime,
        open: async () => {
          throw new Error("launcher exited nonzero");
        },
        terminal: captured.terminal,
      });
      expect(result.exitCode).toBe(0);
      const output = captured.text();
      expect(output).toContain(`${loginOrigin}/device?user_code=KITE-MOSS`);
      expect(output).toContain("Code: KITE-MOSS");
      expect(output).toContain(
        "Could not open a browser automatically; open the URL above in any browser.",
      );
      expect(output).toContain("Open the URL above to complete sign-in");
    } finally {
      await fixture.cleanup();
    }
  });

  test("JSON login exposes the authorization event before an expired code ends the wait", async () => {
    const fixture = await createLoginFixture({
      token: () => Response.json({ error: "expired_token" }, { status: 400 }),
    });
    const captured = captureTerminal();
    try {
      const result = await run(
        ["login", "--profile", "relay", "--json", "--no-open"],
        {
          ...fixture.runtime,
          terminal: captured.terminal,
        },
      );
      expect(result.exitCode).toBe(6);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        category: "authentication",
        code: "device_authorization_expired",
        exitCode: 6,
      });
      const events = stderrEvents(captured.text());
      expect(events[0]).toMatchObject({
        ok: true,
        event: "device_authorization",
        userCode: "KITE-MOSS",
        verificationUri: `${loginOrigin}/device?user_code=KITE-MOSS`,
        expiresInSeconds: 600,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("no-input login never launches a browser and shows the manual path", async () => {
    const fixture = await createLoginFixture();
    const captured = captureTerminal();
    const opened: string[] = [];
    try {
      const result = await run(["login", "--profile", "relay", "--no-input"], {
        ...fixture.runtime,
        open: async (url) => {
          opened.push(url);
        },
        terminal: captured.terminal,
      });
      expect(result.exitCode).toBe(0);
      expect(opened).toEqual([]);
      const output = captured.text();
      expect(output).toContain(`${loginOrigin}/device?user_code=KITE-MOSS`);
      expect(output).toContain("Code: KITE-MOSS");
      expect(output).toContain("Open the URL above to complete sign-in");
    } finally {
      await fixture.cleanup();
    }
  });

  test("setup --no-open --no-input --json emits the authorization event before waiting", async () => {
    const fixture = await createLoginFixture({ emptyCatalog: true });
    const captured = captureTerminal();
    try {
      const result = await run(
        [
          "setup",
          loginOrigin,
          "--accept-profile",
          loginProfileId,
          "--no-open",
          "--no-input",
          "--json",
        ],
        {
          ...fixture.runtime,
          terminal: captured.terminal,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: "relay.example",
        device: "enrolled",
      });
      const events = stderrEvents(captured.text());
      expect(events[0]).toMatchObject({
        ok: true,
        event: "device_authorization",
        userCode: "KITE-MOSS",
        verificationUri: `${loginOrigin}/device?user_code=KITE-MOSS`,
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

const toHexBytes = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// Serves the session probe and workspace boundary a status verification
// contacts, with the session, Device, and Environment lifecycles scripted.
const createStatusHttpFixture = (
  options: Readonly<{
    readonly session: "active" | "expired";
    readonly device: "active" | "inactive";
    readonly environments: readonly EnvironmentFixture[];
    readonly deviceKeys?: () => Readonly<{
      readonly encryption: string;
      readonly signing: string;
    }> | null;
  }>,
): Readonly<{
  readonly origin: string;
  readonly pin: ServerProfilePin;
  readonly requests: Array<
    Readonly<{
      readonly method: string;
      readonly path: string;
      readonly deviceIdHeader: string | null;
      readonly authorization: string | null;
    }>
  >;
  readonly stop: () => void;
}> => {
  const requests: Array<{
    method: string;
    path: string;
    deviceIdHeader: string | null;
    authorization: string | null;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        deviceIdHeader: request.headers.get(DEVICE_ID_HEADER),
        authorization: request.headers.get("Authorization"),
      });
      if (url.pathname === "/api/v1/session") {
        if (
          options.session === "expired" ||
          request.headers.get("Authorization") !== `Bearer ${sessionToken}`
        )
          return problemResponse("authentication_required");
        return jsonResponse({
          authenticated: true,
          user: { id: protocolUserId, name: "Sam" },
        });
      }
      if (url.pathname === "/api/v1/workspace/boundary") {
        const environmentId = url.searchParams.get("environment");
        const environment = environmentId
          ? options.environments.find(
              (entry) =>
                entry.id === environmentId && entry.lifecycle === "active",
            )
          : null;
        const deviceKeys = options.deviceKeys?.() ?? null;
        const device =
          options.device === "active"
            ? {
                active: true,
                id: deviceId,
                ...(deviceKeys ? deviceKeys : {}),
              }
            : { active: false };
        return jsonResponse({
          environment: {
            id: environment?.id ?? null,
            label: environment?.label ?? null,
            projectId,
            teamId,
            headRevision: "empty-environment",
            headHash: null,
            projectEpoch: null,
          },
          session: { active: true, userId: protocolUserId },
          device,
          grantsReady: false,
          epochCurrent: false,
          activeDeviceCount: options.device === "active" ? 1 : 0,
          rotationRequired: false,
          crypto: { available: true },
          projectEpoch: null,
          profile: {
            name: "DotRelay Server Profile",
            origin: "http://127.0.0.1",
            pinned: true,
            serverProfileId,
          },
          catalog: [],
          signingTrustKeys: [],
          peerDevices: [],
        });
      }
      return problemResponse("resource_not_found");
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    pin: Object.freeze({ origin, serverProfileId }),
    requests,
    stop: () => server.stop(true),
  };
};

const seedStatusState = async (
  pin: ServerProfilePin,
  options: Readonly<{
    readonly session?: "stored" | "none";
    readonly device?: "stored" | "stored-broken" | "none";
    readonly onBootstrap?: (
      bootstrap: Awaited<ReturnType<typeof createDeviceBootstrap>>,
    ) => void;
  }> = {},
): Promise<{
  profilePath: string;
  stateDirectory: string;
  contextPath: string;
  credentials: NativeCredentialStore;
  deviceStorage: ReturnType<typeof createCliDeviceStorage> | null;
  cleanup: () => Promise<void>;
}> => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "dotrelay-status-"));
  const profilePath = join(stateDirectory, "profiles.json");
  const contextPath = join(stateDirectory, "context.json");
  await Bun.write(
    profilePath,
    JSON.stringify({
      version: 1,
      selected: "relay",
      profiles: [
        {
          name: "relay",
          origin: pin.origin,
          pin: {
            origin: pin.origin,
            serverProfileId: pin.serverProfileId,
          },
        },
      ],
    }),
  );
  const secrets = new Map<string, Uint8Array>();
  const credentials: NativeCredentialStore = Object.freeze({
    get: async (_service, account) => {
      const value = secrets.get(account);
      return value ? new Uint8Array(value) : null;
    },
    set: async (_service, account, secret) => {
      secrets.set(account, new Uint8Array(secret));
    },
    delete: async (_service, account) => {
      secrets.delete(account);
    },
  });
  if (options.session !== "none")
    await createSessionStore(credentials).save(pin, sessionToken);
  let deviceStorage: ReturnType<typeof createCliDeviceStorage> | null = null;
  if (options.device !== "none") {
    await writeDeviceId(deviceMetadataPath(stateDirectory, pin), pin, deviceId);
    const bootstrap = await createDeviceBootstrap({
      pin,
      userId: protocolUserId,
      deviceId,
    });
    options.onBootstrap?.(bootstrap);
    deviceStorage = createCliDeviceStorage(pin, credentials, {
      recordStore: createMemoryDeviceRecordStore(),
    });
    if (options.device === "stored") await deviceStorage.save(bootstrap.bundle);
    // "stored-broken" keeps the Device id but no loadable bundle: neither
    // the wrapped record nor the wrapping secret exists locally.
  }
  return {
    profilePath,
    stateDirectory,
    contextPath,
    credentials,
    deviceStorage,
    cleanup: async () =>
      rm(stateDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      ),
  };
};

const statusRuntime = (state: {
  profilePath: string;
  stateDirectory: string;
  contextPath: string;
  credentials: NativeCredentialStore;
  deviceStorage: ReturnType<typeof createCliDeviceStorage> | null;
}) => ({
  profilePath: state.profilePath,
  stateDirectory: state.stateDirectory,
  worktreeConfig: state.contextPath,
  credentials: state.credentials,
  ...(state.deviceStorage ? { deviceStorage: state.deviceStorage } : {}),
});

describe("status verifies the session and this Device", () => {
  test("reports a verified session, active Device, and selected Environment", async () => {
    const keyHolder: { encryption?: string; signing?: string } = {};
    const fixture = createStatusHttpFixture({
      session: "active",
      device: "active",
      environments: [
        { id: environmentId, label: "staging", lifecycle: "active" },
      ],
      deviceKeys: () =>
        keyHolder.encryption && keyHolder.signing
          ? { encryption: keyHolder.encryption, signing: keyHolder.signing }
          : null,
    });
    const state = await seedStatusState(fixture.pin, {
      device: "stored",
      onBootstrap: (bootstrap) => {
        keyHolder.encryption = toHexBytes(bootstrap.x25519PublicKey);
        keyHolder.signing = toHexBytes(bootstrap.ed25519PublicKey);
      },
    });
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({ serverProfileId, projectId, environmentId }),
      );
      const result = await run(["status", "--json"], {
        ...statusRuntime(state),
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: "relay",
        origin: fixture.origin,
        service: "verified",
        session: "verified",
        device: "active",
        nextAction: "none",
        projectId,
        environmentId,
        environment: "staging",
        environmentActive: true,
      });
      const sessionProbe = fixture.requests.find(
        (request) => request.path === "/api/v1/session",
      );
      expect(sessionProbe?.authorization).toBe(`Bearer ${sessionToken}`);
      const boundaryProbe = fixture.requests.find((request) =>
        request.path.startsWith("/api/v1/workspace/boundary"),
      );
      expect(boundaryProbe?.deviceIdHeader).toBe(deviceId);
      expect(boundaryProbe?.path).toBe(
        `/api/v1/workspace/boundary?environment=${environmentId}`,
      );
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("never reports an expired or revoked session as signed in", async () => {
    const fixture = createStatusHttpFixture({
      session: "expired",
      device: "active",
      environments: [],
    });
    const state = await seedStatusState(fixture.pin, { device: "stored" });
    try {
      const result = await run(["status"], statusRuntime(state));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Session expired or revoked");
      expect(result.stdout).not.toContain("Signed in");
      expect(result.stdout).toContain("Next: run dotrelay login");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.path).toBe("/api/v1/session");
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("classifies an unreachable service as offline and retains last-known state", async () => {
    const pin: ServerProfilePin = Object.freeze({
      origin: "https://relay.example",
      serverProfileId,
    });
    const state = await seedStatusState(pin, { device: "stored" });
    let attempts = 0;
    try {
      const result = await run(["status"], {
        ...statusRuntime(state),
        fetch: async () => {
          attempts += 1;
          throw new TypeError("fetch failed");
        },
      });
      expect(result.exitCode).toBe(0);
      expect(attempts).toBeGreaterThan(0);
      expect(result.stdout).toContain(
        "Offline: could not reach the Server Profile",
      );
      expect(result.stdout).toContain("Signed in (last known; not verified)");
      expect(result.stdout).toContain("Device (last known; not verified)");
      expect(result.stdout).toContain(
        "Next: retry when the Server Profile is reachable",
      );
      const json = await run(["status", "--json"], {
        ...statusRuntime(state),
        fetch: async () => {
          attempts += 1;
          throw new TypeError("fetch failed");
        },
      });
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: true,
        service: "offline",
        session: "unverified",
        device: "unverified",
        nextAction: "retry when the Server Profile is reachable",
      });
    } finally {
      await state.cleanup();
    }
  });

  test("reports a stored Device whose keys no longer load locally", async () => {
    const fixture = createStatusHttpFixture({
      session: "active",
      device: "active",
      environments: [],
    });
    const state = await seedStatusState(fixture.pin, {
      device: "stored-broken",
    });
    try {
      const result = await run(["status", "--json"], statusRuntime(state));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        service: "verified",
        session: "verified",
        device: "unusable",
        nextAction: "run dotrelay device recover",
      });
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("reports a Device the service no longer considers active", async () => {
    const fixture = createStatusHttpFixture({
      session: "active",
      device: "inactive",
      environments: [],
    });
    const state = await seedStatusState(fixture.pin, { device: "stored" });
    try {
      const result = await run(["status", "--json"], statusRuntime(state));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        service: "rejected",
        session: "verified",
        device: "not-active",
        nextAction: "run dotrelay device enroll",
      });
      const boundaryProbe = fixture.requests.find((request) =>
        request.path.startsWith("/api/v1/workspace/boundary"),
      );
      expect(boundaryProbe?.deviceIdHeader).toBe(deviceId);
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("flags a selected Environment the service no longer resolves", async () => {
    const fixture = createStatusHttpFixture({
      session: "active",
      device: "active",
      environments: [
        { id: archivedEnvironmentId, label: "legacy", lifecycle: "archived" },
      ],
    });
    const state = await seedStatusState(fixture.pin, { device: "stored" });
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({
          serverProfileId,
          projectId,
          environmentId: archivedEnvironmentId,
        }),
      );
      const result = await run(["status", "--json"], statusRuntime(state));
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: true,
        service: "verified",
        device: "active",
        environmentId: archivedEnvironmentId,
        environmentActive: false,
        nextAction: "run dotrelay env use <environment-id>",
      });
      expect(body).not.toHaveProperty("environment");
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });

  test("without a stored session skips the service and offers login", async () => {
    const pin: ServerProfilePin = Object.freeze({
      origin: "https://relay.example",
      serverProfileId,
    });
    const state = await seedStatusState(pin, {
      session: "none",
      device: "none",
    });
    try {
      const result = await run(["status", "--json"], {
        ...statusRuntime(state),
        fetch: async () => {
          throw new Error(
            "status must not contact the service without a session",
          );
        },
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        service: "skipped",
        session: "not-stored",
        device: "not-enrolled",
        nextAction: "run dotrelay login",
      });
    } finally {
      await state.cleanup();
    }
  });

  test("with no Server Profile offers setup", async () => {
    const profilePath = `${import.meta.dir}/.tmp-status-profile-${crypto.randomUUID()}`;
    try {
      await Bun.write(
        profilePath,
        JSON.stringify({ version: 1, profiles: [] }),
      );
      const result = await run(["status", "--json"], {
        profilePath,
        credentials: {
          get: async () => null,
          set: async () => undefined,
          delete: async () => undefined,
        },
        fetch: async () => {
          throw new Error(
            "status must not contact the service without a profile",
          );
        },
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: null,
        origin: null,
        service: "skipped",
        session: "not-stored",
        device: "not-enrolled",
        nextAction: "run dotrelay setup <origin>",
      });
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
    }
  });

  test("reports a service that answered but could not be read as unavailable", async () => {
    const pin: ServerProfilePin = Object.freeze({
      origin: "https://relay.example",
      serverProfileId,
    });
    const state = await seedStatusState(pin, { device: "stored" });
    const fetchUnreadableBoundary: FetchFunction = async (input) => {
      if (String(input).endsWith("/api/v1/session"))
        return Response.json({
          authenticated: true,
          user: { id: protocolUserId, name: "Sam" },
        });
      return new Response(JSON.stringify({ detail: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const result = await run(["status"], {
        ...statusRuntime(state),
        fetch: fetchUnreadableBoundary,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Signed in (verified)");
      expect(result.stdout).toContain(
        "The Server Profile could not complete the Device check",
      );
      expect(result.stdout).toContain("Next: retry dotrelay status");
      const json = await run(["status", "--json"], {
        ...statusRuntime(state),
        fetch: fetchUnreadableBoundary,
      });
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: true,
        service: "unavailable",
        session: "verified",
        device: "unverified",
        nextAction: "retry dotrelay status",
      });
    } finally {
      await state.cleanup();
    }
  });

  test("keeps a verified session while the Device check stays offline", async () => {
    const pin: ServerProfilePin = Object.freeze({
      origin: "https://relay.example",
      serverProfileId,
    });
    const state = await seedStatusState(pin, { device: "stored" });
    const fetchBoundaryOffline: FetchFunction = async (input) => {
      if (String(input).endsWith("/api/v1/session"))
        return Response.json({
          authenticated: true,
          user: { id: protocolUserId, name: "Sam" },
        });
      throw new TypeError("fetch failed");
    };
    try {
      const result = await run(["status"], {
        ...statusRuntime(state),
        fetch: fetchBoundaryOffline,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Signed in (verified)");
      expect(result.stdout).toContain(
        "Offline: the Device check could not be completed",
      );
      expect(result.stdout).toContain("Device (last known; not verified)");
      expect(result.stdout).toContain(
        "Next: retry when the Server Profile is reachable",
      );
      const json = await run(["status", "--json"], {
        ...statusRuntime(state),
        fetch: fetchBoundaryOffline,
      });
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: true,
        service: "offline",
        session: "verified",
        device: "unverified",
        nextAction: "retry when the Server Profile is reachable",
      });
    } finally {
      await state.cleanup();
    }
  });

  test("marks a stored Environment the service cannot resolve as not verified", async () => {
    const fixture = createStatusHttpFixture({
      session: "active",
      device: "active",
      environments: [],
    });
    const state = await seedStatusState(fixture.pin, { device: "stored" });
    try {
      await Bun.write(
        state.contextPath,
        JSON.stringify({
          serverProfileId,
          projectId,
          environmentId: "legacy-env",
        }),
      );
      const result = await run(["status", "--json"], statusRuntime(state));
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: true,
        service: "verified",
        session: "verified",
        device: "active",
        projectId,
        environmentId: "legacy-env",
        environmentUnverified: true,
        nextAction: "none",
      });
      expect(body).not.toHaveProperty("environment");
      expect(body).not.toHaveProperty("environmentActive");
      const boundaryProbe = fixture.requests.find((request) =>
        request.path.startsWith("/api/v1/workspace/boundary"),
      );
      expect(boundaryProbe?.path).toBe("/api/v1/workspace/boundary");
      const card = await run(["status"], statusRuntime(state));
      expect(card.stdout).toContain("Environment legacy-env (not verified)");
    } finally {
      fixture.stop();
      await state.cleanup();
    }
  });
});
