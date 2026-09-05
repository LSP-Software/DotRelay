import {
  ContractError,
  createProblem,
  type ProblemCode,
  parseIdempotencyKey,
  parseJsonObject,
  parseUuid,
} from "@dotrelay/contracts";
import {
  AdministrationRepository,
  type DatabaseClient,
  EnvironmentRepository,
  OperationConflictError,
  ProjectRepository,
  sha384Digest,
} from "@dotrelay/database";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "./auth";
import type { ServerProfileConfig } from "./profile";
import { requireProtocolActor } from "./protocol/context";
import { mapPersistenceError } from "./protocol/errors";

type AdministrationRouteDependencies = Readonly<{
  readonly database: DatabaseClient;
  readonly profile: ServerProfileConfig;
  readonly auth: DotRelayAuth;
}>;

const responseProblem = (context: Context, code: ProblemCode) => {
  const problem = createProblem(code);
  return context.json(problem, problem.status as ContentfulStatusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  });
};

const mapAdministrationError = (error: unknown): ProblemCode => {
  if (error instanceof ContractError) return error.code;
  if (error instanceof OperationConflictError) return "operation_conflict";
  const mapped = mapPersistenceError(error);
  if (mapped) return mapped.code;
  if (!(error instanceof Error)) return "service_unavailable";
  if (error.message.includes("not found")) return "resource_not_found";
  if (error.message.includes("archived")) return "archived_resource";
  if (error.message.includes("authorized")) return "forbidden";
  if (
    error.message.includes("must be positive") ||
    error.message.includes("unsupported media type") ||
    error.message.includes("Team name")
  )
    return "invalid_request";
  return "state_conflict";
};

const readJsonBody = async (
  context: Context,
  allowedFields: readonly string[],
): Promise<Record<string, unknown>> => {
  if (
    context.req.header("Content-Type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  )
    throw new Error("unsupported media type");
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new ContractError("invalid_request");
  }
  return parseJsonObject(body, allowedFields);
};

const requireTeamName = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Team name is required");
  const name = value.trim();
  if (name.length === 0 || name.length > 255)
    throw new Error("Team name must be 1 to 255 characters");
  return name;
};

const requireRepositoryId = (value: unknown): bigint => {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n
  )
    throw new Error("GitHub Repository id must be positive");
  return BigInt(value);
};

const projectResponse = (project: {
  readonly id: string;
  readonly teamId: string;
  readonly githubRepositoryId: bigint;
  readonly lifecycle: "ACTIVE" | "ARCHIVED";
}) => ({
  id: project.id,
  teamId: project.teamId,
  githubRepositoryId: project.githubRepositoryId.toString(),
  lifecycle: project.lifecycle.toLowerCase(),
});

const environmentResponse = (environment: {
  readonly id: string;
  readonly projectId: string;
  readonly lifecycle: "ACTIVE" | "ARCHIVED";
  readonly currentHeadId: string | null;
}) => ({
  id: environment.id,
  projectId: environment.projectId,
  lifecycle: environment.lifecycle.toLowerCase(),
  currentHeadId: environment.currentHeadId,
});

export const registerAdministrationRoutes = (
  app: Hono,
  { database, profile, auth }: AdministrationRouteDependencies,
) => {
  const administration = new AdministrationRepository();
  const environments = new EnvironmentRepository();
  const projects = new ProjectRepository();

  app.use(
    "/api/v1/projects",
    bodyLimit({
      maxSize: profile.limits.adminBodyBytes,
      onError: (context) => responseProblem(context, "payload_too_large"),
    }),
  );
  app.use(
    "/api/v1/projects/*",
    bodyLimit({
      maxSize: profile.limits.adminBodyBytes,
      onError: (context) => responseProblem(context, "payload_too_large"),
    }),
  );
  app.use(
    "/api/v1/teams",
    bodyLimit({
      maxSize: profile.limits.adminBodyBytes,
      onError: (context) => responseProblem(context, "payload_too_large"),
    }),
  );

  app.get("/api/v1/projects", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const repositoryId = requireRepositoryId(
        context.req.query("githubRepositoryId"),
      );
      const projects = await database.project.findMany({
        where: {
          githubRepositoryId: repositoryId,
          team: {
            memberships: {
              some: { userId: actor.userId, lifecycle: "ACTIVE" },
            },
          },
        },
        select: {
          id: true,
          teamId: true,
          githubRepositoryId: true,
          lifecycle: true,
        },
      });
      if (projects.length > 1)
        return responseProblem(context, "state_conflict");
      return context.json(
        { project: projects[0] ? projectResponse(projects[0]) : null },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return responseProblem(context, mapAdministrationError(error));
    }
  });

  app.get("/api/v1/teams", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    const teams = await database.team.findMany({
      where: {
        memberships: { some: { userId: actor.userId, lifecycle: "ACTIVE" } },
      },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    });
    return context.json({ teams }, 200, { "Cache-Control": "no-store" });
  });

  app.post("/api/v1/teams", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readJsonBody(context, ["name"]);
      const name = requireTeamName(body.name);
      const operationId = parseIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );
      const commandBytes = new TextEncoder().encode(
        JSON.stringify({ action: "team.create", name }),
      );
      const result = await administration.createTeamWithOwner(database, {
        serverProfileId: profile.id,
        ownerUserId: actor.userId,
        name,
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          kind: "ADMINISTRATION",
          commandBytes,
          commandDigest: await sha384Digest(commandBytes),
        },
      });
      if (!("team" in result))
        return responseProblem(context, "state_conflict");
      return context.json(
        { id: result.team.id, name: result.team.name },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return responseProblem(context, mapAdministrationError(error));
    }
  });

  app.post("/api/v1/projects", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readJsonBody(context, [
        "teamId",
        "repositoryHost",
        "repositoryOwner",
        "repositoryName",
        "githubRepositoryId",
      ]);
      if (
        body.repositoryHost !== "github.com" ||
        typeof body.repositoryOwner !== "string" ||
        body.repositoryOwner.length === 0 ||
        typeof body.repositoryName !== "string" ||
        body.repositoryName.length === 0
      )
        return responseProblem(context, "invalid_request");
      const teamId = parseUuid(body.teamId, "teamId");
      const githubRepositoryId = requireRepositoryId(body.githubRepositoryId);
      const operationId = parseIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );
      const commandBytes = new TextEncoder().encode(
        JSON.stringify({
          action: "project.link",
          teamId,
          repositoryHost: body.repositoryHost,
          repositoryOwner: body.repositoryOwner,
          repositoryName: body.repositoryName,
          githubRepositoryId: githubRepositoryId.toString(),
        }),
      );
      const result = await projects.create(database, {
        teamId,
        githubRepositoryId,
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          kind: "ADMINISTRATION",
          commandBytes,
          commandDigest: await sha384Digest(commandBytes),
        },
      });
      if (!("project" in result))
        return responseProblem(context, "state_conflict");
      return context.json(projectResponse(result.project), 201, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseProblem(context, mapAdministrationError(error));
    }
  });

  app.get("/api/v1/projects/:projectId/environments", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const projectId = parseUuid(context.req.param("projectId"), "projectId");
      const project = await database.project.findUnique({
        where: { id: projectId },
        select: { teamId: true },
      });
      if (!project) return responseProblem(context, "resource_not_found");
      const membership = await database.membership.findFirst({
        where: {
          teamId: project.teamId,
          userId: actor.userId,
          lifecycle: "ACTIVE",
        },
        select: { id: true },
      });
      if (!membership) return responseProblem(context, "resource_not_found");
      const environments = await database.environment.findMany({
        where: { projectId },
        select: {
          id: true,
          projectId: true,
          lifecycle: true,
          currentHeadId: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return context.json(
        { environments: environments.map(environmentResponse) },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return responseProblem(context, mapAdministrationError(error));
    }
  });

  app.post("/api/v1/projects/:projectId/environments", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const projectId = parseUuid(context.req.param("projectId"), "projectId");
      await readJsonBody(context, []);
      const operationId = parseIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );
      const commandBytes = new TextEncoder().encode(
        JSON.stringify({ action: "environment.create", projectId }),
      );
      const result = await environments.create(database, {
        projectId,
        createdByUserId: actor.userId,
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          kind: "ADMINISTRATION",
          commandBytes,
          commandDigest: await sha384Digest(commandBytes),
        },
      });
      if (!("environment" in result))
        return responseProblem(context, "state_conflict");
      return context.json(environmentResponse(result.environment), 201, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseProblem(context, mapAdministrationError(error));
    }
  });
};
