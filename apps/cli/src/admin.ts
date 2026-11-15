import {
  createDeviceProofSession,
  type DeviceProofSession,
  type DeviceProofSigner,
  sendWithDeviceProof,
} from "@dotrelay/client";
import {
  CBOR_LIMITS,
  parseJsonObject,
  parseProblem,
  type ServerProfilePin,
} from "@dotrelay/contracts";
import type { CommandName } from "./args";
import { createSessionStore } from "./auth";
import type { CredentialStore } from "./credentials";
import {
  CliError,
  CliInvocationError,
  categoryForProblem,
  detailForProblem,
} from "./errors";
import {
  defaultNetworkPolicy,
  fetchWithinBudget,
  NetworkAttemptError,
  type NetworkPolicy,
  networkFailureCliError,
  retryAfterMsFromResponse,
  transientResponseVerdict,
} from "./network";
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
  /**
   * Proves this client's Device (ADR 0020). Requests sent outside the
   * client, such as the protocol transport's, use it to prove the same
   * Device. Absent for a client that acts without a Device.
   */
  readonly deviceProof?: DeviceProofSession;
}>;

/** The Device a client acts as, and how to load its signing key. */
export type StrictJsonClientDevice = Readonly<{
  readonly id: string;
  readonly signer: () => Promise<DeviceProofSigner>;
}>;

// Routes a Device-bound client still calls with its session alone: the
// identity check, and the two routes that hand out Device proofs.
const SESSION_ONLY_PATHS = new Set([
  "/api/v1/session",
  "/api/v1/devices/proofs/challenges",
  "/api/v1/devices/proofs",
]);

export type RepositoryIdentityResolution = Readonly<{
  readonly host: "github.com";
  /** The repository's current descriptive owner, as GitHub reports it. */
  readonly owner: string;
  /** The repository's current descriptive name, as GitHub reports it. */
  readonly name: string;
  /** GitHub's stable numeric Repository Identity, service-verified. */
  readonly identity: string;
}>;

// GitHub's own alphabets for account and repository names. A resolved name
// outside them is rejected rather than printed or stored.
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

// Asks the Server Profile to resolve the descriptive owner/name the Client
// read from its Git remote to the stable Repository Identity, using the
// signed-in User's Delegated GitHub Access. The Client never calls the
// GitHub API and never sends a GitHub token.
export const resolveRepositoryIdentity = async (
  client: Pick<StrictJsonClient, "get">,
  repository: Readonly<{
    readonly host: "github.com";
    readonly owner: string;
    readonly name: string;
  }>,
): Promise<RepositoryIdentityResolution> => {
  const query = new URLSearchParams({
    host: repository.host,
    owner: repository.owner,
    name: repository.name,
  });
  const response = await client.get(
    `/api/v1/github-repositories/resolve?${query}`,
    ["host", "owner", "name", "githubRepositoryId"],
  );
  const owner = response.owner;
  const name = response.name;
  if (
    response.host !== "github.com" ||
    typeof owner !== "string" ||
    !GITHUB_OWNER.test(owner) ||
    typeof name !== "string" ||
    !GITHUB_REPOSITORY_NAME.test(name)
  )
    throw new CliError(
      "transient",
      "the server returned an invalid repository identity",
      {},
      "response_invalid",
    );
  return Object.freeze({
    host: "github.com",
    owner,
    name,
    identity: requireGitHubRepositoryId(response.githubRepositoryId),
  });
};

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
  readonly currentHeadHash: string | null;
  // The head Revision's authored-at instant, when the listing reports one
  // (older servers and create/lifecycle responses do not).
  readonly currentHeadAuthoredAtMs?: number;
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

const requireEnvironmentHeadHash = (value: unknown): string => {
  if (typeof value !== "string" || value.length < 2)
    throw new CliError(
      "transient",
      "the server returned an invalid Environment head hash",
      {},
      "response_invalid",
    );
  return value;
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
    currentHeadHash:
      value.currentHeadHash == null
        ? null
        : requireEnvironmentHeadHash(value.currentHeadHash),
    ...(value.currentHeadAuthoredAtMs == null
      ? {}
      : {
          currentHeadAuthoredAtMs: requireAuthoredAtMs(
            value.currentHeadAuthoredAtMs,
          ),
        }),
  });
};

const requireAuthoredAtMs = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new CliError(
      "transient",
      "the server returned an invalid Environment head time",
      {},
      "response_invalid",
    );
  return value;
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
  const [first] = teams;
  if (first === undefined)
    throw new CliInvocationError("no Team is available for this Project");
  return first;
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
  const [first] = teams;
  if (options.teamId) {
    const teamId = options.teamId.toLowerCase();
    const selected = teams.find((team) => team.id === teamId);
    if (!selected)
      throw new CliInvocationError("the specified Team is not available");
    return selected;
  }
  if (first === undefined) {
    if (options.noInput)
      throw new CliInvocationError(
        "no Team is available; run init interactively or pass --team",
      );
    return createTeam(client, await askForTeamName(options));
  }
  if (teams.length === 1) return first;
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

// The Server Profile's own label rule, checked before a request so a typo
// fails with the rule instead of a generic rejection.
const ENVIRONMENT_LABEL = /^[A-Za-z][A-Za-z0-9._-]{0,62}$/;

export const requireEnvironmentLabel = (label: string): string => {
  const trimmed = label.trim();
  if (!ENVIRONMENT_LABEL.test(trimmed))
    throw new CliInvocationError(
      "an Environment label starts with a letter and has up to 63 letters, digits, dots, dashes, or underscores",
    );
  return trimmed;
};

// A miss names what does exist, so the operator can correct a typo or see
// that the Environment still has to be created.
export const environmentNotFound = (
  reference: string,
  environments: readonly EnvironmentSummary[],
): CliError => {
  const active = environments.filter(
    (candidate) => candidate.lifecycle === "active",
  );
  const labels = [...new Set(active.map((candidate) => candidate.label))];
  const available =
    labels.length === 0
      ? "this Project has no active Environment yet"
      : `available: ${labels.join(", ")}`;
  const suggestion = ENVIRONMENT_LABEL.test(reference)
    ? `dotrelay env create ${reference}`
    : "dotrelay env create <label>";
  return new CliError(
    "invocation",
    `no Environment is labelled ${JSON.stringify(reference.slice(0, 64))} in this Project (${available}).\nPick one of those, or create it with ${suggestion} (Team owners and admins).\nRun dotrelay env list to see every Environment.`,
    {},
    "environment_not_found",
  );
};

export type EnvironmentReferenceOptions = Readonly<{
  readonly noInput: boolean;
  readonly prompt?: (question: string) => Promise<string>;
  readonly terminal?: TerminalIo;
}>;

// Resolves the operator's Environment reference — an opaque id or the
// operator-visible label — to exactly one Environment within the Project, so
// callers only ever carry the stable id. An id always wins over a label that
// happens to equal it. Duplicate labels offer a labelled choice interactively
// and explicit id guidance under --no-input.
export const resolveEnvironmentReference = async (
  client: Pick<StrictJsonClient, "get">,
  projectId: string,
  reference: string,
  options: EnvironmentReferenceOptions,
): Promise<EnvironmentSummary> => {
  const environments = await listEnvironments(client, projectId);
  const byId = environments.filter((candidate) => candidate.id === reference);
  const matches =
    byId.length > 0
      ? byId
      : environments.filter((candidate) => candidate.label === reference);
  if (matches.length === 0) throw environmentNotFound(reference, environments);
  if (matches.length === 1) {
    const selected = matches[0];
    if (!selected)
      throw new CliError(
        "transient",
        "the server returned an invalid Environment list",
        {},
        "response_invalid",
      );
    return selected;
  }
  if (options.noInput)
    throw new CliError(
      "invocation",
      `the Environment reference matches multiple Environments; pass --environment <environment-id> with one of:\n${matches
        .map(
          (candidate, index) =>
            `${index + 1}. ${candidate.label} (${candidate.lifecycle}) — ${candidate.id}`,
        )
        .join("\n")}`,
      {},
      "environment_ambiguous",
    );
  const selectedId = await selectOption(
    "Environment",
    matches.map((candidate) => ({
      id: candidate.id,
      label: `${candidate.label} — ${candidate.id}`,
    })),
    {
      ...(options.terminal ? { terminal: options.terminal } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
      // An empty answer must not steer the change to the first
      // Environment in list order.
      defaultToFirst: false,
    },
  );
  const selected = matches.find((candidate) => candidate.id === selectedId);
  if (!selected)
    throw new CliInvocationError("choose an Environment from the list");
  return selected;
};

export const createEnvironment = async (
  client: Pick<StrictJsonClient, "post">,
  projectId: string,
  label = "default",
): Promise<EnvironmentSummary> => {
  const response = await client.post(
    `/api/v1/projects/${encodeURIComponent(requireOpaqueId(projectId, "Project id"))}/environments`,
    { label: requireEnvironmentLabel(label) },
    [
      "id",
      "projectId",
      "label",
      "lifecycle",
      "currentHeadId",
      "currentHeadHash",
    ],
    { idempotencyKey: crypto.randomUUID() },
  );
  return parseEnvironment(response);
};

export const archiveEnvironment = async (
  client: Pick<StrictJsonClient, "post">,
  environmentId: string,
): Promise<EnvironmentSummary> =>
  parseEnvironment(
    await client.post(
      `/api/v1/environments/${encodeURIComponent(requireOpaqueId(environmentId, "Environment id"))}/lifecycle`,
      { action: "archive" },
      [
        "id",
        "projectId",
        "label",
        "lifecycle",
        "currentHeadId",
        "currentHeadHash",
      ],
      { idempotencyKey: crypto.randomUUID() },
    ),
  );

export type InvitationSummary = TeamSummary &
  Readonly<{
    /** The Membership Invitation id, for dotrelay team decline. */
    readonly invitationId: string;
  }>;

export type PendingTeamAccess = Readonly<{
  /** Teams whose invitation this User accepted, still waiting for keys. */
  readonly pendingMemberships: readonly TeamSummary[];
  /** Invitations addressed to this User that are not accepted yet. */
  readonly invitations: readonly InvitationSummary[];
}>;

const teamEntries = (value: unknown): TeamSummary[] =>
  Array.isArray(value)
    ? value.flatMap((entry): TeamSummary[] =>
        isRecord(entry) &&
        typeof entry.teamId === "string" &&
        opaqueId.test(entry.teamId) &&
        typeof entry.teamName === "string" &&
        entry.teamName.trim().length > 0
          ? [Object.freeze({ id: entry.teamId, name: entry.teamName.trim() })]
          : [],
      )
    : [];

// An invitation without a well-formed id is dropped: it could not be
// declined by id anyway, and the Team still shows through the others.
const invitationEntries = (value: unknown): InvitationSummary[] =>
  Array.isArray(value)
    ? value.flatMap((entry): InvitationSummary[] => {
        if (
          !isRecord(entry) ||
          typeof entry.invitationId !== "string" ||
          !opaqueId.test(entry.invitationId)
        )
          return [];
        const [team] = teamEntries([entry]);
        return team
          ? [
              Object.freeze({
                ...team,
                invitationId: entry.invitationId,
              }),
            ]
          : [];
      })
    : [];

// The addressed User turns down an invitation; it needs only a session. The
// service answers resource_not_found for an invitation addressed to someone
// else and invitation_expired once it is no longer pending.
export const declineInvitation = async (
  client: Pick<StrictJsonClient, "post">,
  invitationId: string,
): Promise<Readonly<{ invitationId: string; status: string }>> => {
  const response = await client.post(
    `/api/v1/invitations/${encodeURIComponent(requireOpaqueId(invitationId, "invitation id"))}/decline`,
    {},
    ["invitationId", "status"],
    { idempotencyKey: crypto.randomUUID() },
  );
  if (
    response.status !== "DECLINED" ||
    typeof response.invitationId !== "string" ||
    response.invitationId.toLowerCase() !== invitationId.toLowerCase()
  )
    throw new CliError(
      "transient",
      "the server returned an invalid invitation status",
      {},
      "response_invalid",
    );
  return Object.freeze({ invitationId, status: response.status });
};

// The Teams this User was invited to or joined but cannot use yet. Neither
// shows up in the Team or Project lists, which only span active Memberships,
// so this is how the CLI tells "not linked" apart from "waiting for keys".
export const listPendingTeamAccess = async (
  client: Pick<StrictJsonClient, "get">,
): Promise<PendingTeamAccess> => {
  const response = await client.get("/api/v1/invitations", [
    "invitations",
    "pendingMemberships",
  ]);
  return Object.freeze({
    pendingMemberships: Object.freeze(teamEntries(response.pendingMemberships)),
    invitations: Object.freeze(invitationEntries(response.invitations)),
  });
};

export type ResolveEnvironmentOptions = Readonly<
  {
    readonly command: CommandName;
  } & EnvironmentReferenceOptions
>;

// Archived Environments are never eligible for automatic selection; an
// operator can still address one explicitly with --environment <id-or-label>.
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
        "multiple Environments are available; pass --environment <environment-id-or-label>",
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
    "no active Environment is available for this Project; pass --environment <environment-id-or-label>",
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
  credentials: CredentialStore,
  options: Readonly<{
    readonly fetch?: FetchFunction;
    /** The Device this client acts as; omit to act with the session alone. */
    readonly device?: StrictJsonClientDevice;
    readonly authorization?: string;
    readonly networkPolicy?: NetworkPolicy;
  }> = {},
): StrictJsonClient => {
  const fetcher = options.fetch ?? fetch;
  const policy = options.networkPolicy ?? defaultNetworkPolicy;
  const sessions = createSessionStore(credentials);
  let deviceProof: DeviceProofSession | undefined;
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
    // The request is assembled once per proof; every retry reuses the same
    // headers and body, so a repeated mutation keeps its operation id
    // instead of starting a new one.
    const send = async (
      proofHeaders: Readonly<Record<string, string>>,
    ): Promise<Response> => {
      const fetchInit: RequestInit = {
        ...init,
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: options.authorization ?? `Bearer ${token}`,
          ...proofHeaders,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
          ...extraHeaders,
        },
      };
      try {
        return (
          await fetchWithinBudget(
            fetcher,
            `${profile.origin}${path}`,
            fetchInit,
            {
              policy,
              retry: {
                verdict: (candidate) =>
                  transientResponseVerdict(candidate, policy.now),
              },
            },
          )
        ).response;
      } catch (error) {
        if (!(error instanceof NetworkAttemptError)) throw error;
        throw networkFailureCliError(
          error,
          "the Server Profile",
          "service_unavailable",
        );
      }
    };
    const pathname = path.split("?", 1)[0] ?? path;
    const response =
      deviceProof && !SESSION_ONLY_PATHS.has(pathname)
        ? await sendWithDeviceProof(deviceProof, send)
        : await send({});
    const body = await readResponse(response);
    if (!response.ok) {
      try {
        const problem = parseProblem(body);
        // The problem body states the wait; the Retry-After header is the
        // fallback for a service that only sends the header.
        const headerRetryMs = retryAfterMsFromResponse(response, policy.now);
        const retryAfterSeconds =
          problem.retryAfterSeconds ??
          (headerRetryMs === undefined
            ? undefined
            : Math.ceil(headerRetryMs / 1000));
        throw new CliError(
          categoryForProblem(problem.code),
          detailForProblem(
            problem.code,
            retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
          ),
          {
            requestPath: path,
            ...(response.headers.get("X-Correlation-ID")
              ? {
                  correlationId: response.headers.get(
                    "X-Correlation-ID",
                  ) as string,
                }
              : {}),
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
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
  const post = (
    path: string,
    body: Record<string, unknown>,
    fields: readonly string[],
    postOptions?: Readonly<{ readonly idempotencyKey?: string }>,
  ) =>
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
    );
  if (options.device)
    deviceProof = createDeviceProofSession({
      deviceId: options.device.id,
      signer: options.device.signer,
      exchange: async (path, body) => {
        try {
          return await post(
            path,
            { ...body },
            path === "/api/v1/devices/proofs"
              ? ["token", "deviceId", "expiresIn"]
              : ["challenge", "expiresIn"],
          );
        } catch (error) {
          // The service checks the signature against the key it registered
          // for this Device; a mismatch means the local bundle is stale.
          if (
            error instanceof CliError &&
            error.code === "invalid_crypto_object"
          )
            throw new CliError(
              "crypto",
              "the saved Device bundle does not match the keys registered on this Server Profile; run dotrelay device recover",
              {},
              "device_bundle_invalid",
            );
          throw error;
        }
      },
    });
  return Object.freeze({
    get: (path, fields) => request(path, { method: "GET" }, fields),
    post,
    ...(deviceProof ? { deviceProof } : {}),
  });
};
