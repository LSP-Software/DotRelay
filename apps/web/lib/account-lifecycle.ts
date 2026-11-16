import { accountDeletionCommand } from "@dotrelay/contracts";
import {
  DeviceProofRequestError,
  fetchWithDeviceProof,
  knownDeviceProof,
} from "./device-proof";
import { rateLimitedMessage, retryAfterSecondsFrom } from "./rate-limit";
import { BROWSER_DEVICE_ID_HEADER } from "./workspace-boundary";

// Browser client for the self-service lifecycle routes: leaving or deleting
// a Team, and exporting or deleting the signed-in account (ADRs 0018, 0019).
// Each of them needs this browser's Device while the account has an active
// Device, and deleting the account also needs the Device's signature
// (ADR 0024).

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
  provedDevice = true,
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
    case "device_proof_required":
      return provedDevice
        ? "This browser couldn't prove its Device. Reload the page and try again."
        : "This needs one of your devices. Open DotRelay in a browser that's set up as one of your devices, or use the CLI on one.";
    case "recent_sign_in_required":
      return "For your safety, sign out and sign in again, then try this within ten minutes.";
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
  // A request that names this browser's Device must also prove it
  // (ADR 0020); session-only requests go out as they are.
  const deviceId = new Headers(init?.headers).get(BROWSER_DEVICE_ID_HEADER);
  try {
    response = await fetchWithDeviceProof(
      deviceId ? knownDeviceProof(apiOrigin, deviceId) : undefined,
      `${apiOrigin}${path}`,
      { credentials: "include", ...init },
    );
  } catch (error) {
    if (error instanceof DeviceProofRequestError)
      return {
        ok: false,
        message: lifecycleProblemMessage(error.code, undefined, true),
      };
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
      deviceId !== null,
    ),
  };
};

const post = (
  body: unknown,
  deviceId?: string,
  operationId: string = globalThis.crypto.randomUUID(),
): RequestInit => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": operationId,
    ...(deviceId ? { [BROWSER_DEVICE_ID_HEADER]: deviceId } : {}),
  },
  body: JSON.stringify(body),
});

const deviceHeaders = (deviceId?: string): RequestInit =>
  deviceId ? { headers: { [BROWSER_DEVICE_ID_HEADER]: deviceId } } : {};

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** This browser's Device, as account-level actions need it (ADR 0024). */
export type LifecycleDevice = Readonly<{
  readonly deviceId: string;
  /** Loads the Device's Ed25519 signing key, or null when it is gone. */
  readonly signingKey: () => Promise<CryptoKey | null>;
}>;

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
  deviceId?: string,
): Promise<LifecycleResult<null>> => {
  const outcome = await call(
    apiOrigin,
    `/api/v1/teams/${teamId}/leave`,
    post({}, deviceId),
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

// Deleting the account: with this browser's Device, the Device signs the
// exact deletion command, as it signs a Device revocation; a browser without
// a Device sends only the confirmation and needs a recent sign-in.
export const deleteAccount = async (
  apiOrigin: string,
  userId: string,
  device?: LifecycleDevice,
): Promise<LifecycleResult<null>> => {
  const operationId = globalThis.crypto.randomUUID();
  let signature: string | undefined;
  if (device) {
    const signingKey = await device.signingKey().catch(() => null);
    if (!signingKey)
      return {
        ok: false,
        message:
          "This browser couldn't use its device key. Reload the page and try again.",
      };
    signature = base64(
      new Uint8Array(
        await globalThis.crypto.subtle.sign(
          "Ed25519",
          signingKey,
          accountDeletionCommand({ userId, operationId }),
        ),
      ),
    );
  }
  const outcome = await call(
    apiOrigin,
    "/api/v1/account/delete",
    post(
      { confirmUserId: userId, ...(signature ? { signature } : {}) },
      device?.deviceId,
      operationId,
    ),
  );
  return outcome.ok ? { ok: true, data: null } : outcome;
};

/** Fetches the account export and hands it to the browser as a download. */
export const downloadAccountExport = async (
  apiOrigin: string,
  deviceId?: string,
): Promise<LifecycleResult<null>> => {
  const outcome = await call(
    apiOrigin,
    "/api/v1/account/export",
    deviceHeaders(deviceId),
  );
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
