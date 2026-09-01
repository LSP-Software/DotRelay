import { describe, expect, test } from "bun:test";
import { CBOR_LIMITS, type ServerProfilePin } from "@dotrelay/contracts";
import {
  createStrictJsonClient,
  linkProject,
  selectEnvironment,
} from "./admin";

const profile: ServerProfilePin = {
  origin: "https://relay.example",
  serverProfileId: "00000000-0000-4000-8000-000000000042",
};

describe("strict administration client", () => {
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

  test("selects one Environment by opaque id and rejects ambiguity", async () => {
    const client = {
      get: async () => ({
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "project-id",
            lifecycle: "active",
            currentHeadId: null,
          },
        ],
      }),
    };
    await expect(
      selectEnvironment(
        client,
        "project-id",
        "00000000-0000-4000-8000-000000000003",
      ),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000003",
      projectId: "project-id",
      lifecycle: "active",
      currentHeadId: null,
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
});
