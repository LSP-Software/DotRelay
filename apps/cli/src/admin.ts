import {
  CBOR_LIMITS,
  parseJsonObject,
  parseProblem,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import type { CommandName } from "./args";
import { createSessionStore } from "./auth";
import type { NativeCredentialStore } from "./credentials";
import { CliError, CliInvocationError } from "./errors";
import type { FetchFunction } from "./profile";
import type { TerminalIo } from "./terminal";
import { selectOption } from "./ui";

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
export type TeamSummary = Readonly<{
  readonly id: string;
  readonly name: string;
}>;

export type EnvironmentSummary = Readonly<{
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly lifecycle: "active" | "archived";
  readonly currentHeadId: string | null;
}>;

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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

export const categoryForProblem = (
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
      "genesis_exists",
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
  if (code === "authentication_required")
    return "login is required for this Server Profile; run dotrelay login";
  if (code === "device_not_active")
    return "this Device is not active; run dotrelay device enroll to re-authorize it";
  if (code === "forbidden") return "the Server Profile denied the request";
  if (code === "resource_not_found")
    return "the requested resource was not found";
  if (code === "invalid_request")
    return "the Server Profile rejected the request";
  if (code === "payload_too_large") return "the request was too large";
  if (code === "genesis_exists")
    return "this Environment already has a genesis Revision";
  if (categoryForProblem(code) === "conflict")
    return "the requested change conflicts with current Server Profile state";
  if (categoryForProblem(code) === "crypto")
    return "the Server Profile rejected the cryptographic request";
  return "the Server Profile could not complete the request";
};

const parseEnvironment = (value: unknown): EnvironmentSummary => {
  if (!isRecord(value))
    throw new CliError(
      "transient",
      "the server returned an invalid Environment",
      {},
      "response_invalid",
    );
  return Object.freeze({
    id: requireOpaqueId(value.id, "Environment id"),
    projectId: requireOpaqueId(value.projectId, "Project id"),
    label:
      typeof value.label === "string" && value.label.trim().length > 0
        ? value.label.trim()
        : "default",
    lifecycle: requireLifecycle(value.lifecycle, "Environment lifecycle"),
    currentHeadId:
      value.currentHeadId === null
        ? null
        : requireOpaqueId(value.currentHeadId, "Environment head id"),
  });
};

export const linkProject = async (
  client: Pick<StrictJsonClient, "post">,
  input: ProjectLinkInput,
): Promise<ProjectSummary & { readonly environment?: EnvironmentSummary }> => {
  const response = await client.post(
    "/api/v1/projects",
    {
      teamId: requireOpaqueId(input.teamId, "Team id"),
      repositoryHost: input.repository.host,
      repositoryOwner: input.repository.owner,
      repositoryName: input.repository.name,
      githubRepositoryId: input.repository.githubRepositoryId,
    },
    ["id", "teamId", "githubRepositoryId", "lifecycle", "environment"],
    { idempotencyKey: crypto.randomUUID() },
  );
  return Object.freeze({
    id: requireOpaqueId(response.id, "Project id"),
    teamId: requireOpaqueId(response.teamId, "Team id"),
    githubRepositoryId: requireGitHubRepositoryId(response.githubRepositoryId),
    lifecycle: requireLifecycle(response.lifecycle, "Project lifecycle"),
    ...(response.environment !== undefined
      ? { environment: parseEnvironment(response.environment) }
      : {}),
  });
};

export type ProjectResolution = Readonly<{
  /** The sole eligible Project, or null when none or several remain. */
  readonly project: ProjectSummary | null;
  /** Every eligible active Project in scope, for labelled choices. */
  readonly candidates: readonly ProjectSummary[];
}>;

const parseProjectSummary = (value: unknown): ProjectSummary => {
  if (!isRecord(value))
    throw new CliError(
      "transient",
      "the server returned an invalid Project",
      {},
      "response_invalid",
    );
  return Object.freeze({
    id: requireOpaqueId(value.id, "Project id"),
    teamId: requireOpaqueId(value.teamId, "Team id"),
    githubRepositoryId: requireGitHubRepositoryId(value.githubRepositoryId),
    lifecycle: requireLifecycle(value.lifecycle, "Project lifecycle"),
  });
};

// Resolves the Project linked to a GitHub Repository within the Teams the
// caller can reach. With a Team id the lookup is scoped to that Team (the
// service verifies Membership); without one it spans every accessible Team
// and only active Projects. Ambiguous lookups resolve to no single Project
// and expose every candidate so the operator can be offered a choice.
export const findProjectByRepository = async (
  client: Pick<StrictJsonClient, "get">,
  githubRepositoryId: string,
  options: Readonly<{ readonly teamId?: string }> = {},
): Promise<ProjectResolution> => {
  const query = new URLSearchParams({
    githubRepositoryId: requireGitHubRepositoryId(githubRepositoryId),
  });
  if (options.teamId !== undefined)
    query.set("teamId", requireOpaqueId(options.teamId, "Team id"));
  const response = await client.get(`/api/v1/projects?${query}`, [
    "project",
    "projects",
  ]);
  const project =
    response.project === null ? null : parseProjectSummary(response.project);
  // Services predating the candidate list answer with only `project`; derive
  // the candidate set from it so a current client still resolves.
  const candidates =
    response.projects === undefined
      ? project
        ? [project]
        : []
      : parseCandidateList(response.projects);
  return Object.freeze({
    project,
    candidates: Object.freeze(candidates),
  });
};

const parseCandidateList = (value: unknown): ProjectSummary[] => {
  if (!Array.isArray(value))
    throw new CliError(
      "transient",
      "the server returned an invalid Project list",
      {},
      "response_invalid",
    );
  return value.map((entry) => parseProjectSummary(entry));
};

export const listTeams = async (
  client: Pick<StrictJsonClient, "get">,
): Promise<readonly TeamSummary[]> => {
  const response = await client.get("/api/v1/teams", ["teams"]);
  if (!Array.isArray(response.teams))
    throw new CliError(
      "transient",
      "the server returned an invalid Team list",
      {},
      "response_invalid",
    );
  return Object.freeze(
    response.teams.map((entry) => {
      if (!isRecord(entry))
        throw new CliError(
          "transient",
          "the server returned an invalid Team list",
          {},
          "response_invalid",
        );
      if (typeof entry.name !== "string" || entry.name.trim().length === 0)
        throw new CliError(
          "transient",
          "the server returned an invalid Team name",
          {},
          "response_invalid",
        );
      return Object.freeze({
        id: requireOpaqueId(entry.id, "Team id"),
        name: entry.name.trim(),
      });
    }),
  );
};

export const createTeam = async (
  client: Pick<StrictJsonClient, "post">,
  name: string,
): Promise<TeamSummary> => {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255)
    throw new CliInvocationError("Team name must be 1 to 255 characters");
  const response = await client.post(
    "/api/v1/teams",
    { name: trimmed },
    ["id", "name"],
    { idempotencyKey: crypto.randomUUID() },
  );
  if (typeof response.name !== "string" || response.name.trim().length === 0)
    throw new CliError(
      "transient",
      "the server returned an invalid Team",
      {},
      "response_invalid",
    );
  return Object.freeze({
    id: requireOpaqueId(response.id, "Team id"),
    name: response.name.trim(),
  });
};

export const findDefaultTeam = async (
  client: Pick<StrictJsonClient, "get">,
): Promise<TeamSummary> => {
  const teams = await listTeams(client);
  if (teams.length === 0)
    throw new CliInvocationError("no Team is available for this Project");
  return teams[0]!;
};

export type ResolveTeamOptions = Readonly<{
  readonly teamId?: string;
  readonly suggestedName: string;
  readonly noInput: boolean;
  readonly prompt: (question: string) => Promise<string>;
  readonly write?: (message: string) => void;
  readonly terminal?: TerminalIo;
}>;

const askForTeamName = async (options: ResolveTeamOptions): Promise<string> => {
  const write = options.write ?? (() => undefined);
  write("No Team yet. Create one to continue.\n");
  const answer = (
    await options.prompt(`Team name [${options.suggestedName}]`)
  ).trim();
  return answer.length > 0 ? answer : options.suggestedName;
};

export const resolveTeamForProject = async (
  client: Pick<StrictJsonClient, "get" | "post">,
  options: ResolveTeamOptions,
): Promise<TeamSummary> => {
  const teams = await listTeams(client);
  if (options.teamId) {
    const teamId = options.teamId.toLowerCase();
    const selected = teams.find((team) => team.id === teamId);
    if (!selected)
      throw new CliInvocationError("the specified Team is not available");
    return selected;
  }
  if (teams.length === 1) return teams[0]!;
  if (teams.length === 0) {
    if (options.noInput)
      throw new CliInvocationError(
        "no Team is available; run init interactively or pass --team",
      );
    return createTeam(client, await askForTeamName(options));
  }
  if (options.noInput)
    throw new CliInvocationError(
      "multiple Teams are available; pass --team <team-id>",
    );
  const write = options.write ?? (() => undefined);
  const selectedId = await selectOption(
    "Team",
    [
      ...teams.map((team) => ({ id: team.id, label: team.name })),
      { id: "create", label: "Create a new Team" },
    ],
    {
      prompt: options.prompt,
      noInput: options.noInput,
      ...(options.terminal ? { terminal: options.terminal } : {}),
    },
  );
  if (selectedId !== "create") {
    const selected = teams.find((team) => team.id === selectedId);
    if (!selected) throw new CliInvocationError("choose a Team from the list");
    return selected;
  }
  write("Create a Team to continue.\n");
  const name = (
    await options.prompt(`Team name [${options.suggestedName}]`)
  ).trim();
  return createTeam(client, name.length > 0 ? name : options.suggestedName);
};

export const listEnvironments = async (
  client: Pick<StrictJsonClient, "get">,
  projectId: string,
): Promise<readonly EnvironmentSummary[]> => {
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
  return Object.freeze(response.environments.map(parseEnvironment));
};

export const selectEnvironment = async (
  client: Pick<StrictJsonClient, "get">,
  projectId: string,
  environmentId: string,
): Promise<EnvironmentSummary> => {
  const environments = await listEnvironments(client, projectId);
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
  return environment;
};

export const createEnvironment = async (
  client: Pick<StrictJsonClient, "post">,
  projectId: string,
  label = "default",
): Promise<EnvironmentSummary> => {
  const response = await client.post(
    `/api/v1/projects/${encodeURIComponent(requireOpaqueId(projectId, "Project id"))}/environments`,
    { label },
    ["id", "projectId", "label", "lifecycle", "currentHeadId"],
    { idempotencyKey: crypto.randomUUID() },
  );
  return parseEnvironment(response);
};

export type ResolveEnvironmentOptions = Readonly<{
  readonly command: CommandName;
  readonly noInput: boolean;
  readonly prompt?: (question: string) => Promise<string>;
  readonly terminal?: TerminalIo;
}>;

// Archived Environments are never eligible for automatic selection; an
// operator can still address one explicitly with --environment.
export const resolveEnvironmentForProject = async (
  client: Pick<StrictJsonClient, "get" | "post">,
  projectId: string,
  options: ResolveEnvironmentOptions,
): Promise<EnvironmentSummary> => {
  const eligible = (await listEnvironments(client, projectId)).filter(
    (environment) => environment.lifecycle === "active",
  );
  if (eligible.length === 1) {
    const soleEligible = eligible[0];
    if (!soleEligible)
      throw new CliError(
        "transient",
        "the server returned an invalid Environment list",
        {},
        "response_invalid",
      );
    return soleEligible;
  }
  if (eligible.length > 1) {
    if (options.noInput)
      throw new CliInvocationError(
        "multiple Environments are available; pass --environment <environment-id>",
      );
    const selectedId = await selectOption(
      "Environment",
      eligible.map((environment) => ({
        id: environment.id,
        label: environment.label,
      })),
      {
        ...(options.terminal ? { terminal: options.terminal } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {}),
        // An empty answer must not steer the change to the first
        // Environment in list order.
        defaultToFirst: false,
      },
    );
    const selected = eligible.find(
      (environment) => environment.id === selectedId,
    );
    if (!selected)
      throw new CliInvocationError("choose an Environment from the list");
    return selected;
  }
  if (options.command === "init" || options.command === "push")
    return createEnvironment(client, projectId);
  throw new CliInvocationError(
    "no active Environment is available for this Project; pass --environment <environment-id>",
  );
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
          {
            requestPath: path,
            ...(response.headers.get("X-Correlation-ID")
              ? {
                  correlationId: response.headers.get(
                    "X-Correlation-ID",
                  ) as string,
                }
              : {}),
          },
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
