import {
  ARGON2ID_POLICY,
  accountKeyTransferAcknowledgementMessage,
  ContractError,
  createProblem,
  DEVICE_ID_HEADER,
  type ProtocolObject,
  parseJsonObject,
  parseProtocolObject,
  parseSha384Hex,
  parseUuid,
  sha384ToHex,
  uuidToBytes,
  validateProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import {
  AccountKeyRepository,
  DeviceRepository,
  OperationRepository,
  StagedObjectRepository,
  sha384Digest,
} from "@dotrelay/database";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "./auth";
import type { ServerProfileConfig } from "./profile";
import { requireProtocolActor } from "./protocol/context";
import { mapPersistenceError } from "./protocol/errors";

type Dependencies = Readonly<{
  readonly database: DatabaseClient;
  readonly profile: ServerProfileConfig;
  readonly auth: DotRelayAuth;
}>;

const problem = (
  context: Context,
  code: Parameters<typeof createProblem>[0],
) => {
  const body = createProblem(code);
  return context.json(body, body.status as ContentfulStatusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  });
};

const mapError = (error: unknown) => {
  if (error instanceof ContractError) return error.code;
  if (error instanceof Error && error.message.includes("cannot be revoked")) {
    // The last-wrapper guards throw plain Errors whose messages the generic
    // persistence mapper would read as invalid input; they are server-state
    // conflicts, so classify them before the mapper runs.
    return "state_conflict" as const;
  }
  const mapped = mapPersistenceError(error);
  if (mapped) return mapped.code;
  if (!(error instanceof Error)) return "service_unavailable" as const;
  if (error.message.includes("generation")) return "stale_generation" as const;
  if (error.message.includes("not pending")) return "state_conflict" as const;
  if (error.message.includes("must differ")) return "forbidden" as const;
  if (error.message.includes("requires no active"))
    return "state_conflict" as const;
  if (error.message.includes("expired")) return "state_conflict" as const;
  if (error.message.includes("already established"))
    return "state_conflict" as const;
  if (error.message.includes("not established"))
    return "state_conflict" as const;
  if (error.message.includes("recovery code is missing"))
    return "state_conflict" as const;
  if (error.message.includes("envelope conflicts"))
    return "state_conflict" as const;
  if (error.message.includes("not delivered")) return "state_conflict" as const;
  if (error.message.includes("recipient is revoked"))
    return "state_conflict" as const;
  return "service_unavailable" as const;
};

const decodeBase64 = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || value.length === 0)
    throw new ContractError("invalid_request");
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new ContractError("invalid_request");
  }
};

const parseHex = (value: unknown, length: number): Uint8Array => {
  if (
    typeof value !== "string" ||
    value.length !== length * 2 ||
    !/^[0-9a-f]+$/i.test(value)
  )
    throw new ContractError("invalid_request");
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1)
    bytes[index] = Number.parseInt(
      (value as string).slice(index * 2, index * 2 + 2),
      16,
    );
  return bytes;
};

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const commandBytes = (...parts: readonly Uint8Array[]) => {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const requireIdempotencyKey = (context: Context, operationId: unknown) => {
  if (
    typeof operationId !== "string" ||
    context.req.header("Idempotency-Key") !== operationId
  )
    throw new ContractError("invalid_request");
};

const readBody = async (context: Context) => {
  if (
    context.req.header("Content-Type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  )
    throw new ContractError("unsupported_media_type");
  try {
    return parseJsonObject(await context.req.json(), [
      "operationId",
      "enrollmentId",
      "userId",
      "transcriptHash",
      "challengeHash",
      "expiresAt",
      "objectId",
      "object",
      "deviceId",
      "identityGeneration",
      "keyId",
      "x25519PublicKey",
      "ed25519PublicKey",
      "enrollmentObjectId",
      "enrollmentObject",
      "certificateObjectId",
      "certificateObject",
      "enrolledDeviceId",
      "wrapperId",
      "recipientDeviceId",
      "transferId",
      "projectId",
      "projectEpoch",
      "ownerUserId",
      "valueGeneration",
      "ciphertextHash",
      "ciphertextLength",
      "intent",
      "signature",
    ]);
  } catch {
    throw new ContractError("invalid_request");
  }
};

export const parseProtocolPayload = async (
  body: Record<string, unknown>,
  idField: string,
  objectField: string,
  expectedKind: number,
) => {
  const id = parseUuid(body[idField], idField);
  const bytes = decodeBase64(body[objectField]);
  const object = parseProtocolObject(bytes);
  validateProtocolObject(object);
  if (object.get(1) !== expectedKind)
    throw new ContractError("invalid_crypto_object");
  const digest = await sha384Digest(bytes);
  return {
    id,
    object,
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    formatVersion: 3,
    kind: expectedKind,
    canonicalBytes: bytes,
    digest,
  };
};

const equalBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const requiredBytes = (
  object: ReadonlyMap<number, unknown>,
  field: number,
  length: number,
) => {
  const value = object.get(field);
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new ContractError("invalid_crypto_object");
  return value;
};

const requiredUint = (object: ReadonlyMap<number, unknown>, field: number) => {
  const value = object.get(field);
  if (
    (typeof value !== "number" && typeof value !== "bigint") ||
    value < 0 ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  )
    throw new ContractError("invalid_crypto_object");
  return BigInt(value);
};

const uintField = (
  object: ReadonlyMap<number, unknown>,
  field: number,
): bigint => {
  const value = object.get(field);
  if (typeof value !== "number" && typeof value !== "bigint")
    throw new ContractError("invalid_crypto_object");
  return BigInt(value);
};

const intField = (
  object: ReadonlyMap<number, unknown>,
  field: number,
): number => {
  const value = object.get(field);
  if (typeof value !== "number")
    throw new ContractError("invalid_crypto_object");
  return value;
};

const validateActorBinding = (
  object: ReadonlyMap<number, unknown>,
  profileId: string,
  userId: string,
) => {
  if (
    !equalBytes(requiredBytes(object, 8, 16), uuidToBytes(profileId)) ||
    !equalBytes(requiredBytes(object, 9, 16), uuidToBytes(userId))
  )
    throw new ContractError("invalid_crypto_object");
};

const operation = async (
  body: Record<string, unknown>,
  actor: { readonly userId: string; readonly deviceId: string },
  kind: "DEVICE_ENROLLMENT" | "ACCOUNT_KEY",
  commandBytes: Uint8Array,
) => {
  const operationId = parseUuid(body.operationId, "operationId");
  return {
    id: operationId,
    actorUserId: actor.userId,
    actorDeviceId: actor.deviceId,
    kind,
    commandBytes,
    commandDigest: await sha384Digest(commandBytes),
  } as const;
};

const verifyWithStoredDevice = async (
  database: DatabaseClient,
  userId: string,
  object: ProtocolObject,
  deviceId?: string,
): Promise<boolean> => {
  const signature = requiredBytes(object, 4, 64);
  const devices = await database.device.findMany({
    where: { userId, ...(deviceId ? { id: deviceId } : {}) },
    select: { ed25519PublicKey: true },
  });
  for (const device of devices) {
    try {
      const publicKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(device.ed25519PublicKey).buffer,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (await verifyProtocolObject(object, signature, publicKey)) return true;
    } catch {
      // A malformed stored key must not make another valid historical key unusable.
    }
  }
  return false;
};

const stage = async (
  database: DatabaseClient,
  input: { readonly id: string; readonly actorDeviceId: string },
  objects: ReadonlyArray<{
    readonly id: string;
    readonly canonicalBytes: Uint8Array;
    readonly digest: Uint8Array;
  }>,
  ttlSeconds: number,
) => {
  const repository = new StagedObjectRepository();
  const now = new Date();
  for (const object of objects)
    await repository.put(database, {
      operationId: input.id,
      objectId: object.id,
      actorDeviceId: input.actorDeviceId,
      canonicalBytes: object.canonicalBytes,
      digest: object.digest,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    });
};

const enrollResponse = (context: Context, result: unknown, status = 201) =>
  context.json(
    "enrollment" in (result as object)
      ? {
          enrollmentId: (result as { enrollment: { id: string } }).enrollment
            .id,
          expiresAt: (
            result as { enrollment: { expiresAt: Date } }
          ).enrollment.expiresAt.toISOString(),
          idempotent: false,
        }
      : {
          idempotent:
            "idempotent" in (result as object) &&
            (result as { idempotent: boolean }).idempotent,
        },
    status as ContentfulStatusCode,
    { "Cache-Control": "no-store" },
  );

export const registerDeviceRoutes = (
  app: Hono,
  { database, profile, auth }: Dependencies,
) => {
  const devices = new DeviceRepository();
  const operations = new OperationRepository();
  const accountKeys = new AccountKeyRepository();
  const jsonLimit = bodyLimit({
    maxSize: profile.limits.adminBodyBytes,
    onError: (context) => problem(context, "payload_too_large"),
  });

  app.use("/api/v1/devices/enrollments", jsonLimit);
  app.use("/api/v1/devices/enrollments/*", jsonLimit);
  app.use("/api/v1/account-keys", jsonLimit);
  app.use("/api/v1/account-keys/*", jsonLimit);

  app.post("/api/v1/devices/enrollments", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readBody(context);
      requireIdempotencyKey(context, body.operationId);
      const userId = parseUuid(body.userId, "userId");
      if (userId !== actor.userId) return problem(context, "forbidden");
      const enrollmentId = parseUuid(body.enrollmentId, "enrollmentId");
      const expiresAt = new Date(String(body.expiresAt));
      const now = new Date();
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt <= now ||
        expiresAt.getTime() >
          now.getTime() + profile.limits.stagingTtlSeconds * 1000
      )
        return problem(context, "invalid_request");
      const transcriptHash = parseSha384Hex(
        body.transcriptHash,
        "transcriptHash",
      );
      const challengeHash = parseSha384Hex(body.challengeHash, "challengeHash");
      const commandBytes = new TextEncoder().encode(
        JSON.stringify({
          enrollmentId,
          userId,
          transcriptHash: sha384ToHex(transcriptHash),
          challengeHash: sha384ToHex(challengeHash),
          expiresAt: expiresAt.toISOString(),
        }),
      );
      const result = await devices.beginEnrollment(database, {
        operation: await operation(
          { operationId: body.operationId },
          actor,
          "DEVICE_ENROLLMENT",
          commandBytes,
        ),
        enrollmentId,
        userId,
        initiatorDeviceId: actor.deviceId,
        transcriptHash,
        challengeHash,
        expiresAt,
        now,
      });
      return enrollResponse(context, result);
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.post(
    "/api/v1/devices/enrollments/:enrollmentId/approve",
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      try {
        const body = await readBody(context);
        requireIdempotencyKey(context, body.operationId);
        const enrollmentId = parseUuid(
          context.req.param("enrollmentId"),
          "enrollmentId",
        );
        const enrollment = await database.deviceEnrollment.findUnique({
          where: { id: enrollmentId },
          select: {
            userId: true,
            transcriptHash: true,
            initiatorDeviceId: true,
          },
        });
        if (!enrollment || enrollment.userId !== actor.userId)
          return problem(context, "resource_not_found");
        const approval = await parseProtocolPayload(
          body,
          "objectId",
          "object",
          5,
        );
        validateActorBinding(approval.object, profile.id, actor.userId);
        if (
          !equalBytes(
            requiredBytes(approval.object, 77, 16),
            uuidToBytes(actor.deviceId),
          )
        )
          throw new ContractError("forbidden");
        if (
          !equalBytes(
            requiredBytes(approval.object, 17, 16),
            uuidToBytes(enrollmentId),
          ) ||
          !equalBytes(
            requiredBytes(approval.object, 76, 48),
            new Uint8Array(enrollment.transcriptHash),
          )
        )
          throw new ContractError("invalid_crypto_object");
        const enrolledDeviceId = parseUuid(
          body.enrolledDeviceId,
          "enrolledDeviceId",
        );
        if (
          !equalBytes(
            requiredBytes(approval.object, 10, 16),
            uuidToBytes(enrolledDeviceId),
          )
        )
          throw new ContractError("invalid_crypto_object");
        if (
          !(await verifyWithStoredDevice(
            database,
            actor.userId,
            approval.object,
            actor.deviceId,
          ))
        )
          throw new ContractError("invalid_crypto_object");
        const command = approval.canonicalBytes;
        const op = await operation(body, actor, "DEVICE_ENROLLMENT", command);
        await operations.begin(database, op);
        await stage(database, op, [approval], profile.limits.stagingTtlSeconds);
        const result = await devices.approveEnrollment(database, {
          operation: op,
          enrollmentId,
          approvalObject: approval,
        });
        return context.json(
          {
            approved: true,
            idempotent: "idempotent" in result && result.idempotent,
          },
          200,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        return problem(context, mapError(error));
      }
    },
  );

  app.post(
    "/api/v1/devices/enrollments/:enrollmentId/complete",
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      try {
        const body = await readBody(context);
        requireIdempotencyKey(context, body.operationId);
        const enrollmentId = parseUuid(
          context.req.param("enrollmentId"),
          "enrollmentId",
        );
        const enrollment = await database.deviceEnrollment.findFirst({
          where: { id: enrollmentId, userId: actor.userId },
          select: {
            initiatorDeviceId: true,
            transcriptHash: true,
            challengeHash: true,
            expiresAt: true,
          },
        });
        if (!enrollment) return problem(context, "resource_not_found");
        if (enrollment.initiatorDeviceId !== actor.deviceId)
          return problem(context, "forbidden");
        const enrollmentObject = await parseProtocolPayload(
          body,
          "enrollmentObjectId",
          "enrollmentObject",
          4,
        );
        const certificateObject = await parseProtocolPayload(
          body,
          "certificateObjectId",
          "certificateObject",
          2,
        );
        if (
          !equalBytes(
            requiredBytes(enrollmentObject.object, 17, 16),
            uuidToBytes(enrollmentId),
          )
        )
          throw new ContractError("invalid_crypto_object");
        if (
          !equalBytes(
            enrollmentObject.digest,
            new Uint8Array(enrollment.transcriptHash),
          ) ||
          !(await verifyWithStoredDevice(
            database,
            actor.userId,
            enrollmentObject.object,
            enrollment.initiatorDeviceId,
          ))
        )
          throw new ContractError("invalid_crypto_object");
        if (
          requiredUint(enrollmentObject.object, 33) !==
          BigInt(enrollment.expiresAt.getTime())
        )
          throw new ContractError("invalid_crypto_object");
        const transcriptChallenge = requiredBytes(
          enrollmentObject.object,
          57,
          32,
        );
        if (
          !equalBytes(
            await sha384Digest(transcriptChallenge),
            new Uint8Array(enrollment.challengeHash),
          )
        )
          throw new ContractError("invalid_crypto_object");
        const persistedApproval =
          await database.enrollmentApprovalObject.findFirst({
            where: { enrollmentId },
            select: { protocolObject: { select: { canonicalBytes: true } } },
          });
        if (!persistedApproval) throw new ContractError("state_conflict");
        const approvalObject = parseProtocolObject(
          new Uint8Array(persistedApproval.protocolObject.canonicalBytes),
        );
        validateProtocolObject(approvalObject);
        if (
          approvalObject.get(1) !== 5 ||
          !equalBytes(
            requiredBytes(approvalObject, 17, 16),
            uuidToBytes(enrollmentId),
          ) ||
          !equalBytes(
            requiredBytes(approvalObject, 10, 16),
            requiredBytes(enrollmentObject.object, 10, 16),
          )
        )
          throw new ContractError("invalid_crypto_object");
        const deviceId = parseUuid(body.deviceId, "deviceId");
        const identityGeneration = body.identityGeneration;
        if (
          typeof identityGeneration !== "string" ||
          !/^[1-9][0-9]*$/.test(identityGeneration)
        )
          throw new ContractError("invalid_request");
        const x25519PublicKey = decodeBase64(body.x25519PublicKey);
        const ed25519PublicKey = decodeBase64(body.ed25519PublicKey);
        const keyId = decodeBase64(body.keyId);
        if (
          x25519PublicKey.length !== 32 ||
          ed25519PublicKey.length !== 32 ||
          keyId.length !== 48
        )
          throw new ContractError("invalid_request");
        validateActorBinding(enrollmentObject.object, profile.id, actor.userId);
        validateActorBinding(
          certificateObject.object,
          profile.id,
          actor.userId,
        );
        if (
          !equalBytes(
            requiredBytes(enrollmentObject.object, 10, 16),
            uuidToBytes(deviceId),
          ) ||
          !equalBytes(
            requiredBytes(certificateObject.object, 10, 16),
            uuidToBytes(deviceId),
          )
        )
          throw new ContractError("invalid_crypto_object");
        const certificateSignature = requiredBytes(
          certificateObject.object,
          4,
          64,
        );
        const certificatePublicKey = await crypto.subtle.importKey(
          "raw",
          new Uint8Array(ed25519PublicKey).slice().buffer,
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        if (
          !(await verifyProtocolObject(
            certificateObject.object,
            certificateSignature,
            certificatePublicKey,
          ))
        )
          throw new ContractError("invalid_crypto_object");
        if (
          requiredUint(certificateObject.object, 28) !==
          BigInt(identityGeneration)
        )
          throw new ContractError("stale_generation");
        const op = await operation(
          body,
          actor,
          "DEVICE_ENROLLMENT",
          commandBytes(
            enrollmentObject.canonicalBytes,
            certificateObject.canonicalBytes,
          ),
        );
        await operations.begin(database, op);
        await stage(
          database,
          op,
          [enrollmentObject, certificateObject],
          profile.limits.stagingTtlSeconds,
        );
        const result = await devices.completeEnrollment(database, {
          operation: op,
          enrollmentId,
          device: {
            id: deviceId,
            identityGeneration: BigInt(identityGeneration),
            keyId,
            x25519PublicKey,
            ed25519PublicKey,
          },
          enrollmentObject,
          certificateObject,
        });
        return context.json(
          {
            deviceId: "device" in result ? result.device.id : deviceId,
            active: true,
            idempotent: "idempotent" in result && result.idempotent,
          },
          201,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        return problem(context, mapError(error));
      }
    },
  );

  const bytesField = (
    object: ReadonlyMap<number, unknown>,
    field: number,
  ): Uint8Array => {
    const value = object.get(field);
    if (!(value instanceof Uint8Array))
      throw new ContractError("invalid_crypto_object");
    return value;
  };

  app.post("/api/v1/account-keys/wrappers", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readBody(context);
      requireIdempotencyKey(context, body.operationId);
      const object = await parseProtocolPayload(body, "objectId", "object", 20);
      validateActorBinding(object.object, profile.id, actor.userId);
      if (
        !equalBytes(
          requiredBytes(object.object, 10, 16),
          uuidToBytes(actor.deviceId),
        )
      )
        throw new ContractError("invalid_crypto_object");
      const wrapperId = parseHex(body.wrapperId, 16);
      const identityGeneration = body.identityGeneration;
      if (
        typeof identityGeneration !== "string" ||
        !/^[1-9][0-9]*$/.test(identityGeneration)
      )
        throw new ContractError("invalid_request");
      const ciphertextHash = parseSha384Hex(
        body.ciphertextHash,
        "ciphertextHash",
      );
      const ciphertextLength = body.ciphertextLength;
      if (
        typeof ciphertextLength !== "number" ||
        !Number.isSafeInteger(ciphertextLength) ||
        ciphertextLength < 0 ||
        ciphertextLength > 64 * 1024 * 1024
      )
        throw new ContractError("invalid_request");
      if (
        !equalBytes(requiredBytes(object.object, 87, 16), wrapperId) ||
        requiredUint(object.object, 28) !== BigInt(identityGeneration) ||
        !equalBytes(requiredBytes(object.object, 48, 48), ciphertextHash) ||
        requiredUint(object.object, 72) !== BigInt(ciphertextLength)
      )
        throw new ContractError("invalid_crypto_object");
      if (
        !(await verifyWithStoredDevice(
          database,
          actor.userId,
          object.object,
          actor.deviceId,
        ))
      )
        throw new ContractError("invalid_crypto_object");
      const intent = body.intent;
      if (intent !== "establish" && intent !== "rotate" && intent !== "add")
        throw new ContractError("invalid_request");
      const wrapperType = object.object.get(86);
      if (wrapperType !== 1 && wrapperType !== 2 && wrapperType !== 3)
        throw new ContractError("invalid_crypto_object");
      if (intent === "rotate" && wrapperType !== 3)
        throw new ContractError("invalid_request");
      if (intent === "add" && wrapperType === 3)
        throw new ContractError("invalid_request");
      let credentialId: Uint8Array | undefined;
      let kdf:
        | Readonly<{
            readonly kdfName: number;
            readonly kdfMemoryKib: bigint;
            readonly kdfIterations: bigint;
            readonly kdfParallelism: number;
          }>
        | undefined;
      if (wrapperType === 1) credentialId = bytesField(object.object, 93);
      if (wrapperType === 2) {
        kdf = {
          kdfName: intField(object.object, 89),
          kdfMemoryKib: uintField(object.object, 90),
          kdfIterations: uintField(object.object, 91),
          kdfParallelism: intField(object.object, 92),
        };
        // Defense in depth: reject a password wrapper whose declared Argon2id
        // cost exceeds the shared policy before it is staged/stored. The wire
        // contract already enforces these bounds; this guards against any path
        // that bypasses client-side validation.
        const memoryKiB = Number(kdf.kdfMemoryKib);
        const iterations = Number(kdf.kdfIterations);
        if (
          kdf.kdfName !== 1 ||
          memoryKiB < 8 ||
          memoryKiB > ARGON2ID_POLICY.maxMemoryKiB ||
          iterations < 1 ||
          iterations > ARGON2ID_POLICY.maxIterations ||
          kdf.kdfParallelism < 1 ||
          kdf.kdfParallelism > ARGON2ID_POLICY.maxParallelism
        )
          throw new ContractError("invalid_crypto_object");
      }
      const op = await operation(
        body,
        actor,
        "ACCOUNT_KEY",
        object.canonicalBytes,
      );
      await operations.begin(database, op);
      await stage(database, op, [object], profile.limits.stagingTtlSeconds);
      const result = await accountKeys.addWrapper(database, {
        operation: op,
        wrapper: {
          protocolObject: object,
          identityGeneration: BigInt(identityGeneration),
          wrapperType:
            wrapperType === 1
              ? "PASSKEY_PRF"
              : wrapperType === 2
                ? "PASSWORD"
                : "RECOVERY_CODE",
          wrapperId,
          ...(credentialId ? { credentialId } : {}),
          ...(kdf
            ? {
                kdfName: kdf.kdfName,
                kdfMemoryKib: kdf.kdfMemoryKib,
                kdfIterations: kdf.kdfIterations,
                kdfParallelism: kdf.kdfParallelism,
              }
            : {}),
          ciphertextHash,
          ciphertextLength,
        },
        intent,
      });
      return context.json(
        {
          wrapperId: toHex(wrapperId),
          idempotent: "idempotent" in result && result.idempotent,
        },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.get("/api/v1/account-keys/wrappers", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const wrappers = await database.accountKeyWrapperObject.findMany({
        where: { userId: actor.userId, retiredAt: null },
        orderBy: { createdAt: "asc" },
        select: {
          wrapperId: true,
          wrapperType: true,
          kdfName: true,
          kdfMemoryKib: true,
          kdfIterations: true,
          kdfParallelism: true,
          createdAt: true,
          protocolObject: { select: { canonicalBytes: true } },
        },
      });
      // Expose each wrapper's creator Device id + Ed25519 signing public key so
      // a client can verify the object's field-4 signature against its trust
      // boundary (R9). The creator device is read from field 10 of the stored
      // canonical object.
      const creatorDevices = new Map<string, string>();
      for (const wrapper of wrappers) {
        const bytes = new Uint8Array(wrapper.protocolObject.canonicalBytes);
        let deviceIdHex: string | undefined;
        let publicKeyHex: string | undefined;
        try {
          const object = parseProtocolObject(bytes);
          const deviceId = object.get(10);
          if (deviceId instanceof Uint8Array && deviceId.length === 16) {
            deviceIdHex = toHex(deviceId);
            const device = await database.device.findFirst({
              where: { id: deviceIdHex, userId: actor.userId },
              select: { ed25519PublicKey: true },
            });
            if (device)
              publicKeyHex = toHex(new Uint8Array(device.ed25519PublicKey));
          }
        } catch {
          // A malformed stored object omits the creator fields rather than failing the list.
        }
        if (deviceIdHex) creatorDevices.set(deviceIdHex, publicKeyHex ?? "");
      }
      return context.json(
        {
          wrappers: wrappers.map((wrapper) => {
            const bytes = new Uint8Array(wrapper.protocolObject.canonicalBytes);
            let creatorDeviceId: string | undefined;
            let creatorPublicKey: string | undefined;
            try {
              const object = parseProtocolObject(bytes);
              const deviceId = object.get(10);
              if (deviceId instanceof Uint8Array && deviceId.length === 16) {
                creatorDeviceId = toHex(deviceId);
                creatorPublicKey = creatorDevices.get(creatorDeviceId);
              }
            } catch {
              // omit creator fields on malformed objects
            }
            return {
              wrapperId: toHex(new Uint8Array(wrapper.wrapperId)),
              type:
                wrapper.wrapperType === "PASSKEY_PRF"
                  ? "passkey-prf"
                  : wrapper.wrapperType === "PASSWORD"
                    ? "password"
                    : "recovery-code",
              object: toBase64(bytes),
              ...(creatorDeviceId
                ? {
                    creatorDeviceId,
                    ...(creatorPublicKey ? { creatorPublicKey } : {}),
                  }
                : {}),
              ...(wrapper.kdfName === null
                ? {}
                : {
                    kdf: {
                      name: wrapper.kdfName,
                      memoryKib:
                        wrapper.kdfMemoryKib === null
                          ? null
                          : wrapper.kdfMemoryKib.toString(),
                      iterations:
                        wrapper.kdfIterations === null
                          ? null
                          : wrapper.kdfIterations.toString(),
                      parallelism: wrapper.kdfParallelism,
                    },
                  }),
              createdAt: wrapper.createdAt.toISOString(),
            };
          }),
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.post("/api/v1/account-keys/wrappers/revoke", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readBody(context);
      requireIdempotencyKey(context, body.operationId);
      const wrapperId = parseHex(body.wrapperId, 16);
      const op = await operation(body, actor, "ACCOUNT_KEY", wrapperId);
      await operations.begin(database, op);
      const result = await accountKeys.revokeWrapper(database, {
        operation: op,
        wrapperId,
      });
      return context.json(
        {
          revoked: true,
          idempotent: "idempotent" in result && result.idempotent,
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.post("/api/v1/account-keys/envelopes", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readBody(context);
      requireIdempotencyKey(context, body.operationId);
      const object = await parseProtocolPayload(body, "objectId", "object", 21);
      validateActorBinding(object.object, profile.id, actor.userId);
      if (
        !equalBytes(
          requiredBytes(object.object, 10, 16),
          uuidToBytes(actor.deviceId),
        )
      )
        throw new ContractError("invalid_crypto_object");
      const ciphertextHash = parseSha384Hex(
        body.ciphertextHash,
        "ciphertextHash",
      );
      const ciphertextLength = body.ciphertextLength;
      if (
        typeof ciphertextLength !== "number" ||
        !Number.isSafeInteger(ciphertextLength) ||
        ciphertextLength < 0 ||
        ciphertextLength > 64 * 1024 * 1024
      )
        throw new ContractError("invalid_request");
      if (
        !equalBytes(requiredBytes(object.object, 48, 48), ciphertextHash) ||
        requiredUint(object.object, 72) !== BigInt(ciphertextLength)
      )
        throw new ContractError("invalid_crypto_object");
      if (
        !(await verifyWithStoredDevice(
          database,
          actor.userId,
          object.object,
          actor.deviceId,
        ))
      )
        throw new ContractError("invalid_crypto_object");
      const envelopeType = object.object.get(96);
      let envelopeFields:
        | { readonly projectId: string; readonly projectEpoch: bigint }
        | { readonly ownerUserId: string; readonly valueGeneration: bigint };
      if (envelopeType === 1) {
        const projectId = parseUuid(body.projectId, "projectId");
        const projectEpoch = body.projectEpoch;
        if (
          typeof projectEpoch !== "string" ||
          !/^[1-9][0-9]*$/.test(projectEpoch)
        )
          throw new ContractError("invalid_request");
        if (
          !equalBytes(
            requiredBytes(object.object, 13, 16),
            uuidToBytes(projectId),
          ) ||
          requiredUint(object.object, 30) !== BigInt(projectEpoch)
        )
          throw new ContractError("invalid_crypto_object");
        envelopeFields = { projectId, projectEpoch: BigInt(projectEpoch) };
      } else if (envelopeType === 2) {
        const ownerUserId = parseUuid(body.ownerUserId, "ownerUserId");
        const valueGeneration = body.valueGeneration;
        if (
          typeof valueGeneration !== "string" ||
          !/^[1-9][0-9]*$/.test(valueGeneration)
        )
          throw new ContractError("invalid_request");
        if (
          !equalBytes(
            requiredBytes(object.object, 26, 16),
            uuidToBytes(ownerUserId),
          ) ||
          requiredUint(object.object, 31) !== BigInt(valueGeneration)
        )
          throw new ContractError("invalid_crypto_object");
        envelopeFields = {
          ownerUserId,
          valueGeneration: BigInt(valueGeneration),
        };
      } else {
        throw new ContractError("invalid_crypto_object");
      }
      const user = await database.user.findUnique({
        where: { id: actor.userId },
        select: { identityGeneration: true },
      });
      if (!user) return problem(context, "service_unavailable");
      const op = await operation(
        body,
        actor,
        "ACCOUNT_KEY",
        object.canonicalBytes,
      );
      await operations.begin(database, op);
      await stage(database, op, [object], profile.limits.stagingTtlSeconds);
      const result = await accountKeys.publishEnvelope(database, {
        operation: op,
        envelope: {
          protocolObject: object,
          identityGeneration: user.identityGeneration,
          envelopeType:
            envelopeType === 1 ? "PROJECT_EPOCH_KEY" : "USER_VALUE_KEY",
          ...envelopeFields,
          ciphertextHash,
          ciphertextLength,
        },
      });
      return context.json(
        {
          objectId: object.id,
          idempotent: "idempotent" in result && result.idempotent,
        },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.get("/api/v1/account-keys/envelopes", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    const envelopes = await database.accountKeyEnvelopeObject.findMany({
      where: { userId: actor.userId, retiredAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        envelopeType: true,
        projectId: true,
        projectEpoch: true,
        ownerUserId: true,
        valueGeneration: true,
        protocolObject: { select: { canonicalBytes: true } },
      },
    });
    const listed = [];
    for (const envelope of envelopes) {
      const bytes = new Uint8Array(envelope.protocolObject.canonicalBytes);
      let creatorDeviceId: string | undefined;
      let creatorPublicKey: string | undefined;
      try {
        const object = parseProtocolObject(bytes);
        const deviceId = object.get(10);
        if (deviceId instanceof Uint8Array && deviceId.length === 16) {
          creatorDeviceId = toHex(deviceId);
          const device = await database.device.findFirst({
            where: { id: creatorDeviceId, userId: actor.userId },
            select: { ed25519PublicKey: true },
          });
          if (device)
            creatorPublicKey = toHex(new Uint8Array(device.ed25519PublicKey));
        }
      } catch {
        // omit creator fields on malformed objects
      }
      listed.push({
        envelopeType:
          envelope.envelopeType === "PROJECT_EPOCH_KEY"
            ? "project-epoch-key"
            : "user-value-key",
        object: toBase64(bytes),
        ...(envelope.projectId ? { projectId: envelope.projectId } : {}),
        ...(envelope.projectEpoch !== null
          ? { projectEpoch: envelope.projectEpoch.toString() }
          : {}),
        ...(envelope.ownerUserId ? { ownerUserId: envelope.ownerUserId } : {}),
        ...(envelope.valueGeneration !== null
          ? { valueGeneration: envelope.valueGeneration.toString() }
          : {}),
        ...(creatorDeviceId
          ? {
              creatorDeviceId,
              ...(creatorPublicKey ? { creatorPublicKey } : {}),
            }
          : {}),
      });
    }
    return context.json({ envelopes: listed }, 200, {
      "Cache-Control": "no-store",
    });
  });

  app.post("/api/v1/account-keys/transfers", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readBody(context);
      requireIdempotencyKey(context, body.operationId);
      const object = await parseProtocolPayload(body, "objectId", "object", 22);
      validateActorBinding(object.object, profile.id, actor.userId);
      if (
        !equalBytes(
          requiredBytes(object.object, 10, 16),
          uuidToBytes(actor.deviceId),
        )
      )
        throw new ContractError("invalid_crypto_object");
      const recipientDeviceId = parseUuid(
        body.recipientDeviceId,
        "recipientDeviceId",
      );
      const transferId = parseHex(body.transferId, 16);
      const expiresAt = new Date(String(body.expiresAt));
      const now = new Date();
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt <= now ||
        expiresAt.getTime() >
          now.getTime() + profile.limits.stagingTtlSeconds * 1000
      )
        throw new ContractError("invalid_request");
      const ciphertextHash = parseSha384Hex(
        body.ciphertextHash,
        "ciphertextHash",
      );
      const ciphertextLength = body.ciphertextLength;
      if (
        typeof ciphertextLength !== "number" ||
        !Number.isSafeInteger(ciphertextLength) ||
        ciphertextLength < 0 ||
        ciphertextLength > 64 * 1024 * 1024
      )
        throw new ContractError("invalid_request");
      if (
        !equalBytes(
          requiredBytes(object.object, 25, 16),
          uuidToBytes(recipientDeviceId),
        ) ||
        !equalBytes(requiredBytes(object.object, 95, 16), transferId) ||
        requiredUint(object.object, 33) !== BigInt(expiresAt.getTime()) ||
        !equalBytes(requiredBytes(object.object, 48, 48), ciphertextHash) ||
        requiredUint(object.object, 72) !== BigInt(ciphertextLength)
      )
        throw new ContractError("invalid_crypto_object");
      if (
        !(await verifyWithStoredDevice(
          database,
          actor.userId,
          object.object,
          actor.deviceId,
        ))
      )
        throw new ContractError("invalid_crypto_object");
      const user = await database.user.findUnique({
        where: { id: actor.userId },
        select: { identityGeneration: true },
      });
      if (!user) return problem(context, "service_unavailable");
      const op = await operation(
        body,
        actor,
        "ACCOUNT_KEY",
        object.canonicalBytes,
      );
      await operations.begin(database, op);
      await stage(database, op, [object], profile.limits.stagingTtlSeconds);
      const result = await accountKeys.createTransfer(database, {
        operation: op,
        transfer: {
          protocolObject: object,
          identityGeneration: user.identityGeneration,
          recipientDeviceId,
          transferId,
          expiresAt,
        },
      });
      return context.json(
        {
          transferId: toHex(transferId),
          recipientDeviceId,
          expiresAt: expiresAt.toISOString(),
          idempotent: "idempotent" in result && result.idempotent,
        },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.post(
    "/api/v1/account-keys/transfers/:transferId/accept",
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      try {
        const transferId = parseHex(context.req.param("transferId"), 16);
        const transfer = await accountKeys.acceptTransfer(database, {
          userId: actor.userId,
          deviceId: actor.deviceId,
          transferId,
        });
        // Expose the creator Device's id + Ed25519 signing public key (read from
        // field 10 of the stored transfer object) so the recipient can verify the
        // signature against its trust boundary (R9).
        let creatorDeviceId: string | undefined;
        let creatorPublicKey: string | undefined;
        try {
          const object = parseProtocolObject(transfer.canonicalBytes);
          const deviceId = object.get(10);
          if (deviceId instanceof Uint8Array && deviceId.length === 16) {
            creatorDeviceId = toHex(deviceId);
            const device = await database.device.findFirst({
              where: { id: creatorDeviceId, userId: actor.userId },
              select: { ed25519PublicKey: true },
            });
            if (device)
              creatorPublicKey = toHex(new Uint8Array(device.ed25519PublicKey));
          }
        } catch {
          // omit creator fields on malformed objects
        }
        return context.json(
          {
            accepted: true,
            object: toBase64(transfer.canonicalBytes),
            ...(creatorDeviceId
              ? {
                  creatorDeviceId,
                  ...(creatorPublicKey ? { creatorPublicKey } : {}),
                }
              : {}),
          },
          200,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        return problem(context, mapError(error));
      }
    },
  );

  app.post(
    "/api/v1/account-keys/transfers/:transferId/acknowledge",
    async (context) => {
      const actor = await requireProtocolActor(
        context,
        database,
        profile,
        auth,
      );
      if (actor instanceof Response) return actor;
      try {
        const body = await readBody(context);
        const transferId = parseHex(context.req.param("transferId"), 16);
        const signature = decodeBase64(body.signature);
        if (signature.length !== 64)
          throw new ContractError("invalid_crypto_object");
        const device = await database.device.findFirst({
          where: {
            id: actor.deviceId,
            userId: actor.userId,
            lifecycle: "ACTIVE",
          },
          select: { ed25519PublicKey: true },
        });
        if (!device) return problem(context, "device_not_active");
        const publicKey = await crypto.subtle.importKey(
          "raw",
          new Uint8Array(device.ed25519PublicKey).buffer,
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        const verified = await crypto.subtle.verify(
          { name: "Ed25519" },
          publicKey,
          new Uint8Array(signature).slice(),
          accountKeyTransferAcknowledgementMessage(transferId),
        );
        if (!verified) throw new ContractError("invalid_crypto_object");
        const result = await accountKeys.acknowledgeTransfer(database, {
          userId: actor.userId,
          deviceId: actor.deviceId,
          transferId,
        });
        return context.json(
          { acknowledged: true, idempotent: result.idempotent },
          200,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        return problem(context, mapError(error));
      }
    },
  );
  void DEVICE_ID_HEADER;
};
