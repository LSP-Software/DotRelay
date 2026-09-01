import {
  parseJsonObject,
  parseProblem,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import { createSessionStore } from "./auth";
import type { NativeCredentialStore } from "./credentials";
import { CliError } from "./errors";
import type { FetchFunction } from "./profile";

export type StrictJsonClient = Readonly<{
  readonly get: <T extends Record<string, unknown>>(
    path: string,
    fields: readonly string[],
  ) => Promise<T>;
  readonly post: <T extends Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
    fields: readonly string[],
  ) => Promise<T>;
}>;

const readResponse = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new CliError(
      "transient",
      "the server returned invalid JSON",
      {},
      "response_invalid",
    );
  }
};

export const createStrictJsonClient = (
  profile: ServerProfilePin,
  credentials: NativeCredentialStore,
  options: Readonly<{ readonly fetch?: FetchFunction }> = {},
): StrictJsonClient => {
  const fetcher = options.fetch ?? fetch;
  const sessions = createSessionStore(credentials);
  const request = async <T extends Record<string, unknown>>(
    path: string,
    init: RequestInit,
    fields: readonly string[],
  ): Promise<T> => {
    const token = await sessions.get(profile);
    if (!token)
      throw new CliError(
        "authentication",
        "login is required for this Server Profile",
        {},
        "authentication_required",
      );
    let response: Response;
    try {
      response = await fetcher(`${profile.origin}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new CliError(
        "transient",
        "could not reach the Server Profile",
        {},
        "service_unavailable",
      );
    }
    const body = await readResponse(response);
    if (!response.ok) {
      try {
        const problem = parseProblem(body);
        throw new CliError(
          problem.code === "authentication_required" ||
            problem.code === "device_not_active"
            ? "authentication"
            : "transient",
          problem.detail,
          {},
          problem.code,
        );
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(
          "transient",
          "the Server Profile rejected the request",
          {},
          "request_failed",
        );
      }
    }
    try {
      return parseJsonObject<T>(body, fields);
    } catch {
      throw new CliError(
        "transient",
        "the server returned an invalid administration response",
        {},
        "response_invalid",
      );
    }
  };
  return Object.freeze({
    get: (path, fields) => request(path, { method: "GET" }, fields),
    post: (path, body, fields) =>
      request(
        path,
        {
          method: "POST",
          body: JSON.stringify(parseJsonObject(body, Object.keys(body))),
        },
        fields,
      ),
  });
};
