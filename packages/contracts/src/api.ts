import { CBOR_LIMITS } from "./cbor";
import {
  contractError,
  PROBLEM_STATUS,
  type Problem,
  type ProblemCode,
} from "./errors";
import { API_VERSION, SUITE_NAME, SUITE_VALUE } from "./registry";
import { utf8Encode } from "./runtime";

export type JsonObject = Readonly<Record<string, unknown>>;

const isJsonValue = (
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): boolean => {
  if (depth > CBOR_LIMITS.maxDepth) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((item) => isJsonValue(item, seen, depth + 1));
    seen.delete(value);
    return valid;
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value as Record<string, unknown>).every((item) =>
    isJsonValue(item, seen, depth + 1),
  );
  seen.delete(value);
  return valid;
};

export const parseJsonObject = <T extends JsonObject>(
  value: unknown,
  allowedFields: readonly string[],
): T => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    contractError("invalid_request");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    contractError("invalid_request");
  const object = value as Record<string, unknown>;
  if (!isJsonValue(object)) contractError("invalid_request");
  let serialized: string;
  try {
    serialized = JSON.stringify(object);
  } catch {
    contractError("invalid_request");
  }
  if (utf8Encode(serialized).length > CBOR_LIMITS.maxAdminBodyBytes)
    contractError("payload_too_large");
  const allowed = new Set(allowedFields);
  if (Object.keys(object).some((key) => !allowed.has(key)))
    contractError("invalid_request");
  return object as T;
};

export type Pagination = Readonly<{
  readonly cursor?: string;
  readonly limit?: number;
}>;

export const parsePagination = (value: unknown): Pagination => {
  const object = parseJsonObject<{ cursor?: unknown; limit?: unknown }>(value, [
    "cursor",
    "limit",
  ]);
  if (
    object.cursor !== undefined &&
    (typeof object.cursor !== "string" ||
      object.cursor.length === 0 ||
      object.cursor.length > 1024)
  )
    contractError("invalid_request");
  if (
    object.limit !== undefined &&
    (typeof object.limit !== "number" ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > 256)
  )
    contractError("invalid_request");
  const pagination: { cursor?: string; limit?: number } = {};
  if (typeof object.cursor === "string") pagination.cursor = object.cursor;
  if (typeof object.limit === "number") pagination.limit = object.limit;
  return pagination;
};

export const validateIdempotencyKey = (value: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
};

export const parseIdempotencyKey = (value: unknown): string => {
  if (typeof value !== "string" || !validateIdempotencyKey(value))
    contractError("invalid_request");
  return value;
};

const isServerProfileId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

export const isCanonicalOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};

export type CapabilitiesDocument = Readonly<{
  readonly serverProfileId: string;
  readonly origin: string;
  readonly apiVersion: typeof API_VERSION;
  readonly suite: Readonly<{
    readonly name: typeof SUITE_NAME;
    readonly value: typeof SUITE_VALUE;
  }>;
  readonly capabilities: readonly string[];
  readonly limits: Readonly<{
    readonly adminBodyBytes: number;
    readonly protocolObjectBytes: number;
    readonly stagingObjects: number;
    readonly stagingBytes: number;
    readonly stagingTtlSeconds: number;
    readonly synchronizationObjects: number;
    readonly synchronizationBytes: number;
    readonly variableNameBytes: number;
    readonly descriptionBytes: number;
    readonly valueBytes: number;
  }>;
}>;

export const createCapabilitiesDocument = (
  options: Readonly<{
    readonly serverProfileId?: string;
    readonly origin?: string;
  }> = {},
): CapabilitiesDocument => {
  return Object.freeze({
    serverProfileId:
      options.serverProfileId ?? "00000000-0000-4000-8000-000000000000",
    origin: options.origin ?? "https://dotrelay.invalid",
    apiVersion: API_VERSION,
    suite: Object.freeze({ name: SUITE_NAME, value: SUITE_VALUE }),
    capabilities: Object.freeze([
      "json-administration",
      "canonical-cbor-protocol",
      "pagination",
      "idempotency",
      "operation-staging",
      "revision-publication",
      "environment-synchronization",
    ]),
    limits: Object.freeze({
      adminBodyBytes: CBOR_LIMITS.maxAdminBodyBytes,
      protocolObjectBytes: CBOR_LIMITS.maxObjectBytes,
      stagingObjects: CBOR_LIMITS.maxStagingObjects,
      stagingBytes: CBOR_LIMITS.maxStagingBytes,
      stagingTtlSeconds: 24 * 60 * 60,
      synchronizationObjects: CBOR_LIMITS.maxSyncObjects,
      synchronizationBytes: CBOR_LIMITS.maxSyncBytes,
      variableNameBytes: 256,
      descriptionBytes: 16 * 1024,
      valueBytes: 1024 * 1024,
    }),
  });
};

const capabilityLimitFields = [
  "adminBodyBytes",
  "protocolObjectBytes",
  "stagingObjects",
  "stagingBytes",
  "stagingTtlSeconds",
  "synchronizationObjects",
  "synchronizationBytes",
  "variableNameBytes",
  "descriptionBytes",
  "valueBytes",
] as const;

type CapabilityLimitField = (typeof capabilityLimitFields)[number];

export const parseCapabilitiesDocument = (
  value: unknown,
): CapabilitiesDocument => {
  const capabilitiesDocument = parseJsonObject<{
    serverProfileId?: unknown;
    origin?: unknown;
    apiVersion?: unknown;
    suite?: unknown;
    capabilities?: unknown;
    limits?: unknown;
  }>(value, [
    "serverProfileId",
    "origin",
    "apiVersion",
    "suite",
    "capabilities",
    "limits",
  ]);
  if (
    typeof capabilitiesDocument.serverProfileId !== "string" ||
    !isServerProfileId(capabilitiesDocument.serverProfileId) ||
    typeof capabilitiesDocument.origin !== "string" ||
    !isCanonicalOrigin(capabilitiesDocument.origin) ||
    !Array.isArray(capabilitiesDocument.capabilities)
  )
    contractError("invalid_request");
  if (capabilitiesDocument.apiVersion !== API_VERSION)
    contractError("unsupported_api_version");
  if (
    !capabilitiesDocument.capabilities.every(
      (capability) => typeof capability === "string",
    )
  )
    contractError("invalid_request");
  const suite = parseJsonObject<{ name?: unknown; value?: unknown }>(
    capabilitiesDocument.suite,
    ["name", "value"],
  );
  if (suite.name !== SUITE_NAME || suite.value !== SUITE_VALUE)
    contractError("unsupported_crypto_suite");
  const limits = parseJsonObject<Record<CapabilityLimitField, unknown>>(
    capabilitiesDocument.limits,
    capabilityLimitFields,
  );
  if (
    capabilityLimitFields.some(
      (field) =>
        typeof limits[field] !== "number" ||
        !Number.isInteger(limits[field]) ||
        limits[field] < 0,
    )
  )
    contractError("invalid_request");
  return Object.freeze({
    serverProfileId: capabilitiesDocument.serverProfileId,
    origin: capabilitiesDocument.origin,
    apiVersion: API_VERSION,
    suite: Object.freeze({ name: SUITE_NAME, value: SUITE_VALUE }),
    capabilities: Object.freeze([
      ...capabilitiesDocument.capabilities,
    ] as string[]),
    limits: Object.freeze(
      Object.fromEntries(
        capabilityLimitFields.map((field) => [field, limits[field]]),
      ) as CapabilitiesDocument["limits"],
    ),
  });
};

export type ApiProblem = Readonly<{
  readonly code: ProblemCode;
  readonly status: number;
}>;

export const parseProblem = (value: unknown): Problem => {
  const problem = parseJsonObject<{
    type?: unknown;
    title?: unknown;
    status?: unknown;
    code?: unknown;
    detail?: unknown;
    instance?: unknown;
    retryAfterSeconds?: unknown;
    headId?: unknown;
    headHash?: unknown;
  }>(value, [
    "type",
    "title",
    "status",
    "code",
    "detail",
    "instance",
    "retryAfterSeconds",
    "headId",
    "headHash",
  ]);
  if (
    problem.type !== "https://dotrelay.dev/problems/v1" ||
    typeof problem.title !== "string" ||
    typeof problem.code !== "string" ||
    !Object.hasOwn(PROBLEM_STATUS, problem.code) ||
    problem.status !== PROBLEM_STATUS[problem.code as ProblemCode] ||
    typeof problem.detail !== "string" ||
    (problem.instance !== undefined && typeof problem.instance !== "string") ||
    (problem.retryAfterSeconds !== undefined &&
      (typeof problem.retryAfterSeconds !== "number" ||
        !Number.isInteger(problem.retryAfterSeconds) ||
        problem.retryAfterSeconds < 0)) ||
    (problem.headId !== undefined && typeof problem.headId !== "string") ||
    (problem.headHash !== undefined && typeof problem.headHash !== "string")
  )
    contractError("invalid_request");
  return problem as Problem;
};

export const OPENAPI_DOCUMENT = Object.freeze({
  openapi: "3.1.0",
  info: Object.freeze({ title: "DotRelay API", version: API_VERSION }),
  "x-dotrelay": Object.freeze({
    apiVersion: API_VERSION,
    protocolMediaType: "application/vnd.dotrelay.e2ee-v3+cbor",
    strictJson: true,
    suite: Object.freeze({ name: SUITE_NAME, value: SUITE_VALUE }),
    problemStatus: Object.freeze({ ...PROBLEM_STATUS }),
  }),
  paths: Object.freeze({
    "/api/v1/capabilities": Object.freeze({
      get: Object.freeze({
        operationId: "getCapabilities",
        responses: Object.freeze({
          "200": Object.freeze({
            description: "Capabilities document",
            content: Object.freeze({
              "application/json": Object.freeze({
                schema: Object.freeze({
                  $ref: "#/components/schemas/Capabilities",
                }),
              }),
            }),
          }),
          "400": Object.freeze({
            description: "Invalid request",
            content: Object.freeze({
              "application/problem+json": Object.freeze({
                schema: Object.freeze({ $ref: "#/components/schemas/Problem" }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
  components: Object.freeze({
    schemas: Object.freeze({
      Problem: Object.freeze({
        type: "object",
        required: Object.freeze(["type", "title", "status", "code", "detail"]),
        additionalProperties: false,
        properties: Object.freeze({
          type: Object.freeze({ type: "string", format: "uri" }),
          title: Object.freeze({ type: "string" }),
          status: Object.freeze({
            type: "integer",
            minimum: 400,
            maximum: 599,
          }),
          code: Object.freeze({
            type: "string",
            enum: Object.freeze(Object.keys(PROBLEM_STATUS)),
          }),
          detail: Object.freeze({ type: "string" }),
          instance: Object.freeze({ type: "string", format: "uri-reference" }),
          retryAfterSeconds: Object.freeze({ type: "integer", minimum: 0 }),
          headId: Object.freeze({ type: "string" }),
          headHash: Object.freeze({ type: "string" }),
        }),
      }),
      Capabilities: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze([
          "serverProfileId",
          "origin",
          "apiVersion",
          "suite",
          "capabilities",
          "limits",
        ]),
        properties: Object.freeze({
          serverProfileId: Object.freeze({ type: "string", format: "uuid" }),
          origin: Object.freeze({ type: "string", format: "uri" }),
          apiVersion: Object.freeze({ type: "string", const: API_VERSION }),
          suite: Object.freeze({
            type: "object",
            additionalProperties: false,
            required: Object.freeze(["name", "value"]),
            properties: Object.freeze({
              name: Object.freeze({ type: "string", const: SUITE_NAME }),
              value: Object.freeze({ type: "integer", const: SUITE_VALUE }),
            }),
          }),
          capabilities: Object.freeze({
            type: "array",
            items: Object.freeze({ type: "string" }),
          }),
          limits: Object.freeze({
            type: "object",
            additionalProperties: false,
            required: Object.freeze([
              "adminBodyBytes",
              "protocolObjectBytes",
              "stagingObjects",
              "stagingBytes",
              "stagingTtlSeconds",
              "synchronizationObjects",
              "synchronizationBytes",
              "variableNameBytes",
              "descriptionBytes",
              "valueBytes",
            ]),
            properties: Object.freeze({
              adminBodyBytes: Object.freeze({ type: "integer", minimum: 0 }),
              protocolObjectBytes: Object.freeze({
                type: "integer",
                minimum: 0,
              }),
              stagingObjects: Object.freeze({ type: "integer", minimum: 0 }),
              stagingBytes: Object.freeze({ type: "integer", minimum: 0 }),
              stagingTtlSeconds: Object.freeze({ type: "integer", minimum: 0 }),
              synchronizationObjects: Object.freeze({
                type: "integer",
                minimum: 0,
              }),
              synchronizationBytes: Object.freeze({
                type: "integer",
                minimum: 0,
              }),
              variableNameBytes: Object.freeze({ type: "integer", minimum: 0 }),
              descriptionBytes: Object.freeze({ type: "integer", minimum: 0 }),
              valueBytes: Object.freeze({ type: "integer", minimum: 0 }),
            }),
          }),
        }),
      }),
      Pagination: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: Object.freeze({
          cursor: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: 1024,
          }),
          limit: Object.freeze({ type: "integer", minimum: 1, maximum: 256 }),
        }),
      }),
      IdempotencyKey: Object.freeze({
        type: "string",
        format: "uuid",
      }),
      ProtocolObject: Object.freeze({
        type: "string",
        format: "binary",
        contentMediaType: "application/vnd.dotrelay.e2ee-v3+cbor",
      }),
      StrictJsonObject: Object.freeze({
        type: "object",
        additionalProperties: false,
      }),
    }),
    parameters: Object.freeze({
      IdempotencyHeader: Object.freeze({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: Object.freeze({ $ref: "#/components/schemas/IdempotencyKey" }),
      }),
    }),
  }),
});
