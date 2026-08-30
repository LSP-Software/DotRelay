import {
  CBOR_LIMITS,
  ContractError,
  createProblem,
  encodeSyncPage,
  formatSyncCursor,
  importSigningPublicKey,
  parseFinalizePublicationRequest,
  parseIdempotencyKey,
  parseProtocolObject,
  parseSyncCursorValue,
  parseSyncRequest,
  parseUuid,
  PROTOCOL_MEDIA_TYPE,
  type ProblemCode,
  validateProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import {
  mutationToWire,
  OperationRepository,
  PublicationRepository,
  StagedObjectRepository,
  SyncRepository,
  validateProtocolProjection,
} from "@dotrelay/database";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "../auth";
import type { ServerProfileConfig } from "../profile";
import { requireProtocolActor } from "./context";
import { digestRequestBody, enrichStaleHead, mapPersistenceError } from "./errors";

export const COMMAND_STAGE_OBJECT_ID =
  "00000000-0000-4000-8000-0000000000c0" as const;

type ProtocolRouteDependencies = Readonly<{
  readonly database: DatabaseClient;
  readonly profile: ServerProfileConfig;
  readonly auth: DotRelayAuth;
}>;

const respondProblem = (
  code: ProblemCode,
  details?: {
    readonly headId?: string;
    readonly headHash?: string;
  },
) => {
  const problem = createProblem(code, details);
  return {
    body: problem,
    status: problem.status as ContentfulStatusCode,
  };
};

const readProtocolBody = async (
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array | Response> => {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  if (mediaType !== PROTOCOL_MEDIA_TYPE)
    return new Response(
      JSON.stringify(createProblem("unsupported_media_type")),
      {
        status: 415,
        headers: {
          "Content-Type": "application/problem+json",
          "Cache-Control": "no-store",
        },
      },
    );
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0 || body.length > maximumBytes)
    return new Response(JSON.stringify(createProblem("payload_too_large")), {
      status: 413,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
      },
    });
  return body;
};

const handlePersistenceFailure = async (
  database: DatabaseClient,
  error: unknown,
): Promise<{ code: ProblemCode; headId?: string; headHash?: string }> => {
  const mapped = mapPersistenceError(error);
  if (!mapped) return { code: "service_unavailable" };
  if (mapped.code === "stale_head" && mapped.headId && !mapped.headHash) {
    const head = await enrichStaleHead(database, mapped.headId);
    return { code: mapped.code, ...head };
  }
  return mapped;
};

const parseOperationKind = (
  value: string | undefined,
): "REVISION_PUBLICATION" | "ROLLBACK" | "EPOCH_ROTATION" => {
  if (
    value !== "REVISION_PUBLICATION" &&
    value !== "ROLLBACK" &&
    value !== "EPOCH_ROTATION"
  )
    throw new ContractError("invalid_request");
  return value;
};

export const registerProtocolRoutes = (
  app: Hono,
  { database, profile, auth }: ProtocolRouteDependencies,
) => {
  const operations = new OperationRepository();
  const staging = new StagedObjectRepository();
  const publications = new PublicationRepository();
  const synchronization = new SyncRepository();

  app.post("/api/v1/operations/:operationId/begin", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    const operationId = parseUuid(context.req.param("operationId"), "operationId");
    const idempotencyKey = context.req.header("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey !== operationId) {
      const problem = respondProblem("invalid_request");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    parseIdempotencyKey(operationId);
    let kind: "REVISION_PUBLICATION" | "ROLLBACK" | "EPOCH_ROTATION";
    try {
      kind = parseOperationKind(context.req.header("X-DotRelay-Operation-Kind") ?? undefined);
    } catch (error) {
      if (error instanceof ContractError) {
        const problem = respondProblem(error.code);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      const problem = respondProblem("invalid_request");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const commandBody = await readProtocolBody(context.req.raw, profile.limits.protocolObjectBytes);
    if (commandBody instanceof Response) return commandBody;
    try {
      validateProtocolObject(parseProtocolObject(commandBody));
    } catch (error) {
      const code =
        error instanceof ContractError ? error.code : "invalid_crypto_object";
      const problem = respondProblem(code);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const commandDigest = await digestRequestBody(commandBody);
    const expiresHeader = context.req.header("X-DotRelay-Expires-At");
    const expiresAt =
      expiresHeader && !Number.isNaN(Date.parse(expiresHeader))
        ? new Date(expiresHeader)
        : new Date(Date.now() + profile.limits.stagingTtlSeconds * 1000);
    const createdAt = new Date();
    try {
      await staging.put(database, {
        operationId,
        objectId: COMMAND_STAGE_OBJECT_ID,
        actorDeviceId: actor.deviceId,
        canonicalBytes: commandBody,
        digest: commandDigest,
        createdAt,
        expiresAt,
      });
      const result = await operations.begin(database, {
        id: operationId,
        actorUserId: actor.userId,
        actorDeviceId: actor.deviceId,
        kind,
        commandBytes: commandBody,
        commandDigest,
        expiresAt,
      });
      return context.json(
        {
          operationId,
          status: result.operation.status,
          idempotent: result.idempotent,
          expiresAt: expiresAt.toISOString(),
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      const mapped = await handlePersistenceFailure(database, error);
      const problem = respondProblem(mapped.code, mapped);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
  });

  app.put("/api/v1/operations/:operationId/staging/:objectId", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    const operationId = parseUuid(context.req.param("operationId"), "operationId");
    const objectId = parseUuid(context.req.param("objectId"), "objectId");
    if (objectId === COMMAND_STAGE_OBJECT_ID) {
      const problem = respondProblem("invalid_request");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const body = await readProtocolBody(context.req.raw, profile.limits.protocolObjectBytes);
    if (body instanceof Response) return body;
    try {
      validateProtocolObject(parseProtocolObject(body));
    } catch (error) {
      const code =
        error instanceof ContractError ? error.code : "invalid_crypto_object";
      const problem = respondProblem(code);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const digest = await digestRequestBody(body);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + profile.limits.stagingTtlSeconds * 1000);
    try {
      await staging.put(database, {
        operationId,
        objectId,
        actorDeviceId: actor.deviceId,
        canonicalBytes: body,
        digest,
        createdAt,
        expiresAt,
      });
      return context.json({ operationId, objectId }, 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      const mapped = await handlePersistenceFailure(database, error);
      const problem = respondProblem(mapped.code, mapped);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
  });

  app.delete("/api/v1/operations/:operationId", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    const operationId = parseUuid(context.req.param("operationId"), "operationId");
    try {
      await operations.cancel(database, {
        operationId,
        actorUserId: actor.userId,
        actorDeviceId: actor.deviceId,
      });
      return context.body(null, 204, { "Cache-Control": "no-store" });
    } catch (error) {
      const mapped = await handlePersistenceFailure(database, error);
      const problem = respondProblem(mapped.code, mapped);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
  });

  app.post("/api/v1/operations/:operationId/finalize", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    const operationId = parseUuid(context.req.param("operationId"), "operationId");
    let finalizeRequest: ReturnType<typeof parseFinalizePublicationRequest>;
    try {
      finalizeRequest = parseFinalizePublicationRequest(await context.req.json());
    } catch (error) {
      const code =
        error instanceof ContractError ? error.code : "invalid_request";
      const problem = respondProblem(code);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const operation = await database.operation.findUnique({
      where: { id: operationId },
    });
    if (
      !operation ||
      operation.actorUserId !== actor.userId ||
      operation.actorDeviceId !== actor.deviceId
    ) {
      const problem = respondProblem("resource_not_found");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const environment = await database.environment.findUnique({
      where: { id: finalizeRequest.environmentId },
      include: { project: true },
    });
    if (!environment) {
      const problem = respondProblem("resource_not_found");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const stagedIds = [
      COMMAND_STAGE_OBJECT_ID,
      finalizeRequest.revision.protocolObjectId,
      finalizeRequest.descriptor.protocolObjectId,
      ...finalizeRequest.lanes.map((lane) => lane.protocolObjectId),
    ];
    const stagedRows = await database.stagedObject.findMany({
      where: {
        operationId,
        objectId: { in: stagedIds },
        actorDeviceId: actor.deviceId,
        committedAt: null,
      },
    });
    if (stagedRows.length !== stagedIds.length) {
      const problem = respondProblem("staged_object_missing");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const stagedById = new Map(stagedRows.map((row) => [row.objectId, row]));
    const commandStaged = stagedById.get(COMMAND_STAGE_OBJECT_ID);
    if (!commandStaged) {
      const problem = respondProblem("staged_object_missing");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const buildProtocolObject = (objectId: string) => {
      const staged = stagedById.get(objectId);
      if (!staged) throw new Error("protocol object was not staged by the actor");
      const parsed = parseProtocolObject(new Uint8Array(staged.canonicalBytes));
      return {
        id: objectId,
        suite: "dotrelay-e2ee-v3-classical-webcrypto",
        formatVersion: 3,
        kind: parsed.get(1) as number,
        canonicalBytes: new Uint8Array(staged.canonicalBytes),
        digest: new Uint8Array(staged.digest),
        projectId: environment.projectId,
        environmentId: environment.id,
      };
    };
    const revisionObject = buildProtocolObject(
      finalizeRequest.revision.protocolObjectId,
    );
    validateProtocolProjection(revisionObject);
    const signingDevice = await database.device.findUnique({
      where: { id: actor.deviceId },
      select: { ed25519PublicKey: true },
    });
    if (!signingDevice) {
      const problem = respondProblem("device_not_active");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const parsedRevision = parseProtocolObject(revisionObject.canonicalBytes);
    const signature = parsedRevision.get(4);
    if (!(signature instanceof Uint8Array)) {
      const problem = respondProblem("invalid_crypto_object");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const verified = await verifyProtocolObject(
      parsedRevision,
      signature,
      await importSigningPublicKey(new Uint8Array(signingDevice.ed25519PublicKey)),
    );
    if (!verified) {
      const problem = respondProblem("invalid_crypto_object");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const operationKind =
      finalizeRequest.revision.mutation === "ROLLBACK"
        ? "ROLLBACK"
        : "REVISION_PUBLICATION";
    try {
      const result = await publications.publishRevision(database, {
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          kind: operationKind,
          commandBytes: new Uint8Array(commandStaged.canonicalBytes),
          commandDigest: new Uint8Array(commandStaged.digest),
          ...(operation.expiresAt ? { expiresAt: operation.expiresAt } : {}),
        },
        environmentId: finalizeRequest.environmentId,
        expectedHeadId: finalizeRequest.expectedHeadId,
        revision: {
          id: finalizeRequest.revision.id,
          protocolObjectId: finalizeRequest.revision.protocolObjectId,
          ...(finalizeRequest.revision.parentHash
            ? { parentHash: finalizeRequest.revision.parentHash }
            : {}),
          projectEpoch: BigInt(finalizeRequest.revision.projectEpoch),
          mutation: finalizeRequest.revision.mutation,
          authoredAtMs: BigInt(finalizeRequest.revision.authoredAtMs),
          ...(finalizeRequest.revision.rollbackTargetId
            ? { rollbackTargetId: finalizeRequest.revision.rollbackTargetId }
            : {}),
        },
        revisionObject,
        descriptor: {
          protocolObject: buildProtocolObject(
            finalizeRequest.descriptor.protocolObjectId,
          ),
          schemaVersion: finalizeRequest.descriptor.schemaVersion,
          descriptorHash: finalizeRequest.descriptor.descriptorHash,
          laneCount: finalizeRequest.descriptor.laneCount,
        },
        lanes: finalizeRequest.lanes.map((lane) => ({
          lane: {
            id: lane.id,
            protocolObjectId: lane.protocolObjectId,
            projectId: environment.projectId,
            environmentId: environment.id,
            scope: lane.scope,
            ...(lane.ownerUserId ? { ownerUserId: lane.ownerUserId } : {}),
            ...(lane.originalProviderUserId
              ? { originalProviderUserId: lane.originalProviderUserId }
              : {}),
            projectEpoch: BigInt(lane.projectEpoch),
            ...(lane.valueGeneration !== undefined
              ? { valueGeneration: BigInt(lane.valueGeneration) }
              : {}),
            plaintextLength: lane.plaintextLength,
            ciphertextLength: lane.ciphertextLength,
            ciphertextHash: lane.ciphertextHash,
          },
          protocolObject: buildProtocolObject(lane.protocolObjectId),
        })),
        commitments: finalizeRequest.commitments.map((commitment) => ({
          ordinal: commitment.ordinal,
          laneObjectId: commitment.laneObjectId,
          objectHash: commitment.objectHash,
          projectEpoch: BigInt(commitment.projectEpoch),
          scope: commitment.scope,
          ciphertextLength: commitment.ciphertextLength,
          ...(commitment.valueGeneration !== undefined
            ? { valueGeneration: BigInt(commitment.valueGeneration) }
            : {}),
          ...(commitment.ownerUserId
            ? { ownerUserId: commitment.ownerUserId }
            : {}),
          ...(commitment.originalProviderUserId
            ? { originalProviderUserId: commitment.originalProviderUserId }
            : {}),
        })),
        audit: {
          kind:
            finalizeRequest.revision.mutation === "ROLLBACK"
              ? "ROLLBACK_PUBLISHED"
              : "REVISION_PUBLISHED",
          entityKind: "ENVIRONMENT",
          entityId: finalizeRequest.environmentId,
        },
      });
      return context.json(
        { revisionId: result.revision.id, idempotent: result.idempotent },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      const mapped = await handlePersistenceFailure(database, error);
      const problem = respondProblem(mapped.code, mapped);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
  });

  app.post("/api/v1/environments/:environmentId/sync", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    const environmentId = parseUuid(
      context.req.param("environmentId"),
      "environmentId",
    );
    let syncRequest: ReturnType<typeof parseSyncRequest>;
    try {
      syncRequest = parseSyncRequest(await context.req.json());
    } catch (error) {
      const code =
        error instanceof ContractError ? error.code : "invalid_request";
      const problem = respondProblem(code);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const limit = syncRequest.pagination.limit ?? CBOR_LIMITS.maxSyncObjects;
    const cursor =
      syncRequest.pagination.cursor === undefined
        ? undefined
        : parseSyncCursorValue(syncRequest.pagination.cursor);
    try {
      const page = await synchronization.synchronize(database, {
        actorUserId: actor.userId,
        actorDeviceId: actor.deviceId,
        environmentId,
        trustedRevisionId: syncRequest.trustedRevisionId,
        trustedRevisionHash: syncRequest.trustedRevisionHash,
        ...(cursor
          ? {
              cursorRevisionId: cursor.revisionId,
              cursorRevisionHash: cursor.revisionHash,
            }
          : {}),
        limit,
      });
      const wirePage = encodeSyncPage({
        environmentId: page.environmentId,
        trustedRevisionId: page.trustedRevisionId,
        trustedRevisionHash: page.trustedRevisionHash,
        currentHeadId: page.currentHeadId,
        currentHeadHash: page.currentHeadHash,
        projectEpoch: page.projectEpoch,
        revisions: page.revisions.map((revision) => ({
          id: revision.id,
          digest: revision.digest,
          parentId: revision.parentId,
          parentHash: revision.parentHash,
          mutation: mutationToWire(revision.mutation),
          projectEpoch: revision.projectEpoch,
          authoredAtMs: revision.authoredAtMs,
          rollbackTargetId: revision.rollbackTargetId,
          objects: revision.objects,
        })),
        nextCursor:
          page.nextCursor === null
            ? null
            : formatSyncCursor(
                page.nextCursor.revisionId,
                page.nextCursor.revisionHash,
              ),
      });
      return new Response(wirePage, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": PROTOCOL_MEDIA_TYPE,
        },
      });
    } catch (error) {
      const mapped = await handlePersistenceFailure(database, error);
      const problem = respondProblem(mapped.code, mapped);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
  });

};
