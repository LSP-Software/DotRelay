import { isAlphaAdmissionProblem } from "@/lib/alpha-admission";

// A session the alpha list doesn't admit gets alpha_admission_required from
// every device route, so each check carries that answer through to its own
// view instead of reading it as a connection problem.
type AlphaAdmission = { readonly kind: "alpha-admission" };

export type DeviceCodeStatus = "pending" | "approved" | "denied";

export type DeviceStatusCheck =
  | { readonly kind: "code"; readonly status: DeviceCodeStatus }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid" }
  | AlphaAdmission
  | { readonly kind: "unavailable" };

export type SessionCheck =
  | { readonly kind: "signed-in" }
  | { readonly kind: "signed-out" }
  | AlphaAdmission
  | { readonly kind: "unavailable" };

export type DeviceApprovalAttempt =
  | { readonly kind: "approved" }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "stale" }
  | { readonly kind: "signed-out" }
  | AlphaAdmission
  | { readonly kind: "unavailable" };

export type DeviceApprovalView =
  | { readonly kind: "sign-in" }
  | { readonly kind: "allow" }
  | { readonly kind: "approved" }
  | { readonly kind: "declined" }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid" }
  | { readonly kind: "forbidden" }
  | AlphaAdmission
  | { readonly kind: "connection" };

type HttpResponse = Readonly<{
  readonly ok: boolean;
  readonly status: number;
}>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const readError = (body: unknown): string | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as { readonly error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
};

const readCodeStatus = (body: unknown): DeviceCodeStatus | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const status = (body as { readonly status?: unknown }).status;
  if (status === "pending" || status === "approved" || status === "denied")
    return status;
  return undefined;
};

export const parseDeviceStatusResponse = (
  response: HttpResponse,
  body: unknown,
): DeviceStatusCheck => {
  if (response.ok) {
    const status = readCodeStatus(body);
    if (status === undefined) return { kind: "unavailable" };
    return { kind: "code", status };
  }
  if (isAlphaAdmissionProblem(response.status, body))
    return { kind: "alpha-admission" };
  const error = readError(body);
  if (response.status === 400 && error === "expired_token")
    return { kind: "expired" };
  if (response.status === 400 && error === "invalid_request")
    return { kind: "invalid" };
  return { kind: "unavailable" };
};

export const parseSessionResponse = (
  response: HttpResponse,
  body: unknown,
): SessionCheck => {
  if (isAlphaAdmissionProblem(response.status, body))
    return { kind: "alpha-admission" };
  if (!response.ok) return { kind: "unavailable" };
  if (body === null || body === undefined) return { kind: "signed-out" };
  if (body !== null && typeof body === "object") {
    const record = body as { readonly session?: unknown };
    if (record.session !== null && record.session !== undefined)
      return { kind: "signed-in" };
  }
  return { kind: "unavailable" };
};

export const parseDeviceApprovalAttempt = (
  response: HttpResponse,
  body: unknown,
): DeviceApprovalAttempt => {
  if (response.ok) return { kind: "approved" };
  if (isAlphaAdmissionProblem(response.status, body))
    return { kind: "alpha-admission" };
  const error = readError(body);
  if (response.status === 400 && error === "expired_token")
    return { kind: "expired" };
  if (
    response.status === 400 &&
    (error === "invalid_request" || error === "device_code_already_processed")
  )
    return { kind: "stale" };
  if (response.status === 401 && error === "unauthorized")
    return { kind: "signed-out" };
  if (response.status === 403 && error === "access_denied")
    return { kind: "forbidden" };
  return { kind: "unavailable" };
};

export const deviceApprovalView = (
  status: DeviceStatusCheck,
  session: SessionCheck,
): DeviceApprovalView => {
  if (status.kind === "alpha-admission" || session.kind === "alpha-admission")
    return { kind: "alpha-admission" };
  if (status.kind === "code") {
    if (status.status === "approved") return { kind: "approved" };
    if (status.status === "denied") return { kind: "declined" };
    if (session.kind === "signed-in") return { kind: "allow" };
    if (session.kind === "signed-out") return { kind: "sign-in" };
    return { kind: "connection" };
  }
  if (status.kind === "expired") return { kind: "expired" };
  if (status.kind === "invalid") return { kind: "invalid" };
  return { kind: "connection" };
};

export type DeviceApprovalResolution =
  DeviceApprovalView | { readonly kind: "recheck" };

export const deviceApprovalAttemptView = (
  attempt: DeviceApprovalAttempt,
): DeviceApprovalResolution => {
  switch (attempt.kind) {
    case "approved":
      return { kind: "approved" };
    case "expired":
      return { kind: "expired" };
    case "forbidden":
      return { kind: "forbidden" };
    case "alpha-admission":
      return { kind: "alpha-admission" };
    case "unavailable":
      return { kind: "connection" };
    case "stale":
    case "signed-out":
      return { kind: "recheck" };
  }
};

const readBody = async (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

export const checkDeviceStatus = async (
  apiOrigin: string,
  userCode: string,
  fetcher: FetchLike = fetch,
): Promise<DeviceStatusCheck> => {
  try {
    const response = await fetcher(
      `${apiOrigin}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
      { credentials: "include", cache: "no-store" },
    );
    return parseDeviceStatusResponse(response, await readBody(response));
  } catch {
    return { kind: "unavailable" };
  }
};

export const checkServerProfileSession = async (
  apiOrigin: string,
  fetcher: FetchLike = fetch,
): Promise<SessionCheck> => {
  try {
    const response = await fetcher(`${apiOrigin}/api/auth/get-session`, {
      credentials: "include",
      cache: "no-store",
    });
    return parseSessionResponse(response, await readBody(response));
  } catch {
    return { kind: "unavailable" };
  }
};

export type DeviceDecision = "approve" | "deny";

/**
 * Post the signed-in user's decision on a code. Approve and deny share the
 * same response shapes, so a successful denial is reported as "approved"
 * (the request was accepted) and mapped by deviceDenialAttemptView.
 */
export const attemptDeviceDecision = async (
  apiOrigin: string,
  userCode: string,
  decision: DeviceDecision,
  fetcher: FetchLike = fetch,
): Promise<DeviceApprovalAttempt> => {
  try {
    const response = await fetcher(`${apiOrigin}/api/auth/device/${decision}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode }),
    });
    return parseDeviceApprovalAttempt(response, await readBody(response));
  } catch {
    return { kind: "unavailable" };
  }
};

export const attemptDeviceApproval = (
  apiOrigin: string,
  userCode: string,
  fetcher: FetchLike = fetch,
): Promise<DeviceApprovalAttempt> =>
  attemptDeviceDecision(apiOrigin, userCode, "approve", fetcher);

export const attemptDeviceDenial = (
  apiOrigin: string,
  userCode: string,
  fetcher: FetchLike = fetch,
): Promise<DeviceApprovalAttempt> =>
  attemptDeviceDecision(apiOrigin, userCode, "deny", fetcher);

export const deviceDenialAttemptView = (
  attempt: DeviceApprovalAttempt,
): DeviceApprovalResolution =>
  attempt.kind === "approved"
    ? { kind: "declined" }
    : deviceApprovalAttemptView(attempt);
