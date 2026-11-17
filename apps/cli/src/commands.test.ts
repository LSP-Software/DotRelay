import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  accountFingerprint,
  createAccountDeviceRoster,
  createCliDeviceStorage,
  createDeviceBootstrap,
  createMemoryDeviceRecordStore,
  deriveAccountSigningKey,
  loadDeviceKeyMaterial,
} from "@dotrelay/client";
import {
  createProblem,
  encodeSyncPage,
  PROTOCOL_MEDIA_TYPE,
  type ProblemCode,
  type ServerProfilePin,
  accountDeletionCommand,
  uuidToBytes,
} from "@dotrelay/contracts";
import type { StrictJsonClient } from "./admin";
import { createSessionStore } from "./auth";
import type { CredentialStore } from "./credentials";
import { answerDeviceProofRoute } from "./device-proof-testing";
import { serializeDotenv } from "./dotenv";
import { deviceMetadataPath, writeDeviceId } from "./device-storage";
import { type CliRuntime, run } from "./index";
import type { NetworkPolicy } from "./network";
import { CliError } from "./errors";
import { childEnvironment, formatEntries } from "./workflow-values";

// Command-level tests for the onboarding and everyday commands: logout,
// env list/create, team list, team share-keys, device list, run, export,
// list, init with a new label, and the pending-Membership diagnosis.

const serverProfileId = "00000000-0000-4000-8000-000000000042";
const teamId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const defaultEnvironmentId = "00000000-0000-4000-8000-0000000000a1";
const productionEnvironmentId = "00000000-0000-4000-8000-0000000000a2";
const deviceId = "00000000-0000-4000-8000-000000000004";
const peerDeviceId = "00000000-0000-4000-8000-000000000005";
const userId = "22222222-2222-4222-8222-222222222222";
const memberUserId = "33333333-3333-4333-8333-333333333333";
const membershipId = "44444444-4444-4444-8444-444444444444";
const memberDeviceId = "55555555-5555-4555-8555-555555555555";
const repositoryId = "1311418611";

const fastPolicy: NetworkPolicy = {
  requestDeadlineMs: 2000,
  maxAttempts: 1,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 1,
  sleep: async () => undefined,
  now: () => Date.now(),
};

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

type Recorded = Readonly<{ method: string; path: string; body: string }>;

type Route = (
  request: Request,
  url: URL,
) => Response | Promise<Response> | undefined;

const emptySyncPage = (environmentId: string): Response =>
  new Response(
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

const boundaryFor = (environmentId: string | null) => ({
  environment: {
    id: environmentId,
    projectId,
    teamId,
    headRevision: environmentId ?? "none",
    headHash: null,
    projectEpoch: "1",
  },
  session: { active: true, userId },
  device: { active: true, id: deviceId },
  grantsReady: true,
  epochCurrent: true,
  rotationRequired: false,
  crypto: { available: true },
});

// A Server Profile that answers the routes each test supplies first, then
// the repository resolution, boundary, and empty sync every protected
// command needs.
const startServer = (
  routes: readonly Route[],
  options: Readonly<{
    /** False when the Server Profile has revoked this machine's Device. */
    readonly deviceActive?: boolean;
  }> = {},
): Readonly<{
  origin: string;
  pin: ServerProfilePin;
  requests: Recorded[];
  stop: () => void;
}> => {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const proof = await answerDeviceProofRoute(
        request,
        options.deviceActive === false ? { isActive: () => false } : {},
      );
      if (proof) return proof;
      const url = new URL(request.url);
      const body = request.method === "GET" ? "" : await request.clone().text();
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body,
      });
      for (const route of routes) {
        const response = await route(request, url);
        if (response) return response;
      }
      if (url.pathname === "/api/v1/github-repositories/resolve")
        return jsonResponse({
          host: "github.com",
          owner: "LSP-Software",
          name: "DotRelay",
          githubRepositoryId: repositoryId,
        });
      if (url.pathname === "/api/v1/session")
        return jsonResponse({ authenticated: true, user: { id: userId } });
      if (url.pathname === "/api/v1/teams" && request.method === "GET")
        return jsonResponse({ teams: [{ id: teamId, name: "Platform" }] });
      if (url.pathname === "/api/v1/workspace/boundary")
        return jsonResponse(boundaryFor(url.searchParams.get("environment")));
      const sync = /\/api\/v1\/environments\/([^/]+)\/sync$/u.exec(
        url.pathname,
      );
      if (sync?.[1] && request.method === "POST") return emptySyncPage(sync[1]);
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

const linkedProjectRoutes: Route[] = [
  (request, url) =>
    request.method === "GET" && url.pathname === "/api/v1/projects"
      ? jsonResponse({
          project: {
            id: projectId,
            teamId,
            githubRepositoryId: repositoryId,
            lifecycle: "active",
          },
        })
      : undefined,
  (request, url) =>
    request.method === "GET" &&
    url.pathname === `/api/v1/projects/${projectId}/environments`
      ? jsonResponse({
          environments: [
            {
              id: productionEnvironmentId,
              projectId,
              label: "production",
              lifecycle: "active",
              currentHeadId: null,
            },
          ],
        })
      : undefined,
];

const memoryCredentials = (): CredentialStore => {
  const secrets = new Map<string, Uint8Array>();
  return Object.freeze({
    get: async (service, account) => {
      const value = secrets.get(`${service}\0${account}`);
      return value ? new Uint8Array(value) : null;
    },
    set: async (service, account, secret) => {
      secrets.set(`${service}\0${account}`, new Uint8Array(secret));
    },
    delete: async (service, account) => {
      secrets.delete(`${service}\0${account}`);
    },
  });
};

type State = Readonly<{
  stateDirectory: string;
  runtime: CliRuntime;
  credentials: CredentialStore;
  cleanup: () => Promise<void>;
}>;

const seedState = async (
  pin: ServerProfilePin,
  options: Readonly<{
    readonly context?: Record<string, unknown>;
    readonly session?: boolean;
  }> = {},
): Promise<State> => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "dotrelay-commands-"));
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
          pin: { origin: pin.origin, serverProfileId: pin.serverProfileId },
        },
      ],
    }),
  );
  if (options.context)
    await Bun.write(contextPath, JSON.stringify(options.context));
  await writeDeviceId(deviceMetadataPath(stateDirectory, pin), pin, deviceId);
  const credentials = memoryCredentials();
  if (options.session !== false)
    await createSessionStore(credentials).save(pin, "session-token");
  const bootstrap = await createDeviceBootstrap({ pin, userId, deviceId });
  const deviceStorage = createCliDeviceStorage(pin, credentials, {
    recordStore: createMemoryDeviceRecordStore(),
  });
  await deviceStorage.save(bootstrap.bundle);
  return {
    stateDirectory,
    credentials,
    runtime: {
      profilePath,
      stateDirectory,
      worktreeConfig: contextPath,
      credentials,
      deviceStorage,
      networkPolicy: fastPolicy,
      readGitRemotes: async () => [
        { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
      ],
    },
    cleanup: async () =>
      rm(stateDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      ),
  };
};

const linkedContext = {
  serverProfileId,
  projectId,
  environmentId: productionEnvironmentId,
};

describe("logout revokes the session on the server", () => {
  test("revokes the bearer session and removes the local copy", async () => {
    const server = startServer([
      (request, url) =>
        request.method === "POST" && url.pathname === "/api/auth/sign-out"
          ? request.headers.get("Authorization") === "Bearer session-token"
            ? jsonResponse({ success: true })
            : problemResponse("authentication_required")
          : undefined,
    ]);
    const state = await seedState(server.pin);
    try {
      const result = await run(["logout", "--json"], state.runtime);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        loggedOut: true,
        serverSession: "revoked",
      });
      expect(
        server.requests.some(
          (request) => request.path === "/api/auth/sign-out",
        ),
      ).toBe(true);
      expect(await createSessionStore(state.credentials).get(server.pin)).toBe(
        null,
      );
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("still removes the local session when the server is unreachable", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin);
    try {
      const result = await run(["logout"], {
        ...state.runtime,
        fetch: async () => {
          throw new TypeError("connect ECONNREFUSED");
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "Removed the session for relay from this machine.",
      );
      expect(result.stdout).toContain("wasn't revoked there");
      expect(await createSessionStore(state.credentials).get(pin)).toBe(null);
    } finally {
      await state.cleanup();
    }
  });

  test("says so when no session was stored", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin, { session: false });
    try {
      const result = await run(["logout", "--json"], {
        ...state.runtime,
        fetch: async () => {
          throw new Error("logout without a session must not call the server");
        },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        serverSession: "none",
      });
    } finally {
      await state.cleanup();
    }
  });
});

const environmentRecord = (
  id: string,
  label: string,
  lifecycle: "active" | "archived" = "active",
  currentHeadId: string | null = null,
) => ({
  id,
  projectId,
  label,
  lifecycle,
  currentHeadId,
  currentHeadHash: null,
});

describe("env list and env create", () => {
  test("env list marks the selected Environment", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin, { context: linkedContext });
    const admin: StrictJsonClient = {
      get: async () => ({
        environments: [
          environmentRecord(defaultEnvironmentId, "default", "archived"),
          environmentRecord(productionEnvironmentId, "production"),
        ],
      }),
      post: async () => {
        throw new Error("env list must not write");
      },
    };
    try {
      const human = await run(["env", "list"], { ...state.runtime, admin });
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("production");
      expect(human.stdout).toContain("selected");
      expect(human.stdout).toContain("archived");
      const result = await run(["env", "list", "--json"], {
        ...state.runtime,
        admin,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        projectId,
        environments: [
          { label: "default", lifecycle: "archived", selected: false },
          { label: "production", lifecycle: "active", selected: true },
        ],
      });
    } finally {
      await state.cleanup();
    }
  });

  test("env create sends the label and does not change the selection", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin, { context: linkedContext });
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const admin: StrictJsonClient = {
      get: async () => ({
        environments: [
          environmentRecord(productionEnvironmentId, "production"),
        ],
      }),
      post: async (path, body) => {
        posts.push({ path, body });
        return environmentRecord(defaultEnvironmentId, "staging");
      },
    };
    try {
      const result = await run(["env", "create", "staging", "--json"], {
        ...state.runtime,
        admin,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        created: true,
        environment: "staging",
      });
      expect(posts).toEqual([
        {
          path: `/api/v1/projects/${projectId}/environments`,
          body: { label: "staging" },
        },
      ]);
      expect(
        JSON.parse(await Bun.file(String(state.runtime.worktreeConfig)).text()),
      ).toEqual(linkedContext);
      const existing = await run(["env", "create", "production", "--json"], {
        ...state.runtime,
        admin,
      });
      expect(JSON.parse(existing.stdout)).toMatchObject({ created: false });
      expect(posts).toHaveLength(1);
    } finally {
      await state.cleanup();
    }
  });

  test("env commands without a linked Project say how to link one", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin);
    try {
      const result = await run(["env", "list"], state.runtime);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "This repository isn't linked to a project yet",
      );
    } finally {
      await state.cleanup();
    }
  });
});

describe("team list and device list", () => {
  test("team list shows Team ids and pending access", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin);
    const admin: StrictJsonClient = {
      get: async (path) =>
        path === "/api/v1/teams"
          ? { teams: [{ id: teamId, name: "Platform" }] }
          : {
              invitations: [],
              pendingMemberships: [
                {
                  teamId: "00000000-0000-4000-8000-000000000009",
                  teamName: "Payments",
                },
              ],
            },
      post: async () => ({}),
    };
    try {
      const human = await run(["team", "list"], { ...state.runtime, admin });
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("Platform");
      expect(human.stdout).toContain(teamId);
      expect(human.stdout).toContain("Share project keys");
      expect(human.stdout).toContain("Payments");
      const result = await run(["team", "list", "--json"], {
        ...state.runtime,
        admin,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        teams: [{ id: teamId, name: "Platform" }],
        pendingMemberships: [{ name: "Payments" }],
      });
    } finally {
      await state.cleanup();
    }
  });

  test("device list shows this Device and the account's others", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin);
    const admin: StrictJsonClient = {
      get: async () => ({
        ...boundaryFor(null),
        device: { active: true, id: deviceId, name: "laptop" },
        peerDevices: [
          {
            id: peerDeviceId,
            encryptionPublicKey: "00".repeat(32),
            signingPublicKey: "00".repeat(32),
            hasEpochGrant: false,
            name: "desktop",
          },
        ],
      }),
      post: async () => ({}),
    };
    try {
      const result = await run(["device", "list", "--json"], {
        ...state.runtime,
        admin,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        devices: [
          { id: deviceId, name: "laptop", current: true },
          { id: peerDeviceId, name: "desktop", current: false },
        ],
      });
    } finally {
      await state.cleanup();
    }
  });
});

describe("run, export, and list read the Environment without writing", () => {
  test("run starts the command and returns its exit code", async () => {
    const server = startServer(linkedProjectRoutes);
    const state = await seedState(server.pin, { context: linkedContext });
    const started: Array<{ argv: readonly string[]; path?: string }> = [];
    try {
      const result = await run(
        [
          "run",
          "--profile",
          "relay",
          "--environment",
          "production",
          "--",
          "node",
          "--version",
        ],
        {
          ...state.runtime,
          spawn: async (argv, environment) => {
            started.push({
              argv,
              ...(environment.PATH !== undefined
                ? { path: environment.PATH }
                : {}),
            });
            return 3;
          },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("");
      expect(started).toEqual([
        {
          argv: ["node", "--version"],
          ...(process.env.PATH !== undefined ? { path: process.env.PATH } : {}),
        },
      ]);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("export prints the Values and list prints names only", async () => {
    const server = startServer(linkedProjectRoutes);
    const state = await seedState(server.pin, { context: linkedContext });
    try {
      const exported = await run(
        ["export", "--format", "json", "--profile", "relay"],
        state.runtime,
      );
      expect(exported.exitCode).toBe(0);
      expect(exported.stdout).toBe("{}\n");
      const refused = await run(["export", "--profile", "relay"], {
        ...state.runtime,
        stdoutIsTerminal: true,
      });
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain("--reveal");
      const listed = await run(["list", "--profile", "relay"], state.runtime);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain("This environment has no variables yet");
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("the shell export refuses process-control Variables unless allowed", () => {
    const entries = [
      { name: "API_URL", value: "https://x.example" },
      { name: "NODE_OPTIONS", value: "--require ./x.js" },
    ];
    expect(() => formatEntries(entries, "shell")).toThrow(
      "--allow-env NODE_OPTIONS",
    );
    expect(formatEntries(entries, "shell", ["NODE_OPTIONS"])).toContain(
      "export NODE_OPTIONS='--require ./x.js'\n",
    );
    // dotenv and JSON are data formats that nothing evaluates.
    expect(formatEntries(entries, "dotenv")).toContain("NODE_OPTIONS=");
    expect(formatEntries(entries, "json")).toContain("NODE_OPTIONS");
  });

  test("run refuses process-control Variables unless each is allowed", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/me" };
    const entries = [
      { name: "API_URL", value: "https://x.example" },
      { name: "PATH", value: "/tmp/evil" },
      { name: "LD_PRELOAD", value: "/tmp/evil.so" },
    ];
    let refused: unknown;
    try {
      childEnvironment(base, entries, []);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(CliError);
    expect((refused as CliError).message).toContain("PATH, LD_PRELOAD");
    expect((refused as CliError).message).toContain(
      "--allow-env PATH --allow-env LD_PRELOAD",
    );
    expect(() => childEnvironment(base, entries, ["PATH"])).toThrow(
      "--allow-env LD_PRELOAD",
    );
    expect(childEnvironment(base, entries, ["path", "LD_PRELOAD"])).toEqual({
      PATH: "/tmp/evil",
      HOME: "/home/me",
      API_URL: "https://x.example",
      LD_PRELOAD: "/tmp/evil.so",
    });
    // The shell's own environment is never filtered; only Environment Values.
    expect(childEnvironment(base, entries.slice(0, 1), [])).toEqual({
      ...base,
      API_URL: "https://x.example",
    });
  });

  test("refuses toolchain and launcher hooks a Member could set", () => {
    // Each runs code, or loads configuration that does, in a teammate's
    // build or tool: go -toolexec through GOFLAGS, a compiler wrapper, a
    // browser opener, or a configuration directory.
    const hooks = [
      { name: "GOFLAGS", value: "-toolexec=/tmp/evil" },
      { name: "CC", value: "/tmp/evil-cc" },
      { name: "CXX", value: "/tmp/evil-cxx" },
      { name: "CGO_LDFLAGS", value: "-Wl,--wrap=main" },
      { name: "BROWSER", value: "/tmp/evil-open" },
      { name: "RUSTC_WRAPPER", value: "/tmp/evil-rustc" },
      { name: "XDG_CONFIG_HOME", value: "/tmp/evil-config" },
    ];
    for (const hook of hooks) {
      expect(() =>
        childEnvironment({}, [{ name: "API_URL", value: "x" }, hook], []),
      ).toThrow(`--allow-env ${hook.name}`);
      expect(childEnvironment({}, [hook], [hook.name.toLowerCase()])).toEqual({
        [hook.name]: hook.value,
      });
    }
    expect(
      childEnvironment({}, [{ name: "NODE_ENV", value: "production" }], []),
    ).toEqual({ NODE_ENV: "production" });
  });

  test("formats dotenv, JSON, and shell exports", () => {
    const entries = [
      { name: "API_URL", value: "https://x.example" },
      { name: "QUOTE", value: "it's $HOME" },
    ];
    expect(formatEntries(entries, "dotenv")).toBe(serializeDotenv(entries));
    expect(JSON.parse(formatEntries(entries, "json"))).toEqual({
      API_URL: "https://x.example",
      QUOTE: "it's $HOME",
    });
    expect(formatEntries(entries, "shell")).toBe(
      "export API_URL='https://x.example'\nexport QUOTE='it'\\''s $HOME'\n",
    );
  });
});

describe("Project discovery explains pending access", () => {
  test("a Member waiting for keys is told who has to share them", async () => {
    const server = startServer([
      (request, url) =>
        request.method === "GET" && url.pathname === "/api/v1/projects"
          ? jsonResponse({ project: null, projects: [] })
          : undefined,
      (request, url) =>
        request.method === "GET" && url.pathname === "/api/v1/invitations"
          ? jsonResponse({
              invitations: [],
              pendingMemberships: [{ teamId, teamName: "Platform" }],
            })
          : undefined,
    ]);
    const state = await seedState(server.pin);
    try {
      for (const command of ["pull", "push"]) {
        const result = await run(
          [command, "--profile", "relay", "--json"],
          state.runtime,
        );
        const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
        expect(diagnostic).toMatchObject({
          code: "membership_pending",
          category: "authentication",
        });
        expect(String(diagnostic.detail)).toContain("You joined Platform");
        expect(String(diagnostic.detail)).toContain("Share project keys");
      }
      // Nothing was created on the Member's behalf.
      expect(
        server.requests.some(
          (request) =>
            request.method === "POST" &&
            (request.path === "/api/v1/projects" ||
              request.path === "/api/v1/teams"),
        ),
      ).toBe(false);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });
});

describe("init with a label on a new Project", () => {
  test("creates the named Environment and archives the empty default", async () => {
    const server = startServer([
      (request, url) =>
        request.method === "GET" && url.pathname === "/api/v1/projects"
          ? jsonResponse({ project: null, projects: [] })
          : undefined,
      (request, url) =>
        request.method === "GET" && url.pathname === "/api/v1/invitations"
          ? jsonResponse({ invitations: [], pendingMemberships: [] })
          : undefined,
      (request, url) =>
        request.method === "POST" && url.pathname === "/api/v1/projects"
          ? jsonResponse(
              {
                id: projectId,
                teamId,
                githubRepositoryId: repositoryId,
                lifecycle: "active",
                environment: environmentRecord(defaultEnvironmentId, "default"),
              },
              201,
            )
          : undefined,
      (request, url) =>
        request.method === "GET" &&
        url.pathname === `/api/v1/projects/${projectId}/environments`
          ? jsonResponse({
              environments: [
                environmentRecord(defaultEnvironmentId, "default"),
              ],
            })
          : undefined,
      (request, url) =>
        request.method === "POST" &&
        url.pathname === `/api/v1/projects/${projectId}/environments`
          ? jsonResponse(
              environmentRecord(productionEnvironmentId, "production"),
              201,
            )
          : undefined,
      (request, url) =>
        request.method === "POST" &&
        url.pathname ===
          `/api/v1/environments/${defaultEnvironmentId}/lifecycle`
          ? jsonResponse(
              environmentRecord(defaultEnvironmentId, "default", "archived"),
            )
          : undefined,
      // Stop the workflow once the Environment is resolved: this test is
      // about which Environment init publishes into.
      (_request, url) =>
        url.pathname === "/api/v1/workspace/boundary"
          ? problemResponse("service_unavailable")
          : undefined,
    ]);
    const state = await seedState(server.pin);
    try {
      const dotenv = join(state.stateDirectory, ".env");
      await Bun.write(dotenv, "API_URL=https://x.example\n");
      const result = await run(
        [
          "init",
          "production",
          "--from",
          dotenv,
          "--classify",
          "API_URL=shared",
          "--profile",
          "relay",
          "--json",
        ],
        state.runtime,
      );
      // The stubbed boundary stops the workflow after resolution.
      expect(result.exitCode).not.toBe(0);
      const created = server.requests.find(
        (request) =>
          request.method === "POST" &&
          request.path === `/api/v1/projects/${projectId}/environments`,
      );
      expect(JSON.parse(created?.body ?? "{}")).toEqual({
        label: "production",
      });
      const archived = server.requests.find(
        (request) =>
          request.path ===
          `/api/v1/environments/${defaultEnvironmentId}/lifecycle`,
      );
      expect(JSON.parse(archived?.body ?? "{}")).toEqual({ action: "archive" });
      expect(
        server.requests.some(
          (request) =>
            request.path ===
            `/api/v1/workspace/boundary?environment=${productionEnvironmentId}`,
        ),
      ).toBe(true);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });
});

describe("team share-keys", () => {
  test("seals the activation for the Member's roster Devices", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin);
    const memberKey = (await crypto.subtle.generateKey(
      { name: "X25519" },
      true,
      ["deriveBits"],
    )) as unknown as CryptoKeyPair;
    const memberPublic = Buffer.from(
      await crypto.subtle.exportKey("raw", memberKey.publicKey),
    ).toString("hex");
    // The Member's own account key signed the roster listing that Device
    // (ADR 0015); keys go only to the Devices it lists.
    const memberAccountKey = crypto.getRandomValues(new Uint8Array(32));
    const memberRoster = Buffer.from(
      (
        await createAccountDeviceRoster({
          serverProfileId,
          userId: memberUserId,
          version: 1,
          devices: [
            {
              deviceId: memberDeviceId,
              encryptionPublicKey: new Uint8Array(
                Buffer.from(memberPublic, "hex"),
              ),
              signingPublicKey: crypto.getRandomValues(new Uint8Array(32)),
              addedAtMs: 0,
            },
          ],
          signingKey: await deriveAccountSigningKey(memberAccountKey, {
            serverProfileId,
            userId: memberUserId,
          }),
        })
      ).canonicalBytes,
    ).toString("base64");
    let servedRoster: string | null = memberRoster;
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const admin: StrictJsonClient = {
      get: async (path) => {
        if (path === "/api/v1/teams")
          return { teams: [{ id: teamId, name: "Platform" }] };
        if (path === `/api/v1/teams/${teamId}/memberships`)
          return {
            memberships: [
              {
                membershipId,
                userId: memberUserId,
                name: "Octo Cat",
                githubSubject: "583231",
                lifecycle: "PENDING_KEY_GRANT",
                role: "MEMBER",
              },
            ],
            invitations: [],
          };
        if (path.endsWith("/provision"))
          return {
            teamId,
            membershipId,
            userId: memberUserId,
            role: "MEMBER",
            projects: [],
            devices: [
              { id: memberDeviceId, encryptionPublicKey: memberPublic },
            ],
            accountRoster: servedRoster,
          };
        if (path === "/api/v1/workspace/boundary") return boundaryFor(null);
        throw new Error(`unexpected GET ${path}`);
      },
      post: async (path, body) => {
        posts.push({ path, body });
        if (path === "/api/v1/github-users/resolve")
          return { login: "octocat", githubUserId: "583231" };
        return { membershipId, lifecycle: "ACTIVE" };
      },
    };
    const shareKeys = (...flags: string[]) =>
      run(
        [
          "team",
          "share-keys",
          "octocat",
          "--profile",
          "relay",
          "--no-input",
          "--force",
          "--json",
          ...flags,
        ],
        { ...state.runtime, admin },
      );
    const memberFingerprint = await accountFingerprint(
      (
        await deriveAccountSigningKey(memberAccountKey, {
          serverProfileId,
          userId: memberUserId,
        })
      ).identity,
    );
    try {
      // Sharing confirms the Member's first-sight identity, so without a
      // terminal it needs the fingerprint the user compared: --force alone
      // is refused, and a different fingerprint is refused.
      const unconfirmed = await shareKeys();
      expect(unconfirmed.exitCode).not.toBe(0);
      expect(JSON.parse(unconfirmed.stderr)).toMatchObject({
        code: "account_fingerprint_required",
      });
      const mismatched = await shareKeys("--fingerprint", "f".repeat(40));
      expect(JSON.parse(mismatched.stderr)).toMatchObject({
        code: "account_fingerprint_mismatch",
      });
      expect(posts.some((post) => post.path.endsWith("/provision"))).toBe(
        false,
      );
      const result = await shareKeys("--fingerprint", memberFingerprint);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        userId: memberUserId,
        lifecycle: "ACTIVE",
        deviceCount: 1,
      });
      const activation = posts.find((post) => post.path.endsWith("/provision"));
      expect(activation?.path).toBe(
        `/api/v1/teams/${teamId}/memberships/${membershipId}/provision`,
      );
      expect(activation?.body).toMatchObject({ grants: [] });
      expect(typeof activation?.body.operationId).toBe("string");
      // Without a signed roster for the Member there is nothing to seal to.
      servedRoster = null;
      posts.length = 0;
      const refused = await shareKeys("--fingerprint", memberFingerprint);
      expect(refused.exitCode).not.toBe(0);
      expect(JSON.parse(refused.stderr)).toMatchObject({
        code: "trust_failed",
      });
      expect(posts.some((post) => post.path.endsWith("/provision"))).toBe(
        false,
      );
    } finally {
      await state.cleanup();
    }
  });

  test("refuses a name that is not a Member and requires --force without input", async () => {
    const pin = { origin: "https://relay.invalid", serverProfileId };
    const state = await seedState(pin);
    const admin: StrictJsonClient = {
      get: async (path) =>
        path === "/api/v1/teams"
          ? { teams: [{ id: teamId, name: "Platform" }] }
          : { memberships: [], invitations: [] },
      post: async () => ({ login: "someone", githubUserId: "1" }),
    };
    try {
      const missing = await run(
        ["team", "share-keys", "someone", "--profile", "relay"],
        { ...state.runtime, admin },
      );
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain(
        '"someone" isn\'t a member of this team',
      );
    } finally {
      await state.cleanup();
    }
  });
});

describe("status names the repository", () => {
  test("adds the linked repository and a hint for an unlinked worktree", async () => {
    const server = startServer([]);
    const linked = await seedState(server.pin, {
      context: {
        ...linkedContext,
        repositoryRemote: "origin",
        repositoryOwner: "LSP-Software",
        repositoryName: "DotRelay",
        repositoryIdentity: repositoryId,
      },
    });
    // No context file yet: a worktree this machine has not linked.
    const unlinked = await seedState(server.pin);
    try {
      const withRepository = await run(["status", "--json"], linked.runtime);
      expect(JSON.parse(withRepository.stdout)).toMatchObject({
        repository: "github.com/LSP-Software/DotRelay",
      });
      const human = await run(["status"], linked.runtime);
      expect(human.stdout).toContain("github.com/LSP-Software/DotRelay");
      const hinted = await run(["status", "--json"], unlinked.runtime);
      expect(JSON.parse(hinted.stdout)).toMatchObject({
        nextAction: "none",
        hint: expect.stringContaining("dotrelay init"),
      });
      const linkedBody = JSON.parse(withRepository.stdout) as Record<
        string,
        unknown
      >;
      expect(linkedBody.hint).toBeUndefined();
    } finally {
      server.stop();
      await linked.cleanup();
      await unlinked.cleanup();
    }
  });
});

describe("team decline", () => {
  const paymentsTeamId = "00000000-0000-4000-8000-000000000009";
  const invitationId = "99999999-9999-4999-8999-999999999999";
  const invitationRoutes = (
    decline: (id: string) => Response = (id) =>
      jsonResponse({ invitationId: id, status: "DECLINED" }, 201),
    invitations: readonly Record<string, unknown>[] = [
      {
        invitationId,
        teamId: paymentsTeamId,
        teamName: "Payments",
        providerSubject: "1",
        createdAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-11-15T00:00:00.000Z",
      },
    ],
  ): Route[] => [
    (request, url) =>
      request.method === "GET" && url.pathname === "/api/v1/invitations"
        ? jsonResponse({ invitations, pendingMemberships: [] })
        : undefined,
    (request, url) => {
      const match = /^\/api\/v1\/invitations\/([^/]+)\/decline$/u.exec(
        url.pathname,
      );
      return request.method === "POST" && match?.[1]
        ? decline(match[1])
        : undefined;
    },
  ];
  const declinePosts = (requests: readonly Recorded[]) =>
    requests.filter(
      (request) =>
        request.method === "POST" && request.path.endsWith("/decline"),
    );

  test("declines the invitation named by its Team", async () => {
    const server = startServer(invitationRoutes());
    const state = await seedState(server.pin);
    try {
      const result = await run(
        [
          "team",
          "decline",
          "payments",
          "--profile",
          "relay",
          "--no-input",
          "--force",
          "--json",
        ],
        state.runtime,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        invitationId,
        teamId: paymentsTeamId,
        team: "Payments",
        status: "DECLINED",
      });
      expect(declinePosts(server.requests)).toEqual([
        {
          method: "POST",
          path: `/api/v1/invitations/${invitationId}/decline`,
          body: "{}",
        },
      ]);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("requires --force without input and sends nothing", async () => {
    const server = startServer(invitationRoutes());
    const state = await seedState(server.pin);
    try {
      const result = await run(
        ["team", "decline", invitationId, "--profile", "relay", "--no-input"],
        state.runtime,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--force");
      expect(declinePosts(server.requests)).toHaveLength(0);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("asks before declining interactively", async () => {
    const server = startServer(invitationRoutes());
    const state = await seedState(server.pin);
    const questions: string[] = [];
    try {
      const result = await run(["team", "decline", invitationId], {
        ...state.runtime,
        confirm: async (question) => {
          questions.push(question);
          return false;
        },
      });
      expect(result.exitCode).toBe(2);
      expect(questions).toEqual([
        "Decline the invitation to Payments? A team owner or admin would have to invite you again.",
      ]);
      expect(declinePosts(server.requests)).toHaveLength(0);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("reports an invitation that is no longer pending", async () => {
    const server = startServer(
      invitationRoutes(() => problemResponse("invitation_expired")),
    );
    const state = await seedState(server.pin);
    try {
      const result = await run(
        [
          "team",
          "decline",
          invitationId,
          "--profile",
          "relay",
          "--no-input",
          "--force",
          "--json",
        ],
        state.runtime,
      );
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "invitation_expired",
        detail: expect.stringContaining("can't be declined anymore"),
      });
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("sends an unlisted invitation id and reports one addressed to someone else", async () => {
    const unlisted = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const server = startServer(
      invitationRoutes(() => problemResponse("resource_not_found")),
    );
    const state = await seedState(server.pin);
    try {
      const result = await run(
        [
          "team",
          "decline",
          unlisted,
          "--profile",
          "relay",
          "--no-input",
          "--force",
        ],
        state.runtime,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "You don't have a pending invitation with that id",
      );
      expect(declinePosts(server.requests).map((r) => r.path)).toEqual([
        `/api/v1/invitations/${unlisted}/decline`,
      ]);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("asks for the invitation id when a Team name matches several", async () => {
    const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const server = startServer(
      invitationRoutes(undefined, [
        { invitationId, teamId: paymentsTeamId, teamName: "Payments" },
        { invitationId: second, teamId, teamName: "Payments" },
      ]),
    );
    const state = await seedState(server.pin);
    try {
      const result = await run(
        [
          "team",
          "decline",
          "Payments",
          "--profile",
          "relay",
          "--no-input",
          "--force",
        ],
        state.runtime,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(invitationId);
      expect(result.stderr).toContain(second);
      expect(declinePosts(server.requests)).toHaveLength(0);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("team list shows each invitation's id and how to decline it", async () => {
    const server = startServer(invitationRoutes());
    const state = await seedState(server.pin);
    try {
      const human = await run(["team", "list"], state.runtime);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("Payments");
      expect(human.stdout).toContain(invitationId);
      expect(human.stdout).toContain("dotrelay team decline");
      const result = await run(["team", "list", "--json"], state.runtime);
      expect(JSON.parse(result.stdout)).toMatchObject({
        invitations: [{ id: paymentsTeamId, name: "Payments", invitationId }],
      });
    } finally {
      server.stop();
      await state.cleanup();
    }
  });
});

describe("status reports an owed Project key rotation", () => {
  test("names the removals and the rotate command without changing the next action", async () => {
    const rotationOwed = {
      since: "2026-11-01T09:30:00.000Z",
      sinceEpoch: "1",
      membershipRemovals: 1,
      deviceRevocations: 0,
    };
    const server = startServer([
      (request, url) =>
        url.pathname === "/api/v1/workspace/boundary"
          ? jsonResponse({
              ...boundaryFor(url.searchParams.get("environment")),
              environment: {
                ...boundaryFor(url.searchParams.get("environment")).environment,
                label: "production",
                rotationOwed,
              },
            })
          : undefined,
    ]);
    const state = await seedState(server.pin, { context: linkedContext });
    try {
      const result = await run(["status", "--json"], state.runtime);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        nextAction: "none",
        rotationOwed,
        rotationOwedNotice: expect.stringContaining(
          "1 member removed since 2026-11-01",
        ),
      });
      const human = await run(["status"], state.runtime);
      expect(human.stdout).toContain("dotrelay project rotate");
    } finally {
      server.stop();
      await state.cleanup();
    }
  });
});

describe("team leave and account lifecycle", () => {
  const paymentsTeamId = "00000000-0000-4000-8000-000000000009";
  const lifecycleRoutes = (
    options: Readonly<{
      leave?: () => Response;
      blockingTeams?: readonly Record<string, string>[];
      /** Sees each leave, export and delete request. */
      record?: (request: Request) => void;
    }> = {},
  ): Route[] => [
    (request, url) =>
      request.method === "GET" && url.pathname === "/api/v1/teams"
        ? jsonResponse({
            teams: [{ id: paymentsTeamId, name: "Payments", role: "MEMBER" }],
          })
        : undefined,
    (request, url) =>
      request.method === "POST" &&
      url.pathname === `/api/v1/teams/${paymentsTeamId}/leave`
        ? (options.record?.(request),
          options.leave?.() ??
            jsonResponse(
              { teamId: paymentsTeamId, membershipId, lifecycle: "REMOVED" },
              201,
            ))
        : undefined,
    (request, url) =>
      request.method === "GET" && url.pathname === "/api/v1/account/export"
        ? (options.record?.(request),
          jsonResponse({
            format: "dotrelay-account-export-v1",
            exportedAt: "2026-11-15T00:00:00.000Z",
            serverOrigin: url.origin,
            user: { id: userId },
            profile: null,
            linkedAccounts: [],
            sessions: [],
            memberships: [],
            invitations: [],
            devices: [],
            accountKeyWrappers: [],
            projectsCreated: [],
            revisionsAuthored: { count: 0 },
            auditFacts: [],
          }))
        : undefined,
    (request, url) =>
      request.method === "GET" && url.pathname === "/api/v1/account/deletion"
        ? jsonResponse({
            userId,
            blockingTeams: options.blockingTeams ?? [],
            teamsDeleted: [],
            teamsLeft: [{ teamId: paymentsTeamId, name: "Payments" }],
          })
        : undefined,
    (request, url) =>
      request.method === "POST" && url.pathname === "/api/v1/account/delete"
        ? (options.record?.(request),
          jsonResponse(
            {
              userId,
              status: "DELETED",
              deletedAt: "2026-11-15T00:00:00.000Z",
              teamsDeleted: [],
              teamsLeft: [{ teamId: paymentsTeamId, name: "Payments" }],
            },
            201,
          ))
        : undefined,
  ];
  const proven = (request: Request) =>
    request.headers.get("X-DotRelay-Device-Id") === deviceId &&
    request.headers.has("X-DotRelay-Device-Proof");
  const posts = (requests: readonly Recorded[]) =>
    requests.filter((request) => request.method === "POST");

  test("leaves a Team named by its name", async () => {
    const seen: boolean[] = [];
    const server = startServer(
      lifecycleRoutes({ record: (request) => seen.push(proven(request)) }),
    );
    const state = await seedState(server.pin);
    try {
      const result = await run(
        [
          "team",
          "leave",
          "payments",
          "--profile",
          "relay",
          "--no-input",
          "--force",
          "--json",
        ],
        state.runtime,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        teamId: paymentsTeamId,
        lifecycle: "REMOVED",
      });
      expect(posts(server.requests)).toEqual([
        {
          method: "POST",
          path: `/api/v1/teams/${paymentsTeamId}/leave`,
          body: "{}",
        },
      ]);
      // A session alone may not make the account leave a Team (ADR 0024).
      expect(seen).toEqual([true]);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("leaving requires --force without input, and reports a last owner", async () => {
    const server = startServer(
      lifecycleRoutes({
        leave: () => problemResponse("owner_transfer_required"),
      }),
    );
    const state = await seedState(server.pin);
    try {
      const unforced = await run(
        ["team", "leave", "Payments", "--profile", "relay", "--no-input"],
        state.runtime,
      );
      expect(unforced.exitCode).toBe(2);
      expect(unforced.stderr).toContain("--force");
      expect(posts(server.requests)).toHaveLength(0);
      const owner = await run(
        [
          "team",
          "leave",
          "Payments",
          "--profile",
          "relay",
          "--no-input",
          "--force",
          "--json",
        ],
        state.runtime,
      );
      expect(owner.exitCode).toBe(4);
      expect(JSON.parse(owner.stderr)).toMatchObject({
        code: "owner_transfer_required",
        detail: expect.stringContaining("last active owner"),
      });
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("exports the account to stdout or a protected file", async () => {
    const seen: boolean[] = [];
    const server = startServer(
      lifecycleRoutes({ record: (request) => seen.push(proven(request)) }),
    );
    const state = await seedState(server.pin);
    try {
      const printed = await run(["account", "export"], state.runtime);
      expect(printed.exitCode).toBe(0);
      expect(JSON.parse(printed.stdout)).toMatchObject({
        format: "dotrelay-account-export-v1",
      });
      const output = join(state.stateDirectory, "account.json");
      const written = await run(
        ["account", "export", "--output", output],
        state.runtime,
      );
      expect(written.exitCode).toBe(0);
      expect(await Bun.file(output).json()).toMatchObject({
        user: { id: userId },
      });
      expect(seen).toEqual([true, true]);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("refuses to delete the account of a Team's last owner", async () => {
    const server = startServer(
      lifecycleRoutes({
        blockingTeams: [{ teamId: paymentsTeamId, name: "Payments" }],
      }),
    );
    const state = await seedState(server.pin);
    try {
      const result = await run(
        [
          "account",
          "delete",
          "--profile",
          "relay",
          "--no-input",
          "--force",
          "--json",
        ],
        state.runtime,
      );
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "owner_transfer_required",
        detail: expect.stringContaining("Payments"),
      });
      expect(posts(server.requests)).toHaveLength(0);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("deletes the account after the typed phrase and clears local keys", async () => {
    const seen: Array<
      Readonly<{ proven: boolean; operationId: string | null }>
    > = [];
    const server = startServer(
      lifecycleRoutes({
        record: (request) =>
          seen.push({
            proven: proven(request),
            operationId: request.headers.get("Idempotency-Key"),
          }),
      }),
    );
    const state = await seedState(server.pin);
    const storedKey = (
      await loadDeviceKeyMaterial(
        await state.runtime.deviceStorage!.load({
          pin: server.pin,
          deviceId: uuidToBytes(deviceId),
        }),
      )
    ).signingPublicKey;
    if (!storedKey) throw new Error("Device signing key is missing");
    const signingPublicKey = await crypto.subtle.importKey(
      "raw",
      await crypto.subtle.exportKey("raw", storedKey),
      "Ed25519",
      false,
      ["verify"],
    );
    try {
      const wrong = await run(["account", "delete"], {
        ...state.runtime,
        prompt: async () => "yes",
      });
      expect(wrong.exitCode).toBe(2);
      expect(posts(server.requests)).toHaveLength(0);

      const questions: string[] = [];
      const result = await run(["account", "delete", "--json"], {
        ...state.runtime,
        prompt: async (question) => {
          questions.push(question);
          return "delete my account";
        },
      });
      expect(result.exitCode).toBe(0);
      expect(questions[0]).toContain("You'll leave: Payments.");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        status: "DELETED",
        localDataRemoved: ["session", "device keys"],
      });
      // The proven Device signs the exact deletion command (ADR 0024).
      const [deletion] = posts(server.requests);
      expect(deletion?.path).toBe("/api/v1/account/delete");
      const body = JSON.parse(deletion?.body ?? "{}") as {
        confirmUserId: string;
        signature: string;
      };
      expect(body.confirmUserId).toBe(userId);
      expect(seen).toEqual([{ proven: true, operationId: expect.any(String) }]);
      expect(
        await crypto.subtle.verify(
          "Ed25519",
          signingPublicKey,
          Buffer.from(body.signature, "base64"),
          accountDeletionCommand({
            userId,
            operationId: seen[0]?.operationId ?? "",
          }),
        ),
      ).toBe(true);
      expect(
        await createSessionStore(state.credentials).get(server.pin),
      ).toBeNull();
      expect(
        await Bun.file(
          deviceMetadataPath(state.stateDirectory, server.pin),
        ).exists(),
      ).toBe(false);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("acts on the session alone once this machine's Device is revoked", async () => {
    const seen: boolean[] = [];
    const server = startServer(
      lifecycleRoutes({ record: (request) => seen.push(proven(request)) }),
      { deviceActive: false },
    );
    const state = await seedState(server.pin);
    try {
      const flags = ["--profile", "relay", "--no-input", "--force", "--json"];
      const left = await run(
        ["team", "leave", "payments", ...flags],
        state.runtime,
      );
      expect(left.exitCode).toBe(0);
      const exported = await run(["account", "export"], state.runtime);
      expect(exported.exitCode).toBe(0);
      const deleted = await run(["account", "delete", ...flags], state.runtime);
      expect(deleted.exitCode).toBe(0);
      expect(JSON.parse(deleted.stdout)).toMatchObject({
        status: "DELETED",
        localDataRemoved: ["session", "device keys"],
      });
      // No proof and no signature from a revoked Device; the service
      // decides from the session (ADR 0024).
      expect(seen).toEqual([false, false, false]);
      const deletion = posts(server.requests).find(
        (request) => request.path === "/api/v1/account/delete",
      );
      expect(JSON.parse(deletion?.body ?? "{}")).toEqual({
        confirmUserId: userId,
      });
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("names the active Device when the session alone is not enough", async () => {
    const server = startServer(
      lifecycleRoutes({
        leave: () => problemResponse("device_proof_required"),
      }),
      { deviceActive: false },
    );
    const state = await seedState(server.pin);
    try {
      const result = await run(
        [
          "team",
          "leave",
          "payments",
          "--profile",
          "relay",
          "--no-input",
          "--force",
          "--json",
        ],
        state.runtime,
      );
      expect(result.exitCode).toBe(6);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "device_not_active",
        detail: expect.stringContaining("still has an active device"),
      });
    } finally {
      server.stop();
      await state.cleanup();
    }
  });
});

describe("guided runs offer the fix and carry on", () => {
  const captureTerminal = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    return { terminal: { input, output }, text: () => chunks.join("") };
  };

  test("a signed-out run explains, offers sign-in, and ends with the command when declined", async () => {
    const server = startServer([]);
    const state = await seedState(server.pin, { session: false });
    const questions: string[] = [];
    const captured = captureTerminal();
    try {
      const result = await run(["team", "list"], {
        ...state.runtime,
        terminal: captured.terminal,
        guide: true,
        confirm: async (question) => {
          questions.push(question);
          return false;
        },
      });
      expect(result.exitCode).toBe(6);
      expect(questions).toEqual(["Sign in with GitHub?"]);
      const host = new URL(server.origin).host;
      expect(captured.text()).toContain(`▲  You're signed out of ${host}`);
      expect(captured.text()).toContain(
        "Sign in with GitHub, then dotrelay team list carries on.",
      );
      expect(result.stderr).toBe("└  next  dotrelay login\n");
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("a dropped connection offers a retry and the same run carries on", async () => {
    const server = startServer([]);
    const state = await seedState(server.pin);
    const questions: string[] = [];
    const captured = captureTerminal();
    let dropped = false;
    try {
      const result = await run(["team", "list"], {
        ...state.runtime,
        terminal: captured.terminal,
        guide: true,
        fetch: async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          if (url.pathname === "/api/v1/teams" && !dropped) {
            dropped = true;
            throw new TypeError("fetch failed");
          }
          return fetch(input, init);
        },
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
      });
      expect(result.exitCode).toBe(0);
      expect(questions).toEqual(["Try again?"]);
      expect(captured.text()).toContain("Couldn't reach");
      // A dropped request may have reached the server, so the guidance no
      // longer promises that nothing changed.
      expect(captured.text()).toContain(
        "Check your connection, then try again.",
      );
      expect(captured.text()).not.toContain("Nothing was changed");
      expect(result.stdout).toContain("Platform");
      // The resumed run doesn't open a second rail.
      expect(result.stdout.match(/┌ {2}dotrelay team list/g)).toHaveLength(1);
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("an offer is made once; a second failure of the same kind stops", async () => {
    const server = startServer([]);
    const state = await seedState(server.pin);
    const questions: string[] = [];
    const captured = captureTerminal();
    try {
      const result = await run(["team", "list"], {
        ...state.runtime,
        terminal: captured.terminal,
        guide: true,
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
      });
      expect(questions).toEqual(["Try again?"]);
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain("■  Couldn't reach");
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("scripts get the same headline, a stable code and the exact next command", async () => {
    const server = startServer([]);
    const state = await seedState(server.pin, { session: false });
    try {
      const json = await run(["team", "list", "--json"], {
        ...state.runtime,
        guide: true,
        confirm: async () => {
          throw new Error("--json must never prompt");
        },
      });
      expect(json.exitCode).toBe(6);
      expect(JSON.parse(json.stderr)).toMatchObject({
        ok: false,
        code: "authentication_required",
        exitCode: 6,
        next: "dotrelay login",
      });
      // Piped or in CI: no prompt, the same headline and next command.
      const human = await run(["team", "list"], {
        ...state.runtime,
        guide: false,
        confirm: async () => {
          throw new Error("an unguided run must never prompt");
        },
      });
      expect(human.exitCode).toBe(6);
      expect(human.stderr).toContain("You're signed out of");
      expect(human.stderr).toContain("└  next  dotrelay login");
    } finally {
      server.stop();
      await state.cleanup();
    }
  });

  test("a machine with no server says so and names setup", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "dotrelay-guided-"));
    try {
      const result = await run(["pull", "--json"], {
        profilePath: join(stateDirectory, "profiles.json"),
        stateDirectory,
      });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "profile_not_selected",
        next: "dotrelay setup https://api.dotrelay.dev",
      });
      const human = await run(["pull"], {
        profilePath: join(stateDirectory, "profiles.json"),
        stateDirectory,
        guide: false,
      });
      expect(human.stderr).toContain(
        "■  DotRelay isn't set up on this machine yet",
      );
      expect(human.stderr).toContain(
        "└  next  dotrelay setup https://api.dotrelay.dev",
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
