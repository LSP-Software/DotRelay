import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProblem,
  DEVICE_ID_HEADER,
  type ProblemCode,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import type { NativeCredentialStore } from "./credentials";
import { deviceMetadataPath, writeDeviceId } from "./device-storage";
import { main, renderHelp, run, version } from "./index";

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
