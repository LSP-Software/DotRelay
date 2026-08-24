import {
  type CapabilitiesDocument,
  CBOR_LIMITS,
  SUITE_NAME,
  SUITE_VALUE,
} from "@dotrelay/contracts";

export type ServerProfileConfig = Readonly<{
  readonly id: string;
  readonly origin: string;
  readonly webOrigin: string;
  readonly apiVersion: "v1";
  readonly suite: Readonly<{
    readonly name: typeof SUITE_NAME;
    readonly value: typeof SUITE_VALUE;
  }>;
  readonly limits: CapabilitiesDocument["limits"];
  readonly authSecret: string;
  readonly githubClientId?: string;
  readonly githubClientSecret?: string;
  readonly isProduction: boolean;
  readonly trustProxy: boolean;
  readonly allowRebind: boolean;
}>;

const defaultProfileId = "00000000-0000-4000-8000-000000000001";
const defaultOrigin = "http://localhost:3001";
const defaultAuthSecret = "dotrelay-development-auth-secret-change-me";

const parsePositiveInteger = (
  name: string,
  value: string | undefined,
  fallback: number,
) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
};

export const normalizeOrigin = (
  value: string,
  options: Readonly<{ allowHttpLoopback?: boolean }> = {},
) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("origin must be an absolute URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "origin must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol === "http:" &&
    !(options.allowHttpLoopback === true && isLoopback)
  ) {
    throw new Error("HTTPS is required for a Server Profile origin");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("origin must not contain a path");
  }
  return url.origin;
};

const validateProfileId = (value: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("SERVER_PROFILE_ID must be a UUID");
  }
  return value.toLowerCase();
};

const bounded = (
  name: string,
  value: string | undefined,
  frozenMaximum: number,
  fallback: number,
) => {
  const result = parsePositiveInteger(name, value, fallback);
  if (result > frozenMaximum)
    throw new Error(`${name} cannot exceed the protocol ceiling`);
  return result;
};

export const loadServerProfileConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): ServerProfileConfig => {
  const isProduction = environment.NODE_ENV === "production";
  if (isProduction && !environment.SERVER_PROFILE_ID) {
    throw new Error("SERVER_PROFILE_ID must be configured in production");
  }
  const origin = normalizeOrigin(
    environment.SERVER_PROFILE_ORIGIN ??
      environment.BETTER_AUTH_URL ??
      defaultOrigin,
    {
      allowHttpLoopback: !isProduction,
    },
  );
  const webOrigin = normalizeOrigin(environment.WEB_ORIGIN ?? origin, {
    allowHttpLoopback: !isProduction,
  });
  const authSecret = environment.BETTER_AUTH_SECRET ?? defaultAuthSecret;
  if (isProduction && authSecret === defaultAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET must be configured in production");
  }
  if (authSecret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const trustProxy = environment.SERVER_PROFILE_TRUST_PROXY === "true";
  const allowRebind = environment.SERVER_PROFILE_REBIND === "true";
  return Object.freeze({
    id: validateProfileId(environment.SERVER_PROFILE_ID ?? defaultProfileId),
    origin,
    webOrigin,
    apiVersion: "v1",
    suite: Object.freeze({ name: SUITE_NAME, value: SUITE_VALUE }),
    limits: Object.freeze({
      adminBodyBytes: bounded(
        "ADMIN_BODY_BYTES",
        environment.ADMIN_BODY_BYTES,
        CBOR_LIMITS.maxAdminBodyBytes,
        CBOR_LIMITS.maxAdminBodyBytes,
      ),
      protocolObjectBytes: bounded(
        "PROTOCOL_OBJECT_BYTES",
        environment.PROTOCOL_OBJECT_BYTES,
        CBOR_LIMITS.maxObjectBytes,
        CBOR_LIMITS.maxObjectBytes,
      ),
      stagingObjects: bounded(
        "STAGING_OBJECTS",
        environment.STAGING_OBJECTS,
        CBOR_LIMITS.maxStagingObjects,
        CBOR_LIMITS.maxStagingObjects,
      ),
      stagingBytes: bounded(
        "STAGING_BYTES",
        environment.STAGING_BYTES,
        CBOR_LIMITS.maxStagingBytes,
        CBOR_LIMITS.maxStagingBytes,
      ),
      stagingTtlSeconds: bounded(
        "STAGING_TTL_SECONDS",
        environment.STAGING_TTL_SECONDS,
        24 * 60 * 60,
        24 * 60 * 60,
      ),
      synchronizationObjects: bounded(
        "SYNCHRONIZATION_OBJECTS",
        environment.SYNCHRONIZATION_OBJECTS,
        CBOR_LIMITS.maxSyncObjects,
        CBOR_LIMITS.maxSyncObjects,
      ),
      synchronizationBytes: bounded(
        "SYNCHRONIZATION_BYTES",
        environment.SYNCHRONIZATION_BYTES,
        CBOR_LIMITS.maxSyncBytes,
        CBOR_LIMITS.maxSyncBytes,
      ),
      variableNameBytes: bounded(
        "VARIABLE_NAME_BYTES",
        environment.VARIABLE_NAME_BYTES,
        256,
        256,
      ),
      descriptionBytes: bounded(
        "DESCRIPTION_BYTES",
        environment.DESCRIPTION_BYTES,
        16 * 1024,
        16 * 1024,
      ),
      valueBytes: bounded(
        "VALUE_BYTES",
        environment.VALUE_BYTES,
        1024 * 1024,
        1024 * 1024,
      ),
    }),
    authSecret,
    ...(environment.GITHUB_CLIENT_ID
      ? { githubClientId: environment.GITHUB_CLIENT_ID }
      : {}),
    ...(environment.GITHUB_CLIENT_SECRET
      ? { githubClientSecret: environment.GITHUB_CLIENT_SECRET }
      : {}),
    isProduction,
    trustProxy,
    allowRebind,
  });
};

export const createCapabilitiesDocument = (profile: ServerProfileConfig) =>
  Object.freeze({
    serverProfileId: profile.id,
    origin: profile.origin,
    apiVersion: profile.apiVersion,
    suite: profile.suite,
    capabilities: Object.freeze([
      "json-administration",
      "canonical-cbor-protocol",
      "pagination",
      "idempotency",
      "better-auth",
      "device-authorization",
      "bearer-sessions",
    ]),
    limits: profile.limits,
  });

export const etagFor = async (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-384", bytes);
  return `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
};

export const isAllowedOrigin = (
  origin: string | null,
  profile: ServerProfileConfig,
) =>
  origin === null || origin === profile.origin || origin === profile.webOrigin;

export const isSecureRequest = (
  request: Request,
  profile: ServerProfileConfig,
) => {
  if (!profile.isProduction) return true;
  if (new URL(request.url).protocol === "https:") return true;
  return (
    profile.trustProxy &&
    ["https", "https:"].includes(request.headers.get("x-forwarded-proto") ?? "")
  );
};

export const hasMixedCredentials = (request: Request) =>
  request.headers.has("authorization") && request.headers.has("cookie");
