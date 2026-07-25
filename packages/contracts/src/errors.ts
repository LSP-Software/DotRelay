export const PROBLEM_STATUS = {
  invalid_request: 400,
  invalid_crypto_object: 400,
  authentication_required: 401,
  forbidden: 403,
  device_not_active: 403,
  resource_not_found: 404,
  membership_not_key_provisioned: 409,
  operation_conflict: 409,
  stale_head: 409,
  stale_epoch: 409,
  stale_generation: 409,
  rotation_required: 409,
  archived_resource: 409,
  state_conflict: 409,
  staged_object_missing: 409,
  invitation_expired: 410,
  staging_expired: 410,
  payload_too_large: 413,
  unsupported_media_type: 415,
  unsupported_api_version: 422,
  unsupported_crypto_suite: 422,
  rate_limited: 429,
  rate_limit_unavailable: 503,
  service_unavailable: 503,
} as const;

export type ProblemCode = keyof typeof PROBLEM_STATUS;

const GENERIC_TITLES: Record<ProblemCode, string> = {
  invalid_request: "Invalid request",
  invalid_crypto_object: "Invalid cryptographic object",
  authentication_required: "Authentication required",
  forbidden: "Forbidden",
  device_not_active: "Device not active",
  resource_not_found: "Resource not found",
  membership_not_key_provisioned: "Membership not key provisioned",
  operation_conflict: "Operation conflict",
  stale_head: "Stale head",
  stale_epoch: "Stale epoch",
  stale_generation: "Stale generation",
  rotation_required: "Rotation required",
  archived_resource: "Archived resource",
  state_conflict: "State conflict",
  staged_object_missing: "Staged object missing",
  invitation_expired: "Invitation expired",
  staging_expired: "Staging expired",
  payload_too_large: "Payload too large",
  unsupported_media_type: "Unsupported media type",
  unsupported_api_version: "Unsupported API version",
  unsupported_crypto_suite: "Unsupported cryptographic suite",
  rate_limited: "Rate limited",
  rate_limit_unavailable: "Rate limit unavailable",
  service_unavailable: "Service unavailable",
};

export class ContractError extends Error {
  readonly code: ProblemCode;

  constructor(code: ProblemCode) {
    super(code);
    this.name = "ContractError";
    this.code = code;
  }
}

export function contractError(code: ProblemCode): never {
  throw new ContractError(code);
}

export type Problem = {
  readonly type: "https://dotrelay.dev/problems/v1";
  readonly title: string;
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail: string;
  readonly retryAfterSeconds?: number;
  readonly headId?: string;
  readonly headHash?: string;
};

export function createProblem(
  code: ProblemCode,
  details?: {
    readonly retryAfterSeconds?: number;
    readonly headId?: string;
    readonly headHash?: string;
  },
): Problem {
  if (typeof code !== "string" || !Object.hasOwn(PROBLEM_STATUS, code))
    contractError("invalid_request");
  const problem: Problem = {
    type: "https://dotrelay.dev/problems/v1",
    title: GENERIC_TITLES[code],
    status: PROBLEM_STATUS[code],
    code,
    detail: GENERIC_TITLES[code],
  };
  return {
    ...problem,
    ...(details?.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: details.retryAfterSeconds }),
    ...(details?.headId === undefined ? {} : { headId: details.headId }),
    ...(details?.headHash === undefined ? {} : { headHash: details.headHash }),
  };
}
