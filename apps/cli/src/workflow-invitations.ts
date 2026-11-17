import {
  declineInvitation,
  type InvitationSummary,
  listPendingTeamAccess,
} from "./admin";
import type { ParsedArguments } from "./args";
import { CliError, CliInvocationError, sanitizeCliLine } from "./errors";
import {
  adminClient,
  confirmSilent,
  type WorkflowOptions,
} from "./workflow-core";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InvitationMatch =
  | Readonly<{ kind: "listed"; invitation: InvitationSummary }>
  | Readonly<{ kind: "unlisted"; invitationId: string }>;

// The reference is an invitation id, or the Team id or name an invitation
// is for. An id the listing does not show (the listing is capped) is still
// sent as-is: the service decides whether it is addressed to this User.
export const resolveInvitationReference = (
  invitations: readonly InvitationSummary[],
  reference: string,
): InvitationMatch => {
  const wanted = reference.trim().toLowerCase();
  const byId = invitations.find(
    (invitation) => invitation.invitationId.toLowerCase() === wanted,
  );
  if (byId) return { kind: "listed", invitation: byId };
  const byTeam = invitations.filter(
    (invitation) =>
      invitation.id.toLowerCase() === wanted ||
      invitation.name.toLowerCase() === wanted,
  );
  const [only] = byTeam;
  if (byTeam.length === 1 && only) return { kind: "listed", invitation: only };
  if (byTeam.length > 1)
    throw new CliInvocationError(
      `More than one invitation matches ${sanitizeCliLine(reference)}. Pass one of these invitation ids instead: ${byTeam.map((invitation) => invitation.invitationId).join(", ")}.`,
    );
  if (uuidPattern.test(wanted))
    return { kind: "unlisted", invitationId: wanted };
  throw new CliError(
    "invocation",
    `No pending invitation matches ${sanitizeCliLine(reference)}. Run dotrelay team list to see your invitations.`,
    {},
    "resource_not_found",
  );
};

// `dotrelay team decline`: turn down a Membership Invitation addressed to
// this User, the CLI counterpart of Decline in the web app.
export const declineTeamInvitation = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown>> => {
  const reference = parsed.positionals[0];
  if (!reference)
    throw new CliInvocationError(
      "Say which invitation to decline. Run dotrelay team decline <invitation-id-or-team>.",
    );
  const admin = adminClient(options);
  const pending = await listPendingTeamAccess(admin);
  const match = resolveInvitationReference(pending.invitations, reference);
  const invitationId =
    match.kind === "listed"
      ? match.invitation.invitationId
      : match.invitationId;
  const team = match.kind === "listed" ? match.invitation : null;
  const label = team ? sanitizeCliLine(team.name) : invitationId;
  if (options.noInput && !options.force)
    throw new CliInvocationError(
      "With --no-input, add --force to confirm declining the invitation.",
    );
  if (!(options.noInput && options.force)) {
    const question = `Decline the invitation to ${label}? A team owner or admin would have to invite you again.`;
    if (!(await confirmSilent(options, question)))
      throw new CliInvocationError("Cancelled. The invitation is still open.");
  }
  try {
    await declineInvitation(admin, invitationId);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (error.code === "resource_not_found")
      throw new CliError(
        "invocation",
        "You don't have a pending invitation with that id. Run dotrelay team list to see your invitations.",
        {},
        "resource_not_found",
      );
    if (error.code === "invitation_expired")
      throw new CliError(
        "conflict",
        "This invitation can't be declined anymore. It expired, or it was already accepted, declined or revoked.",
        {},
        "invitation_expired",
      );
    throw error;
  }
  return {
    invitationId,
    ...(team ? { teamId: team.id, team: team.name } : {}),
    status: "DECLINED",
    message: `Declined the invitation to ${label}.`,
  };
};
