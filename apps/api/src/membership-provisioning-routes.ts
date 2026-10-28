import {
  bytesToUuid,
  type CborValue,
  ContractError,
  canonicalEncode,
  createProblem,
  type ProtocolObject,
  parseIdempotencyKey,
  parseJsonObject,
  parseUuid,
  sha384,
  uuidToBytes,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import {
  type DatabaseClient,
  GrantRepository,
  MembershipRepository,
  OperationRepository,
  type PersistenceClient,
  StagedObjectRepository,
} from "@dotrelay/database";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "./auth";
import { parseProtocolPayload } from "./device-routes";
import type { ServerProfileConfig } from "./profile";
import { type ProtocolActor, requireProtocolActor } from "./protocol/context";
import { mapPersistenceError } from "./protocol/errors";

const equal = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);
const bytes = (
  object: ProtocolObject,
  field: number,
  length?: number,
): Uint8Array => {
  const value = object.get(field);
  if (
    !(value instanceof Uint8Array) ||
    (length !== undefined && value.length !== length)
  )
    throw new ContractError("invalid_crypto_object");
  return value;
};
const uuid = (object: ProtocolObject, field: number) =>
  bytesToUuid(bytes(object, field, 16));
const problem = (context: Context, error: unknown) => {
  const code =
    error instanceof ContractError
      ? error.code
      : (mapPersistenceError(error)?.code ?? "state_conflict");
  const body = createProblem(code);
  return context.json(body, body.status as ContentfulStatusCode, {
    "Content-Type": "application/problem+json",
    "Cache-Control": "no-store",
  });
};

export const loadMembershipProvisioningPlan = async (
  database: PersistenceClient,
  actor: ProtocolActor,
  teamId: string,
  membershipId: string,
) => {
  const authority = await database.membership.findFirst({
    where: { teamId, userId: actor.userId, lifecycle: "ACTIVE" },
  });
  if (!authority || !["OWNER", "ADMIN"].includes(authority.role))
    throw new ContractError("forbidden");
  const team = await database.team.findFirst({
    where: { id: teamId, lifecycle: "ACTIVE" },
  });
  if (!team) throw new ContractError("resource_not_found");
  const member = await database.membership.findFirst({
    where: { id: membershipId, teamId },
  });
  if (!member) throw new ContractError("resource_not_found");
  if (member.lifecycle !== "PENDING_KEY_GRANT" && member.lifecycle !== "ACTIVE")
    throw new ContractError("state_conflict");
  if (authority.role === "ADMIN" && member.role !== "MEMBER")
    throw new ContractError("forbidden");
  const devices = await database.device.findMany({
    where: { userId: member.userId, lifecycle: "ACTIVE" },
    orderBy: { id: "asc" },
    select: { id: true, x25519PublicKey: true },
  });
  if (devices.length === 0) throw new ContractError("device_not_active");
  // An empty Project has no content key to share. Once initialized, its key
  // must be provisioned before the pending Member can become active.
  const projects = await database.project.findMany({
    where: {
      teamId,
      lifecycle: "ACTIVE",
      environments: {
        some: { lifecycle: "ACTIVE", currentHeadId: { not: null } },
      },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      currentEpoch: true,
      environments: {
        where: { lifecycle: "ACTIVE", currentHeadId: { not: null } },
        orderBy: { id: "asc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  if (projects.length * devices.length > 128)
    throw new ContractError("payload_too_large");
  return {
    teamId,
    membershipId,
    userId: member.userId,
    role: member.role,
    projects: projects.map((project) => {
      const epoch = Number(project.currentEpoch);
      const environmentId = project.environments[0]?.id;
      if (!Number.isSafeInteger(epoch) || !environmentId)
        throw new ContractError("state_conflict");
      return { id: project.id, epoch, environmentId };
    }),
    devices: devices.map((device) => ({
      id: device.id,
      encryptionPublicKey: Buffer.from(device.x25519PublicKey).toString("hex"),
    })),
  };
};

export const registerMembershipProvisioningRoutes = (
  app: Hono,
  {
    database,
    profile,
    auth,
  }: Readonly<{
    database: DatabaseClient;
    profile: ServerProfileConfig;
    auth: DotRelayAuth;
  }>,
) => {
  const path = "/api/v1/teams/:teamId/memberships/:membershipId/provision";
  app.get(path, async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const plan = await loadMembershipProvisioningPlan(
        database,
        actor,
        parseUuid(context.req.param("teamId"), "teamId"),
        parseUuid(context.req.param("membershipId"), "membershipId"),
      );
      return context.json(plan, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      return problem(context, error);
    }
  });
  app.post(
    path,
    bodyLimit({
      maxSize: profile.limits.adminBodyBytes,
      onError: (context) =>
        problem(context, new ContractError("payload_too_large")),
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
        const teamId = parseUuid(context.req.param("teamId"), "teamId");
        const membershipId = parseUuid(
          context.req.param("membershipId"),
          "membershipId",
        );
        const body = parseJsonObject(await context.req.json(), [
          "operationId",
          "activation",
          "grants",
        ]);
        const operationId = parseIdempotencyKey(
          context.req.header("Idempotency-Key"),
        );
        if (
          body.operationId !== operationId ||
          !Array.isArray(body.grants) ||
          body.grants.length > 128
        )
          throw new ContractError("invalid_request");
        const activation = await parseProtocolPayload(
          parseJsonObject(body.activation, ["objectId", "object"]),
          "objectId",
          "object",
          6,
        );
        if (
          uuid(activation.object, 11) !== teamId ||
          uuid(activation.object, 12) !== membershipId ||
          uuid(activation.object, 17) !== operationId ||
          uuid(activation.object, 23) !== actor.deviceId
        )
          throw new ContractError("invalid_crypto_object");
        const grants = await Promise.all(
          body.grants.map((grant) =>
            parseProtocolPayload(
              parseJsonObject(grant, ["objectId", "object"]),
              "objectId",
              "object",
              7,
            ),
          ),
        );
        const device = await database.device.findFirst({
          where: {
            id: actor.deviceId,
            userId: actor.userId,
            lifecycle: "ACTIVE",
          },
        });
        if (!device) throw new ContractError("device_not_active");
        const signingKey = await crypto.subtle.importKey(
          "raw",
          new Uint8Array(device.ed25519PublicKey),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        for (const payload of [activation, ...grants]) {
          if (
            uuid(payload.object, 8) !== profile.id ||
            !(await verifyProtocolObject(
              payload.object,
              bytes(payload.object, 4, 64),
              signingKey,
            ))
          )
            throw new ContractError("invalid_crypto_object");
        }
        const operation = {
          id: operationId,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          kind: "MEMBERSHIP_CHANGE" as const,
          commandBytes: activation.canonicalBytes,
          commandDigest: activation.digest,
        };
        await database.$transaction(
          async (transaction) => {
            await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
            const begun = await new OperationRepository().begin(
              transaction,
              operation,
            );
            if (begun.idempotent) return;
            // Project initialization and epoch rotation lock these rows, so the
            // signed grant set cannot go stale between validation and activation.
            await transaction.$queryRaw`SELECT "id" FROM "projects" WHERE "teamId" = ${teamId} ORDER BY "id" FOR UPDATE`;
            const target = await transaction.membership.findFirst({
              where: { id: membershipId, teamId },
            });
            if (!target) throw new ContractError("resource_not_found");
            await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${target.userId} FOR UPDATE`;
            const plan = await loadMembershipProvisioningPlan(
              transaction,
              actor,
              teamId,
              membershipId,
            );
            const object = activation.object;
            if (
              uuid(object, 9) !== plan.userId ||
              uuid(object, 11) !== teamId ||
              uuid(object, 12) !== membershipId ||
              uuid(object, 17) !== operationId ||
              uuid(object, 23) !== actor.deviceId ||
              Number(object.get(78)) !==
                { OWNER: 1, ADMIN: 2, MEMBER: 3 }[plan.role] ||
              !equal(
                canonicalEncode(object.get(55) as CborValue),
                canonicalEncode(
                  plan.devices.map((recipient) => uuidToBytes(recipient.id)),
                ),
              ) ||
              grants.length !== plan.projects.length * plan.devices.length
            )
              throw new ContractError("state_conflict");
            const references: CborValue[] = [];
            let index = 0;
            const now = new Date();
            const stage = async (
              inputOperation:
                | typeof operation
                | {
                    id: string;
                    actorUserId: string;
                    actorDeviceId: string;
                    kind: "ADMINISTRATION";
                    commandBytes: Uint8Array;
                    commandDigest: Uint8Array;
                  },
              payload: typeof activation,
            ) => {
              await new OperationRepository().begin(
                transaction,
                inputOperation,
              );
              await new StagedObjectRepository().put(transaction, {
                operationId: inputOperation.id,
                objectId: payload.id,
                actorDeviceId: actor.deviceId,
                canonicalBytes: payload.canonicalBytes,
                digest: payload.digest,
                createdAt: now,
                expiresAt: new Date(
                  now.getTime() + profile.limits.stagingTtlSeconds * 1000,
                ),
                limits: profile.limits,
              });
            };
            for (const project of plan.projects) {
              for (const recipient of plan.devices) {
                const payload = grants[index++];
                if (!payload) throw new ContractError("invalid_request");
                const grant = payload.object;
                const ciphertext = bytes(grant, 47);
                if (
                  uuid(grant, 11) !== teamId ||
                  uuid(grant, 13) !== project.id ||
                  uuid(grant, 24) !== actor.deviceId ||
                  uuid(grant, 25) !== recipient.id ||
                  Number(grant.get(30)) !== project.epoch ||
                  grant.get(37) !== 1 ||
                  grant.get(70) !== 1 ||
                  grant.get(71) !== 32 ||
                  grant.get(72) !== ciphertext.length ||
                  !equal(
                    bytes(grant, 39, 32),
                    Uint8Array.from(
                      Buffer.from(recipient.encryptionPublicKey, "hex"),
                    ),
                  ) ||
                  !equal(bytes(grant, 48, 48), await sha384(ciphertext))
                )
                  throw new ContractError("invalid_crypto_object");
                const grantOperation = {
                  ...operation,
                  id: crypto.randomUUID(),
                  kind: "ADMINISTRATION" as const,
                  commandBytes: payload.canonicalBytes,
                  commandDigest: payload.digest,
                };
                await stage(grantOperation, payload);
                await new GrantRepository().create(transaction, {
                  operation: grantOperation,
                  grant: {
                    protocolObject: { ...payload, projectId: project.id },
                    projectId: project.id,
                    teamId,
                    membershipId,
                    senderDeviceId: actor.deviceId,
                    recipientDeviceId: recipient.id,
                    recipientDeviceIds: [recipient.id],
                    keyKind: "PROJECT_EPOCH",
                    grantKind: "CURRENT_PROJECT_EPOCH",
                    projectEpoch: BigInt(project.epoch),
                    plaintextLength: 32,
                    ciphertextLength: ciphertext.length,
                    ciphertextHash: bytes(grant, 48, 48),
                  },
                });
                references.push(
                  new Map<number, CborValue>([
                    [13, uuidToBytes(project.id)],
                    [25, uuidToBytes(recipient.id)],
                    [30, project.epoch],
                    [48, payload.digest],
                  ]),
                );
              }
            }
            if (
              !equal(
                canonicalEncode(object.get(56) as CborValue),
                canonicalEncode(references),
              )
            )
              throw new ContractError("invalid_crypto_object");
            await stage(operation, activation);
            await new MembershipRepository().activate(transaction, {
              operation,
              teamId,
              membershipId,
              requiredGrantCount: grants.length,
              grantObjectIds: grants.map((grant) => grant.id),
              activationObject: activation,
            });
          },
          { maxWait: 5000, timeout: 10000 },
        );
        return context.json({ membershipId, lifecycle: "ACTIVE" }, 200, {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        return problem(context, error);
      }
    },
  );
};
