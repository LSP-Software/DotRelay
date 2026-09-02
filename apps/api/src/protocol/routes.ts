import {
  CBOR_LIMITS,
  ContractError,
  createProblem,
  DEVICE_ID_HEADER,
  encodeSyncPage,
  formatSyncCursor,
  PROTOCOL_MEDIA_TYPE,
  type ProblemCode,
  parseEpochRotationRequest,
  parseFinalizePublicationRequest,
  parseIdempotencyKey,
  parseProtocolObject,
  parseSyncCursorValue,
  parseSyncRequest,
  parseUuid,
  validateProtocolObject,
} from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import {
  mutationToWire,
  OperationRepository,
  ProjectEpochRepository,
  PublicationRepository,
  StagedObjectRepository,
  SyncRepository,
} from "@dotrelay/database";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "../auth";
import type { ServerProfileConfig } from "../profile";
import { COMMAND_STAGE_OBJECT_ID } from "./constants";
import { requireProtocolActor } from "./context";
import {
  digestRequestBody,
  enrichStaleHead,
  mapPersistenceError,
} from "./errors";
import { createProtocolRateLimit } from "./rate-limit";
import {
  buildProtocolObjectFromStage,
  buildPublicationInput,
  collectStagedObjectIds,
  hasAllStagedObjects,
  uniqueStagedObjectIds,
  verifyRevisionSignature,
} from "./staging";

export { COMMAND_STAGE_OBJECT_ID } from "./constants";

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

const respondContractError = (error: unknown) => {
  if (error instanceof ContractError) return respondProblem(error.code);
  return respondProblem("invalid_request");
};

const readPathUuid = (context: Context, name: string) =>
  parseUuid(context.req.param(name), name);

const clampStagingExpiry = (
  expiresHeader: string | undefined,
  stagingTtlSeconds: number,
): Date => {
  const now = Date.now();
  const ceiling = now + stagingTtlSeconds * 1000;
  if (!expiresHeader || Number.isNaN(Date.parse(expiresHeader)))
    return new Date(ceiling);
  const requested = Date.parse(expiresHeader);
  if (requested <= now) return new Date(Math.min(now + 1, ceiling));
  return new Date(Math.min(requested, ceiling));
};

const readProtocolBody = async (
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array | Response> => {
  const mediaType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim();
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
  if (body.length === 0)
    return new Response(JSON.stringify(createProblem("invalid_request")), {
      status: 400,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
      },
    });
  if (body.length > maximumBytes)
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
):
  | "REVISION_PUBLICATION"
  | "ROLLBACK"
  | "EPOCH_ROTATION"
  | "DEVICE_ENROLLMENT"
  | "RECOVERY" => {
  if (
    value !== "REVISION_PUBLICATION" &&
    value !== "ROLLBACK" &&
    value !== "EPOCH_ROTATION" &&
    value !== "DEVICE_ENROLLMENT" &&
    value !== "RECOVERY"
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
  const epochRotations = new ProjectEpochRepository();

  app.use(
    "/api/v1/operations/*",
    createProtocolRateLimit(profile.isProduction),
  );
  app.use(
    "/api/v1/environments/*",
    createProtocolRateLimit(profile.isProduction),
  );
  app.use("/api/v1/projects/*", createProtocolRateLimit(profile.isProduction));

  const adminJsonLimit = bodyLimit({
    maxSize: profile.limits.adminBodyBytes,
    onError: (context) => {
      const problem = createProblem("payload_too_large");
      return context.json(problem, problem.status as ContentfulStatusCode, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    },
  });

  void DEVICE_ID_HEADER;

  app.post("/api/v1/operations/:operationId/begin", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    let operationId: string;
    try {
      operationId = readPathUuid(context, "operationId");
    } catch (error) {
      const problem = respondContractError(error);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    const idempotencyKey = context.req.header("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey !== operationId) {
      const problem = respondProblem("invalid_request");
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    parseIdempotencyKey(operationId);
    let kind: ReturnType<typeof parseOperationKind>;
    try {
      kind = parseOperationKind(
        context.req.header("X-DotRelay-Operation-Kind") ?? undefined,
      );
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
    const commandBody = await readProtocolBody(
      context.req.raw,
      profile.limits.protocolObjectBytes,
    );
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
    const expiresAt = clampStagingExpiry(
      context.req.header("X-DotRelay-Expires-At") ?? undefined,
      profile.limits.stagingTtlSeconds,
    );
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

  app.put(
    "/api/v1/operations/:operationId/staging/:objectId",
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      let operationId: string;
      let objectId: string;
      try {
        operationId = readPathUuid(context, "operationId");
        objectId = readPathUuid(context, "objectId");
      } catch (error) {
        const problem = respondContractError(error);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      if (objectId === COMMAND_STAGE_OBJECT_ID) {
        const problem = respondProblem("invalid_request");
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      const body = await readProtocolBody(
        context.req.raw,
        profile.limits.protocolObjectBytes,
      );
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
      const expiresAt = new Date(
        createdAt.getTime() + profile.limits.stagingTtlSeconds * 1000,
      );
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
    },
  );

  app.delete("/api/v1/operations/:operationId", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    let operationId: string;
    try {
      operationId = readPathUuid(context, "operationId");
    } catch (error) {
      const problem = respondContractError(error);
      return context.json(problem.body, problem.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
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

  app.post(
    "/api/v1/operations/:operationId/finalize",
    adminJsonLimit,
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      let operationId: string;
      try {
        operationId = readPathUuid(context, "operationId");
      } catch (error) {
        const problem = respondContractError(error);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      let finalizeRequest: ReturnType<typeof parseFinalizePublicationRequest>;
      try {
        finalizeRequest = parseFinalizePublicationRequest(
          await context.req.json(),
        );
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
      const stagedIds = uniqueStagedObjectIds(
        collectStagedObjectIds(finalizeRequest),
      );
      const stagedRows = await database.stagedObject.findMany({
        where: {
          operationId,
          objectId: { in: [...stagedIds] },
          actorDeviceId: actor.deviceId,
          committedAt: null,
        },
      });
      if (!hasAllStagedObjects(stagedIds, stagedRows)) {
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
      let revisionObject: ReturnType<typeof buildProtocolObjectFromStage>;
      try {
        revisionObject = buildProtocolObjectFromStage(
          stagedById,
          finalizeRequest.revision.protocolObjectId,
          environment.projectId,
          environment.id,
        );
      } catch (error) {
        const problem = respondContractError(error);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
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
      if (
        !(await verifyRevisionSignature(
          revisionObject,
          signingDevice.ed25519PublicKey,
        ))
      ) {
        const problem = respondProblem("invalid_crypto_object");
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      try {
        const result = await publications.publishRevision(
          database,
          buildPublicationInput({
            operationId,
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            commandStaged,
            operationExpiresAt: operation.expiresAt,
            finalizeRequest,
            projectId: environment.projectId,
            environmentId: environment.id,
            stagedById,
          }),
        );
        return context.json(
          { revisionId: result.revision.id, idempotent: result.idempotent },
          200,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        if (error instanceof ContractError) {
          const problem = respondProblem(error.code);
          return context.json(problem.body, problem.status, {
            "Cache-Control": "no-store",
            "Content-Type": "application/problem+json",
          });
        }
        const mapped = await handlePersistenceFailure(database, error);
        const problem = respondProblem(mapped.code, mapped);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
    },
  );

  app.post(
    "/api/v1/environments/:environmentId/sync",
    adminJsonLimit,
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      let environmentId: string;
      try {
        environmentId = readPathUuid(context, "environmentId");
      } catch (error) {
        const problem = respondContractError(error);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
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
      let cursor: ReturnType<typeof parseSyncCursorValue> | undefined;
      try {
        cursor =
          syncRequest.pagination.cursor === undefined
            ? undefined
            : parseSyncCursorValue(syncRequest.pagination.cursor);
      } catch (error) {
        const problem = respondContractError(error);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
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
        if (error instanceof ContractError) {
          const problem = respondProblem(error.code);
          return context.json(problem.body, problem.status, {
            "Cache-Control": "no-store",
            "Content-Type": "application/problem+json",
          });
        }
        const mapped = await handlePersistenceFailure(database, error);
        const problem = respondProblem(mapped.code, mapped);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
    },
  );

  app.post(
    "/api/v1/operations/:operationId/epoch-transitions",
    adminJsonLimit,
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      let operationId: string;
      try {
        operationId = readPathUuid(context, "operationId");
      } catch (error) {
        const problem = respondContractError(error);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      let rotationRequest: ReturnType<typeof parseEpochRotationRequest>;
      try {
        rotationRequest = parseEpochRotationRequest(await context.req.json());
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
        operation.actorDeviceId !== actor.deviceId ||
        operation.kind !== "EPOCH_ROTATION"
      ) {
        const problem = respondProblem("resource_not_found");
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      const stagedIds = uniqueStagedObjectIds([
        COMMAND_STAGE_OBJECT_ID,
        ...rotationRequest.transitions.flatMap((transition) => [
          transition.protocolObjectId,
          ...collectStagedObjectIds(transition.publication).filter(
            (objectId) => objectId !== COMMAND_STAGE_OBJECT_ID,
          ),
        ]),
      ]);
      const stagedRows = await database.stagedObject.findMany({
        where: {
          operationId,
          objectId: { in: [...stagedIds] },
          actorDeviceId: actor.deviceId,
          committedAt: null,
        },
      });
      if (!hasAllStagedObjects(stagedIds, stagedRows)) {
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
      try {
        const transitions = rotationRequest.transitions.map((transition) => ({
          environmentId: transition.environmentId,
          expectedHeadId: transition.expectedHeadId,
          newHeadId: transition.newHeadId,
          protocolObject: buildProtocolObjectFromStage(
            stagedById,
            transition.protocolObjectId,
            rotationRequest.projectId,
            transition.environmentId,
          ),
          publication: buildPublicationInput({
            operationId,
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            commandStaged,
            operationExpiresAt: operation.expiresAt,
            finalizeRequest: transition.publication,
            projectId: rotationRequest.projectId,
            environmentId: transition.environmentId,
            stagedById,
          }),
        }));
        for (const transition of transitions) {
          if (
            !(await verifyRevisionSignature(
              buildProtocolObjectFromStage(
                stagedById,
                transition.publication.revision.protocolObjectId,
                rotationRequest.projectId,
                transition.environmentId,
              ),
              signingDevice.ed25519PublicKey,
            ))
          ) {
            const problem = respondProblem("invalid_crypto_object");
            return context.json(problem.body, problem.status, {
              "Cache-Control": "no-store",
              "Content-Type": "application/problem+json",
            });
          }
        }
        const result = await epochRotations.rotate(database, {
          operation: {
            id: operationId,
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            kind: "EPOCH_ROTATION",
            commandBytes: new Uint8Array(commandStaged.canonicalBytes),
            commandDigest: new Uint8Array(commandStaged.digest),
            ...(operation.expiresAt ? { expiresAt: operation.expiresAt } : {}),
          },
          projectId: rotationRequest.projectId,
          expectedEpoch: BigInt(rotationRequest.expectedEpoch),
          newEpoch: BigInt(rotationRequest.newEpoch),
          transitions,
        });
        return context.json(
          {
            projectEpoch: ("projectEpoch" in result
              ? result.projectEpoch
              : BigInt(rotationRequest.newEpoch)
            ).toString(),
            idempotent: "idempotent" in result ? result.idempotent : false,
          },
          200,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        if (error instanceof ContractError) {
          const problem = respondProblem(error.code);
          return context.json(problem.body, problem.status, {
            "Cache-Control": "no-store",
            "Content-Type": "application/problem+json",
          });
        }
        const mapped = await handlePersistenceFailure(database, error);
        const problem = respondProblem(mapped.code, mapped);
        return context.json(problem.body, problem.status, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
    },
  );
};
