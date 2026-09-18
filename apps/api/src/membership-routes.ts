import {
  ContractError,
  createProblem,
  type ProblemCode,
  parseIdempotencyKey,
  parseJsonObject,
  parseUuid,
} from "@dotrelay/contracts";
import {
  type DatabaseClient,
  MembershipAdministrationRepository,
  OperationConflictError,
  sha384Digest,
} from "@dotrelay/database";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "./auth";
import { isValidGitHubLogin, resolveGitHubUserIdentity } from "./github-user";
import type { ServerProfileConfig } from "./profile";
import { requireProtocolActor, requireWebActor } from "./protocol/context";
import { mapPersistenceError } from "./protocol/errors";

type MembershipRouteDependencies = Readonly<{
  readonly database: DatabaseClient;
  readonly profile: ServerProfileConfig;
  readonly auth: DotRelayAuth;
  readonly githubFetch?: typeof fetch;
}>;

const responseProblem = (context: Context, code: ProblemCode) => {
  const problem = createProblem(code);
  return context.json(problem, problem.status as ContentfulStatusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  });
};

const mapMembershipError = (error: unknown): ProblemCode => {
  if (error instanceof ContractError) return error.code;
  if (error instanceof OperationConflictError) return "operation_conflict";
  // Checked before the generic mapper: its "expired" rule would otherwise
  // surface a used-up invitation as a staging expiry.
  if (
    error instanceof Error &&
    error.message.includes("expired or already used")
  )
    return "invitation_expired";
  const mapped = mapPersistenceError(error);
  if (mapped) return mapped.code;
  if (!(error instanceof Error)) return "service_unavailable";
  if (
    error.message.includes("addressed to another User") ||
    error.message.includes("another Server Profile")
  )
    return "forbidden";
  if (error.message.includes("active actor device")) return "device_not_active";
  if (
    error.message.includes("must be positive") ||
    error.message.includes("unsupported media type") ||
    error.message.includes("GitHub provider subject") ||
    error.message.includes("GitHub login")
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

// A Membership Invitation addresses the invitee's stable GitHub provider
// subject — the numeric GitHub user id — never a mutable login or email.
const requireProviderSubject = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n
  )
    throw new Error("GitHub provider subject must be a stable GitHub id");
  return value;
};

const requireGitHubLogin = (value: unknown): string => {
  if (typeof value !== "string" || !isValidGitHubLogin(value.trim()))
    throw new Error("GitHub login is invalid");
  return value.trim();
};

const loadTeam = async (
  database: MembershipRouteDependencies["database"],
  teamId: string,
): Promise<
  | { readonly code: "not_found" }
  | { readonly code: "archived" }
  | { readonly teamId: string }
> => {
  const team = await database.team.findUnique({
    where: { id: teamId },
    select: { id: true, lifecycle: true },
  });
  if (!team) return { code: "not_found" };
  if (team.lifecycle !== "ACTIVE") return { code: "archived" };
  return { teamId };
};

type MembershipRow = Readonly<{
  readonly id: string;
  readonly userId: string;
  readonly role: "OWNER" | "ADMIN" | "MEMBER";
  readonly lifecycle: "ACTIVE" | "PENDING_KEY_GRANT" | "REMOVED";
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
  readonly removedAt: Date | null;
  readonly authSubject: string;
  readonly githubSubject: string;
}>;

const membershipLifecycleOrder: Readonly<
  Record<MembershipRow["lifecycle"], number>
> = {
  ACTIVE: 0,
  PENDING_KEY_GRANT: 1,
  REMOVED: 2,
};

type InvitationView = Readonly<{
  readonly invitationId: string;
  readonly providerSubject: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}>;

type MembershipView =
  | Readonly<{
      readonly membershipId: string;
      readonly userId: string;
      readonly name: string | null;
      readonly image: string | null;
      readonly githubSubject: string;
      readonly role: MembershipRow["role"];
      readonly lifecycle: MembershipRow["lifecycle"];
      readonly createdAt: string;
      readonly activatedAt: string | null;
      readonly removedAt: string | null;
    }>
  | Readonly<{
      readonly membershipId: string;
      readonly userId: string;
      readonly name: string | null;
      readonly image: string | null;
      readonly githubSubject: string;
      readonly lifecycle: "ACTIVE";
    }>;

const loadTeamMembershipState = async (
  database: MembershipRouteDependencies["database"],
  teamId: string,
  actorUserId: string,
): Promise<
  | { readonly code: "not_found" }
  | { readonly code: "archived" }
  | { readonly code: "forbidden" }
  | {
      readonly code: "ok";
      readonly privileged: boolean;
      readonly memberships: readonly MembershipView[];
      readonly invitations: readonly InvitationView[];
    }
> => {
  const team = await loadTeam(database, teamId);
  if ("code" in team) return team;
  const membership = await database.membership.findFirst({
    where: { teamId, userId: actorUserId },
    select: { role: true, lifecycle: true },
  });
  if (!membership || membership.lifecycle === "REMOVED")
    return { code: "forbidden" };
  const privileged =
    membership.lifecycle === "ACTIVE" &&
    (membership.role === "OWNER" || membership.role === "ADMIN");
  const memberships = await database.membership.findMany({
    where: {
      teamId,
      ...(privileged ? {} : { lifecycle: "ACTIVE" }),
    },
    select: {
      id: true,
      userId: true,
      role: true,
      lifecycle: true,
      createdAt: true,
      activatedAt: true,
      removedAt: true,
      user: { select: { authSubject: true, githubSubject: true } },
    },
  });
  const rows: MembershipRow[] = memberships
    .map((membership) => ({
      id: membership.id,
      userId: membership.userId,
      role: membership.role,
      lifecycle: membership.lifecycle,
      createdAt: membership.createdAt,
      activatedAt: membership.activatedAt,
      removedAt: membership.removedAt,
      authSubject: membership.user.authSubject,
      githubSubject: membership.user.githubSubject,
    }))
    .sort(
      (left, right) =>
        membershipLifecycleOrder[left.lifecycle] -
          membershipLifecycleOrder[right.lifecycle] ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        (left.id < right.id ? -1 : 1),
    );
  const authSubjects = [...new Set(rows.map((row) => row.authSubject))];
  const authUsers = authSubjects.length
    ? await database.authUser.findMany({
        where: { id: { in: authSubjects } },
        select: { id: true, name: true, image: true },
      })
    : [];
  const display = new Map(
    authUsers.map((user) => [user.id, { name: user.name, image: user.image }]),
  );
  const invitations = privileged
    ? await database.membershipInvitation.findMany({
        where: {
          teamId,
          acceptedByUserId: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          providerSubject: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const decorated = rows.map((row) => ({
    membershipId: row.id,
    userId: row.userId,
    name: display.get(row.authSubject)?.name ?? null,
    image: display.get(row.authSubject)?.image ?? null,
    githubSubject: row.githubSubject,
    ...(privileged
      ? {
          role: row.role,
          lifecycle: row.lifecycle,
          createdAt: row.createdAt.toISOString(),
          activatedAt: row.activatedAt?.toISOString() ?? null,
          removedAt: row.removedAt?.toISOString() ?? null,
        }
      : { lifecycle: "ACTIVE" as const }),
  }));
  return {
    code: "ok",
    privileged,
    memberships: decorated,
    invitations: invitations.map((invitation) => ({
      invitationId: invitation.id,
      providerSubject: invitation.providerSubject,
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
    })),
  };
};

export const registerMembershipRoutes = (
  app: Hono,
  { database, profile, auth, githubFetch }: MembershipRouteDependencies,
) => {
  const memberships = new MembershipAdministrationRepository();

  app.use(
    "/api/v1/teams/*",
    bodyLimit({
      maxSize: profile.limits.adminBodyBytes,
      onError: (context) => responseProblem(context, "payload_too_large"),
    }),
  );
  app.use(
    "/api/v1/github-users/*",
    bodyLimit({
      maxSize: profile.limits.adminBodyBytes,
      onError: (context) => responseProblem(context, "payload_too_large"),
    }),
  );
  app.use(
    "/api/v1/invitations/*",
    bodyLimit({
      maxSize: profile.limits.adminBodyBytes,
      onError: (context) => responseProblem(context, "payload_too_large"),
    }),
  );

  // Resolves a familiar GitHub login to its stable GitHub user id on the
  // acting User's behalf, through their Delegated GitHub Access. Invitations
  // address this stable subject, so a login rename or account settings change
  // can never re-address one. Distinct from Repository Resolution, which
  // stays governed by its own ADRs.
  app.post("/api/v1/github-users/resolve", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const body = await readJsonBody(context, ["login"]);
      const login = requireGitHubLogin(body.login);
      const resolutionOptions = githubFetch ? { fetch: githubFetch } : {};
      const outcome = await resolveGitHubUserIdentity(
        auth,
        actor.authSubject,
        login,
        resolutionOptions,
      );
      if (outcome.code === "resolved")
        return context.json(
          { login: outcome.login, githubUserId: outcome.githubUserId },
          200,
          { "Cache-Control": "no-store" },
        );
      if (outcome.code === "github_rate_limited") {
        const problem = createProblem(
          "github_rate_limited",
          outcome.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: outcome.retryAfterSeconds }
            : undefined,
        );
        return context.json(problem, problem.status as ContentfulStatusCode, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      if (outcome.code === "github_access_denied")
        return responseProblem(context, "forbidden");
      if (outcome.code === "github_identity_not_found")
        return responseProblem(context, "github_identity_not_found");
      return responseProblem(context, "github_unavailable");
    } catch (error) {
      return responseProblem(context, mapMembershipError(error));
    }
  });

  // Creates a Membership Invitation for the Team, addressed to the invitee's
  // stable GitHub provider subject. Only an active owner or admin of the
  // Team may invite; the service confirms creation before the browser may
  // claim it.
  app.post("/api/v1/teams/:teamId/invitations", async (context) => {
    const actor = await requireProtocolActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const teamId = parseUuid(context.req.param("teamId"), "teamId");
      const body = await readJsonBody(context, ["providerSubject"]);
      const providerSubject = requireProviderSubject(body.providerSubject);
      const operationId = parseIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );
      const commandBytes = new TextEncoder().encode(
        JSON.stringify({ action: "team.invite", teamId, providerSubject }),
      );
      const result = await memberships.invite(database, {
        teamId,
        providerSubject,
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          kind: "INVITATION",
          commandBytes,
          commandDigest: await sha384Digest(commandBytes),
        },
      });
      if ("invitation" in result) {
        const invitation = result.invitation;
        return context.json(
          {
            invitationId: invitation.id,
            teamId,
            providerSubject: invitation.providerSubject,
            createdAt: invitation.createdAt.toISOString(),
            expiresAt: invitation.expiresAt.toISOString(),
          },
          201,
          { "Cache-Control": "no-store" },
        );
      }
      if (result.idempotent) {
        // A replay names the same Team and subject: report the invitation
        // the original command created instead of a second one.
        const existing = await database.membershipInvitation.findFirst({
          where: { teamId, providerSubject },
          select: {
            id: true,
            providerSubject: true,
            createdAt: true,
            expiresAt: true,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        if (!existing) return responseProblem(context, "state_conflict");
        return context.json(
          {
            invitationId: existing.id,
            teamId,
            providerSubject: existing.providerSubject,
            createdAt: existing.createdAt.toISOString(),
            expiresAt: existing.expiresAt.toISOString(),
          },
          200,
          { "Cache-Control": "no-store" },
        );
      }
      return responseProblem(context, "state_conflict");
    } catch (error) {
      return responseProblem(context, mapMembershipError(error));
    }
  });

  // The Team's pending Membership Invitations, visible to its active owners
  // and admins only: a plain Member never learns whom the Team is inviting.
  app.get("/api/v1/teams/:teamId/invitations", async (context) => {
    const actor = await requireWebActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const teamId = parseUuid(context.req.param("teamId"), "teamId");
      const state = await loadTeamMembershipState(
        database,
        teamId,
        actor.userId,
      );
      if (state.code === "not_found")
        return responseProblem(context, "resource_not_found");
      if (state.code === "archived")
        return responseProblem(context, "archived_resource");
      if (state.code === "forbidden")
        return responseProblem(context, "forbidden");
      return context.json({ invitations: state.invitations }, 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseProblem(context, mapMembershipError(error));
    }
  });

  // The Team's persisted Membership and invitation state. Every active
  // Member sees the active Members; owners and admins additionally see
  // roles, the pending key-grant lifecycle, pending invitations with their
  // expiry, and removed history. Nothing here is derived from the request
  // or a fixture: the table is the Team's record.
  app.get("/api/v1/teams/:teamId/memberships", async (context) => {
    const actor = await requireWebActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const teamId = parseUuid(context.req.param("teamId"), "teamId");
      const state = await loadTeamMembershipState(
        database,
        teamId,
        actor.userId,
      );
      if (state.code === "not_found")
        return responseProblem(context, "resource_not_found");
      if (state.code === "archived")
        return responseProblem(context, "archived_resource");
      if (state.code === "forbidden")
        return responseProblem(context, "forbidden");
      return context.json(
        {
          memberships: state.memberships,
          invitations: state.invitations,
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return responseProblem(context, mapMembershipError(error));
    }
  });

  // The Membership Invitations addressed to the acting User's stable GitHub
  // subject, plus the Teams whose Membership the User accepted but has not
  // finished key provisioning. This is how an invitee sees the persisted
  // invitation they hold and the pending state it creates.
  app.get("/api/v1/invitations", async (context) => {
    const actor = await requireWebActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const user = await database.user.findUnique({
        where: { id: actor.userId },
        select: { githubSubject: true, serverProfileId: true },
      });
      if (!user) return responseProblem(context, "service_unavailable");
      const now = new Date();
      const [invitations, pending] = await Promise.all([
        database.membershipInvitation.findMany({
          where: {
            providerSubject: user.githubSubject,
            acceptedByUserId: null,
            expiresAt: { gt: now },
            team: {
              lifecycle: "ACTIVE",
              serverProfileId: user.serverProfileId,
            },
          },
          select: {
            id: true,
            teamId: true,
            providerSubject: true,
            createdAt: true,
            expiresAt: true,
            team: { select: { name: true } },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
        database.membership.findMany({
          where: {
            userId: actor.userId,
            lifecycle: "PENDING_KEY_GRANT",
            team: {
              lifecycle: "ACTIVE",
              serverProfileId: user.serverProfileId,
            },
          },
          select: { teamId: true, team: { select: { name: true } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      ]);
      return context.json(
        {
          invitations: invitations.map((invitation) => ({
            invitationId: invitation.id,
            teamId: invitation.teamId,
            teamName: invitation.team.name,
            providerSubject: invitation.providerSubject,
            createdAt: invitation.createdAt.toISOString(),
            expiresAt: invitation.expiresAt.toISOString(),
          })),
          pendingMemberships: pending.map((membership) => ({
            teamId: membership.teamId,
            teamName: membership.team.name,
          })),
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return responseProblem(context, mapMembershipError(error));
    }
  });

  // The invitee's User accepts the invitation addressed to its stable
  // GitHub subject; the service creates the PENDING_KEY_GRANT Membership.
  // Activation through key provisioning is a later stage, so no Device is
  // required to accept.
  app.post("/api/v1/invitations/:invitationId/accept", async (context) => {
    const actor = await requireWebActor(context, database, profile, auth);
    if (actor instanceof Response) return actor;
    try {
      const invitationId = parseUuid(
        context.req.param("invitationId"),
        "invitationId",
      );
      const operationId = parseIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );
      const commandBytes = new TextEncoder().encode(
        JSON.stringify({ action: "invitation.accept", invitationId }),
      );
      const result = await memberships.accept(database, {
        invitationId,
        userId: actor.userId,
        operation: {
          id: operationId,
          actorUserId: actor.userId,
          kind: "INVITATION",
          commandBytes,
          commandDigest: await sha384Digest(commandBytes),
        },
      });
      if ("membership" in result) {
        const membership = result.membership;
        return context.json(
          {
            membershipId: membership.id,
            teamId: membership.teamId,
            lifecycle: "PENDING_KEY_GRANT",
          },
          201,
          { "Cache-Control": "no-store" },
        );
      }
      if (result.idempotent) {
        const existing = await database.membership.findFirst({
          where: { invitationId },
          select: { id: true, teamId: true },
        });
        if (!existing) return responseProblem(context, "state_conflict");
        return context.json(
          {
            membershipId: existing.id,
            teamId: existing.teamId,
            lifecycle: "PENDING_KEY_GRANT",
          },
          200,
          { "Cache-Control": "no-store" },
        );
      }
      return responseProblem(context, "state_conflict");
    } catch (error) {
      return responseProblem(context, mapMembershipError(error));
    }
  });
};
