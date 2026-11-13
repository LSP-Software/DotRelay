import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCliDeviceStorage,
  createDeviceBootstrap,
  createMemoryDeviceRecordStore,
} from "@dotrelay/client";
import {
  createProblem,
  encodeSyncPage,
  PROTOCOL_MEDIA_TYPE,
  type ProblemCode,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import type { StrictJsonClient } from "./admin";
import { createSessionStore } from "./auth";
import type { CredentialStore } from "./credentials";
import { serializeDotenv } from "./dotenv";
import { deviceMetadataPath, writeDeviceId } from "./device-storage";
import { type CliRuntime, run } from "./index";
import type { NetworkPolicy } from "./network";
import { formatEntries } from "./workflow-values";

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
      expect(result.stdout).toContain("Removed the local session for relay");
      expect(result.stdout).toContain("was not revoked there");
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
      expect(result.stderr).toContain("No Project is linked in this worktree");
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
      expect(listed.stdout).toContain("no Variables yet");
    } finally {
      server.stop();
      await state.cleanup();
    }
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
        expect(String(diagnostic.detail)).toContain("you joined Platform");
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
            accountRoster: null,
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
    try {
      const result = await run(
        [
          "team",
          "share-keys",
          "octocat",
          "--profile",
          "relay",
          "--no-input",
          "--force",
          "--json",
        ],
        { ...state.runtime, admin },
      );
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
      expect(missing.stderr).toContain("is not a Member of this Team");
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
          "1 Member removed since 2026-11-01",
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
