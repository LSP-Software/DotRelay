import { describe, expect, test } from "bun:test";
import { CBOR_LIMITS, type ServerProfilePin } from "@dotrelay/contracts";
import {
  createStrictJsonClient,
  createTeam,
  findProjectByRepository,
  linkProject,
  listTeams,
  type ProjectSummary,
  resolveEnvironmentReference,
  resolveTeamForProject,
} from "./admin";
import type { NetworkPolicy } from "./network";

const profile: ServerProfilePin = {
  origin: "https://relay.example",
  serverProfileId: "00000000-0000-4000-8000-000000000042",
};

describe("strict administration client", () => {
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
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            projectId: "project-id",
            label: "production",
            lifecycle: "active",
            currentHeadId: null,
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
    });
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
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            projectId: "project-id",
            label: "staging",
            lifecycle: "active",
            currentHeadId: null,
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
      message: "the requested Environment was not found",
    });
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
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            projectId: "project-id",
            label: "staging",
            lifecycle: "archived",
            currentHeadId: null,
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
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            projectId: "project-id",
            label: "staging",
            lifecycle: "active",
            currentHeadId: null,
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
