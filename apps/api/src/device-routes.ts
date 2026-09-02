import {
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
  DeviceRepository,
  OperationRepository,
  RecoveryRepository,
  resolveDotRelayUser,
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
  const mapped = mapPersistenceError(error);
  if (mapped) return mapped.code;
  if (!(error instanceof Error)) return "service_unavailable" as const;
  if (error.message.includes("generation")) return "stale_generation" as const;
  if (error.message.includes("not pending")) return "state_conflict" as const;
  if (error.message.includes("must differ")) return "forbidden" as const;
  if (error.message.includes("requires no active"))
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

const encodeBase64 = (bytes: Uint8Array) => {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    output += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(output);
};

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
      "envelopeId",
      "envelope",
      "recoveryGeneration",
      "ciphertextHash",
      "ciphertextLength",
      "succeeded",
      "challenge",
      "proof",
      "certificateId",
      "certificate",
      "replacementSigningPublicKey",
      "replacementEncryptionPublicKey",
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
  kind: "DEVICE_ENROLLMENT" | "RECOVERY",
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

const requireSessionUser = async (
  context: Context,
  database: DatabaseClient,
  profile: ServerProfileConfig,
  auth: DotRelayAuth,
): Promise<string | Response> => {
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session) return problem(context, "authentication_required");
  const user = await resolveDotRelayUser(database, {
    serverProfileId: profile.id,
    authSubject: session.user.id,
  });
  if (!user) return problem(context, "service_unavailable");
  return user.id;
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
  const recovery = new RecoveryRepository();
  const jsonLimit = bodyLimit({
    maxSize: profile.limits.adminBodyBytes,
    onError: (context) => problem(context, "payload_too_large"),
  });

  app.use("/api/v1/devices/enrollments", jsonLimit);
  app.use("/api/v1/devices/enrollments/*", jsonLimit);
  app.use("/api/v1/recovery/*", jsonLimit);

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

  app.post("/api/v1/recovery/envelopes", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readBody(context);
      requireIdempotencyKey(context, body.operationId);
      const object = await parseProtocolPayload(body, "objectId", "object", 10);
      const identityGeneration = body.identityGeneration;
      const recoveryGeneration = body.recoveryGeneration;
      const ciphertextLength = body.ciphertextLength;
      if (
        ![identityGeneration, recoveryGeneration].every(
          (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value),
        ) ||
        typeof ciphertextLength !== "number" ||
        !Number.isSafeInteger(ciphertextLength) ||
        ciphertextLength < 0 ||
        ciphertextLength > 64 * 1024 * 1024
      )
        throw new ContractError("invalid_request");
      const envelopeId = parseUuid(body.envelopeId, "envelopeId");
      const ciphertextHash = parseSha384Hex(
        body.ciphertextHash,
        "ciphertextHash",
      );
      validateActorBinding(object.object, profile.id, actor.userId);
      if (
        !(await verifyWithStoredDevice(
          database,
          actor.userId,
          object.object,
          actor.deviceId,
        ))
      )
        throw new ContractError("invalid_crypto_object");
      if (
        !equalBytes(
          requiredBytes(object.object, 59, 16),
          uuidToBytes(envelopeId),
        ) ||
        requiredUint(object.object, 28) !==
          BigInt(identityGeneration as string) ||
        requiredUint(object.object, 29) !==
          BigInt(recoveryGeneration as string) ||
        !equalBytes(requiredBytes(object.object, 48, 48), ciphertextHash) ||
        requiredUint(object.object, 72) !== BigInt(ciphertextLength)
      )
        throw new ContractError("invalid_crypto_object");
      const op = await operation(
        body,
        actor,
        "RECOVERY",
        object.canonicalBytes,
      );
      await operations.begin(database, op);
      await stage(database, op, [object], profile.limits.stagingTtlSeconds);
      const result = await recovery.replaceEnvelope(database, {
        operation: op,
        envelope: {
          id: envelopeId,
          protocolObject: object,
          identityGeneration: BigInt(identityGeneration as string),
          recoveryGeneration: BigInt(recoveryGeneration as string),
          ciphertextHash,
          ciphertextLength,
        },
      });
      return context.json(
        {
          envelopeId,
          recoveryGeneration: ("envelope" in result
            ? result.envelope.recoveryGeneration
            : BigInt(recoveryGeneration as string)
          ).toString(),
          idempotent: "idempotent" in result && result.idempotent,
        },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.post("/api/v1/recovery/restore", async (context) => {
    const user = await requireSessionUser(context, database, profile, auth);
    if (user instanceof Response) return user;
    try {
      const body = await readBody(context);
      requireIdempotencyKey(context, body.operationId);
      const current = await database.recoveryEnvelope.findFirst({
        where: { userId: user, retiredAt: null },
        orderBy: { recoveryGeneration: "desc" },
        include: { protocolObject: true },
      });
      if (!current) return problem(context, "resource_not_found");
      const envelope = await parseProtocolPayload(
        body,
        "envelopeId",
        "envelope",
        10,
      );
      if (
        envelope.id !== current.id ||
        !equalBytes(
          envelope.digest,
          new Uint8Array(current.protocolObject.digest),
        )
      )
        throw new ContractError("state_conflict");
      if (!(await verifyWithStoredDevice(database, user, envelope.object)))
        throw new ContractError("invalid_crypto_object");

      const challenge = decodeBase64(body.challenge);
      if (challenge.length !== 32) throw new ContractError("invalid_request");
      const proofBytes = decodeBase64(body.proof);
      const proof = parseProtocolObject(proofBytes);
      validateProtocolObject(proof);
      if (proof.get(1) !== 17) throw new ContractError("invalid_crypto_object");
      const replacementSigningPublicKey = decodeBase64(
        body.replacementSigningPublicKey,
      );
      if (replacementSigningPublicKey.length !== 32)
        throw new ContractError("invalid_request");
      const proofKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(replacementSigningPublicKey).buffer,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const proofSignature = requiredBytes(proof, 4, 64);
      if (!(await verifyProtocolObject(proof, proofSignature, proofKey)))
        throw new ContractError("invalid_crypto_object");
      if (
        !equalBytes(requiredBytes(proof, 8, 16), uuidToBytes(profile.id)) ||
        !equalBytes(requiredBytes(proof, 9, 16), uuidToBytes(user)) ||
        !equalBytes(requiredBytes(proof, 17, 16), uuidToBytes(envelope.id))
      ) {
        throw new ContractError("invalid_crypto_object");
      }
      const deviceId = parseUuid(body.deviceId, "deviceId");
      const identityGeneration = body.identityGeneration;
      if (
        typeof identityGeneration !== "string" ||
        !/^[1-9][0-9]*$/.test(identityGeneration)
      )
        throw new ContractError("invalid_request");
      if (
        !equalBytes(requiredBytes(proof, 10, 16), uuidToBytes(deviceId)) ||
        requiredUint(proof, 28) !== BigInt(identityGeneration) ||
        requiredUint(proof, 29) !== current.recoveryGeneration
      )
        throw new ContractError("invalid_crypto_object");
      const expiresAt = requiredUint(proof, 33);
      if (expiresAt <= BigInt(Date.now()))
        throw new ContractError("stale_generation");
      const challengeHash = await sha384Digest(challenge);
      if (!equalBytes(requiredBytes(proof, 58, 48), challengeHash))
        throw new ContractError("invalid_crypto_object");

      const x25519PublicKey = decodeBase64(body.x25519PublicKey);
      const ed25519PublicKey = decodeBase64(body.ed25519PublicKey);
      const keyId = decodeBase64(body.keyId);
      if (
        x25519PublicKey.length !== 32 ||
        ed25519PublicKey.length !== 32 ||
        keyId.length !== 48 ||
        !equalBytes(ed25519PublicKey, replacementSigningPublicKey)
      )
        throw new ContractError("invalid_request");
      const expectedKeyId = await sha384Digest(x25519PublicKey);
      if (!equalBytes(keyId, expectedKeyId))
        throw new ContractError("invalid_crypto_object");
      const certificate = await parseProtocolPayload(
        body,
        "certificateId",
        "certificate",
        2,
      );
      validateActorBinding(certificate.object, profile.id, user);
      if (
        !equalBytes(
          requiredBytes(certificate.object, 10, 16),
          uuidToBytes(deviceId),
        ) ||
        requiredUint(certificate.object, 28) !== BigInt(identityGeneration) ||
        !equalBytes(
          requiredBytes(certificate.object, 39, 32),
          x25519PublicKey,
        ) ||
        !equalBytes(requiredBytes(certificate.object, 41, 32), ed25519PublicKey)
      )
        throw new ContractError("invalid_crypto_object");
      const certificateSignature = requiredBytes(certificate.object, 4, 64);
      if (
        !(await verifyProtocolObject(
          certificate.object,
          certificateSignature,
          proofKey,
        ))
      )
        throw new ContractError("invalid_crypto_object");
      const op = {
        id: body.operationId as string,
        actorUserId: user,
        kind: "RECOVERY" as const,
        commandBytes: commandBytes(
          envelope.canonicalBytes,
          proofBytes,
          certificate.canonicalBytes,
        ),
        commandDigest: await sha384Digest(
          commandBytes(
            envelope.canonicalBytes,
            proofBytes,
            certificate.canonicalBytes,
          ),
        ),
      };
      const result = await new DeviceRepository().completeBootstrap(database, {
        operation: op,
        device: {
          id: deviceId,
          identityGeneration: BigInt(identityGeneration),
          keyId,
          x25519PublicKey,
          ed25519PublicKey,
        },
        certificateObject: certificate,
        recoveryAttempt: {
          envelopeId: current.id,
          challengeHash,
        },
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
  });

  app.post("/api/v1/recovery/attempts", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readBody(context);
      const challengeHash = parseSha384Hex(body.challengeHash, "challengeHash");
      const succeeded = body.succeeded;
      if (typeof succeeded !== "boolean")
        throw new ContractError("invalid_request");
      if (succeeded) throw new ContractError("forbidden");
      const envelopeId =
        body.envelopeId === undefined
          ? undefined
          : parseUuid(body.envelopeId, "envelopeId");
      if (envelopeId) {
        const envelope = await database.recoveryEnvelope.findFirst({
          where: { id: envelopeId, userId: actor.userId },
        });
        if (!envelope) return problem(context, "resource_not_found");
      }
      await recovery.recordAttempt(database, {
        userId: actor.userId,
        deviceId: actor.deviceId,
        ...(envelopeId ? { envelopeId } : {}),
        challengeHash,
        succeeded,
      });
      return context.json({ recorded: true }, 201, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.get("/api/v1/devices/enrollments/:enrollmentId", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const enrollmentId = parseUuid(
        context.req.param("enrollmentId"),
        "enrollmentId",
      );
      const enrollment = await database.deviceEnrollment.findFirst({
        where: { id: enrollmentId, userId: actor.userId },
        select: {
          id: true,
          initiatorDeviceId: true,
          approverDeviceId: true,
          expiresAt: true,
          completedAt: true,
        },
      });
      if (!enrollment) return problem(context, "resource_not_found");
      return context.json(
        {
          enrollmentId: enrollment.id,
          initiatorDeviceId: enrollment.initiatorDeviceId,
          approverDeviceId: enrollment.approverDeviceId,
          expiresAt: enrollment.expiresAt.toISOString(),
          status: enrollment.completedAt
            ? "completed"
            : enrollment.approverDeviceId
              ? "approved"
              : "pending",
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  app.get("/api/v1/recovery/envelopes/current", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const envelope = await database.recoveryEnvelope.findFirst({
        where: { userId: actor.userId, retiredAt: null },
        orderBy: { recoveryGeneration: "desc" },
        include: { protocolObject: true },
      });
      if (!envelope) return problem(context, "resource_not_found");
      return context.json(
        {
          envelopeId: envelope.id,
          identityGeneration: envelope.identityGeneration.toString(),
          recoveryGeneration: envelope.recoveryGeneration.toString(),
          ciphertextHash: sha384ToHex(new Uint8Array(envelope.ciphertextHash)),
          ciphertextLength: envelope.ciphertextLength,
          object: encodeBase64(
            new Uint8Array(envelope.protocolObject.canonicalBytes),
          ),
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return problem(context, mapError(error));
    }
  });

  void DEVICE_ID_HEADER;
};
