import {
  accountFingerprint,
  type AccountTrustStatus,
  deriveAccountSigningKey,
  isBlockingStatus,
  resolveAccountTrust,
  retrustTeammate,
} from "@dotrelay/client";
import type { ParsedArguments } from "./args";
import { CliError, CliInvocationError } from "./errors";
import { loadAccountMasterKey } from "./workflow-account-key";
import {
  loadAccountTrustPins,
  saveAccountTrustPins,
} from "./workflow-account-trust";
import {
  confirmSilent,
  createDeviceAdmin,
  fromBase64,
  isRecord,
  type WorkflowOptions,
} from "./workflow-core";
import { loadWorkflowSession } from "./workflow-session";

type MembershipEntry = Readonly<{
  userId: string;
  name: string | null;
  githubSubject: string | null;
  role: string | null;
  lifecycle: string | null;
  accountRoster: string | null;
}>;

const statusLabel: Readonly<Record<AccountTrustStatus, string>> = {
  verified: "verified",
  unverified: "unverified (no signed Device roster yet)",
  "identity-changed": "ACCOUNT KEY CHANGED — not trusted",
  rollback: "ROSTER ROLLED BACK — not trusted",
  invalid: "INVALID ROSTER — not trusted",
};

const loadTeamTrust = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
) => {
  // A full session verifies this installation's own roster first, and
  // publishes it when this Device holds the AMK.
  const session = await loadWorkflowSession(options, parsed);
  const teamId = parsed.team ?? session.boundary.environment.teamId;
  const userId = session.boundary.session.userId;
  if (!teamId || !userId)
    throw new CliInvocationError(
      "no Team is linked to this worktree; pass --team <team-id>",
    );
  const listed = await createDeviceAdmin(options, session.deviceId).get(
    `/api/v1/teams/${teamId}/memberships`,
    ["memberships"],
  );
  const members: MembershipEntry[] = Array.isArray(listed.memberships)
    ? listed.memberships.flatMap((entry): MembershipEntry[] =>
        isRecord(entry) && typeof entry.userId === "string"
          ? [
              {
                userId: entry.userId,
                name: typeof entry.name === "string" ? entry.name : null,
                githubSubject:
                  typeof entry.githubSubject === "string"
                    ? entry.githubSubject
                    : null,
                role: typeof entry.role === "string" ? entry.role : null,
                lifecycle:
                  typeof entry.lifecycle === "string" ? entry.lifecycle : null,
                accountRoster:
                  typeof entry.accountRoster === "string"
                    ? entry.accountRoster
                    : null,
              },
            ]
          : [],
      )
    : [];
  const accountMasterKey = await loadAccountMasterKey(
    options,
    session.deviceId,
  ).catch(() => null);
  const ownIdentity = accountMasterKey
    ? (
        await deriveAccountSigningKey(accountMasterKey, {
          serverProfileId: options.profile.pin.serverProfileId,
          userId,
        })
      ).identity
    : null;
  const pins = await loadAccountTrustPins(options);
  const resolution = await resolveAccountTrust({
    pins,
    serverProfileId: options.profile.pin.serverProfileId,
    ownUserId: userId,
    ownIdentity,
    rosters: new Map(
      members.map((member) => [
        member.userId,
        member.accountRoster === null
          ? null
          : (() => {
              try {
                return fromBase64(member.accountRoster, "Account roster");
              } catch {
                return new Uint8Array();
              }
            })(),
      ]),
    ),
  });
  return { teamId, userId, members, pins, resolution };
};

export const listTeamMembers = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
) => {
  const { teamId, userId, members, resolution } = await loadTeamTrust(
    options,
    parsed,
  );
  // First sight pins each teammate's identity (trust on first use).
  if (resolution.changed) await saveAccountTrustPins(options, resolution.pins);
  const rows = await Promise.all(
    members.map(async (member) => {
      const trust = resolution.users.get(member.userId);
      const status = trust?.status ?? "unverified";
      const shown = trust?.presentedIdentity ?? trust?.identity ?? null;
      return {
        userId: member.userId,
        name: member.name,
        githubSubject: member.githubSubject,
        role: member.role,
        self: member.userId === userId,
        status,
        newlyPinned: trust?.newlyPinned === true,
        ...(parsed.fingerprints && shown
          ? { fingerprint: await accountFingerprint(shown) }
          : {}),
      };
    }),
  );
  const lines = rows.map((row) =>
    [
      `${row.name ?? row.githubSubject ?? row.userId}${row.self ? " (you)" : ""}`,
      `  user ${row.userId}${row.role ? ` · ${row.role.toLowerCase()}` : ""}`,
      `  account ${statusLabel[row.status]}${row.newlyPinned ? " · pinned now on first sight" : ""}`,
      ...("fingerprint" in row ? [`  fingerprint ${row.fingerprint}`] : []),
    ].join("\n"),
  );
  const blocked = rows.filter((row) => isBlockingStatus(row.status));
  return {
    teamId,
    members: rows,
    message: `${lines.join("\n\n")}${
      blocked.length > 0
        ? "\n\nCompare a changed fingerprint with the Member out of band, then run dotrelay team trust <user-id>."
        : ""
    }`,
  };
};

export const trustTeamMember = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
) => {
  const targetUserId = parsed.positionals[0];
  if (!targetUserId) throw new CliInvocationError("a User id is required");
  const { userId, pins, resolution } = await loadTeamTrust(options, parsed);
  if (targetUserId === userId)
    throw new CliInvocationError(
      "your own account identity comes from your Account Master Key and cannot be re-trusted",
    );
  const trust = resolution.users.get(targetUserId);
  if (!trust)
    throw new CliError(
      "conflict",
      "that User is not a Member of this Team",
      {},
      "resource_not_found",
    );
  if (trust.status !== "identity-changed" || !trust.presentedIdentity)
    return {
      userId: targetUserId,
      status: trust.status,
      message:
        trust.status === "verified"
          ? "This Member's account identity is already trusted."
          : "There is no changed account identity to re-trust for this Member.",
    };
  const fingerprint = await accountFingerprint(trust.presentedIdentity);
  if (
    !(options.noInput && options.force) &&
    !(await confirmSilent(
      options,
      `Trust the new account fingerprint ${fingerprint} for ${targetUserId}?`,
    ))
  )
    throw new CliInvocationError("re-trust was declined");
  await saveAccountTrustPins(
    options,
    retrustTeammate(pins, targetUserId, trust.presentedIdentity),
  );
  return {
    userId: targetUserId,
    status: "verified",
    fingerprint,
    message: `Trusted the new account fingerprint ${fingerprint}.`,
  };
};
