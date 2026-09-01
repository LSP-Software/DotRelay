import { describe, expect, test } from "bun:test";
import { CBOR_LIMITS, type ServerProfilePin } from "@dotrelay/contracts";
import { createStrictJsonClient } from "./admin";

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
