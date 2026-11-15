import { describe, expect, test } from "bun:test";
import {
  CBOR_LIMITS,
  createProblem,
  DEVICE_PROOF_CHALLENGE_BYTES,
  DEVICE_PROOF_TOKEN_BYTES,
  decodeDeviceProofValue,
  deviceProofMessage,
  encodeDeviceProofValue,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import {
  createEnvironment,
  createStrictJsonClient,
  createTeam,
  declineInvitation,
  findProjectByRepository,
  linkProject,
  listEnvironments,
  listTeams,
  type ProjectSummary,
  resolveEnvironmentReference,
  resolveRepositoryIdentity,
  resolveTeamForProject,
} from "./admin";
import type { NetworkPolicy } from "./network";

const profile: ServerProfilePin = {
  origin: "https://relay.example",
  serverProfileId: "00000000-0000-4000-8000-000000000042",
};

describe("strict administration client", () => {
  test("accepts GitHub's full repository name length after identity resolution", async () => {
    for (const name of ["my_app", ".github", "a".repeat(100)]) {
      const result = await resolveRepositoryIdentity(
        {
          get: async () => ({
            host: "github.com",
            owner: "LSP-Software",
            name,
            githubRepositoryId: "1311418611",
          }),
        },
        { host: "github.com", owner: "LSP-Software", name },
      );
      expect(result.name).toBe(name);
    }
  });

  test("rejects a resolved repository name outside GitHub's alphabet", async () => {
    for (const [owner, name] of [
      ["LSP-Software", "app\x1b]0;pwned\x07"],
      ["LSP\x1b[31m", "app"],
      ["LSP-Software", "app\u202e"],
      ["LSP Software", "app"],
    ] as const) {
      await expect(
        resolveRepositoryIdentity(
          {
            get: async () => ({
              host: "github.com",
              owner,
              name,
              githubRepositoryId: "1311418611",
            }),
          },
          { host: "github.com", owner: "LSP-Software", name: "app" },
        ),
      ).rejects.toThrow("invalid repository identity");
    }
  });

  test("finds an accessible Project by GitHub Repository id", async () => {
    await expect(
      findProjectByRepository(
        {
          get: async (path) => {
            expect(path).toBe("/api/v1/projects?githubRepositoryId=1311418611");
            return {
              project: {
                id: "00000000-0000-4000-8000-000000000002",
                teamId: "00000000-0000-4000-8000-000000000001",
                githubRepositoryId: "1311418611",
                lifecycle: "active",
              },
            };
          },
        },
        "1311418611",
      ),
    ).resolves.toEqual({
      project: {
        id: "00000000-0000-4000-8000-000000000002",
        teamId: "00000000-0000-4000-8000-000000000001",
        githubRepositoryId: "1311418611",
        lifecycle: "active",
      },
      candidates: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          teamId: "00000000-0000-4000-8000-000000000001",
          githubRepositoryId: "1311418611",
          lifecycle: "active",
        },
      ],
    });
  });

  test("scopes the Project lookup to a Team for the service to Membership-check", async () => {
    await expect(
      findProjectByRepository(
        {
          get: async (path) => {
            expect(path).toBe(
              "/api/v1/projects?githubRepositoryId=1311418611&teamId=00000000-0000-4000-8000-000000000001",
            );
            return { project: null, projects: [] };
          },
        },
        "1311418611",
        { teamId: "00000000-0000-4000-8000-000000000001" },
      ),
    ).resolves.toEqual({ project: null, candidates: [] });
  });

  test("keeps every eligible candidate visible when a repository spans Teams", async () => {
    const candidates: readonly ProjectSummary[] = [
      {
        id: "00000000-0000-4000-8000-000000000002",
        teamId: "00000000-0000-4000-8000-000000000001",
        githubRepositoryId: "1311418611",
        lifecycle: "active",
      },
      {
        id: "00000000-0000-4000-8000-00000000000a",
        teamId: "00000000-0000-4000-8000-00000000000b",
        githubRepositoryId: "1311418611",
        lifecycle: "active",
      },
    ];
    await expect(
      findProjectByRepository(
        {
          get: async () => ({ project: null, projects: candidates }),
        },
        "1311418611",
      ),
    ).resolves.toEqual({ project: null, candidates });
  });

  test("uses the profile-scoped bearer session and rejects extra response fields", async () => {
    const credentials = {
      get: async () => new TextEncoder().encode("session-token"),
      set: async () => undefined,
      delete: async () => undefined,
    };
    let authorization = "";
    const client = createStrictJsonClient(profile, credentials, {
      fetch: async (_input, init) => {
        authorization = String(new Headers(init?.headers).get("Authorization"));
        return Response.json({ id: "team-1", unexpected: true });
      },
    });
    await expect(client.get("/api/v1/teams", ["id"])).rejects.toThrow(
      "invalid administration response",
    );
    expect(authorization).toBe("Bearer session-token");
  });

  test("a Device-bound client proves its Device with the Device key (A-1)", async () => {
    const credentials = {
      get: async () => new TextEncoder().encode("session-token"),
      set: async () => undefined,
      delete: async () => undefined,
    };
    const deviceId = "00000000-0000-4000-8000-0000000000d1";
    const userId = "00000000-0000-4000-8000-0000000000a1";
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const seen: Array<
      Readonly<{ path: string; proof: string | null; claim: string | null }>
    > = [];
    let issued = 0;
    let refuseNext = true;
    const client = createStrictJsonClient(profile, credentials, {
      device: {
        id: deviceId,
        signer: async () => ({
          serverProfileId: profile.serverProfileId,
          userId,
          deviceId,
          signingKey: keys.privateKey,
        }),
      },
      fetch: async (input, init) => {
        const request = new Request(input as never, init);
        const path = new URL(request.url).pathname;
        seen.push({
          path,
          proof: request.headers.get("X-DotRelay-Device-Proof"),
          claim: request.headers.get("X-DotRelay-Device-Id"),
        });
        if (path === "/api/v1/devices/proofs/challenges")
          return Response.json(
            {
              challenge: encodeDeviceProofValue(
                new Uint8Array(DEVICE_PROOF_CHALLENGE_BYTES).fill(3),
              ),
              expiresIn: 120,
            },
            { status: 201 },
          );
        if (path === "/api/v1/devices/proofs") {
          const body = (await request.json()) as Record<string, string>;
          const signature = Uint8Array.from(
            atob(body.signature ?? ""),
            (character) => character.charCodeAt(0),
          );
          const verified = await crypto.subtle.verify(
            "Ed25519",
            keys.publicKey,
            signature,
            deviceProofMessage({
              serverProfileId: profile.serverProfileId,
              userId,
              deviceId,
              challenge: decodeDeviceProofValue(
                body.challenge,
                DEVICE_PROOF_CHALLENGE_BYTES,
              ),
            }),
          );
          if (!verified) throw new Error("the proof signature did not verify");
          issued += 1;
          return Response.json(
            {
              token: encodeDeviceProofValue(
                new Uint8Array(DEVICE_PROOF_TOKEN_BYTES).fill(issued),
              ),
              deviceId,
              expiresIn: 300,
            },
            { status: 201 },
          );
        }
        if (path === "/api/v1/teams" && refuseNext) {
          // The first proof has expired by the time the request arrives.
          refuseNext = false;
          const problem = createProblem("device_proof_required");
          return Response.json(problem, { status: problem.status });
        }
        return Response.json({ teams: [] });
      },
    });
    expect(client.deviceProof?.deviceId).toBe(deviceId);
    await client.get("/api/v1/session", ["teams"]);
    await client.get("/api/v1/teams", ["teams"]);
    const first = encodeDeviceProofValue(
      new Uint8Array(DEVICE_PROOF_TOKEN_BYTES).fill(1),
    );
    const second = encodeDeviceProofValue(
      new Uint8Array(DEVICE_PROOF_TOKEN_BYTES).fill(2),
    );
    expect(seen).toEqual([
      // The session check never needs the Device.
      { path: "/api/v1/session", proof: null, claim: null },
      { path: "/api/v1/devices/proofs/challenges", proof: null, claim: null },
      { path: "/api/v1/devices/proofs", proof: null, claim: null },
      { path: "/api/v1/teams", proof: first, claim: deviceId },
      // A refused proof is replaced and the request sent once more.
      { path: "/api/v1/devices/proofs/challenges", proof: null, claim: null },
      { path: "/api/v1/devices/proofs", proof: null, claim: null },
      { path: "/api/v1/teams", proof: second, claim: deviceId },
    ]);
  });

  test("a stale Device bundle is reported when the service refuses its proof signature", async () => {
    const credentials = {
      get: async () => new TextEncoder().encode("session-token"),
      set: async () => undefined,
      delete: async () => undefined,
    };
    const deviceId = "00000000-0000-4000-8000-0000000000d1";
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
    ])) as CryptoKeyPair;
    const client = createStrictJsonClient(profile, credentials, {
      device: {
        id: deviceId,
        signer: async () => ({
          serverProfileId: profile.serverProfileId,
          userId: "00000000-0000-4000-8000-0000000000a1",
          deviceId,
          signingKey: keys.privateKey,
        }),
      },
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/v1/devices/proofs/challenges")
          return Response.json(
            {
              challenge: encodeDeviceProofValue(
                new Uint8Array(DEVICE_PROOF_CHALLENGE_BYTES),
              ),
              expiresIn: 120,
            },
            { status: 201 },
          );
        const problem = createProblem("invalid_crypto_object");
        return Response.json(problem, { status: problem.status });
      },
    });
    await expect(client.get("/api/v1/teams", ["teams"])).rejects.toMatchObject({
      code: "device_bundle_invalid",
    });
  });

  test("links a detected GitHub Repository without sending protected content", async () => {
    const calls: Array<
      Readonly<{ path: string; body: Record<string, unknown> }>
    > = [];
    const client = {
      post: async (path: string, body: Record<string, unknown>) => {
        calls.push({ path, body });
        return {
          id: "00000000-0000-4000-8000-000000000002",
          teamId: "00000000-0000-4000-8000-000000000001",
          githubRepositoryId: "1311418611",
          lifecycle: "active",
        };
      },
    };

    await expect(
      linkProject(client, {
        teamId: "00000000-0000-4000-8000-000000000001",
        repository: {
          host: "github.com",
          owner: "LSP-Software",
          name: "DotRelay",
          githubRepositoryId: "1311418611",
        },
      }),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000002",
      teamId: "00000000-0000-4000-8000-000000000001",
      githubRepositoryId: "1311418611",
      lifecycle: "active",
    });
    expect(calls).toEqual([
      {
        path: "/api/v1/projects",
        body: {
          teamId: "00000000-0000-4000-8000-000000000001",
          repositoryHost: "github.com",
          repositoryOwner: "LSP-Software",
          repositoryName: "DotRelay",
          githubRepositoryId: "1311418611",
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("value");
  });

  test("resolves a unique Environment label to its stable id", async () => {
    const client = {
      get: async () => ({
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "project-id",
            label: "development",
            lifecycle: "active",
            currentHeadId: null,
            currentHeadHash: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            projectId: "project-id",
            label: "production",
            lifecycle: "active",
            currentHeadId: null,
            currentHeadHash: null,
          },
        ],
      }),
    };
    await expect(
      resolveEnvironmentReference(client, "project-id", "development", {
        noInput: true,
      }),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000003",
      projectId: "project-id",
      label: "development",
      lifecycle: "active",
      currentHeadId: null,
      currentHeadHash: null,
    });
  });

  test("keeps a listed head's authored-at instant and rejects a bad one", async () => {
    const listed = (currentHeadAuthoredAtMs: unknown) => ({
      get: async () => ({
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "project-id",
            label: "development",
            lifecycle: "active",
            currentHeadId: "00000000-0000-4000-8000-0000000000aa",
            currentHeadHash: "ab".repeat(48),
            currentHeadAuthoredAtMs,
          },
        ],
      }),
    });
    const [environment] = await listEnvironments(
      listed(1_700_000_000_123),
      "project-id",
    );
    expect(environment?.currentHeadAuthoredAtMs).toBe(1_700_000_000_123);
    await expect(
      listEnvironments(listed("soon"), "project-id"),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  test("prefers an opaque id over a same-named label", async () => {
    const client = {
      get: async () => ({
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "project-id",
            label: "staging",
            lifecycle: "active",
            currentHeadId: null,
            currentHeadHash: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            projectId: "project-id",
            label: "staging",
            lifecycle: "active",
            currentHeadId: null,
            currentHeadHash: null,
          },
        ],
      }),
    };
    await expect(
      resolveEnvironmentReference(
        client,
        "project-id",
        "00000000-0000-4000-8000-000000000004",
        { noInput: true },
      ),
    ).resolves.toMatchObject({
      id: "00000000-0000-4000-8000-000000000004",
      label: "staging",
    });
  });

  test("reports an Environment reference that matches nothing in the Project", async () => {
    const client = {
      get: async () => ({
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "project-id",
            label: "development",
            lifecycle: "active",
            currentHeadId: null,
            currentHeadHash: null,
          },
        ],
      }),
    };
    await expect(
      resolveEnvironmentReference(client, "project-id", "staging", {
        noInput: true,
      }),
    ).rejects.toMatchObject({
      code: "environment_not_found",
      message: [
        'no Environment is labelled "staging" in this Project (available: development).',
        "Pick one of those, or create it with dotrelay env create staging (Team owners and admins).",
        "Run dotrelay env list to see every Environment.",
      ].join("\n"),
    });
  });

  test("a miss on a Project with no active Environment says so", async () => {
    const client = {
      get: async () => ({
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "project-id",
            label: "old",
            lifecycle: "archived",
            currentHeadId: null,
            currentHeadHash: null,
          },
        ],
      }),
    };
    await expect(
      resolveEnvironmentReference(client, "project-id", "not a label", {
        noInput: true,
      }),
    ).rejects.toMatchObject({
      code: "environment_not_found",
      message: expect.stringContaining(
        "(this Project has no active Environment yet).\nPick one of those, or create it with dotrelay env create <label>",
      ),
    });
  });

  test("createEnvironment sends the label and accepts the full response", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const client = {
      post: async (
        path: string,
        body: Record<string, unknown>,
        fields: readonly string[],
      ) => {
        posted.push({ path, body, fields });
        return {
          id: "00000000-0000-4000-8000-000000000009",
          projectId: "00000000-0000-4000-8000-000000000002",
          label: "staging",
          lifecycle: "active",
          currentHeadId: null,
          currentHeadHash: null,
        };
      },
    };
    const created = await createEnvironment(
      client,
      "00000000-0000-4000-8000-000000000002",
      "staging",
    );
    expect(created.label).toBe("staging");
    expect(posted[0]?.body).toEqual({ label: "staging" });
    expect(posted[0]?.fields).toContain("currentHeadHash");
    await expect(
      createEnvironment(client, "00000000-0000-4000-8000-000000000002", "9x"),
    ).rejects.toThrow("an Environment label starts with a letter");
  });

  test("duplicate labels offer explicit id guidance under --no-input", async () => {
    const client = {
      get: async () => ({
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "project-id",
            label: "staging",
            lifecycle: "active",
            currentHeadId: null,
            currentHeadHash: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            projectId: "project-id",
            label: "staging",
            lifecycle: "archived",
            currentHeadId: null,
            currentHeadHash: null,
          },
        ],
      }),
    };
    await expect(
      resolveEnvironmentReference(client, "project-id", "staging", {
        noInput: true,
      }),
    ).rejects.toMatchObject({
      code: "environment_ambiguous",
    });
    const error = await resolveEnvironmentReference(
      client,
      "project-id",
      "staging",
      { noInput: true },
    ).catch((value) => value);
    expect(String((error as Error).message)).toContain(
      "00000000-0000-4000-8000-000000000003",
    );
    expect(String((error as Error).message)).toContain(
      "00000000-0000-4000-8000-000000000004",
    );
    expect(String((error as Error).message)).toContain(
      "--environment <environment-id>",
    );
  });

  test("duplicate labels offer a labelled choice interactively", async () => {
    const client = {
      get: async () => ({
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "project-id",
            label: "staging",
            lifecycle: "active",
            currentHeadId: null,
            currentHeadHash: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            projectId: "project-id",
            label: "staging",
            lifecycle: "active",
            currentHeadId: null,
            currentHeadHash: null,
          },
        ],
      }),
    };
    await expect(
      resolveEnvironmentReference(client, "project-id", "staging", {
        noInput: false,
        prompt: async () => "2",
      }),
    ).resolves.toMatchObject({
      id: "00000000-0000-4000-8000-000000000004",
    });
  });

  test("rejects oversized responses before parsing them", async () => {
    const credentials = {
      get: async () => new TextEncoder().encode("session-token"),
      set: async () => undefined,
      delete: async () => undefined,
    };
    const client = createStrictJsonClient(profile, credentials, {
      fetch: async () =>
        new Response("x".repeat(CBOR_LIMITS.maxAdminBodyBytes + 1)),
    });
    await expect(client.get("/api/v1/teams", ["id"])).rejects.toThrow(
      "response was too large",
    );
  });

  test("lists Teams and creates one when none exist", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const client = {
      get: async () => ({ teams: [] }),
      post: async (_path: string, body: Record<string, unknown>) => {
        posts.push(body);
        return {
          id: "00000000-0000-4000-8000-000000000001",
          name: String(body.name),
        };
      },
    };
    await expect(listTeams(client)).resolves.toEqual([]);
    await expect(createTeam(client, "Personal")).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Personal",
    });
    expect(posts).toEqual([{ name: "Personal" }]);
  });

  test("resolves a single Team without prompting", async () => {
    const prompts: string[] = [];
    await expect(
      resolveTeamForProject(
        {
          get: async () => ({
            teams: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                name: "Personal",
              },
            ],
          }),
          post: async () => {
            throw new Error("should not create");
          },
        },
        {
          suggestedName: "LSP-Software",
          noInput: false,
          prompt: async (question) => {
            prompts.push(question);
            return "";
          },
        },
      ),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Personal",
    });
    expect(prompts).toEqual([]);
  });

  test("creates a Team interactively when none are available", async () => {
    const lines: string[] = [];
    await expect(
      resolveTeamForProject(
        {
          get: async () => ({ teams: [] }),
          post: async (_path, body) => ({
            id: "00000000-0000-4000-8000-000000000009",
            name: String(body.name),
          }),
        },
        {
          suggestedName: "LSP-Software",
          noInput: false,
          prompt: async () => "",
          write: (message) => {
            lines.push(message);
          },
        },
      ),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000009",
      name: "LSP-Software",
    });
    expect(lines.join("")).toContain("No Team yet");
  });

  test("lets the operator pick among multiple Teams", async () => {
    await expect(
      resolveTeamForProject(
        {
          get: async () => ({
            teams: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                name: "Personal",
              },
              {
                id: "00000000-0000-4000-8000-000000000002",
                name: "Acme",
              },
            ],
          }),
          post: async () => {
            throw new Error("should not create");
          },
        },
        {
          suggestedName: "LSP-Software",
          noInput: false,
          prompt: async () => "2",
          write: () => undefined,
        },
      ),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000002",
      name: "Acme",
    });
  });
});

describe("strict administration client network behaviour", () => {
  const credentials = {
    get: async () => new TextEncoder().encode("session-token"),
    set: async () => undefined,
    delete: async () => undefined,
  };

  // Instant-sleep twin of the default policy so outage tests stay fast.
  const fastPolicy: NetworkPolicy = {
    requestDeadlineMs: 20,
    maxAttempts: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    sleep: async () => undefined,
    now: Date.now,
  };

  test("retries a transient network failure before surfacing the answer", async () => {
    let calls = 0;
    const client = createStrictJsonClient(profile, credentials, {
      networkPolicy: fastPolicy,
      fetch: async () => {
        calls += 1;
        if (calls <= 2) throw new TypeError("fetch failed");
        return Response.json({ id: "team-1" });
      },
    });
    await expect(client.get("/api/v1/teams", ["id"])).resolves.toEqual({
      id: "team-1",
    });
    expect(calls).toBe(3);
  });

  test("a stalled request is retryable and ends in a service_unavailable", async () => {
    let calls = 0;
    const client = createStrictJsonClient(profile, credentials, {
      networkPolicy: fastPolicy,
      fetch: async () => {
        calls += 1;
        return new Promise<Response>(() => undefined);
      },
    });
    const error = await client
      .get("/api/v1/teams", ["id"])
      .catch((value) => value);
    expect(error).toMatchObject({
      category: "transient",
      code: "service_unavailable",
    });
    expect(String((error as Error).message)).toContain(
      "the Server Profile stopped responding",
    );
    expect(calls).toBe(3);
  });

  test("an unreachable service ends in a retryable service_unavailable", async () => {
    let calls = 0;
    const client = createStrictJsonClient(profile, credentials, {
      networkPolicy: fastPolicy,
      fetch: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
    });
    const error = await client
      .get("/api/v1/teams", ["id"])
      .catch((value) => value);
    expect(error).toMatchObject({
      category: "transient",
      code: "service_unavailable",
    });
    expect(String((error as Error).message)).toContain(
      "could not reach the Server Profile after 3 attempts",
    );
    expect(calls).toBe(3);
  });

  test("waits the server's Retry-After on a rate-limited request", async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = createStrictJsonClient(profile, credentials, {
      networkPolicy: {
        ...fastPolicy,
        sleep: async (milliseconds) => void waits.push(milliseconds),
      },
      fetch: async () => {
        calls += 1;
        if (calls === 1)
          return Response.json(
            {
              type: "https://dotrelay.dev/problems/v1",
              title: "Rate limited",
              status: 429,
              code: "rate_limited",
              detail: "slow down",
            },
            { status: 429, headers: { "Retry-After": "2" } },
          );
        return Response.json({ id: "team-1" });
      },
    });
    await expect(client.get("/api/v1/teams", ["id"])).resolves.toEqual({
      id: "team-1",
    });
    expect(calls).toBe(2);
    expect(waits).toContain(2000);
  });

  test("a rate limit that outlasts the retry budget names the wait", async () => {
    const client = createStrictJsonClient(profile, credentials, {
      networkPolicy: { ...fastPolicy, maxAttempts: 1 },
      fetch: async () =>
        Response.json(
          {
            type: "https://dotrelay.dev/problems/v1",
            title: "Rate limited",
            status: 429,
            code: "rate_limited",
            detail: "slow down",
          },
          { status: 429, headers: { "Retry-After": "120" } },
        ),
    });
    const error = await client
      .get("/api/v1/teams", ["id"])
      .catch((value) => value);
    expect(error).toMatchObject({
      category: "transient",
      code: "rate_limited",
      details: expect.objectContaining({ retryAfterSeconds: 120 }),
    });
    expect(String((error as Error).message)).toContain(
      "wait 2 minutes and retry",
    );
  });

  test("declines an invitation with an Idempotency-Key and no fields", async () => {
    const invitationId = "99999999-9999-4999-8999-999999999999";
    const requests: Request[] = [];
    const client = createStrictJsonClient(profile, credentials, {
      networkPolicy: fastPolicy,
      fetch: async (input, init) => {
        requests.push(new Request(input as string, init));
        return Response.json(
          { invitationId, status: "DECLINED" },
          { status: 201 },
        );
      },
    });
    await expect(declineInvitation(client, invitationId)).resolves.toEqual({
      invitationId,
      status: "DECLINED",
    });
    const [request] = requests;
    expect(new URL(request?.url ?? "").pathname).toBe(
      `/api/v1/invitations/${invitationId}/decline`,
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await request?.text()).toBe("{}");
  });

  test("does not retry a definitive authentication failure", async () => {
    let calls = 0;
    const client = createStrictJsonClient(profile, credentials, {
      networkPolicy: fastPolicy,
      fetch: async () => {
        calls += 1;
        return Response.json(
          {
            type: "https://dotrelay.dev/problems/v1",
            title: "Authentication required",
            status: 401,
            code: "authentication_required",
            detail: "login required",
          },
          { status: 401 },
        );
      },
    });
    await expect(client.get("/api/v1/teams", ["id"])).rejects.toMatchObject({
      category: "authentication",
      code: "authentication_required",
    });
    expect(calls).toBe(1);
  });

  test("repeats a mutation with the same Idempotency-Key and body", async () => {
    const posts: Array<Readonly<{ key: string; body: string }>> = [];
    let calls = 0;
    const client = createStrictJsonClient(profile, credentials, {
      networkPolicy: fastPolicy,
      fetch: async (_input, init) => {
        posts.push({
          key: String(new Headers(init?.headers).get("Idempotency-Key")),
          body: String(init?.body),
        });
        calls += 1;
        if (calls === 1)
          return Response.json(
            {
              type: "https://dotrelay.dev/problems/v1",
              title: "Service unavailable",
              status: 503,
              code: "service_unavailable",
              detail: "try again",
            },
            { status: 503 },
          );
        return Response.json({ id: "00000000-0000-4000-8000-000000000002" });
      },
    });
    await expect(
      client.post("/api/v1/teams", { name: "Personal" }, ["id"], {
        idempotencyKey: "op-1",
      }),
    ).resolves.toEqual({ id: "00000000-0000-4000-8000-000000000002" });
    // A retried mutation must stay the same logical operation.
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(posts[0]?.key).toBe("op-1");
  });
});
