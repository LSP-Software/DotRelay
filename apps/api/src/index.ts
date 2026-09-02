import {
  bytesToUuid,
  ContractError,
  createProblem,
  DEVICE_ID_HEADER,
  type ProblemCode,
  parseCapabilitiesDocument,
  parseProtocolObject,
  parseUuid,
  validateProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import {
  createBetterAuthDatabaseAdapter,
  createDatabaseClient,
  type DatabaseClient,
  DeviceRepository,
  ensureServerProfile,
  GrantRepository,
  OperationConflictError,
  OperationRepository,
  resolveDotRelayUser,
  StagedObjectRepository,
  sha384Digest,
} from "@dotrelay/database";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
import { requireProtocolActor } from "./protocol/context";

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

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const bytesToHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

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
    operationId,
    deviceId,
    certificateId,
    identityGeneration,
    x25519PublicKey,
    ed25519PublicKey,
    keyId,
    certificateBytes,
  };
};

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
    allowHeaders: ["Content-Type", "Authorization", DEVICE_ID_HEADER],
    allowMethods: ["POST", "OPTIONS"],
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

  app.use("/api/v1/devices/bootstrap", protocolCors(profile));
  app.use("/api/v1/grants/bootstrap", protocolCors(profile));
  app.post(
    "/api/v1/devices/bootstrap",
    bodyLimit({
      maxSize: profile.limits.protocolObjectBytes,
      onError: (context) => jsonProblem(context, "payload_too_large"),
    }),
    async (context) => {
      const session = await auth.api.getSession({
        headers: context.req.raw.headers,
      });
      if (!session) return jsonProblem(context, "authentication_required");
      const user = await resolveDotRelayUser(database, {
        serverProfileId: profile.id,
        authSubject: session.user.id,
      });
      if (!user) return jsonProblem(context, "service_unavailable");
      try {
        const request = await parseBootstrapRequest(
          context,
          profile.id,
          user.id,
        );
        if (
          !equalBytes(
            request.keyId,
            await sha384Digest(request.x25519PublicKey),
          )
        )
          return jsonProblem(context, "invalid_request");
        const result = await new DeviceRepository().completeBootstrap(
          database,
          {
            operation: {
              id: request.operationId,
              actorUserId: user.id,
              kind: "DEVICE_ENROLLMENT",
              commandBytes: request.certificateBytes,
              commandDigest: await sha384Digest(request.certificateBytes),
            },
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
          },
        );
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
    },
  );

  app.post(
    "/api/v1/grants/bootstrap",
    bodyLimit({
      maxSize: profile.limits.protocolObjectBytes,
      onError: (context) => jsonProblem(context, "payload_too_large"),
    }),
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      try {
        const request = await parseGrantBootstrapRequest(context);
        const grant = parseProtocolObject(request.grantBytes);
        validateProtocolObject(grant);
        if (grant.get(1) !== 7)
          throw new ContractError("invalid_crypto_object");
        const requiredBytes = (field: number, length: number): Uint8Array => {
          const value = grant.get(field);
          if (!(value instanceof Uint8Array) || value.length !== length)
            throw new ContractError("invalid_crypto_object");
          return value;
        };
        const requiredUuid = (field: number): string =>
          bytesToUuid(requiredBytes(field, 16));
        if (
          requiredUuid(11) !== request.teamId ||
          requiredUuid(13) !== request.projectId ||
          requiredUuid(24) !== actor.deviceId ||
          requiredUuid(25) !== actor.deviceId
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
        const device = await database.device.findUnique({
          where: { id: actor.deviceId },
          select: { x25519PublicKey: true, ed25519PublicKey: true },
        });
        if (!device) throw new Error("Device is not active");
        if (
          !equalBytes(
            requiredBytes(39, 32),
            new Uint8Array(device.x25519PublicKey),
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
          new Uint8Array(device.ed25519PublicKey).buffer,
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        if (!(await verifyProtocolObject(grant, signature, signingKey)))
          throw new ContractError("invalid_crypto_object");
        if (!equalBytes(request.digest, await sha384Digest(request.grantBytes)))
          throw new ContractError("invalid_crypto_object");
        const operation = {
          id: request.operationId,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          kind: "ADMINISTRATION" as const,
          commandBytes: request.grantBytes,
          commandDigest: request.digest,
        };
        const begun = await new OperationRepository().begin(
          database,
          operation,
        );
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
            recipientDeviceId: actor.deviceId,
            keyKind: "PROJECT_EPOCH",
            grantKind: "CURRENT_PROJECT_EPOCH",
            projectEpoch: BigInt(epoch),
            plaintextLength: Number(grant.get(71)),
            ciphertextLength: ciphertext.length,
            ciphertextHash,
            recipientDeviceIds: [actor.deviceId],
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
        if (error instanceof Error && error.message.includes("not active"))
          return jsonProblem(context, "device_not_active");
        if (error instanceof Error && error.message.includes("not authorized"))
          return jsonProblem(context, "forbidden");
        if (error instanceof Error && error.message.includes("not found"))
          return jsonProblem(context, "resource_not_found");
        return jsonProblem(context, "state_conflict");
      }
    },
  );

  app.get("/api/v1/workspace/boundary", async (context) => {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session) return jsonProblem(context, "authentication_required");
    const user = await resolveDotRelayUser(database, {
      serverProfileId: profile.id,
      authSubject: session.user.id,
    });
    if (!user) return jsonProblem(context, "service_unavailable");

    const requestedEnvironmentId = context.req.query("environment");
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
              orderBy: { id: "asc" },
              select: {
                id: true,
                currentHeadId: true,
                currentHead: {
                  select: { protocolObject: { select: { digest: true } } },
                },
              },
            })
          : null;
    const requestedDeviceId = context.req.header(DEVICE_ID_HEADER);
    const device = await database.device.findFirst({
      where: {
        ...(requestedDeviceId ? { id: requestedDeviceId } : {}),
        userId: user.id,
        lifecycle: "ACTIVE",
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, x25519PublicKey: true, ed25519PublicKey: true },
    });
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
          projectId: project?.id ?? null,
          teamId: project?.teamId ?? null,
          headHash: environment?.currentHead?.protocolObject.digest
            ? bytesToHex(
                new Uint8Array(environment.currentHead.protocolObject.digest),
              )
            : null,
          projectEpoch: project?.currentEpoch.toString() ?? null,
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
              }
            : {}),
        },
        grantsReady:
          deviceActive &&
          membership !== null &&
          project !== null &&
          currentEpochGrantCount > 0,
        epochCurrent: project !== null,
        rotationRequired: false,
        projectEpoch: project?.currentEpoch.toString() ?? null,
        profile: {
          name: "DotRelay Server Profile",
          origin: profile.origin,
          pinned: true,
          serverProfileId: profile.id,
        },
        crypto: { available: true },
      },
      200,
      { "Cache-Control": "no-store" },
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
