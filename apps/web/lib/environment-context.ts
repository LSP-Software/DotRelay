import type { PublicationContext } from "@dotrelay/client";

export type EnvironmentContextIdentity = Readonly<{
  readonly profileId: string;
  readonly serverProfileId: string | null;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
}>;

const FIELD_SEPARATOR = "\u0000";

export const environmentContextKey = (
  identity: EnvironmentContextIdentity,
): string =>
  [
    identity.profileId,
    identity.serverProfileId ?? "",
    identity.teamId ?? "",
    identity.projectId ?? "",
    identity.environmentId ?? "",
  ].join(FIELD_SEPARATOR);

export const sameEnvironmentContext = (
  a: EnvironmentContextIdentity,
  b: EnvironmentContextIdentity,
): boolean =>
  a.profileId === b.profileId &&
  a.serverProfileId === b.serverProfileId &&
  a.teamId === b.teamId &&
  a.projectId === b.projectId &&
  a.environmentId === b.environmentId;

const fieldMatches = (expected: string | null, actual: string): boolean =>
  expected === null || expected === actual;

export const sessionMatchesContext = (
  context: Pick<
    PublicationContext,
    "serverProfileId" | "teamId" | "projectId" | "environmentId"
  >,
  identity: EnvironmentContextIdentity,
): boolean =>
  fieldMatches(identity.serverProfileId, context.serverProfileId) &&
  fieldMatches(identity.teamId, context.teamId) &&
  fieldMatches(identity.projectId, context.projectId) &&
  fieldMatches(identity.environmentId, context.environmentId);

export type ContextSwitchDecision =
  | Readonly<{ readonly type: "noop" }>
  | Readonly<{ readonly type: "rebind" }>
  | Readonly<{ readonly type: "prompt" }>
  | Readonly<{ readonly type: "switch" }>;

export const planContextSwitch = (
  input: Readonly<{
    readonly current: EnvironmentContextIdentity;
    readonly next: EnvironmentContextIdentity;
    readonly dirtyDraft: boolean;
  }>,
): ContextSwitchDecision => {
  if (sameEnvironmentContext(input.current, input.next))
    return { type: "noop" };
  if (input.current.profileId !== input.next.profileId)
    return { type: "rebind" };
  if (input.dirtyDraft) return { type: "prompt" };
  return { type: "switch" };
};

export const environmentContextIdentity = (
  input: Readonly<{
    readonly profileId: string;
    readonly serverProfileId?: string | null | undefined;
    readonly teamId?: string | null | undefined;
    readonly projectId?: string | null | undefined;
    readonly environmentId?: string | null | undefined;
  }>,
): EnvironmentContextIdentity => ({
  profileId: input.profileId,
  serverProfileId: input.serverProfileId ?? null,
  teamId: input.teamId ?? null,
  projectId: input.projectId ?? null,
  environmentId: input.environmentId ?? null,
});
