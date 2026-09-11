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

  test("reports authentication from the selected profile session", async () => {
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
      const result = await run(["status", "--json"], {
        profilePath,
        credentials: {
          get: async () => new TextEncoder().encode("session-token"),
          set: async () => undefined,
          delete: async () => undefined,
        },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: "relay",
        authenticated: true,
      });
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
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: "other",
        origin: "https://other.example",
        authenticated: true,
      });
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

const loginOrigin = "https://relay.example";
const loginProfileId = "00000000-0000-4000-8000-000000000042";
const loginUserId = "22222222-2222-4222-8222-222222222222";
const loginDeviceId = "33333333-3333-4333-8333-333333333333";

const createLoginFixture = async (
  options: Readonly<{
    readonly token?: (poll: number) => Response;
    readonly emptyCatalog?: boolean;
  }> = {},
): Promise<
  Readonly<{
    readonly profilePath: string;
    readonly credentials: NativeCredentialStore;
    readonly fetch: FetchFunction;
    readonly cleanup: () => Promise<void>;
  }>
> => {
  const profilePath = `${import.meta.dir}/.tmp-login-profile-${crypto.randomUUID()}`;
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
    get: async (_service, account) => secrets.get(account) ?? null,
    set: async (_service, account, secret) => {
      secrets.set(account, secret);
    },
    delete: async (_service, account) => {
      secrets.delete(account);
    },
  });
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
    if (url.pathname === "/api/v1/workspace/boundary")
      return Response.json({
        environment: { headRevision: "empty-environment" },
        session: { active: true, userId: loginUserId },
        device: { active: true, id: loginDeviceId },
      });
    return Response.json({ detail: "unhandled" }, { status: 404 });
  };
  return {
    profilePath,
    credentials,
    fetch,
    cleanup: async () => {
      await rm(profilePath).catch(() => undefined);
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
        profilePath: fixture.profilePath,
        credentials: fixture.credentials,
        fetch: fixture.fetch,
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
      expect(result.stdout).toContain("Signed in. Device already enrolled.");
    } finally {
      await fixture.cleanup();
    }
  });

  test("JSON login emits the authorization event and a browser_open_failed diagnostic", async () => {
    const fixture = await createLoginFixture();
    const captured = captureTerminal();
    try {
      const result = await run(["login", "--profile", "relay", "--json"], {
        profilePath: fixture.profilePath,
        credentials: fixture.credentials,
        fetch: fixture.fetch,
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
        profilePath: fixture.profilePath,
        credentials: fixture.credentials,
        fetch: fixture.fetch,
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
          profilePath: fixture.profilePath,
          credentials: fixture.credentials,
          fetch: fixture.fetch,
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
        profilePath: fixture.profilePath,
        credentials: fixture.credentials,
        fetch: fixture.fetch,
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
          profilePath: fixture.profilePath,
          credentials: fixture.credentials,
          fetch: fixture.fetch,
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
