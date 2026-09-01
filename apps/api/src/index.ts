import {
  createProblem,
  type ProblemCode,
  parseCapabilitiesDocument,
} from "@dotrelay/contracts";
import {
  createBetterAuthDatabaseAdapter,
  createDatabaseClient,
  type DatabaseClient,
  ensureServerProfile,
  resolveDotRelayUser,
} from "@dotrelay/database";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { registerAdministrationRoutes } from "./administration-routes";
import { createAuth, type DotRelayAuth } from "./auth";
import {
  createCapabilitiesDocument,
  etagFor,
  hasMixedCredentials,
  isAllowedOrigin,
  isSecureRequest,
  loadServerProfileConfig,
  type ServerProfileConfig,
} from "./profile";
import { registerProtocolRoutes } from "./protocol";

type ApiDependencies = Readonly<{
  readonly database: DatabaseClient;
  readonly profile: ServerProfileConfig;
  readonly auth: DotRelayAuth;
}>;

const jsonProblem = (context: Context, code: ProblemCode) => {
  const problem = createProblem(code);
  return context.json(problem, problem.status as ContentfulStatusCode, {
    "Content-Type": "application/problem+json",
  });
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );

const devicePage = (userCode: string) => {
  const safeCode = escapeHtml(userCode);
  const scriptCode = JSON.stringify(userCode).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DotRelay device sign-in</title></head>
<body><main><h1>Sign in to DotRelay</h1><p>Device code: <strong>${safeCode}</strong></p>
<form method="post" action="/api/auth/sign-in/social">
<input type="hidden" name="provider" value="github">
<input type="hidden" name="callbackURL" value="/device?user_code=${encodeURIComponent(userCode)}">
<button type="submit">Continue with GitHub</button></form>
<button id="approve" type="button" hidden>Approve this device</button><p id="status"></p></main>
<script>
const userCode = ${scriptCode};
const status = document.getElementById("status");
const approve = document.getElementById("approve");
fetch("/api/auth/device/verify?user_code=" + encodeURIComponent(userCode), {credentials: "include"})
  .then((response) => response.ok ? response.json() : null)
  .then((device) => { if (device && device.status === "pending") approve.hidden = false; });
approve.addEventListener("click", async () => {
  const response = await fetch("/api/auth/device/approve", {method: "POST", credentials: "include",
    headers: {"Content-Type": "application/json"}, body: JSON.stringify({userCode})});
  status.textContent = response.ok ? "Device approved. You may close this page." : "This device could not be approved.";
  approve.hidden = true;
});
</script></body></html>`;
};

const createApi = ({ database, profile, auth }: ApiDependencies) => {
  const app = new Hono();
  const capabilities = createCapabilitiesDocument(profile);
  let capabilitiesEtagPromise: Promise<string> | undefined;
  const getCapabilitiesEtag = () => {
    capabilitiesEtagPromise ??= etagFor(capabilities);
    return capabilitiesEtagPromise;
  };

  app.use("*", async (context, next) => {
    if (!isSecureRequest(context.req.raw, profile))
      return jsonProblem(context, "forbidden");
    const requestOrigin = context.req.header("Origin") ?? null;
    if (!isAllowedOrigin(requestOrigin, profile))
      return jsonProblem(context, "forbidden");
    if (hasMixedCredentials(context.req.raw))
      return jsonProblem(context, "authentication_required");
    const isStateChanging = !["GET", "HEAD", "OPTIONS"].includes(
      context.req.method,
    );
    if (isStateChanging && context.req.header("Cookie") && !requestOrigin)
      return jsonProblem(context, "forbidden");
    if (
      requestOrigin &&
      requestOrigin !== profile.origin &&
      requestOrigin !== profile.webOrigin
    ) {
      return jsonProblem(context, "forbidden");
    }
    await next();
  });

  app.use(
    "/api/auth/*",
    cors({
      origin: (origin) =>
        origin === profile.origin || origin === profile.webOrigin
          ? origin
          : undefined,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      exposeHeaders: ["X-Retry-After", "Set-Auth-Token"],
      maxAge: 600,
    }),
  );

  app.get("/health", (context) => context.json({ status: "ok" }));
  app.get("/api/v1/capabilities", async (context) => {
    const etag = await getCapabilitiesEtag();
    if (context.req.header("If-None-Match") === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "public, max-age=60, must-revalidate",
        },
      });
    }
    return context.json(parseCapabilitiesDocument(capabilities), 200, {
      ETag: etag,
      "Cache-Control": "public, max-age=60, must-revalidate",
      Vary: "Origin",
    });
  });

  app.get("/device", (context) => {
    const userCode = context.req.query("user_code");
    if (!userCode) return jsonProblem(context, "invalid_request");
    return new Response(devicePage(userCode), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'unsafe-inline'",
        "Content-Type": "text/html; charset=UTF-8",
      },
    });
  });

  app.all("/api/auth/*", async (context) => {
    try {
      const response = await auth.handler(context.req.raw);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch {
      return jsonProblem(context, "service_unavailable");
    }
  });

  app.get("/api/v1/session", async (context) => {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session) return jsonProblem(context, "authentication_required");
    const user = await resolveDotRelayUser(database, {
      serverProfileId: profile.id,
      authSubject: session.user.id,
    });
    if (!user) return jsonProblem(context, "service_unavailable");
    return context.json(
      { authenticated: true, user: { id: user.id, name: session.user.name } },
      200,
      {
        "Cache-Control": "no-store",
      },
    );
  });

  registerAdministrationRoutes(app, { database, profile, auth });

  registerProtocolRoutes(app, { database, profile, auth });

  void database;
  return app;
};

const profile = loadServerProfileConfig();
const database = createDatabaseClient();
export const auth = createAuth(
  createBetterAuthDatabaseAdapter(database),
  profile,
);
export const app = createApi({ database, profile, auth });
export { createApi, loadServerProfileConfig };

if (import.meta.main) {
  await ensureServerProfile(database, {
    id: profile.id,
    origin: profile.origin,
    allowRebind: profile.allowRebind,
  });
  Bun.serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3001) });
}
