import { expect, test } from "bun:test";
import { GET } from "./route";

type BoundaryBody = {
  source?: unknown;
  connection?: unknown;
  catalog?: { readonly teams?: unknown; readonly projects?: unknown };
  session?: {
    readonly active?: unknown;
    readonly displayName?: unknown;
    readonly userId?: unknown;
  };
  profile?: { readonly origin?: unknown; readonly serverProfileId?: unknown };
  device?: { readonly active?: unknown };
};

const boundaryRequest = (profile = "hosted"): Request =>
  new Request(`http://web.local/api/workspace/boundary?profile=${profile}`);

const stubUpstream = (
  handler: (url: string) => Response | undefined,
): (() => void) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const response = handler(url);
    if (response === undefined) throw new TypeError("fetch failed");
    return response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
};

const withoutWorkspaceEnv = (): (() => void) => {
  const previous = {
    fixture: process.env.DOTRELAY_WORKSPACE_FIXTURE,
    nextPublic: process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN,
    api: process.env.DOTRELAY_API_ORIGIN,
    profile: process.env.SERVER_PROFILE_ORIGIN,
  };
  delete process.env.DOTRELAY_WORKSPACE_FIXTURE;
  delete process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN;
  delete process.env.DOTRELAY_API_ORIGIN;
  delete process.env.SERVER_PROFILE_ORIGIN;
  return () => {
    if (previous.fixture === undefined)
      delete process.env.DOTRELAY_WORKSPACE_FIXTURE;
    else process.env.DOTRELAY_WORKSPACE_FIXTURE = previous.fixture;
    if (previous.nextPublic === undefined)
      delete process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN;
    else process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN = previous.nextPublic;
    if (previous.api === undefined) delete process.env.DOTRELAY_API_ORIGIN;
    else process.env.DOTRELAY_API_ORIGIN = previous.api;
    if (previous.profile === undefined)
      delete process.env.SERVER_PROFILE_ORIGIN;
    else process.env.SERVER_PROFILE_ORIGIN = previous.profile;
  };
};

test("an unreachable API renders an honest offline boundary, not the e2e fixture", async () => {
  const restoreEnv = withoutWorkspaceEnv();
  const restoreFetch = stubUpstream(() => undefined);
  try {
    const response = await GET(boundaryRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as BoundaryBody;
    expect(body.source).toBe("live");
    expect(body.connection).toBe("offline");
    expect(body.catalog).toEqual({ teams: [], projects: [] });
    expect(body.session).toEqual({ active: false });
    expect(body.session?.displayName).toBeUndefined();
    expect(body.device?.active).toBe(false);
    expect(body.profile?.origin).toBe("http://localhost:3001");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("explicit dev fixture mode still serves the e2e boundary", async () => {
  const restoreEnv = withoutWorkspaceEnv();
  process.env.DOTRELAY_WORKSPACE_FIXTURE = "1";
  try {
    const response = await GET(boundaryRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as BoundaryBody;
    expect(body.source).toBe("fixture");
    expect(body.connection).toBe("online");
    expect(body.session?.displayName).toBe("Ari Stone");
  } finally {
    restoreEnv();
  }
});

test("a failed workspace endpoint keeps a verified session but no resources", async () => {
  const restoreEnv = withoutWorkspaceEnv();
  const restoreFetch = stubUpstream((url) => {
    if (url.includes("/api/v1/session"))
      return Response.json({ user: { id: "user-1", name: "Real Person" } });
    if (url.includes("/api/v1/capabilities"))
      return Response.json({ serverProfileId: "profile-1" });
    if (url.includes("/api/v1/workspace/boundary"))
      return new Response("boom", { status: 500 });
    return undefined;
  });
  try {
    const response = await GET(boundaryRequest());
    const body = (await response.json()) as BoundaryBody;
    expect(body.source).toBe("live");
    expect(body.connection).toBe("online");
    expect(body.catalog).toEqual({ teams: [], projects: [] });
    expect(body.session?.active).toBe(true);
    expect(body.session?.displayName).toBe("Real Person");
    expect(body.session?.userId).toBe("user-1");
    expect(body.profile?.serverProfileId).toBe("profile-1");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("a malformed workspace endpoint body is treated as unavailable", async () => {
  const restoreEnv = withoutWorkspaceEnv();
  const restoreFetch = stubUpstream((url) => {
    if (url.includes("/api/v1/session"))
      return Response.json({ user: { id: "user-1", name: "Real Person" } });
    if (url.includes("/api/v1/capabilities"))
      return Response.json({ serverProfileId: "profile-1" });
    if (url.includes("/api/v1/workspace/boundary"))
      return new Response("not-json", {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    return undefined;
  });
  try {
    const response = await GET(boundaryRequest());
    const body = (await response.json()) as BoundaryBody;
    expect(body.connection).toBe("online");
    expect(body.catalog).toEqual({ teams: [], projects: [] });
    expect(body.session?.displayName).toBe("Real Person");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});
