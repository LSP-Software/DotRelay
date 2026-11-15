import { apiReady, databaseReady } from "./readiness";
import {
  bytesToUuid,
  ContractError,
  createProblem,
  DEVICE_ID_HEADER,
  DEVICE_PROOF_HEADER,
  type DeviceClientInfo,
  type ProblemCode,
  parseCapabilitiesDocument,
  parseDeviceClientInfo,
  parseJsonObject,
  parseProtocolObject,
  parseUuid,
  sanitizeDeviceName,
  validateProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import {
  AccountRosterRepository,
  createBetterAuthDatabaseAdapter,
  createDatabaseClient,
  type DatabaseClient,
  DeviceNotActiveError,
  DeviceRepository,
  ensureServerProfile,
  GrantRepository,
  loadTeamMembershipWindows,
  OperationConflictError,
  OperationRepository,
  ProjectRotationObligationRepository,
  recordGitHubLogin,
  requireTeamAction,
  resolveDotRelayUser,
  StagedObjectRepository,
  sha384Digest,
} from "@dotrelay/database";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { registerAccountRoutes } from "./account-routes";
import { registerAdministrationRoutes } from "./administration-routes";
import { createAuth, type DotRelayAuth, signBearerToken } from "./auth";
import { createClientIpResolver } from "./client-ip";
import { registerDeviceProofRoutes } from "./device-proof-routes";
import { registerDeviceRoutes } from "./device-routes";
import { createResendTransport, loadEmailConfig } from "./email";
import {
  createEmailNotifier,
  disabledEmailNotifier,
  type EmailNotifier,
} from "./email-notifications";
import { delegatedGitHubAccessToken } from "./github-access";
import {
  type GitHubRepositoryDisplayOptions,
  lookupGitHubRepositoryDisplay,
} from "./github-repository";
import { registerMembershipProvisioningRoutes } from "./membership-provisioning-routes";
import { registerMembershipRoutes } from "./membership-routes";
import { createMetricsRegistry, startMetricsServer } from "./metrics";
import { loadMetricsConfig } from "./metrics-config";
import {
  API_CORRELATION_HEADER,
  type ApiObservability,
  createApiObservability,
  createConsoleDiagnosticSink,
  createServerCorrelationId,
  type ServerDiagnosticProblemCode,
  toServerDiagnosticProblemCode,
  toServerDiagnosticRetryAfterSeconds,
} from "./observability";
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
import {
  optionalProtocolActor,
  requireProtocolActor,
} from "./protocol/context";
import {
  apiRateLimitBuckets,
  createUserRateLimit,
  RATE_LIMIT_BUCKET_CONTEXT_KEY,
} from "./protocol/rate-limit";
import {
  createSessionLifetimeGate,
  requestSession,
  requestWasAuthenticated,
} from "./session";

export type ApiDependencies = Readonly<{
  readonly database: DatabaseClient;
  readonly profile: ServerProfileConfig;
  readonly auth: DotRelayAuth;
  /** Outbound GitHub transport for the delegated-access seam; tests stub it. */
  readonly githubFetch?: typeof fetch;
  readonly observability?: ApiObservability;
  readonly resolveClientIp?: (request: Request) => string | null;
  /** Post-commit transactional email; disabled when omitted. */
  readonly notifications?: EmailNotifier;
}>;

// Reads at most maxBytes of a body; a larger or unreadable one is null.
const readCappedText = async (
  request: Readonly<{
    readonly headers: { get(name: string): string | null };
    readonly body: ReadableStream<Uint8Array> | null;
  }>,
  maxBytes: number,
): Promise<string | null> => {
  if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes)
    return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const jsonProblem = (context: Context, code: ProblemCode) => {
  const correlationId = context.get("correlationId" as never) as
    string | undefined;
  const problem = createProblem(code, {
    ...(correlationId === undefined ? {} : { correlationId }),
  });
  return context.json(problem, problem.status as ContentfulStatusCode, {
    "Content-Type": "application/problem+json",
  });
};

const readDiagnosticProblemDetails = async (
  response: Response,
): Promise<DiagnosticProblemDetails> => {
  if (response.status < 400) return {};
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/problem+json")
  )
    return {};
  try {
    const body = (await response.clone().json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {};
    const object = body as Record<string, unknown>;
    const problemCode = toServerDiagnosticProblemCode(object.code);
    const retryAfterSeconds = toServerDiagnosticRetryAfterSeconds(
      object.retryAfterSeconds,
    );
    const details: {
      problemCode?: ServerDiagnosticProblemCode;
      retryAfterSeconds?: number;
    } = {};
    if (problemCode !== undefined) details.problemCode = problemCode;
    if (retryAfterSeconds !== undefined)
      details.retryAfterSeconds = retryAfterSeconds;
    return details;
  } catch {
    return {};
  }
};

type DiagnosticProblemDetails = Readonly<{
  readonly problemCode?: ServerDiagnosticProblemCode;
  readonly retryAfterSeconds?: number;
}>;

const safeAuthErrorCodes = new Set([
  "access_denied",
  "authorization_pending",
  "expired_token",
  "slow_down",
]);

// The browser device-approval surface (the /device verification page) renders
// distinct code, session, and connection states from these additional stable
// device authorization codes. Only the `error` code is exposed, so no Better
// Auth detail leaks on any endpoint.
const safeDeviceApprovalErrorCodes = new Set([
  ...safeAuthErrorCodes,
  "device_code_already_processed",
  "invalid_request",
  "unauthorized",
]);

const isDeviceApprovalPath = (path: string) =>
  path === "/api/auth/device" ||
  path === "/api/auth/device/approve" ||
  path === "/api/auth/device/deny";

const sanitizeAuthResponse = async (
  context: Context,
  response: Response,
): Promise<Response> => {
  if (response.status < 400) return response;
  if (response.status === 429) {
    const retryAfter = response.headers.get("x-retry-after");
    if (retryAfter) context.header("X-Retry-After", retryAfter);
    return jsonProblem(context, "rate_limited");
  }
  const allowedErrorCodes = isDeviceApprovalPath(context.req.path)
    ? safeDeviceApprovalErrorCodes
    : safeAuthErrorCodes;
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = (await response.clone().json()) as {
        readonly error?: unknown;
      };
      if (typeof body.error === "string" && allowedErrorCodes.has(body.error))
        return Response.json(
          { error: body.error },
          {
            status: response.status,
            headers: { "Cache-Control": "no-store" },
          },
        );
    } catch {
      // Fall through to the generic problem response.
    }
  }
  return jsonProblem(context, "service_unavailable");
};

// Session tokens never reach page script: get-session and list-sessions
// answer without them. The CLI's device token is the one place a token
// leaves the service, and it leaves signed, the only bearer form accepted.
const protectSessionTokens = async (
  authPath: string,
  response: Response,
  authSecret: string,
): Promise<Response> => {
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json") ||
    ![
      "/api/auth/get-session",
      "/api/auth/list-sessions",
      "/api/auth/device/token",
    ].includes(authPath)
  )
    return response;
  const body = (await response.clone().json()) as unknown;
  const withoutToken = (value: unknown): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const { token: _token, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  const replaced = await (async (): Promise<unknown> => {
    if (authPath === "/api/auth/get-session")
      return body !== null && typeof body === "object" && !Array.isArray(body)
        ? {
            ...(body as Record<string, unknown>),
            session: withoutToken((body as Record<string, unknown>).session),
          }
        : body;
    if (authPath === "/api/auth/list-sessions")
      return Array.isArray(body) ? body.map(withoutToken) : body;
    const grant = body as Record<string, unknown> | null;
    if (!grant || typeof grant.access_token !== "string") return body;
    return {
      ...grant,
      access_token: await signBearerToken(authSecret, grant.access_token),
    };
  })();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(replaced), {
    status: response.status,
    headers,
  });
};

// GitHub sends the browser to this API, which then redirects to the web app.
// A session cookie set on that cross-site 302 is dropped by some browsers, so
// the approval page loads signed-out and Continue with GitHub starts again.
// Deliver the cookie on a document response, then navigate.
const bridgeSessionRedirect = (
  response: Response,
  profile: ServerProfileConfig,
): Response => {
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get("location");
  if (!location || !trustedBrowserRedirect(location, profile)) return response;
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  if (!cookies.some(setsSessionCookie)) return response;
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  const target = JSON.stringify(location).replaceAll("<", "\\u003c");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Returning to DotRelay</title><meta http-equiv="refresh" content="0;url=${escapeHtmlAttribute(location)}"></head><body><p>Signed in. Returning to DotRelay.</p><script>location.replace(${target})</script></body></html>`;
  return new Response(html, { status: 200, headers });
};

const setsSessionCookie = (cookie: string): boolean =>
  cookie.split(";", 1)[0]?.includes("session_token=") === true &&
  !/max-age=0/i.test(cookie);

const trustedBrowserRedirect = (
  location: string,
  profile: ServerProfileConfig,
): boolean => {
  if (location.startsWith("/") && !location.startsWith("//")) return true;
  try {
    const url = new URL(location);
    return url.origin === profile.origin || url.origin === profile.webOrigin;
  } catch {
    return false;
  }
};

const escapeHtmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const bytesToHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const bytesToBase64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const loadWorkspaceCatalog = async (
  database: DatabaseClient,
  userId: string,
  repositoryDisplay: GitHubRepositoryDisplayOptions,
) => {
  const memberships = await database.membership.findMany({
    where: { userId, lifecycle: "ACTIVE" },
    select: {
      role: true,
      team: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const teamIds = memberships.map((membership) => membership.team.id);
  const projects = teamIds.length
    ? await database.project.findMany({
        where: { teamId: { in: teamIds } },
        select: {
          id: true,
          teamId: true,
          githubRepositoryId: true,
          lifecycle: true,
          environments: {
            select: {
              id: true,
              label: true,
              lifecycle: true,
              currentHeadId: true,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  return {
    teams: memberships.map((membership) => ({
      id: membership.team.id,
      name: membership.team.name,
      role: membership.role,
    })),
    projects: await Promise.all(
      projects.map(async (project) => {
        const githubRepositoryId = project.githubRepositoryId.toString();
        // Best effort: on a miss or timeout the Project is shown by its
        // stored GitHub repository id.
        const repository = await lookupGitHubRepositoryDisplay(
          githubRepositoryId,
          repositoryDisplay,
        );
        return {
          id: project.id,
          teamId: project.teamId,
          githubRepositoryId,
          lifecycle: project.lifecycle,
          environments: project.environments,
          ...(repository ? { repository } : {}),
        };
      }),
    ),
  };
};

// The Devices that may sign the Team's Revision history: every Device of a
// Member, with the Device and Membership windows that were valid when a
// Revision was authored. Windows let a legitimate historical Revision stay
// verifiable after its signing Device is revoked or its Member leaves, while
// a write made after the revocation or removal stays rejected.
// memberSinceMs/memberUntilMs describe the current Membership period only;
// membershipPeriods lists every period, so a Member who was removed and
// invited back keeps their earlier Revisions verifiable (ADR 0017).
const loadTeamSigningTrustDevices = async (
  database: DatabaseClient,
  teamId: string,
) => {
  const membershipByUser = await loadTeamMembershipWindows(database, teamId);
  const userIds = [...membershipByUser.keys()];
  if (userIds.length === 0) return [];
  const devices = await database.device.findMany({
    where: { userId: { in: userIds } },
    select: {
      id: true,
      userId: true,
      ed25519PublicKey: true,
      x25519PublicKey: true,
      activatedAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const toMillis = (value: Date | null): number | null =>
    value === null ? null : value.getTime();
  return devices.map((device) => {
    const membership = membershipByUser.get(device.userId);
    return {
      deviceId: device.id,
      userId: device.userId,
      signingPublicKey: bytesToHex(new Uint8Array(device.ed25519PublicKey)),
      encryptionPublicKey: bytesToHex(new Uint8Array(device.x25519PublicKey)),
      deviceActiveFromMs: toMillis(device.activatedAt),
      deviceActiveUntilMs: toMillis(device.revokedAt),
      memberSinceMs: toMillis(membership?.current.activatedAt ?? null),
      memberUntilMs: toMillis(membership?.current.removedAt ?? null),
      membershipPeriods: (membership?.periods ?? []).map((period) => ({
        sinceMs: period.activatedAt.getTime(),
        untilMs: toMillis(period.removedAt),
      })),
    };
  });
};

const decodeHex = (
  value: unknown,
  length: number,
  name: string,
): Uint8Array => {
  if (
    typeof value !== "string" ||
    value.length !== length * 2 ||
    !/^[0-9a-f]+$/i.test(value)
  )
    throw new Error(`${name} is invalid`);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

const decodeBase64 = (value: unknown, name: string): Uint8Array => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} is invalid`);
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error(`${name} is invalid`);
  }
};

const parseBootstrapRequest = async (
  context: Context,
  serverProfileId: string,
  userId: string,
) => {
  const body = (await context.req.json()) as Record<string, unknown>;
  const operationId = parseUuid(body.operationId, "operationId");
  const deviceId = parseUuid(body.deviceId, "deviceId");
  const certificateId = parseUuid(body.certificateId, "certificateId");
  const identityGeneration = body.identityGeneration;
  if (
    typeof identityGeneration !== "number" ||
    !Number.isSafeInteger(identityGeneration) ||
    identityGeneration < 1
  )
    throw new Error("identity generation is invalid");
  const x25519PublicKey = decodeHex(body.x25519PublicKey, 32, "X25519 key");
  const ed25519PublicKey = decodeHex(body.ed25519PublicKey, 32, "Ed25519 key");
  const keyId = decodeHex(body.keyId, 48, "Device key id");
  const certificateBytes = decodeBase64(body.certificate, "certificate");
  const certificate = parseProtocolObject(certificateBytes);
  validateProtocolObject(certificate);
  if (
    certificate.get(1) !== 2 ||
    !equalBytes(
      certificate.get(8) as Uint8Array,
      parseUuidBytes(serverProfileId),
    ) ||
    !equalBytes(certificate.get(9) as Uint8Array, parseUuidBytes(userId))
  )
    throw new Error("Device certificate identity is invalid");
  if (
    certificate.get(28) !== identityGeneration ||
    !equalBytes(certificate.get(10) as Uint8Array, parseUuidBytes(deviceId)) ||
    !equalBytes(certificate.get(39) as Uint8Array, x25519PublicKey) ||
    !equalBytes(certificate.get(41) as Uint8Array, ed25519PublicKey)
  )
    throw new Error("Device certificate does not match the Device request");
  const signature = certificate.get(4);
  if (!(signature instanceof Uint8Array))
    throw new Error("Device certificate signature is invalid");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(ed25519PublicKey).buffer,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (!(await verifyProtocolObject(certificate, signature, publicKey)))
    throw new Error("Device certificate signature is invalid");
  return {
    ...(body.recovery === undefined
      ? {}
      : {
          recovery: (() => {
            const recovery = parseJsonObject<{
              wrapperId: unknown;
              signature: unknown;
            }>(body.recovery, ["wrapperId", "signature"]);
            const signature = decodeBase64(
              recovery.signature,
              "recovery signature",
            );
            if (signature.length !== 64)
              throw new Error("invalid recovery signature");
            return {
              wrapperId: decodeHex(recovery.wrapperId, 16, "wrapper id"),
              signature,
              profileId: serverProfileId,
            };
          })(),
        }),
    operationId,
    deviceId,
    certificateId,
    identityGeneration,
    x25519PublicKey,
    ed25519PublicKey,
    keyId,
    certificateBytes,
    client: parseDeviceClientInfo(body.client),
  };
};

// Parsed wire client info → persistence metadata (Prisma enum casing).
const toClientMetadata = (
  client: DeviceClientInfo,
): Readonly<{
  displayName: string;
  clientKind: "CLI" | "BROWSER";
  osName: string | null;
  clientSummary: string | null;
}> => ({
  displayName: client.displayName,
  clientKind: client.clientKind === "cli" ? "CLI" : "BROWSER",
  osName: client.osName,
  clientSummary: client.clientSummary,
});

// Display fields carried on a Device row for the boundary response. Names
// are optional so a Device enrolled before this metadata existed (or one
// that has never refreshed) still lists cleanly.
type DeviceDisplayRow = Readonly<{
  readonly displayName: string | null;
  readonly clientKind: "CLI" | "BROWSER" | null;
  readonly osName: string | null;
  readonly clientSummary: string | null;
}>;

const deviceDisplayFields = (row: DeviceDisplayRow) => ({
  ...(row.displayName ? { name: row.displayName } : {}),
  ...(row.clientKind
    ? { clientKind: row.clientKind === "CLI" ? "cli" : "browser" }
    : {}),
  ...(row.osName ? { osName: row.osName } : {}),
  ...(row.clientSummary ? { clientSummary: row.clientSummary } : {}),
});

const parseGrantBootstrapRequest = async (context: Context) => {
  const body = (await context.req.json()) as Record<string, unknown>;
  const operationId = parseUuid(body.operationId, "operationId");
  const projectId = parseUuid(body.projectId, "projectId");
  const teamId = parseUuid(body.teamId, "teamId");
  const objectId = parseUuid(body.objectId, "objectId");
  const digest = decodeBase64(body.digest, "grant digest");
  const grantBytes = decodeBase64(body.grant, "grant");
  if (digest.length !== 48) throw new Error("grant digest is invalid");
  return { operationId, projectId, teamId, objectId, digest, grantBytes };
};

const protocolCors = (profile: ServerProfileConfig) =>
  cors({
    origin: (origin) =>
      origin === profile.origin || origin === profile.webOrigin
        ? origin
        : undefined,
    credentials: true,
    allowHeaders: [
      "Accept",
      "Content-Type",
      "Authorization",
      DEVICE_ID_HEADER,
      DEVICE_PROOF_HEADER,
      "Idempotency-Key",
      "X-DotRelay-Operation-Kind",
      "X-DotRelay-Expires-At",
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    // The protocol rate limiter sends Retry-After; the auth rate limiter's
    // 429 carries X-Retry-After.
    exposeHeaders: ["X-Correlation-ID", "Retry-After", "X-Retry-After"],
    maxAge: 600,
  });

const parseUuidBytes = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(
      normalized.slice(index * 2, index * 2 + 2),
      16,
    );
  return bytes;
};

// The largest legitimate body is a CBOR staging upload (bounded by the
// protocol object and staging byte limits); everything else is an admin body.
export const maxRequestBodyBytes = (profile: ServerProfileConfig): number =>
  Math.max(
    Math.min(profile.limits.protocolObjectBytes, profile.limits.stagingBytes),
    profile.limits.adminBodyBytes,
  );

// Docker's default stop timeout is 10 s: drain plus shutdown must fit in it.
export const shutdownDrainMs = (value: string | undefined): number => {
  const parsed = value === undefined ? 5000 : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, 7000)
    : 5000;
};

const rateLimitBucketOf = (context: Context) => {
  const bucket = context.get(RATE_LIMIT_BUCKET_CONTEXT_KEY as never) as unknown;
  return typeof bucket === "string" ? { rateLimitBucket: bucket } : {};
};

const createApi = ({
  database,
  profile,
  auth,
  githubFetch,
  observability: suppliedObservability,
  resolveClientIp,
  notifications = disabledEmailNotifier,
}: ApiDependencies) => {
  const app = new Hono();
  // Auth, Device bootstrap/self and grant bootstrap bodies are a few KB.
  const smallBodyLimit = bodyLimit({
    maxSize: profile.limits.adminBodyBytes,
    onError: (context) => jsonProblem(context, "payload_too_large"),
  });
  const observability =
    suppliedObservability ??
    createApiObservability(
      database,
      resolveClientIp === undefined ? {} : { resolveClientIp },
    );
  const capabilities = createCapabilitiesDocument(profile);
  const sessionLifetimeGate = createSessionLifetimeGate(database, auth);
  let capabilitiesEtagPromise: Promise<string> | undefined;
  const getCapabilitiesEtag = () => {
    capabilitiesEtagPromise ??= etagFor(capabilities);
    return capabilitiesEtagPromise;
  };

  app.use("*", async (context, next) => {
    const correlationId = createServerCorrelationId();
    const startedAt = performance.now();
    context.set("correlationId" as never, correlationId);
    context.header(API_CORRELATION_HEADER, correlationId);
    try {
      await next();
    } finally {
      try {
        const problemDetails = await readDiagnosticProblemDetails(context.res);
        observability.recordRequest({
          request: context.req.raw,
          path: context.req.path,
          status: context.res.status,
          correlationId,
          durationMs: performance.now() - startedAt,
          authenticated: await requestWasAuthenticated(context),
          ...problemDetails,
          ...rateLimitBucketOf(context),
        });
      } catch {
        // Observability loss must never affect the response or domain behavior.
      }
    }
  });

  app.onError((_error, context) => jsonProblem(context, "service_unavailable"));

  // Unmatched routes answer with the same problem document shape as known
  // routes (instead of the framework's plain-text 404) so API clients can
  // always parse the failure.
  app.notFound((context) => jsonProblem(context, "resource_not_found"));

  app.use("*", async (context, next) => {
    // Liveness probe: not a secure-request surface. Bypasses the TLS/proxy,
    // origin, and credential gates so the in-container health check (plain
    // HTTP, no proxy, no x-forwarded-proto) always gets a deterministic 200
    // instead of the production secure-request 403.
    if (["/health", "/ready"].includes(context.req.path)) {
      await next();
      return;
    }
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
      // Set-Auth-Token is deliberately not exposed: browser script must never
      // read the bearer session token. Non-browser clients are unaffected.
      exposeHeaders: ["X-Correlation-ID", "Retry-After", "X-Retry-After"],
      maxAge: 600,
    }),
  );

  // Sessions slide; this caps their absolute age before anything reads them.
  app.use("*", async (context, next) => {
    if (["/health", "/ready"].includes(context.req.path)) {
      await next();
      return;
    }
    return sessionLifetimeGate(context, next);
  });

  const isAlphaAdmitted = async (
    allowed: readonly string[],
    userId: string,
  ): Promise<boolean> => {
    const account = await database.authAccount.findFirst({
      where: { userId, providerId: "github" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { accountId: true },
    });
    return account !== null && allowed.includes(account.accountId);
  };

  // A device code opened by a browser outside the alpha list can never be
  // allowed, so it is declined on the spot and the waiting CLI learns why
  // at sign-in instead of polling until the code expires. Only a pending,
  // unexpired code that nobody else has claimed is touched.
  const declineDeviceCodeOutsideAlpha = async (
    context: Context,
    userId: string,
  ) => {
    if (context.req.method !== "GET" || context.req.path !== "/api/auth/device")
      return;
    const userCode = context.req.query("user_code");
    if (!userCode || userCode.length > 64) return;
    const normalized = userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    await database.authDeviceCode.updateMany({
      where: {
        userCode: { in: [...new Set([userCode, normalized])] },
        status: "pending",
        expiresAt: { gt: new Date() },
        OR: [{ userId: null }, { userId }],
      },
      data: { status: "denied", userId },
    });
  };

  const readDeviceCodeFromTokenRequest = async (
    context: Context,
  ): Promise<string | null> => {
    if (
      context.req.method !== "POST" ||
      context.req.path !== "/api/auth/device/token"
    )
      return null;
    const text = await readCappedText(context.req.raw.clone(), 4096);
    if (text === null) return null;
    const contentType = context.req.header("Content-Type") ?? "";
    let deviceCode: unknown;
    if (contentType.startsWith("application/x-www-form-urlencoded"))
      deviceCode = new URLSearchParams(text).get("device_code");
    else {
      try {
        deviceCode = (JSON.parse(text) as { device_code?: unknown })
          ?.device_code;
      } catch {
        return null;
      }
    }
    return typeof deviceCode === "string" &&
      deviceCode.length > 0 &&
      deviceCode.length <= 255
      ? deviceCode
      : null;
  };

  app.use("*", async (context, next) => {
    const allowed = profile.allowedGitHubIds;
    if (
      allowed === undefined ||
      context.req.method === "OPTIONS" ||
      ["/health", "/ready"].includes(context.req.path) ||
      context.req.path === "/api/v1/capabilities" ||
      context.req.path === "/api/auth/sign-out"
    ) {
      await next();
      return;
    }
    const session = await requestSession(context, auth);
    if (session) {
      // The distinct code lets clients show "not on the list" instead of a
      // generic error; the body names neither the list nor the account.
      if (!(await isAlphaAdmitted(allowed, session.user.id))) {
        // Best effort: the CLI falls back to waiting out the code.
        await declineDeviceCodeOutsideAlpha(context, session.user.id).catch(
          () => undefined,
        );
        context.header("Cache-Control", "no-store");
        return jsonProblem(context, "alpha_admission_required");
      }
    } else if (context.req.path.startsWith("/api/v1/")) {
      return jsonProblem(context, "authentication_required");
    } else {
      const deviceCode = await readDeviceCodeFromTokenRequest(context);
      if (deviceCode) {
        const declined = await database.authDeviceCode.findUnique({
          where: { deviceCode },
          select: { id: true, status: true, userId: true },
        });
        if (
          declined?.status === "denied" &&
          declined.userId &&
          !(await isAlphaAdmitted(allowed, declined.userId))
        ) {
          // Consumed like Better Auth consumes any denied code.
          await database.authDeviceCode.deleteMany({
            where: { id: declined.id },
          });
          context.header("Cache-Control", "no-store");
          return jsonProblem(context, "alpha_admission_required");
        }
      }
    }
    await next();
  });

  // Every authenticated /api/v1 request counts against its User's budget;
  // GitHub-calling and row-creating routes also count against tighter ones.
  // The bucket owner is the server-verified session, never a header.
  const apiRateLimit = createUserRateLimit({
    isProduction: profile.isProduction,
    identify: async (context) =>
      (await requestSession(context, auth).catch(() => null))?.user.id ?? null,
    buckets: (context) =>
      apiRateLimitBuckets(context.req.method, context.req.path),
  });
  app.use("/api/v1/*", async (context, next) => {
    if (
      context.req.method === "OPTIONS" ||
      context.req.path === "/api/v1/capabilities"
    ) {
      await next();
      return;
    }
    return apiRateLimit(context, next);
  });

  app.get("/health", (context) => context.json({ status: "ok" }));
  app.get("/ready", async (context) => {
    context.header("Cache-Control", "no-store");
    const ready = await apiReady(database);
    return context.json(
      { status: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
    );
  });
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
    const target = new URL("/device", profile.webOrigin);
    target.searchParams.set("user_code", userCode);
    return context.redirect(target.toString(), 302);
  });

  app.all("/api/auth/*", smallBodyLimit, async (context) => {
    // Delegated GitHub credentials are service-only. Keep Better Auth's
    // server-side refresh API usable without exposing token-returning HTTP
    // endpoints to browser or CLI sessions.
    const authPath = decodeURIComponent(context.req.path)
      .replace(/\/+$/, "")
      .toLowerCase();
    // Profile and email edits are blocked too: display names are shown in
    // Team views, so self-service renames could impersonate an owner.
    // Account linking is off: a User keeps the one GitHub account that
    // created them.
    if (
      [
        "/api/auth/get-access-token",
        "/api/auth/refresh-token",
        "/api/auth/update-user",
        "/api/auth/change-email",
        "/api/auth/link-social",
        "/api/auth/unlink-account",
      ].includes(authPath)
    )
      return jsonProblem(context, "forbidden");
    try {
      const response = await auth.handler(context.req.raw);
      response.headers.set("Cache-Control", "no-store");
      return bridgeSessionRedirect(
        await sanitizeAuthResponse(
          context,
          await protectSessionTokens(authPath, response, profile.authSecret),
        ),
        profile,
      );
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
      serverProfileOrigin: profile.origin,
      allowRebind: profile.allowRebind,
    });
    if (!user) return jsonProblem(context, "service_unavailable");
    return context.json(
      {
        authenticated: true,
        user: {
          id: user.id,
          name: session.user.name,
          image: session.user.image ?? null,
        },
      },
      200,
      {
        "Cache-Control": "no-store",
      },
    );
  });

  app.use("/api/v1/devices/bootstrap", protocolCors(profile));
  app.use("/api/v1/devices/enrollments", protocolCors(profile));
  app.use("/api/v1/devices/enrollments/*", protocolCors(profile));
  app.use("/api/v1/devices/self", protocolCors(profile));
  app.use("/api/v1/devices/proofs", protocolCors(profile));
  app.use("/api/v1/devices/proofs/*", protocolCors(profile));
  app.use("/api/v1/devices/*/revoke", protocolCors(profile));
  app.use("/api/v1/account-keys", protocolCors(profile));
  app.use("/api/v1/account-keys/*", protocolCors(profile));
  app.use("/api/v1/grants/bootstrap", protocolCors(profile));
  app.use("/api/v1/operations/*", protocolCors(profile));
  app.use("/api/v1/environments/*", protocolCors(profile));
  app.use("/api/v1/projects/*", protocolCors(profile));
  // The Team membership and invitation surfaces are browser-reachable: the
  // workspace's Members table and invitation dialog call them cross-origin
  // with the session cookie and, for mutations, the browser Device id.
  app.use("/api/v1/teams/*", protocolCors(profile));
  app.use("/api/v1/invitations", protocolCors(profile));
  app.use("/api/v1/invitations/*", protocolCors(profile));
  app.use("/api/v1/github-users/*", protocolCors(profile));
  app.post("/api/v1/devices/bootstrap", smallBodyLimit, async (context) => {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session) return jsonProblem(context, "authentication_required");
    const user = await resolveDotRelayUser(database, {
      serverProfileId: profile.id,
      authSubject: session.user.id,
      serverProfileOrigin: profile.origin,
      allowRebind: profile.allowRebind,
    });
    if (!user) return jsonProblem(context, "service_unavailable");
    try {
      const request = await parseBootstrapRequest(context, profile.id, user.id);
      if (
        !equalBytes(request.keyId, await sha384Digest(request.x25519PublicKey))
      )
        return jsonProblem(context, "invalid_request");
      const result = await new DeviceRepository().completeBootstrap(database, {
        operation: {
          id: request.operationId,
          actorUserId: user.id,
          kind: "DEVICE_ENROLLMENT",
          commandBytes: request.certificateBytes,
          commandDigest: await sha384Digest(request.certificateBytes),
        },
        ...(request.recovery ? { recovery: request.recovery } : {}),
        device: {
          id: request.deviceId,
          identityGeneration: BigInt(request.identityGeneration),
          keyId: request.keyId,
          x25519PublicKey: request.x25519PublicKey,
          ed25519PublicKey: request.ed25519PublicKey,
        },
        certificateObject: {
          id: request.certificateId,
          suite: profile.suite.name,
          formatVersion: 3,
          kind: 2,
          canonicalBytes: request.certificateBytes,
          digest: await sha384Digest(request.certificateBytes),
        },
        ...(request.client ? { client: toClientMetadata(request.client) } : {}),
      });
      return context.json(
        {
          deviceId: request.deviceId,
          identityGeneration: request.identityGeneration,
          active:
            "device" in result ? result.device.lifecycle === "ACTIVE" : true,
        },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      if (error instanceof ContractError)
        return jsonProblem(context, error.code);
      return jsonProblem(context, "state_conflict");
    }
  });

  registerDeviceProofRoutes(app, {
    database,
    profile,
    auth,
    bodyLimit: smallBodyLimit,
  });

  app.post("/api/v1/grants/bootstrap", smallBodyLimit, async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const request = await parseGrantBootstrapRequest(context);
      const grant = parseProtocolObject(request.grantBytes);
      validateProtocolObject(grant);
      if (grant.get(1) !== 7) throw new ContractError("invalid_crypto_object");
      const requiredBytes = (field: number, length: number): Uint8Array => {
        const value = grant.get(field);
        if (!(value instanceof Uint8Array) || value.length !== length)
          throw new ContractError("invalid_crypto_object");
        return value;
      };
      const requiredUuid = (field: number): string =>
        bytesToUuid(requiredBytes(field, 16));
      const senderDeviceId = requiredUuid(24);
      const recipientDeviceId = requiredUuid(25);
      if (
        requiredUuid(11) !== request.teamId ||
        requiredUuid(13) !== request.projectId ||
        senderDeviceId !== actor.deviceId
      )
        throw new ContractError("invalid_crypto_object");
      const project = await database.project.findUnique({
        where: { id: request.projectId },
        select: { teamId: true, currentEpoch: true, lifecycle: true },
      });
      if (!project || project.teamId !== request.teamId)
        throw new Error("Project not found");
      if (project.lifecycle !== "ACTIVE")
        throw new Error("Project is archived");
      // Cheap authorization pre-check before anything is staged; the
      // repository repeats it inside the creating transaction. This endpoint
      // only seals the key to the actor's own Devices, which any active
      // Member may do: they already hold the key (grantCreationAction).
      await requireTeamAction(
        database,
        actor.userId,
        actor.deviceId,
        request.teamId,
        "VIEW",
      );
      const sender = await database.device.findUnique({
        where: { id: actor.deviceId },
        select: {
          x25519PublicKey: true,
          ed25519PublicKey: true,
          userId: true,
        },
      });
      if (!sender) throw new DeviceNotActiveError();
      const recipient =
        recipientDeviceId === actor.deviceId
          ? sender
          : await database.device.findFirst({
              where: { id: recipientDeviceId, lifecycle: "ACTIVE" },
              select: {
                x25519PublicKey: true,
                ed25519PublicKey: true,
                userId: true,
              },
            });
      if (!recipient)
        throw new DeviceNotActiveError("grant recipient device is not active");
      // Another User's Devices receive keys only through Membership
      // provisioning, never through this endpoint.
      if (recipient.userId !== sender.userId)
        throw new Error("actor is not authorized to grant to another User");
      if (
        !equalBytes(
          requiredBytes(39, 32),
          new Uint8Array(recipient.x25519PublicKey),
        )
      )
        throw new ContractError("invalid_crypto_object");
      const epoch = grant.get(30);
      if (
        (typeof epoch !== "number" && typeof epoch !== "bigint") ||
        BigInt(epoch) !== project.currentEpoch ||
        grant.get(37) !== 1 ||
        grant.get(70) !== 1 ||
        grant.get(71) !== 32
      )
        throw new ContractError("stale_epoch");
      const ciphertext = requiredBytes(47, Number(grant.get(72)));
      const ciphertextHash = requiredBytes(48, 48);
      if (
        !equalBytes(ciphertextHash, await sha384Digest(ciphertext)) ||
        !equalBytes(requiredBytes(8, 16), parseUuidBytes(profile.id))
      )
        throw new ContractError("invalid_crypto_object");
      const signature = requiredBytes(4, 64);
      const signingKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(sender.ed25519PublicKey).buffer,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (!(await verifyProtocolObject(grant, signature, signingKey)))
        throw new ContractError("invalid_crypto_object");
      if (!equalBytes(request.digest, await sha384Digest(request.grantBytes)))
        throw new ContractError("invalid_crypto_object");
      // Begun before GrantRepository re-checks authorization, so a refused
      // grant must not stay STAGED forever.
      const operation = {
        id: request.operationId,
        actorUserId: actor.userId,
        actorDeviceId: actor.deviceId,
        kind: "ADMINISTRATION" as const,
        commandBytes: request.grantBytes,
        commandDigest: request.digest,
        expiresAt: new Date(
          Date.now() + profile.limits.stagingTtlSeconds * 1000,
        ),
      };
      const begun = await new OperationRepository().begin(database, operation);
      if (begun.idempotent)
        return context.json({ idempotent: true }, 200, {
          "Cache-Control": "no-store",
        });
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + profile.limits.stagingTtlSeconds * 1000,
      );
      await new StagedObjectRepository().put(database, {
        operationId: request.operationId,
        objectId: request.objectId,
        actorDeviceId: actor.deviceId,
        canonicalBytes: request.grantBytes,
        digest: request.digest,
        createdAt: now,
        expiresAt,
      });
      const result = await new GrantRepository().create(database, {
        operation,
        grant: {
          protocolObject: {
            id: request.objectId,
            suite: profile.suite.name,
            formatVersion: 3,
            kind: 7,
            canonicalBytes: request.grantBytes,
            digest: request.digest,
            projectId: request.projectId,
          },
          projectId: request.projectId,
          teamId: request.teamId,
          senderDeviceId: actor.deviceId,
          recipientDeviceId,
          keyKind: "PROJECT_EPOCH",
          grantKind: "CURRENT_PROJECT_EPOCH",
          projectEpoch: BigInt(epoch),
          plaintextLength: Number(grant.get(71)),
          ciphertextLength: ciphertext.length,
          ciphertextHash,
          recipientDeviceIds: [recipientDeviceId],
        },
      });
      if ("idempotent" in result && result.idempotent)
        return context.json({ idempotent: true }, 200, {
          "Cache-Control": "no-store",
        });
      if (!("grant" in result)) return jsonProblem(context, "state_conflict");
      return context.json(
        { grantObjectId: result.grant.protocolObjectId, idempotent: false },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      if (error instanceof ContractError)
        return jsonProblem(context, error.code);
      if (error instanceof OperationConflictError)
        return jsonProblem(context, "operation_conflict");
      if (error instanceof DeviceNotActiveError)
        return jsonProblem(context, "device_not_active");
      if (error instanceof Error && error.message.includes("not active"))
        return jsonProblem(context, "device_not_active");
      if (error instanceof Error && error.message.includes("not authorized"))
        return jsonProblem(context, "forbidden");
      if (error instanceof Error && error.message.includes("not found"))
        return jsonProblem(context, "resource_not_found");
      return jsonProblem(context, "state_conflict");
    }
  });

  app.get("/api/v1/workspace/boundary", async (context) => {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session) return jsonProblem(context, "authentication_required");
    const user = await resolveDotRelayUser(database, {
      serverProfileId: profile.id,
      authSubject: session.user.id,
      serverProfileOrigin: profile.origin,
      allowRebind: profile.allowRebind,
    });
    if (!user) return jsonProblem(context, "service_unavailable");
    // Device-scoped fields need a Device proof (ADR 0020). Without one the
    // caller gets the session view: no Device ids, keys, rosters, links,
    // grants or envelopes. A proof for a Device revoked since it was issued
    // reads as no Device, as a revoked Device always has.
    const deviceActor = await optionalProtocolActor(
      context,
      database,
      profile,
      auth,
    );
    if (deviceActor instanceof Response && deviceActor.status !== 403)
      return deviceActor;
    const provenDeviceId =
      deviceActor && !(deviceActor instanceof Response)
        ? deviceActor.deviceId
        : null;
    let catalogAccessToken: Promise<string | null> | undefined;

    const requestedEnvironmentId = context.req.query("environment");
    const requestedRepositoryId = context.req.query("githubRepositoryId");
    if (requestedEnvironmentId !== undefined) {
      try {
        parseUuid(requestedEnvironmentId, "environment");
      } catch {
        return jsonProblem(context, "invalid_request");
      }
    }
    if (requestedRepositoryId !== undefined) {
      if (
        !/^[1-9][0-9]{0,18}$/.test(requestedRepositoryId) ||
        BigInt(requestedRepositoryId) > 9_223_372_036_854_775_807n
      )
        return jsonProblem(context, "invalid_request");
    }
    const requestedEnvironment = requestedEnvironmentId
      ? await database.environment.findFirst({
          where: {
            id: requestedEnvironmentId,
            lifecycle: "ACTIVE",
            project: {
              lifecycle: "ACTIVE",
              team: {
                memberships: {
                  some: { userId: user.id, lifecycle: "ACTIVE" },
                },
              },
            },
          },
          select: { id: true, projectId: true },
        })
      : null;
    const membership = await database.membership.findFirst({
      where: { userId: user.id, lifecycle: "ACTIVE" },
      orderBy: { id: "asc" },
      select: { teamId: true },
    });
    const project =
      requestedEnvironmentId !== undefined
        ? requestedEnvironment
          ? await database.project.findFirst({
              where: {
                id: requestedEnvironment.projectId,
                lifecycle: "ACTIVE",
              },
              select: { id: true, teamId: true, currentEpoch: true },
            })
          : null
        : requestedRepositoryId !== undefined
          ? await database.project.findFirst({
              where: {
                githubRepositoryId: BigInt(requestedRepositoryId),
                lifecycle: "ACTIVE",
                team: {
                  memberships: {
                    some: { userId: user.id, lifecycle: "ACTIVE" },
                  },
                },
              },
              select: { id: true, teamId: true, currentEpoch: true },
            })
          : membership
            ? await database.project.findFirst({
                where: { teamId: membership.teamId, lifecycle: "ACTIVE" },
                orderBy: { id: "asc" },
                select: { id: true, teamId: true, currentEpoch: true },
              })
            : null;
    const environment =
      requestedEnvironmentId !== undefined
        ? requestedEnvironment && project
          ? await database.environment.findUnique({
              where: { id: requestedEnvironment.id },
              select: {
                id: true,
                label: true,
                currentHeadId: true,
                currentHead: {
                  select: { protocolObject: { select: { digest: true } } },
                },
              },
            })
          : null
        : project
          ? await database.environment.findFirst({
              where: { projectId: project.id, lifecycle: "ACTIVE" },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                id: true,
                label: true,
                currentHeadId: true,
                currentHead: {
                  select: { protocolObject: { select: { digest: true } } },
                },
              },
            })
          : null;
    const devices = await database.device.findMany({
      where: { userId: user.id, lifecycle: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        x25519PublicKey: true,
        ed25519PublicKey: true,
        displayName: true,
        clientKind: true,
        osName: true,
        clientSummary: true,
      },
    });
    // Resolve only the Device this client proved. A fallback to the first
    // active Device would let a new installation claim a Device it does not
    // possess and receive another Device's epoch grant.
    const device = provenDeviceId
      ? (devices.find((candidate) => candidate.id === provenDeviceId) ?? null)
      : null;
    const deviceActive = device !== null;
    const currentEpochGrantCount =
      device && project
        ? await database.grantObject.count({
            where: {
              projectId: project.id,
              recipientDeviceId: device.id,
              projectEpoch: project.currentEpoch,
              grantKind: "CURRENT_PROJECT_EPOCH",
            },
          })
        : 0;
    const epochGrant =
      device && project && currentEpochGrantCount > 0
        ? await database.grantObject.findFirst({
            where: {
              projectId: project.id,
              recipientDeviceId: device.id,
              projectEpoch: project.currentEpoch,
              grantKind: "CURRENT_PROJECT_EPOCH",
            },
            select: {
              protocolObject: { select: { canonicalBytes: true } },
            },
            orderBy: { protocolObject: { acceptedAt: "desc" } },
          })
        : null;
    // The current Project Epoch Key wrapped by this User's Account Master
    // Key: any of the User's Devices that recovers the AMK can open it
    // without help from an existing Device. A stale-epoch envelope is
    // worthless for decryption, so only the current epoch is reported.
    const accountKeyEnvelope =
      device && project
        ? await database.accountKeyEnvelopeObject.findFirst({
            where: {
              userId: user.id,
              envelopeType: "PROJECT_EPOCH_KEY",
              projectId: project.id,
              projectEpoch: project.currentEpoch,
              retiredAt: null,
            },
            orderBy: { createdAt: "desc" },
            select: { protocolObject: { select: { canonicalBytes: true } } },
          })
        : null;
    // The Project's key chain (ADR 0014): each link seals an epoch key under
    // the next. Clients verify and walk them from the current epoch down.
    const epochKeyLinks =
      device && project
        ? await database.projectEpochKeyLinkObject.findMany({
            where: {
              projectId: project.id,
              toEpoch: { lte: project.currentEpoch },
            },
            orderBy: { toEpoch: "asc" },
            select: { protocolObject: { select: { canonicalBytes: true } } },
          })
        : [];
    const userValueKeyEnvelope = device
      ? await database.accountKeyEnvelopeObject.findFirst({
          where: {
            userId: user.id,
            envelopeType: "USER_VALUE_KEY",
            ownerUserId: user.id,
            valueGeneration: 1n,
            retiredAt: null,
          },
          orderBy: { createdAt: "desc" },
          select: { protocolObject: { select: { canonicalBytes: true } } },
        })
      : null;
    const peerGrantRecipients =
      device && project
        ? new Set(
            (
              await database.grantObject.findMany({
                where: {
                  projectId: project.id,
                  projectEpoch: project.currentEpoch,
                  grantKind: "CURRENT_PROJECT_EPOCH",
                  recipientDeviceId: {
                    in: devices.map((candidate) => candidate.id),
                  },
                },
                select: { recipientDeviceId: true },
              })
            ).map((grant) => grant.recipientDeviceId),
          )
        : new Set<string>();
    // With a resolved Project, the trust set spans the whole Team: Members'
    // Devices, including Devices revoked after they signed. Without one, a
    // client can sync nothing, so only its own Devices are reported.
    const signingTrustDevices =
      device && project
        ? await loadTeamSigningTrustDevices(database, project.teamId)
        : [];
    // The latest Account Device roster (ADR 0015) of this User and of every
    // User whose Devices are in the trust set; null where none exists yet.
    // Clients verify each against the identity they derived or pinned.
    const accountRosters = device
      ? await new AccountRosterRepository().latestFor(database, [
          user.id,
          ...signingTrustDevices.map((entry) => entry.userId),
        ])
      : new Map<string, Uint8Array | null>();
    // A rotation owed since a Member was removed or a Device revoked. It is
    // advice for UI copy and never blocks publication; rotationRequired
    // stays the publication gate and is not set by it.
    const rotationOwed = project
      ? await new ProjectRotationObligationRepository().outstanding(
          database,
          project.id,
        )
      : null;
    return context.json(
      {
        session: {
          active: true,
          userId: user.id,
          displayName: session.user.name,
        },
        environment: {
          headRevision: environment?.currentHeadId ?? "empty-environment",
          id: environment?.id ?? null,
          label: environment?.label ?? null,
          projectId: project?.id ?? null,
          teamId: project?.teamId ?? null,
          headHash: environment?.currentHead?.protocolObject.digest
            ? bytesToHex(
                new Uint8Array(environment.currentHead.protocolObject.digest),
              )
            : null,
          projectEpoch: project?.currentEpoch.toString() ?? null,
          rotationOwed: rotationOwed
            ? {
                since: rotationOwed.since.toISOString(),
                sinceEpoch: rotationOwed.sinceEpoch.toString(),
                membershipRemovals: rotationOwed.membershipRemovals,
                deviceRevocations: rotationOwed.deviceRevocations,
              }
            : null,
        },
        device: {
          active: deviceActive,
          label: deviceActive ? "Active Device" : "No active Device",
          ...(device
            ? {
                id: device.id,
                encryptionPublicKey: bytesToHex(
                  new Uint8Array(device.x25519PublicKey),
                ),
                signingPublicKey: bytesToHex(
                  new Uint8Array(device.ed25519PublicKey),
                ),
                ...deviceDisplayFields(device),
              }
            : {}),
        },
        signingTrustKeys: !device
          ? []
          : project
            ? signingTrustDevices.map((entry) => entry.signingPublicKey)
            : devices.map((candidate) =>
                bytesToHex(new Uint8Array(candidate.ed25519PublicKey)),
              ),
        signingTrustDevices,
        ...(epochGrant?.protocolObject.canonicalBytes
          ? {
              epochGrant: bytesToBase64(
                new Uint8Array(epochGrant.protocolObject.canonicalBytes),
              ),
            }
          : {}),
        ...(accountKeyEnvelope?.protocolObject.canonicalBytes
          ? {
              accountKeyEnvelope: bytesToBase64(
                new Uint8Array(
                  accountKeyEnvelope.protocolObject.canonicalBytes,
                ),
              ),
            }
          : {}),
        ...(userValueKeyEnvelope?.protocolObject.canonicalBytes
          ? {
              userValueKeyEnvelope: bytesToBase64(
                new Uint8Array(
                  userValueKeyEnvelope.protocolObject.canonicalBytes,
                ),
              ),
            }
          : {}),
        accountRosters: Object.fromEntries(
          [...accountRosters].map(([userId, roster]) => [
            userId,
            roster ? bytesToBase64(roster) : null,
          ]),
        ),
        epochKeyLinks: epochKeyLinks.map((link) =>
          bytesToBase64(new Uint8Array(link.protocolObject.canonicalBytes)),
        ),
        peerDevices: (device ? devices : [])
          .filter((candidate) => candidate.id !== device?.id)
          .map((candidate) => ({
            id: candidate.id,
            encryptionPublicKey: bytesToHex(
              new Uint8Array(candidate.x25519PublicKey),
            ),
            signingPublicKey: bytesToHex(
              new Uint8Array(candidate.ed25519PublicKey),
            ),
            hasEpochGrant: peerGrantRecipients.has(candidate.id),
            ...deviceDisplayFields(candidate),
          })),
        grantsReady:
          deviceActive &&
          membership !== null &&
          project !== null &&
          currentEpochGrantCount > 0,
        activeDeviceCount: devices.length,
        epochCurrent: project !== null,
        // Current CLI and web clients refuse to publish while this is true,
        // so a removal or revocation reports environment.rotationOwed
        // instead (publication must not be blocked).
        rotationRequired: false,
        projectEpoch: project?.currentEpoch.toString() ?? null,
        profile: {
          name: "DotRelay Server Profile",
          origin: profile.origin,
          pinned: true,
          serverProfileId: profile.id,
        },
        crypto: { available: true },
        catalog: await loadWorkspaceCatalog(database, user.id, {
          ...(githubFetch ? { fetch: githubFetch } : {}),
          // Resolved at most once per request, and only on a cache miss.
          accessToken: () =>
            (catalogAccessToken ??= delegatedGitHubAccessToken(
              auth,
              session.user.id,
            )),
          cacheScope: session.user.id,
        }),
      },
      200,
      { "Cache-Control": "no-store" },
    );
  });

  // Display metadata for the Device this client presents. Two shapes share
  // one route: a describe payload (auto name + kind/OS/summary) refreshes an
  // un-overridden name and always updates the client fields; a displayName
  // payload renames and sets nameOverridden so later describes stop
  // clobbering it. Body has no Idempotency-Key: a repeated describe is
  // idempotent by construction, and a repeated rename rewrites the same row.
  app.post("/api/v1/devices/self", smallBodyLimit, async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const contentType = context.req.header("Content-Type")?.split(";", 1)[0];
      if (contentType?.trim() !== "application/json")
        return jsonProblem(context, "unsupported_media_type");
      const body = parseJsonObject<{
        client?: unknown;
        displayName?: unknown;
        resetName?: unknown;
      }>(await context.req.json(), ["client", "displayName", "resetName"]);
      const client = parseDeviceClientInfo(body.client);
      const hasRename =
        body.displayName !== undefined && body.displayName !== null;
      const rename = hasRename
        ? sanitizeDeviceName(String(body.displayName))
        : null;
      if (hasRename && !rename) return jsonProblem(context, "invalid_request");
      if (
        body.resetName !== undefined &&
        body.resetName !== null &&
        body.resetName !== true &&
        body.resetName !== false
      )
        return jsonProblem(context, "invalid_request");
      if (!client && !hasRename && body.resetName !== true)
        return jsonProblem(context, "invalid_request");
      const existing = await database.device.findUnique({
        where: { id: actor.deviceId },
        select: {
          displayName: true,
          nameOverridden: true,
          clientKind: true,
          osName: true,
          clientSummary: true,
        },
      });
      if (!existing) return jsonProblem(context, "device_not_active");
      const data: Record<string, unknown> = {};
      if (client) {
        data.clientKind = client.clientKind === "cli" ? "CLI" : "BROWSER";
        if (client.osName !== null) data.osName = client.osName;
        if (client.clientSummary !== null)
          data.clientSummary = client.clientSummary;
        if (!existing.nameOverridden) data.displayName = client.displayName;
      }
      if (rename) {
        data.displayName = rename;
        data.nameOverridden = true;
      } else if (body.resetName === true) {
        data.nameOverridden = false;
        if (client) data.displayName = client.displayName;
      }
      const result =
        Object.keys(data).length === 0
          ? existing
          : await database.device.update({
              where: { id: actor.deviceId },
              data,
              select: {
                displayName: true,
                clientKind: true,
                osName: true,
                clientSummary: true,
                nameOverridden: true,
              },
            });
      return context.json(
        {
          name: result.displayName,
          clientKind: result.clientKind
            ? result.clientKind === "CLI"
              ? "cli"
              : "browser"
            : null,
          osName: result.osName,
          clientSummary: result.clientSummary,
          nameOverridden: result.nameOverridden,
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      if (error instanceof ContractError)
        return jsonProblem(context, error.code);
      return jsonProblem(context, "service_unavailable");
    }
  });

  registerAdministrationRoutes(app, {
    database,
    profile,
    auth,
    ...(githubFetch ? { githubFetch } : {}),
  });
  registerMembershipRoutes(app, {
    database,
    profile,
    auth,
    notifications,
    ...(githubFetch ? { githubFetch } : {}),
  });

  registerDeviceRoutes(app, { database, profile, auth });
  registerAccountRoutes(app, { database, profile, auth });
  registerMembershipProvisioningRoutes(app, {
    database,
    profile,
    auth,
    notifications,
  });

  registerProtocolRoutes(app, { database, profile, auth });

  return app;
};

const profile = loadServerProfileConfig();
const database = createDatabaseClient();
type RequestIpServer = {
  stop(closeActiveConnections?: boolean): Promise<void>;
  readonly requestIP: (request: Request) => { readonly address: string } | null;
};
let server: RequestIpServer | undefined;
const resolveClientIp = createClientIpResolver(profile);
const runtimeMetrics = createMetricsRegistry();
const runtimeObservability = createApiObservability(database, {
  ...(import.meta.main ? { diagnostics: createConsoleDiagnosticSink() } : {}),
  metrics: runtimeMetrics,
  resolveClientIp: (request) =>
    resolveClientIp(
      server?.requestIP(request)?.address ?? null,
      request.headers,
    ),
});
export const auth = createAuth(
  createBetterAuthDatabaseAdapter(database),
  profile,
  {
    onGitHubProfile: (github) => recordGitHubLogin(database, github),
  },
);
const emailConfig = loadEmailConfig();
const runtimeNotifications = createEmailNotifier({
  database,
  profile,
  config: emailConfig,
  transport: emailConfig.apiKey
    ? createResendTransport({
        apiKey: emailConfig.apiKey,
        from: emailConfig.from,
      })
    : null,
  diagnostics: runtimeObservability.diagnostics,
  // The same best-effort, cached lookup the workspace catalog uses, on the
  // acting owner's or admin's Delegated GitHub Access.
  resolveProjectName: async ({ githubRepositoryId, actorUserId }) => {
    const actor = await database.user.findUnique({
      where: { id: actorUserId },
      select: { authSubject: true },
    });
    if (!actor) return undefined;
    const repository = await lookupGitHubRepositoryDisplay(githubRepositoryId, {
      accessToken: () => delegatedGitHubAccessToken(auth, actor.authSubject),
      cacheScope: actor.authSubject,
    });
    return repository ? `${repository.owner}/${repository.name}` : undefined;
  },
});
export const app = createApi({
  database,
  profile,
  auth,
  observability: runtimeObservability,
  notifications: runtimeNotifications,
});
export { createApi, loadServerProfileConfig };

if (import.meta.main) {
  if (!(await databaseReady(database)))
    throw new Error(
      "Database schema is not ready; run the deployment migration process",
    );
  await ensureServerProfile(database, {
    id: profile.id,
    origin: profile.origin,
    allowRebind: profile.allowRebind,
  });
  const metricsConfig = loadMetricsConfig(process.env, profile.isProduction);
  server = Bun.serve({
    fetch: app.fetch,
    port: Number(process.env.PORT ?? 3001),
    maxRequestBodySize: maxRequestBodyBytes(profile),
  });
  console.error(`DotRelay API listening on ${profile.origin}`);
  if (!emailConfig.apiKey)
    console.error("Transactional email is off: RESEND_API_KEY is not set");
  // Private, opt-in listener; never routed through the public API surface.
  startMetricsServer(metricsConfig, {
    registry: runtimeMetrics,
    ready: () => apiReady(database),
    onReadiness: runtimeObservability.recordReadiness,
  });
  const cleanupTimer = setInterval(
    () => {
      void runtimeObservability.runRetentionCleanup().catch(() => {
        // The expiry failure is already recorded by the observability adapter.
      });
    },
    // Expired staging counts against the quota until it is deleted.
    10 * 60 * 1000,
  );
  cleanupTimer.unref?.();
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      process.env.MAINTENANCE_MODE = "true";
      clearInterval(cleanupTimer);
      // Keep the whole sequence under Docker's default 10 s stop timeout.
      const deadline = setTimeout(() => process.exit(1), 9_500);
      deadline.unref();
      void (async () => {
        try {
          // /ready now fails; give load balancers time to stop routing here.
          await Bun.sleep(shutdownDrainMs(process.env.SHUTDOWN_DRAIN_MS));
          await server?.stop(false);
          // Let queued emails finish within the remaining stop budget.
          await Promise.race([runtimeNotifications.drain(), Bun.sleep(2_000)]);
          await database.$disconnect();
          clearTimeout(deadline);
          process.exit(0);
        } catch {
          process.exit(1);
        }
      })();
    });
}
