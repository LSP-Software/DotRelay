import {
  CBOR_LIMITS,
  parseJsonObject,
  parseProblem,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import { createSessionStore } from "./auth";
import type { NativeCredentialStore } from "./credentials";
import { CliError } from "./errors";
import type { FetchFunction } from "./profile";

export type StrictJsonClient = Readonly<{
  readonly get: (
    path: string,
    fields: readonly string[],
  ) => Promise<Record<string, unknown>>;
  readonly post: (
    path: string,
    body: Record<string, unknown>,
    fields: readonly string[],
    options?: Readonly<{ readonly idempotencyKey?: string }>,
  ) => Promise<Record<string, unknown>>;
}>;

export type ProjectLinkInput = Readonly<{
  readonly teamId: string;
  readonly repository: Readonly<{
    readonly host: "github.com";
    readonly owner: string;
    readonly name: string;
    readonly githubRepositoryId: string;
  }>;
}>;

export type ProjectSummary = Readonly<{
  readonly id: string;
  readonly teamId: string;
  readonly githubRepositoryId: string;
  readonly lifecycle: "active" | "archived";
}>;

export type EnvironmentSummary = Readonly<{
  readonly id: string;
  readonly projectId: string;
  readonly lifecycle: "active" | "archived";
  readonly currentHeadId: string | null;
}>;

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

const requireOpaqueId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !opaqueId.test(value))
    throw new CliError("invocation", `${label} is invalid`, {}, "invalid_id");
  return value;
};

const requireGitHubRepositoryId = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n
  )
    throw new CliError(
      "transient",
      "the server returned an invalid GitHub Repository id",
      {},
      "response_invalid",
    );
  return value;
};

const requireLifecycle = (
  value: unknown,
  label: string,
): "active" | "archived" => {
  if (value !== "active" && value !== "archived")
    throw new CliError(
      "transient",
      `the server returned an invalid ${label}`,
      {},
      "response_invalid",
    );
  return value;
};

const categoryForProblem = (
  code: string,
): "invocation" | "conflict" | "crypto" | "authentication" | "transient" => {
  if (
    code === "authentication_required" ||
    code === "device_not_active" ||
    code === "forbidden"
  )
    return "authentication";
  if (
    [
      "membership_not_key_provisioned",
      "operation_conflict",
      "stale_head",
      "stale_epoch",
      "stale_generation",
      "rotation_required",
      "archived_resource",
      "state_conflict",
      "staged_object_missing",
      "invitation_expired",
      "staging_expired",
    ].includes(code)
  )
    return "conflict";
  if (
    [
      "invalid_crypto_object",
      "unsupported_media_type",
      "unsupported_api_version",
      "unsupported_crypto_suite",
      "unsupported_crypto_runtime",
      "crypto_provider_unavailable",
    ].includes(code)
  )
    return "crypto";
  if (
    ["invalid_request", "resource_not_found", "payload_too_large"].includes(
      code,
    )
  )
    return "invocation";
  return "transient";
};

const detailForProblem = (code: string): string => {
  if (code === "authentication_required" || code === "device_not_active")
    return "login or an active Device is required";
  if (code === "forbidden") return "the Server Profile denied the request";
  if (code === "resource_not_found")
    return "the requested resource was not found";
  if (code === "invalid_request")
    return "the Server Profile rejected the request";
  if (code === "payload_too_large") return "the request was too large";
  if (categoryForProblem(code) === "conflict")
    return "the requested change conflicts with current Server Profile state";
  if (categoryForProblem(code) === "crypto")
    return "the Server Profile rejected the cryptographic request";
  return "the Server Profile could not complete the request";
};

export const linkProject = async (
  client: Pick<StrictJsonClient, "post">,
  input: ProjectLinkInput,
): Promise<ProjectSummary> => {
  const response = await client.post(
    "/api/v1/projects",
    {
      teamId: requireOpaqueId(input.teamId, "Team id"),
      repositoryHost: input.repository.host,
      repositoryOwner: input.repository.owner,
      repositoryName: input.repository.name,
      githubRepositoryId: input.repository.githubRepositoryId,
    },
    ["id", "teamId", "githubRepositoryId", "lifecycle"],
    { idempotencyKey: crypto.randomUUID() },
  );
  return Object.freeze({
    id: requireOpaqueId(response.id, "Project id"),
    teamId: requireOpaqueId(response.teamId, "Team id"),
    githubRepositoryId: requireGitHubRepositoryId(response.githubRepositoryId),
    lifecycle: requireLifecycle(response.lifecycle, "Project lifecycle"),
  });
};

export const selectEnvironment = async (
  client: Pick<StrictJsonClient, "get">,
  projectId: string,
  environmentId: string,
): Promise<EnvironmentSummary> => {
  const response = await client.get(
    `/api/v1/projects/${encodeURIComponent(requireOpaqueId(projectId, "Project id"))}/environments`,
    ["environments"],
  );
  if (!Array.isArray(response.environments))
    throw new CliError(
      "transient",
      "the server returned an invalid Environment list",
      {},
      "response_invalid",
    );
  const environments = response.environments.map((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    )
      throw new CliError(
        "transient",
        "the server returned an invalid Environment list",
        {},
        "response_invalid",
      );
    const environment = candidate as Record<string, unknown>;
    return {
      id: requireOpaqueId(environment.id, "Environment id"),
      projectId: requireOpaqueId(environment.projectId, "Project id"),
      lifecycle: requireLifecycle(
        environment.lifecycle,
        "Environment lifecycle",
      ),
      currentHeadId:
        environment.currentHeadId === null
          ? null
          : requireOpaqueId(environment.currentHeadId, "Environment head id"),
    };
  });
  const selected = environments.filter(
    (candidate) =>
      candidate.id === environmentId && candidate.projectId === projectId,
  );
  if (selected.length === 0)
    throw new CliError(
      "invocation",
      "the requested Environment was not found",
      {},
      "environment_not_found",
    );
  if (selected.length !== 1)
    throw new CliError(
      "invocation",
      "the requested Environment id is ambiguous",
      {},
      "environment_ambiguous",
    );
  const environment = selected[0];
  if (!environment)
    throw new CliError(
      "transient",
      "the server returned an invalid Environment list",
      {},
      "response_invalid",
    );
  return Object.freeze({
    id: requireOpaqueId(environment.id, "Environment id"),
    projectId: requireOpaqueId(environment.projectId, "Project id"),
    lifecycle: requireLifecycle(environment.lifecycle, "Environment lifecycle"),
    currentHeadId:
      environment.currentHeadId === null
        ? null
        : requireOpaqueId(environment.currentHeadId, "Environment head id"),
  });
};

const readResponse = async (response: Response): Promise<unknown> => {
  const body = response.body;
  if (!body)
    throw new CliError(
      "transient",
      "the server returned invalid JSON",
      {},
      "response_invalid",
    );
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > CBOR_LIMITS.maxAdminBodyBytes) {
        await reader.cancel();
        throw new CliError(
          "transient",
          "the server response was too large",
          {},
          "response_too_large",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "transient",
      "the server returned invalid JSON",
      {},
      "response_invalid",
    );
  }
  reader.releaseLock();
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
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
  options: Readonly<{
    readonly fetch?: FetchFunction;
    readonly deviceId?: string;
    readonly authorization?: string;
  }> = {},
): StrictJsonClient => {
  const fetcher = options.fetch ?? fetch;
  const sessions = createSessionStore(credentials);
  const request = async (
    path: string,
    init: RequestInit,
    fields: readonly string[],
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> => {
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
          Authorization: options.authorization ?? `Bearer ${token}`,
          ...(options.deviceId
            ? { "X-DotRelay-Device-Id": options.deviceId }
            : {}),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
          ...extraHeaders,
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
          categoryForProblem(problem.code),
          detailForProblem(problem.code),
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
      return parseJsonObject(body, fields);
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
    post: (path, body, fields, postOptions) =>
      request(
        path,
        {
          method: "POST",
          body: JSON.stringify(parseJsonObject(body, Object.keys(body))),
        },
        fields,
        postOptions?.idempotencyKey
          ? { "Idempotency-Key": postOptions.idempotencyKey }
          : {},
      ),
  });
};
