import {
  ContractError,
  createProblem,
  type ProblemCode,
  parseIdempotencyKey,
  parseJsonObject,
  parseUuid,
} from "@dotrelay/contracts";
import {
  AccountDeletedError,
  AccountDeletionConfirmationError,
  AccountLifecycleRepository,
  type DatabaseClient,
  MembershipAdministrationRepository,
  OwnerTransferRequiredError,
  sha384Digest,
  TEAM_PURGE_AFTER_MS,
  TeamDeletionConfirmationError,
  TeamLifecycleRepository,
} from "@dotrelay/database";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "./auth";
import type { ServerProfileConfig } from "./profile";
import { requireProtocolActor, requireWebActor } from "./protocol/context";
import { mapPersistenceError } from "./protocol/errors";

// Self-service lifecycle routes: leaving a Team, deleting a Team, and
// exporting or deleting the signed-in User's account (ADRs 0018, 0019).

type AccountRouteDependencies = Readonly<{
  readonly database: DatabaseClient;
  readonly profile: ServerProfileConfig;
  readonly auth: DotRelayAuth;
}>;

const noStore = { "Cache-Control": "no-store" } as const;

const responseProblem = (context: Context, code: ProblemCode) => {
  const problem = createProblem(code);
  return context.json(problem, problem.status as ContentfulStatusCode, {
    ...noStore,
    "Content-Type": "application/problem+json",
  });
};

const mapLifecycleError = (error: unknown): ProblemCode => {
  if (error instanceof ContractError) return error.code;
  if (error instanceof OwnerTransferRequiredError)
    return "owner_transfer_required";
  if (
    error instanceof TeamDeletionConfirmationError ||
    error instanceof AccountDeletionConfirmationError
  )
    return "invalid_request";
  if (error instanceof AccountDeletedError) return "authentication_required";
  const mapped = mapPersistenceError(error);
  if (mapped) return mapped.code;
  return "service_unavailable";
};

const readJsonBody = async (
  context: Context,
  allowedFields: readonly string[],
): Promise<Record<string, unknown>> => {
  if (
    context.req.header("Content-Type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  )
    throw new ContractError("unsupported_media_type");
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new ContractError("invalid_request");
  }
  return parseJsonObject(body, allowedFields);
};

const requireString = (value: unknown, maxLength: number): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  )
    throw new ContractError("invalid_request");
  return value;
};

// Each command names its Idempotency-Key, so a retry with a new key is a new
// command rather than a conflict with the committed one.
const commandFor = async (command: Readonly<Record<string, string>>) => {
  const commandBytes = new TextEncoder().encode(JSON.stringify(command));
  return { commandBytes, commandDigest: await sha384Digest(commandBytes) };
};

export const registerAccountRoutes = (
  app: Hono,
  { database, profile, auth }: AccountRouteDependencies,
) => {
  const memberships = new MembershipAdministrationRepository();
  const teams = new TeamLifecycleRepository();
  const accounts = new AccountLifecycleRepository();
  const limit = bodyLimit({
    maxSize: profile.limits.adminBodyBytes,
    onError: (context) => responseProblem(context, "payload_too_large"),
  });
  app.use("/api/v1/account/*", limit);

  // The signed-in User ends their own Membership. Session only: a Member
  // still waiting for keys has no Device yet. The last active owner may not
  // leave while anyone else remains.
  app.post("/api/v1/teams/:teamId/leave", async (context) => {
    const actor = await requireWebActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const teamId = parseUuid(context.req.param("teamId"), "teamId");
      await readJsonBody(context, []);
      const operationId = parseIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );
      const result = await memberships.leave(database, {
        teamId,
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          kind: "MEMBERSHIP_CHANGE",
          ...(await commandFor({ action: "team.leave", teamId, operationId })),
        },
      });
      const membership =
        "membership" in result
          ? result.membership
          : await database.membership.findUnique({
              where: { teamId_userId: { teamId, userId: actor.userId } },
              select: { id: true },
            });
      if (!membership) return responseProblem(context, "state_conflict");
      return context.json(
        { teamId, membershipId: membership.id, lifecycle: "REMOVED" },
        "membership" in result ? 201 : 200,
        noStore,
      );
    } catch (error) {
      return responseProblem(context, mapLifecycleError(error));
    }
  });

  // An owner deletes the Team. The body repeats the Team name. Everyone
  // loses access at once; retention purges the ciphertext later.
  app.post("/api/v1/teams/:teamId/delete", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const teamId = parseUuid(context.req.param("teamId"), "teamId");
      const body = await readJsonBody(context, ["confirmName"]);
      const confirmName = requireString(body.confirmName, 255);
      const operationId = parseIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );
      const result = await teams.deleteTeam(database, {
        teamId,
        confirmName,
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          kind: "ADMINISTRATION",
          ...(await commandFor({
            action: "team.delete",
            teamId,
            confirmName,
            operationId,
          })),
        },
      });
      const deletedAt =
        "deletedAt" in result
          ? result.deletedAt
          : (
              await database.team.findUnique({
                where: { id: teamId },
                select: { deletedAt: true },
              })
            )?.deletedAt;
      if (!deletedAt) return responseProblem(context, "state_conflict");
      return context.json(
        {
          teamId,
          status: "DELETED",
          deletedAt: deletedAt.toISOString(),
          purgeAfter: new Date(
            deletedAt.getTime() + TEAM_PURGE_AFTER_MS,
          ).toISOString(),
        },
        "deletedAt" in result ? 201 : 200,
        noStore,
      );
    } catch (error) {
      return responseProblem(context, mapLifecycleError(error));
    }
  });

  // The account metadata the service holds about the signed-in User, as a
  // JSON download. No ciphertext, wrapped keys, public keys, or tokens.
  app.get("/api/v1/account/export", async (context) => {
    const actor = await requireWebActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const exported = await accounts.exportAccount(database, actor.userId);
      const exportedAt = new Date();
      return context.json(
        {
          ...exported,
          exportedAt: exportedAt.toISOString(),
          serverOrigin: profile.origin,
        },
        200,
        {
          ...noStore,
          "Content-Disposition": `attachment; filename="dotrelay-account-${exportedAt.toISOString().slice(0, 10)}.json"`,
        },
      );
    } catch (error) {
      return responseProblem(context, mapLifecycleError(error));
    }
  });

  // What deleting the account would do: Teams that block it, Teams deleted
  // with it, and Teams the User would leave.
  app.get("/api/v1/account/deletion", async (context) => {
    const actor = await requireWebActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const plan = await accounts.deletionPlan(database, actor.userId);
      return context.json(
        {
          userId: actor.userId,
          blockingTeams: plan.blockingTeams,
          teamsDeleted: plan.teamsDeleted,
          teamsLeft: plan.teamsLeft,
        },
        200,
        noStore,
      );
    } catch (error) {
      return responseProblem(context, mapLifecycleError(error));
    }
  });

  // Deletes the signed-in User's account (ADR 0018). Session only, so a
  // User who lost every Device can still delete; the body repeats the User
  // id. Every session of the User ends with it.
  app.post("/api/v1/account/delete", async (context) => {
    const actor = await requireWebActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readJsonBody(context, ["confirmUserId"]);
      const confirmUserId = requireString(body.confirmUserId, 64);
      const operationId = parseIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );
      const result = await accounts.deleteAccount(database, {
        confirmUserId,
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          kind: "ACCOUNT_DELETION",
          ...(await commandFor({
            action: "account.delete",
            confirmUserId,
            operationId,
          })),
        },
      });
      if (!("deletedAt" in result))
        return responseProblem(context, "state_conflict");
      return context.json(
        {
          userId: actor.userId,
          status: "DELETED",
          deletedAt: result.deletedAt.toISOString(),
          teamsDeleted: result.teamsDeleted,
          teamsLeft: result.teamsLeft,
        },
        201,
        noStore,
      );
    } catch (error) {
      return responseProblem(context, mapLifecycleError(error));
    }
  });
};
