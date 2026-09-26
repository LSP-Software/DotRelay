import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  establishServerProfileTrust,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import { CliError, CliInvocationError } from "./errors";
import {
  defaultNetworkPolicy,
  fetchWithinBudget,
  NetworkAttemptError,
  type NetworkPolicy,
  networkFailureCliError,
  transientResponseVerdict,
} from "./network";
import { atomicWriteProtectedFile } from "./output";
import { defaultOrigin } from "./version";

export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CliServerProfile = Readonly<{
  readonly name: string;
  readonly origin: string;
  readonly pin: ServerProfilePin;
}>;

export type ProfileCatalog = Readonly<{
  readonly version: 1;
  readonly selected?: string;
  readonly profiles: readonly CliServerProfile[];
}>;

export type ProfileCatalogStore = Readonly<{
  readonly read: () => Promise<ProfileCatalog>;
  readonly write: (catalog: ProfileCatalog) => Promise<void>;
}>;

export type ProfileTrustCandidate = Readonly<{
  readonly name: string;
  readonly origin: string;
  readonly pin: ServerProfilePin;
}>;

const emptyCatalog = (): ProfileCatalog =>
  Object.freeze({ version: 1, profiles: Object.freeze([]) });

const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const serverProfileId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
const explicitHttpScheme = /^https?:\/\//i;

const isLoopbackHost = (origin: string): boolean => {
  try {
    return loopbackHosts.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
};

const isCanonicalStoredOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    const loopback = loopbackHosts.includes(url.hostname);
    return (
      url.origin === value &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};

const validateCatalog = (value: unknown): ProfileCatalog => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CliError(
      "local-io",
      "profile catalog is invalid",
      {},
      "profile_catalog_invalid",
    );
  const object = value as Record<string, unknown>;
  if (object.version !== 1 || !Array.isArray(object.profiles))
    throw new CliError(
      "local-io",
      "profile catalog is invalid",
      {},
      "profile_catalog_invalid",
    );
  const profiles = object.profiles.map((profile) => {
    if (
      profile === null ||
      typeof profile !== "object" ||
      Array.isArray(profile)
    )
      throw new CliError(
        "local-io",
        "profile catalog is invalid",
        {},
        "profile_catalog_invalid",
      );
    const record = profile as Record<string, unknown>;
    const pin = record.pin as Record<string, unknown> | undefined;
    if (
      typeof record.name !== "string" ||
      !profileName.test(record.name) ||
      typeof record.origin !== "string" ||
      !pin ||
      typeof pin.origin !== "string" ||
      typeof pin.serverProfileId !== "string" ||
      record.origin !== pin.origin ||
      !isCanonicalStoredOrigin(record.origin) ||
      !isCanonicalStoredOrigin(pin.origin) ||
      !serverProfileId.test(pin.serverProfileId)
    )
      throw new CliError(
        "local-io",
        "profile catalog is invalid",
        {},
        "profile_catalog_invalid",
      );
    return Object.freeze({
      name: record.name,
      origin: record.origin,
      pin: Object.freeze({
        origin: pin.origin,
        serverProfileId: pin.serverProfileId,
      }),
    });
  });
  const selected = object.selected;
  if (
    selected !== undefined &&
    (typeof selected !== "string" ||
      !profiles.some((profile) => profile.name === selected))
  )
    throw new CliError(
      "local-io",
      "profile catalog selects a missing profile",
      {},
      "profile_selection_invalid",
    );
  return Object.freeze({
    version: 1,
    profiles: Object.freeze(profiles),
    ...(selected === undefined ? {} : { selected }),
  });
};

export const profileCatalogPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  const root =
    environment.DOTRELAY_CONFIG_DIR ??
    (process.platform === "win32"
      ? join(environment.APPDATA ?? environment.LOCALAPPDATA ?? ".", "DotRelay")
      : join(
          environment.XDG_CONFIG_HOME ??
            join(environment.HOME ?? ".", ".config"),
          "dotrelay",
        ));
  return join(root, "profiles.json");
};

export const createFileProfileCatalog = (path: string): ProfileCatalogStore =>
  Object.freeze({
    read: async () => {
      try {
        return validateCatalog(
          JSON.parse(await readFile(path, "utf8")) as unknown,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return emptyCatalog();
        if (error instanceof CliError) throw error;
        throw new CliError(
          "local-io",
          "could not read profile catalog",
          {},
          "profile_catalog_read_failed",
        );
      }
    },
    write: async (catalog) => {
      const valid = validateCatalog(catalog);
      try {
        await atomicWriteProtectedFile(path, `${JSON.stringify(valid)}\n`);
      } catch {
        throw new CliError(
          "local-io",
          "could not write profile catalog",
          {},
          "profile_catalog_write_failed",
        );
      }
    },
  });

// Operators type bare hostnames; a profile is an origin, so a missing scheme
// is completed as HTTPS. addServerProfile then probes HTTPS first and, on
// loopback hosts where the origin policy already allows plain HTTP, retries
// an unreachable HTTPS endpoint over HTTP.
export const withDefaultProtocol = (origin: string): string => {
  const trimmed = origin.trim();
  return explicitHttpScheme.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const validateOrigin = (origin: string): string => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new CliInvocationError(
      "Server Profile origin must be an absolute URL",
    );
  }
  const loopback = loopbackHosts.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new CliInvocationError("Server Profile origin must use HTTPS");
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new CliInvocationError(
      "Server Profile origin must be an exact origin without a path",
    );
  return origin;
};

// Derives the local profile name from the origin's host so an origin seeded
// by a build-time default or added by the operator gets the same name a
// manual `dotrelay setup <origin>` would choose for it.
export const profileNameFromOrigin = (origin: string): string => {
  let host = "default";
  try {
    host = new URL(origin).hostname;
  } catch {
    throw new CliInvocationError(
      "Server Profile origin must be an absolute URL",
    );
  }
  const normalized = host
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)
    ? normalized
    : "default";
};

export const addServerProfile = async (
  store: ProfileCatalogStore,
  name: string,
  requestedOrigin: string,
  options: Readonly<{
    readonly fetch?: FetchFunction;
    readonly runtime?: Crypto;
    readonly confirm?: (candidate: ProfileTrustCandidate) => Promise<boolean>;
    readonly networkPolicy?: NetworkPolicy;
  }> = {},
): Promise<CliServerProfile> => {
  if (!profileName.test(name))
    throw new CliInvocationError(
      "profile name must contain only letters, digits, ., _, or -",
    );
  const origin = validateOrigin(withDefaultProtocol(requestedOrigin));
  // Only a bare host typed by the operator may fall back to plain HTTP: an
  // explicit scheme is honored exactly as typed.
  const schemeWasImplicit = !explicitHttpScheme.test(requestedOrigin.trim());
  const catalog = await store.read();
  const existing = catalog.profiles.find(
    (profile) => profile.name === name || profile.origin === origin,
  );
  const policy = options.networkPolicy ?? defaultNetworkPolicy;
  const fetcher = options.fetch ?? fetch;

  const attempt = async (
    profileOrigin: string,
  ): Promise<Readonly<{ origin: string; pin: ServerProfilePin }>> => {
    const response = (
      await fetchWithinBudget(
        fetcher,
        `${profileOrigin}/api/v1/capabilities`,
        {
          method: "GET",
          redirect: "error",
          headers: { Accept: "application/json" },
        },
        {
          policy,
          retry: {
            verdict: (candidate) =>
              transientResponseVerdict(candidate, policy.now),
          },
        },
      )
    ).response;
    if (!response.ok)
      throw new CliError(
        "transient",
        "could not read Server Profile capabilities",
        {},
        "capabilities_unavailable",
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CliError(
        "crypto",
        "Server Profile capabilities were not valid JSON",
        {},
        "capabilities_invalid",
      );
    }
    let trusted: Awaited<ReturnType<typeof establishServerProfileTrust>>;
    try {
      trusted = await establishServerProfileTrust(body, {
        requestedOrigin: profileOrigin,
        ...(existing ? { pinned: existing.pin } : {}),
        ...(options.runtime ? { runtime: options.runtime } : {}),
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      const code =
        error instanceof Error && "code" in error
          ? String(error.code)
          : "trust_failed";
      throw new CliError(
        "crypto",
        "Server Profile trust could not be established",
        {},
        code,
      );
    }
    return Object.freeze({ origin: profileOrigin, pin: trusted.pin });
  };

  const loopbackHttpFallback =
    schemeWasImplicit && origin.startsWith("https://") && isLoopbackHost(origin)
      ? `http://${new URL(origin).host}`
      : undefined;
  let chosen: Readonly<{ origin: string; pin: ServerProfilePin }>;
  try {
    chosen = await attempt(origin);
  } catch (error) {
    if (error instanceof NetworkAttemptError && loopbackHttpFallback) {
      try {
        chosen = await attempt(loopbackHttpFallback);
      } catch (fallbackError) {
        if (fallbackError instanceof NetworkAttemptError)
          throw networkFailureCliError(
            fallbackError,
            `the Server Profile capabilities endpoint at ${loopbackHttpFallback}`,
            "capabilities_unavailable",
          );
        throw fallbackError;
      }
    } else if (error instanceof NetworkAttemptError) {
      throw networkFailureCliError(
        error,
        `the Server Profile capabilities endpoint at ${origin}`,
        "capabilities_unavailable",
      );
    } else {
      throw error;
    }
  }
  const profile = Object.freeze({
    name,
    origin: chosen.origin,
    pin: chosen.pin,
  });
  if (options.confirm && !(await options.confirm(profile)))
    throw new CliInvocationError(
      "Server Profile trust confirmation was declined; nothing was saved",
    );
  const profiles = Object.freeze([
    ...catalog.profiles.filter((candidate) => candidate.name !== name),
    profile,
  ]);
  await store.write(
    Object.freeze({
      version: 1,
      profiles,
      selected: catalog.selected ?? name,
    }),
  );
  return profile;
};

export const useServerProfile = async (
  store: ProfileCatalogStore,
  name: string,
): Promise<CliServerProfile> => {
  const catalog = await store.read();
  const profile = catalog.profiles.find((candidate) => candidate.name === name);
  if (!profile) throw new CliInvocationError("Server Profile not found");
  await store.write(
    Object.freeze({ version: 1, profiles: catalog.profiles, selected: name }),
  );
  return profile;
};

export type ResolveProfileOptions = Readonly<{
  readonly fetch?: FetchFunction;
  readonly networkPolicy?: NetworkPolicy;
  readonly defaultOrigin?: string;
}>;

// Resolves the Server Profile a command runs against: an explicit --profile
// override, then the globally selected profile, then the origin this build
// ships targeting. When nothing is selected on a build with a stamped
// default origin, that origin is trusted and selected on first use: the
// operator already chose the destination by installing the build, and the
// live capabilities pin still binds the actual service identity. Builds
// without a stamped origin keep requiring an explicit `dotrelay setup`.
export const resolveServerProfile = async (
  store: ProfileCatalogStore,
  override?: string,
  options: ResolveProfileOptions = {},
): Promise<CliServerProfile> => {
  const catalog = await store.read();
  if (!override) {
    const builtIn = options.defaultOrigin ?? defaultOrigin;
    if (builtIn && !catalog.selected) {
      const existing = catalog.profiles.find(
        (profile) => profile.origin === builtIn,
      );
      if (existing) {
        await store.write(
          Object.freeze({
            version: 1,
            profiles: catalog.profiles,
            selected: existing.name,
          }),
        );
        return existing;
      }
      return addServerProfile(store, profileNameFromOrigin(builtIn), builtIn, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.networkPolicy
          ? { networkPolicy: options.networkPolicy }
          : {}),
      });
    }
  }
  const name = override ?? catalog.selected;
  if (!name)
    throw new CliInvocationError(
      "No Server Profile selected; run dotrelay setup <origin>",
    );
  const profile = catalog.profiles.find((candidate) => candidate.name === name);
  if (!profile)
    throw new CliError(
      "local-io",
      "selected Server Profile is missing",
      {},
      "profile_selection_invalid",
    );
  return profile;
};
