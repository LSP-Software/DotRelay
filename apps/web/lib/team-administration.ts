import {
  BROWSER_DEVICE_ID_HEADER,
  type MembershipRole,
} from "./workspace-boundary";

// Browser client for the Team membership and invitation surfaces. These calls
// go straight from the browser to the Server Profile's API origin (like the
// device and grant bootstraps) so the workspace reflects the persisted Team
// record — the Members table and pending invitations survive a reload or a
// Team switch because nothing here is held in component state.

export type MembershipLifecycle = "ACTIVE" | "PENDING_KEY_GRANT" | "REMOVED";

export type TeamMember = Readonly<{
  readonly membershipId: string;
  readonly userId: string;
  readonly name: string | null;
  readonly image: string | null;
  readonly githubSubject: string;
  readonly lifecycle: MembershipLifecycle;
  // Present only for Owners and Admins: the service withholds roles and the
  // removed history from plain Members.
  readonly role?: MembershipRole;
  readonly createdAt?: string;
  readonly activatedAt?: string | null;
  readonly removedAt?: string | null;
}>;

export type TeamInvitation = Readonly<{
  readonly invitationId: string;
  readonly providerSubject: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}>;

export type TeamMembershipState = Readonly<{
  readonly memberships: readonly TeamMember[];
  readonly invitations: readonly TeamInvitation[];
}>;

export type ResolvedGitHubUser = Readonly<{
  readonly login: string;
  readonly githubUserId: string;
}>;

export type MyInvitation = Readonly<{
  readonly invitationId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly providerSubject: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}>;

export type MyPendingMembership = Readonly<{
  readonly teamId: string;
  readonly teamName: string;
}>;

export type MyInvitations = Readonly<{
  readonly invitations: readonly MyInvitation[];
  readonly pendingMemberships: readonly MyPendingMembership[];
}>;

export type AcceptedInvitation = Readonly<{
  readonly membershipId: string;
  readonly teamId: string;
  readonly lifecycle: "PENDING_KEY_GRANT";
}>;

export type TeamAdminResult<T> =
  | Readonly<{ readonly ok: true; readonly data: T }>
  | Readonly<{ readonly ok: false; readonly message: string }>;

const failure = <T>(message: string): TeamAdminResult<T> => ({
  ok: false,
  message,
});

// Maps the service's stable problem codes to a sentence a person can act on.
// The raw code and any detail are deliberately not shown.
const problemMessage = (code: unknown): string => {
  switch (code) {
    case "authentication_required":
      return "Sign in again to manage this team.";
    case "device_not_active":
      return "Set up this browser before managing team members.";
    case "invalid_request":
      return "That value didn't look right. Check it and try again.";
    case "resource_not_found":
      return "We couldn't find that on this server.";
    case "github_identity_not_found":
      return "We couldn't find that GitHub login. Check the spelling and try again.";
    case "github_rate_limited":
      return "GitHub is limiting requests right now. Wait a moment and try again.";
    case "github_unavailable":
      return "GitHub is unavailable right now. Try again in a moment.";
    case "forbidden":
      return "You don't have permission to do that on this team.";
    case "invitation_expired":
      return "That invitation expired or was already used.";
    case "archived_resource":
      return "This team is archived.";
    case "operation_conflict":
      return "Something changed while you were working. Refresh and try again.";
    case "last_owner_protection":
      return "This team needs at least one active owner. Promote another owner first.";
    case "state_conflict":
      return "Something changed while you were working. Refresh and try again.";
    case "payload_too_large":
      return "That request was too large.";
    case "service_unavailable":
      return "The server is unavailable. Try again.";
    default:
      return "Something went wrong. Try again.";
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

type FetchOutcome =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly message: string };

const call = async (
  apiOrigin: string,
  path: string,
  init?: RequestInit,
): Promise<FetchOutcome> => {
  let response: Response;
  try {
    response = await fetch(`${apiOrigin}${path}`, {
      credentials: "include",
      ...init,
    });
  } catch {
    return {
      ok: false,
      message:
        "We couldn't reach the server. Check your connection and try again.",
    };
  }
  if (response.ok) {
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, message: "The server returned a malformed reply." };
    }
  }
  const body = (await response.json().catch(() => null)) as {
    readonly code?: unknown;
  } | null;
  return { ok: false, message: problemMessage(body?.code) };
};

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const parseTeamMembershipState = (
  body: unknown,
): TeamMembershipState | null => {
  if (!isRecord(body)) return null;
  const memberships: TeamMember[] = asArray(body.memberships).flatMap(
    (entry): TeamMember[] => {
      if (!isRecord(entry)) return [];
      const membershipId = asString(entry.membershipId);
      const userId = asString(entry.userId);
      const githubSubject = asString(entry.githubSubject);
      if (!membershipId || !userId || !githubSubject) return [];
      const lifecycle =
        entry.lifecycle === "PENDING_KEY_GRANT" || entry.lifecycle === "REMOVED"
          ? entry.lifecycle
          : "ACTIVE";
      const member: TeamMember = {
        membershipId,
        userId,
        name: asString(entry.name) ?? null,
        image: asString(entry.image) ?? null,
        githubSubject,
        lifecycle,
      };
      const role = entry.role;
      if (role === "OWNER" || role === "ADMIN" || role === "MEMBER") {
        return [{ ...member, role }];
      }
      return [member];
    },
  );
  const invitations = asArray(body.invitations).flatMap((entry) => {
    const invitation = parseInvitationEntry(entry);
    return invitation === null ? [] : [invitation];
  });
  return { memberships, invitations };
};

export const parseMyInvitations = (body: unknown): MyInvitations | null => {
  if (!isRecord(body)) return null;
  const invitations = asArray(body.invitations).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const invitationId = asString(entry.invitationId);
    const teamId = asString(entry.teamId);
    const providerSubject = asString(entry.providerSubject);
    const expiresAt = asString(entry.expiresAt);
    if (!invitationId || !teamId || !providerSubject || !expiresAt) return [];
    return [
      {
        invitationId,
        teamId,
        teamName: asString(entry.teamName) ?? "",
        providerSubject,
        createdAt: asString(entry.createdAt) ?? "",
        expiresAt,
      },
    ];
  });
  const pendingMemberships = asArray(body.pendingMemberships).flatMap(
    (entry) => {
      if (!isRecord(entry)) return [];
      const teamId = asString(entry.teamId);
      if (!teamId) return [];
      return [{ teamId, teamName: asString(entry.teamName) ?? "" }];
    },
  );
  return { invitations, pendingMemberships };
};

const parseResolvedGitHubUser = (body: unknown): ResolvedGitHubUser | null => {
  if (!isRecord(body)) return null;
  const login = asString(body.login);
  const githubUserId = asString(body.githubUserId);
  if (!login || !githubUserId) return null;
  return { login, githubUserId };
};

const parseInvitationEntry = (entry: unknown): TeamInvitation | null => {
  if (!isRecord(entry)) return null;
  const invitationId = asString(entry.invitationId);
  const providerSubject = asString(entry.providerSubject);
  const expiresAt = asString(entry.expiresAt);
  if (!invitationId || !providerSubject || !expiresAt) return null;
  return {
    invitationId,
    providerSubject,
    createdAt: asString(entry.createdAt) ?? "",
    expiresAt,
  };
};

const parseAcceptedInvitation = (body: unknown): AcceptedInvitation | null => {
  if (!isRecord(body)) return null;
  const membershipId = asString(body.membershipId);
  const teamId = asString(body.teamId);
  if (!membershipId || !teamId) return null;
  return { membershipId, teamId, lifecycle: "PENDING_KEY_GRANT" };
};

const deviceHeaders = (deviceId?: string): HeadersInit =>
  deviceId ? { [BROWSER_DEVICE_ID_HEADER]: deviceId } : {};

export const fetchTeamMemberships = async (
  apiOrigin: string,
  teamId: string,
): Promise<TeamAdminResult<TeamMembershipState>> => {
  const outcome = await call(apiOrigin, `/api/v1/teams/${teamId}/memberships`);
  if (!outcome.ok) return failure(outcome.message);
  const state = parseTeamMembershipState(outcome.body);
  if (!state) return failure("The server returned a malformed reply.");
  return { ok: true, data: state };
};

export const resolveGitHubLogin = async (
  apiOrigin: string,
  login: string,
  deviceId?: string,
): Promise<TeamAdminResult<ResolvedGitHubUser>> => {
  const outcome = await call(apiOrigin, "/api/v1/github-users/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...deviceHeaders(deviceId) },
    body: JSON.stringify({ login }),
  });
  if (!outcome.ok) return failure(outcome.message);
  const user = parseResolvedGitHubUser(outcome.body);
  if (!user) return failure("The server returned a malformed reply.");
  return { ok: true, data: user };
};

export const createTeamInvitation = async (
  apiOrigin: string,
  teamId: string,
  providerSubject: string,
  deviceId?: string,
): Promise<TeamAdminResult<TeamInvitation>> => {
  const outcome = await call(apiOrigin, `/api/v1/teams/${teamId}/invitations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": globalThis.crypto.randomUUID(),
      ...deviceHeaders(deviceId),
    },
    body: JSON.stringify({ providerSubject }),
  });
  if (!outcome.ok) return failure(outcome.message);
  const invitation = parseInvitationEntry(outcome.body);
  if (!invitation) return failure("The server returned a malformed reply.");
  return { ok: true, data: invitation };
};

export const fetchMyInvitations = async (
  apiOrigin: string,
): Promise<TeamAdminResult<MyInvitations>> => {
  const outcome = await call(apiOrigin, "/api/v1/invitations");
  if (!outcome.ok) return failure(outcome.message);
  const invitations = parseMyInvitations(outcome.body);
  if (!invitations) return failure("The server returned a malformed reply.");
  return { ok: true, data: invitations };
};

export const acceptTeamInvitation = async (
  apiOrigin: string,
  invitationId: string,
): Promise<TeamAdminResult<AcceptedInvitation>> => {
  const outcome = await call(
    apiOrigin,
    `/api/v1/invitations/${invitationId}/accept`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": globalThis.crypto.randomUUID(),
      },
      body: "{}",
    },
  );
  if (!outcome.ok) return failure(outcome.message);
  const accepted = parseAcceptedInvitation(outcome.body);

  if (!accepted) return failure("The server returned a malformed reply.");
  return { ok: true, data: accepted };
};
export type MemberRoleChange = Readonly<{
  readonly membershipId: string;
  readonly teamId: string;
  readonly role: MembershipRole;
  readonly lifecycle: MembershipLifecycle;
}>;

export type MemberRemoval = Readonly<{
  readonly membershipId: string;
  readonly teamId: string;
  readonly lifecycle: MembershipLifecycle;
}>;

const parseMemberRoleChange = (body: unknown): MemberRoleChange | null => {
  if (!isRecord(body)) return null;
  const membershipId = asString(body.membershipId);
  const teamId = asString(body.teamId);
  const lifecycle = asString(body.lifecycle);
  const role = body.role;
  if (
    !membershipId ||
    !teamId ||
    (lifecycle !== "ACTIVE" &&
      lifecycle !== "PENDING_KEY_GRANT" &&
      lifecycle !== "REMOVED") ||
    (role !== "OWNER" && role !== "ADMIN" && role !== "MEMBER")
  )
    return null;
  return {
    membershipId,
    teamId,
    role,
    lifecycle: lifecycle as MembershipLifecycle,
  };
};

const parseMemberRemoval = (body: unknown): MemberRemoval | null => {
  if (!isRecord(body)) return null;
  const membershipId = asString(body.membershipId);
  const teamId = asString(body.teamId);
  const lifecycle = asString(body.lifecycle);
  if (
    !membershipId ||
    !teamId ||
    (lifecycle !== "ACTIVE" &&
      lifecycle !== "PENDING_KEY_GRANT" &&
      lifecycle !== "REMOVED")
  )
    return null;
  return { membershipId, teamId, lifecycle: lifecycle as MembershipLifecycle };
};

// Changes a Member's role in the Team. Owners may change any role; the
// server withholds the owner and admin rows from admins and enforces the
// last-owner guard.
export const changeTeamMemberRole = async (
  apiOrigin: string,
  teamId: string,
  membershipId: string,
  role: MembershipRole,
  deviceId?: string,
): Promise<TeamAdminResult<MemberRoleChange>> => {
  const outcome = await call(
    apiOrigin,
    `/api/v1/teams/${teamId}/memberships/${membershipId}/role`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": globalThis.crypto.randomUUID(),
        ...deviceHeaders(deviceId),
      },
      body: JSON.stringify({ role }),
    },
  );
  if (!outcome.ok) return failure(outcome.message);
  const changed = parseMemberRoleChange(outcome.body);
  if (!changed) return failure("The server returned a malformed reply.");
  return { ok: true, data: changed };
};

// Removes a Member from the Team. The server keeps the Team's last active
// owner in place, so a Team never loses every owner.
export const removeTeamMember = async (
  apiOrigin: string,
  teamId: string,
  membershipId: string,
  deviceId?: string,
): Promise<TeamAdminResult<MemberRemoval>> => {
  const outcome = await call(
    apiOrigin,
    `/api/v1/teams/${teamId}/memberships/${membershipId}/remove`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": globalThis.crypto.randomUUID(),
        ...deviceHeaders(deviceId),
      },
      body: "{}",
    },
  );
  if (!outcome.ok) return failure(outcome.message);
  const removed = parseMemberRemoval(outcome.body);
  if (!removed) return failure("The server returned a malformed reply.");
  return { ok: true, data: removed };
};
