import { rateLimitedMessage, retryAfterSecondsFrom } from "./rate-limit";
import { BROWSER_DEVICE_ID_HEADER } from "./workspace-boundary";

// Browser client for the self-service lifecycle routes: leaving or deleting
// a Team, and exporting or deleting the signed-in account (ADRs 0018, 0019).

export type LifecycleResult<T> =
  | Readonly<{ readonly ok: true; readonly data: T }>
  | Readonly<{ readonly ok: false; readonly message: string }>;

export type TeamRef = Readonly<{
  readonly teamId: string;
  readonly name: string;
}>;

export type AccountDeletionPlan = Readonly<{
  readonly blockingTeams: readonly TeamRef[];
  readonly teamsDeleted: readonly TeamRef[];
  readonly teamsLeft: readonly TeamRef[];
}>;

export const lifecycleProblemMessage = (
  code: unknown,
  retryAfterSeconds?: number,
): string => {
  switch (code) {
    case "owner_transfer_required":
      return "You're this team's only owner. Make another active member an owner, or delete the team, first.";
    case "rate_limited":
      return rateLimitedMessage(retryAfterSeconds);
    case "authentication_required":
      return "Sign in again to continue.";
    case "device_not_active":
      return "Set up this browser before deleting a team.";
    case "forbidden":
      return "Only a team owner can delete the team.";
    case "invalid_request":
      return "The confirmation didn't match. Check it and try again.";
    case "membership_not_active":
      return "You're no longer a member of this team.";
    case "archived_resource":
      return "This team was already deleted.";
    case "resource_not_found":
      return "We couldn't find that on this server.";
    case "service_unavailable":
      return "The server is unavailable. Try again.";
    default:
      return "Something went wrong. Try again.";
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const call = async (
  apiOrigin: string,
  path: string,
  init?: RequestInit,
): Promise<LifecycleResult<unknown>> => {
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
      return { ok: true, data: await response.json() };
    } catch {
      return { ok: false, message: "The server returned a malformed reply." };
    }
  }
  const body = (await response.json().catch(() => null)) as {
    readonly code?: unknown;
  } | null;
  return {
    ok: false,
    message: lifecycleProblemMessage(
      body?.code,
      retryAfterSecondsFrom(body, response.headers),
    ),
  };
};

const post = (body: unknown, deviceId?: string): RequestInit => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": globalThis.crypto.randomUUID(),
    ...(deviceId ? { [BROWSER_DEVICE_ID_HEADER]: deviceId } : {}),
  },
  body: JSON.stringify(body),
});

const parseTeamRefs = (value: unknown): TeamRef[] =>
  (Array.isArray(value) ? value : []).flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.teamId === "string" &&
    typeof entry.name === "string"
      ? [{ teamId: entry.teamId, name: entry.name }]
      : [],
  );

export const leaveTeam = async (
  apiOrigin: string,
  teamId: string,
): Promise<LifecycleResult<null>> => {
  const outcome = await call(
    apiOrigin,
    `/api/v1/teams/${teamId}/leave`,
    post({}),
  );
  return outcome.ok ? { ok: true, data: null } : outcome;
};

export const deleteTeam = async (
  apiOrigin: string,
  teamId: string,
  confirmName: string,
  deviceId?: string,
): Promise<LifecycleResult<Readonly<{ purgeAfter: string | null }>>> => {
  const outcome = await call(
    apiOrigin,
    `/api/v1/teams/${teamId}/delete`,
    post({ confirmName }, deviceId),
  );
  if (!outcome.ok) return outcome;
  const purgeAfter =
    isRecord(outcome.data) && typeof outcome.data.purgeAfter === "string"
      ? outcome.data.purgeAfter
      : null;
  return { ok: true, data: { purgeAfter } };
};

export const fetchAccountDeletionPlan = async (
  apiOrigin: string,
): Promise<LifecycleResult<AccountDeletionPlan>> => {
  const outcome = await call(apiOrigin, "/api/v1/account/deletion");
  if (!outcome.ok) return outcome;
  if (!isRecord(outcome.data))
    return { ok: false, message: "The server returned a malformed reply." };
  return {
    ok: true,
    data: {
      blockingTeams: parseTeamRefs(outcome.data.blockingTeams),
      teamsDeleted: parseTeamRefs(outcome.data.teamsDeleted),
      teamsLeft: parseTeamRefs(outcome.data.teamsLeft),
    },
  };
};

export const deleteAccount = async (
  apiOrigin: string,
  userId: string,
): Promise<LifecycleResult<null>> => {
  const outcome = await call(
    apiOrigin,
    "/api/v1/account/delete",
    post({ confirmUserId: userId }),
  );
  return outcome.ok ? { ok: true, data: null } : outcome;
};

/** Fetches the account export and hands it to the browser as a download. */
export const downloadAccountExport = async (
  apiOrigin: string,
): Promise<LifecycleResult<null>> => {
  const outcome = await call(apiOrigin, "/api/v1/account/export");
  if (!outcome.ok) return outcome;
  const blob = new Blob([`${JSON.stringify(outcome.data, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `dotrelay-account-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { ok: true, data: null };
};

/** The phrase a User types to confirm account deletion. */
export const ACCOUNT_DELETION_PHRASE = "delete my account";
