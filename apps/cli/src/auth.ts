import type { ServerProfilePin } from "@dotrelay/contracts";
import type { NativeCredentialStore } from "./credentials";
import { CliError } from "./errors";
import type { FetchFunction } from "./profile";

export const AUTH_CLIENT_ID = "dotrelay-cli" as const;
export const DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code" as const;
const SESSION_SERVICE = "dotrelay-session";

export type DeviceAuthorization = Readonly<{
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}>;

export type DeviceLoginResult = Readonly<{
  readonly profile: ServerProfilePin;
  readonly userCode: string;
  readonly verificationUri: string;
}>;

export type LoginOptions = Readonly<{
  readonly fetch?: FetchFunction;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly open?: (url: string) => Promise<void>;
  readonly noOpen?: boolean;
  readonly maxPolls?: number;
}>;

const sessionAccount = (profile: ServerProfilePin): string =>
  `v1:${encodeURIComponent(`${profile.origin}\0${profile.serverProfileId}`)}`;

const legacySessionAccount = (profile: ServerProfilePin): string =>
  `${profile.origin}\0${profile.serverProfileId}`;

const readToken = async (
  credentials: NativeCredentialStore,
  profile: ServerProfilePin,
): Promise<Uint8Array | null> => {
  const current = await credentials.get(
    SESSION_SERVICE,
    sessionAccount(profile),
  );
  if (current) return current;
  try {
    const legacy = await credentials.get(
      SESSION_SERVICE,
      legacySessionAccount(profile),
    );
    if (legacy) {
      await credentials.set(SESSION_SERVICE, sessionAccount(profile), legacy);
      await credentials
        .delete(SESSION_SERVICE, legacySessionAccount(profile))
        .catch(() => undefined);
      return legacy;
    }
  } catch {
    // Legacy POSIX accounts cannot be represented as process arguments.
  }
  return null;
};

export const createSessionStore = (credentials: NativeCredentialStore) =>
  Object.freeze({
    get: async (profile: ServerProfilePin): Promise<string | null> => {
      const token = await readToken(credentials, profile);
      return token ? new TextDecoder().decode(token).trimEnd() : null;
    },
    save: async (profile: ServerProfilePin, token: string): Promise<void> => {
      if (token.length === 0)
        throw new CliError(
          "authentication",
          "the server returned an empty session",
          {},
          "session_invalid",
        );
      await credentials.set(
        SESSION_SERVICE,
        sessionAccount(profile),
        new TextEncoder().encode(token),
      );
    },
    remove: async (profile: ServerProfilePin): Promise<void> => {
      await credentials.delete(SESSION_SERVICE, sessionAccount(profile));
      try {
        await credentials.delete(
          SESSION_SERVICE,
          legacySessionAccount(profile),
        );
      } catch {
        // Legacy accounts can be unaddressable on POSIX stores because their
        // original format contained a NUL separator.
      }
    },
  });

const readObject = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CliError(
      "authentication",
      "the server returned an invalid device authorization response",
      {},
      "auth_response_invalid",
    );
  return value as Record<string, unknown>;
};

const stringField = (
  object: Record<string, unknown>,
  ...names: string[]
): string => {
  const value = names
    .map((name) => object[name])
    .find((candidate) => typeof candidate === "string");
  if (typeof value !== "string" || value.length === 0)
    throw new CliError(
      "authentication",
      "the server returned an invalid device authorization response",
      {},
      "auth_response_invalid",
    );
  return value;
};

const numberField = (
  object: Record<string, unknown>,
  fallback: number,
  ...names: string[]
): number => {
  const value = names
    .map((name) => object[name])
    .find((candidate) => candidate !== undefined);
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new CliError(
      "authentication",
      "the server returned an invalid polling interval",
      {},
      "auth_response_invalid",
    );
  return value;
};

const parseAuthorization = (value: unknown): DeviceAuthorization => {
  const object = readObject(value);
  return Object.freeze({
    deviceCode: stringField(object, "device_code", "deviceCode"),
    userCode: stringField(object, "user_code", "userCode"),
    verificationUri: stringField(object, "verification_uri", "verificationUri"),
    ...(typeof object.verification_uri_complete === "string" ||
    typeof object.verificationUriComplete === "string"
      ? {
          verificationUriComplete: stringField(
            object,
            "verification_uri_complete",
            "verificationUriComplete",
          ),
        }
      : {}),
    intervalSeconds: numberField(object, 5, "interval", "intervalSeconds"),
    expiresInSeconds: numberField(
      object,
      600,
      "expires_in",
      "expiresInSeconds",
    ),
  });
};

const requireProfileUrl = (value: string, profile: ServerProfilePin): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(
      "authentication",
      "the server returned an invalid verification URL",
      {},
      "auth_response_invalid",
    );
  }
  if (url.origin !== profile.origin || url.username || url.password)
    throw new CliError(
      "authentication",
      "the verification URL does not belong to the Server Profile",
      {},
      "auth_response_invalid",
    );
  return url;
};

const parseResponseBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new CliError(
      "authentication",
      "the server returned invalid JSON",
      {},
      "auth_response_invalid",
    );
  }
};

const requestDeviceCode = async (
  origin: string,
  fetcher: FetchFunction,
): Promise<DeviceAuthorization> => {
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/auth/device/code`, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: AUTH_CLIENT_ID }),
    });
  } catch {
    throw new CliError(
      "transient",
      "could not reach the device authorization endpoint",
      {},
      "device_authorization_unavailable",
    );
  }
  if (!response.ok)
    throw new CliError(
      "authentication",
      "the server could not start device authorization",
      {},
      "device_authorization_failed",
    );
  return parseAuthorization(await parseResponseBody(response));
};

export const loginWithDeviceAuthorization = async (
  profile: ServerProfilePin,
  sessions: ReturnType<typeof createSessionStore>,
  options: LoginOptions = {},
): Promise<DeviceLoginResult> => {
  const fetcher = options.fetch ?? fetch;
  const authorization = await requestDeviceCode(profile.origin, fetcher);
  const verificationUri = requireProfileUrl(
    authorization.verificationUri,
    profile,
  );
  const verificationUrl = authorization.verificationUriComplete
    ? requireProfileUrl(
        authorization.verificationUriComplete,
        profile,
      ).toString()
    : (() => {
        verificationUri.searchParams.set("user_code", authorization.userCode);
        return verificationUri.toString();
      })();
  if (!options.noOpen && options.open) await options.open(verificationUrl);
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxPolls =
    options.maxPolls ??
    Math.max(
      1,
      Math.ceil(authorization.expiresInSeconds / authorization.intervalSeconds),
    );
  let intervalSeconds = authorization.intervalSeconds;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    await sleep(intervalSeconds * 1000);
    let response: Response;
    try {
      response = await fetcher(`${profile.origin}/api/auth/device/token`, {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: AUTH_CLIENT_ID,
          device_code: authorization.deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        }),
      });
    } catch {
      throw new CliError(
        "transient",
        "could not reach the device authorization endpoint",
        {},
        "device_authorization_unavailable",
      );
    }
    const body = readObject(await parseResponseBody(response));
    if (response.ok) {
      const token = stringField(body, "access_token", "accessToken", "token");
      await sessions.save(profile, token);
      return Object.freeze({
        profile,
        userCode: authorization.userCode,
        verificationUri: verificationUri.toString(),
      });
    }
    const error = typeof body.error === "string" ? body.error : "";
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalSeconds += 5;
      continue;
    }
    if (error === "expired_token")
      throw new CliError(
        "authentication",
        "device authorization expired",
        {},
        "device_authorization_expired",
      );
    if (error === "access_denied")
      throw new CliError(
        "authentication",
        "device authorization was denied",
        {},
        "device_authorization_denied",
      );
    throw new CliError(
      "authentication",
      "device authorization failed",
      {},
      "device_authorization_failed",
    );
  }
  throw new CliError(
    "authentication",
    "device authorization timed out",
    {},
    "device_authorization_timeout",
  );
};

export const verificationPageCommand = (
  platform: NodeJS.Platform,
  url: string,
): readonly string[] =>
  platform === "darwin"
    ? ["open", url]
    : platform === "win32"
      ? ["explorer.exe", url]
      : ["xdg-open", url];

export const openVerificationPage = async (url: string): Promise<void> => {
  const command = verificationPageCommand(process.platform, url);
  try {
    Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
  } catch {
    throw new CliError(
      "local-io",
      "could not open the verification page; retry with --no-open",
      {},
      "browser_open_failed",
    );
  }
};
