import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  establishServerProfileTrust,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import { CliError, CliInvocationError } from "./errors";
import { atomicWriteProtectedFile } from "./output";

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

const emptyCatalog = (): ProfileCatalog =>
  Object.freeze({ version: 1, profiles: Object.freeze([]) });

const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
      typeof pin.serverProfileId !== "string"
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

const validateOrigin = (origin: string): string => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new CliInvocationError(
      "Server Profile origin must be an absolute URL",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
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

export const addServerProfile = async (
  store: ProfileCatalogStore,
  name: string,
  requestedOrigin: string,
  options: Readonly<{
    readonly fetch?: FetchFunction;
    readonly runtime?: Crypto;
  }> = {},
): Promise<CliServerProfile> => {
  if (!profileName.test(name))
    throw new CliInvocationError(
      "profile name must contain only letters, digits, ., _, or -",
    );
  const origin = validateOrigin(requestedOrigin);
  const catalog = await store.read();
  const existing = catalog.profiles.find((profile) => profile.name === name);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${origin}/api/v1/capabilities`, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new CliError(
      "transient",
      "could not reach the Server Profile capabilities endpoint",
      {},
      "capabilities_unavailable",
    );
  }
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
      requestedOrigin: origin,
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
  const profile = Object.freeze({ name, origin, pin: trusted.pin });
  const profiles = Object.freeze([
    ...catalog.profiles.filter((candidate) => candidate.name !== name),
    profile,
  ]);
  await store.write(
    Object.freeze({
      version: 1,
      profiles,
      ...(catalog.selected ? { selected: catalog.selected } : {}),
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
  if (!profile)
    throw new CliInvocationError(`Server Profile not found: ${name}`);
  await store.write(
    Object.freeze({ version: 1, profiles: catalog.profiles, selected: name }),
  );
  return profile;
};

export const resolveServerProfile = async (
  store: ProfileCatalogStore,
  override?: string,
): Promise<CliServerProfile> => {
  const catalog = await store.read();
  const name = override ?? catalog.selected;
  if (!name)
    throw new CliInvocationError(
      "No Server Profile selected; use profile add and profile use, or pass --profile",
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
