import {
  accountFingerprint,
  type AccountTrustStatus,
  confirmTeammateIdentity,
  deriveAccountSigningKey,
  isBlockingStatus,
  readAccountDeviceRoster,
  resolveAccountTrust,
} from "@dotrelay/client";
import type { ParsedArguments } from "./args";
import { CliError, CliInvocationError } from "./errors";
import { loadAccountMasterKey } from "./workflow-account-key";
import {
  loadAccountTrustPins,
  saveAccountTrustPins,
} from "./workflow-account-trust";
import {
  confirmPrompt,
  createDeviceAdmin,
  fromBase64,
  isRecord,
  requireExpectedFingerprint,
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
  unverified: "unverified (no signed Device roster yet) — not trusted",
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
    // An owner's or admin's listing also carries open invitations; the
    // strict client rejects a response field it was not told about.
    ["memberships", "invitations"],
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
        // A teammate pinned on first sight verifies history only until the
        // user confirms the fingerprint (ADR 0022).
        confirmed: trust?.confirmed === true,
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
      `  account ${statusLabel[row.status]}${
        row.status === "verified" && !row.self && !row.confirmed
          ? " · not confirmed"
          : ""
      }${row.newlyPinned ? " · pinned now on first sight" : ""}`,
      ...("fingerprint" in row ? [`  fingerprint ${row.fingerprint}`] : []),
    ].join("\n"),
  );
  const blocked = rows.filter((row) => isBlockingStatus(row.status));
  const unconfirmed = rows.filter(
    (row) => row.status === "verified" && !row.self && !row.confirmed,
  );
  return {
    teamId,
    members: rows,
    message: `${lines.join("\n\n")}${
      blocked.length > 0 || unconfirmed.length > 0
        ? "\n\nCompare a new or changed fingerprint with the Member out of band, then run dotrelay team trust <user-id>. Until then no Project key is taken from that Member."
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
  const { userId, members, pins, resolution } = await loadTeamTrust(
    options,
    parsed,
  );
  if (targetUserId === userId)
    throw new CliInvocationError(
      "your own account identity comes from your Account Master Key and cannot be re-trusted",
    );
  const trust = resolution.users.get(targetUserId);
  const member = members.find((entry) => entry.userId === targetUserId);
  if (!trust || !member)
    throw new CliError(
      "conflict",
      "that User is not a Member of this Team",
      {},
      "resource_not_found",
    );
  // A confirmed identity needs nothing; a first-sight or changed one is
  // confirmed against the roster the Member's account key signed.
  if (trust.status === "verified" && trust.confirmed)
    return {
      userId: targetUserId,
      status: trust.status,
      message: "This Member's account identity is already confirmed.",
    };
  if (
    member.accountRoster === null ||
    !(
      trust.status === "verified" ||
      (trust.status === "identity-changed" && trust.presentedIdentity)
    )
  )
    return {
      userId: targetUserId,
      status: trust.status,
      message:
        trust.status === "rollback"
          ? "This Member's Device list is older than the one already verified, or missing. There is nothing new to trust; ask the Member to run dotrelay pull, then check again."
          : "This Member has no signed Device list to confirm yet.",
    };
  let roster: Uint8Array;
  try {
    roster = fromBase64(member.accountRoster, "Account roster");
    readAccountDeviceRoster(roster);
  } catch {
    throw new CliError(
      "crypto",
      "the Member's signed Device list is malformed",
      {},
      "trust_failed",
    );
  }
  const identity = trust.presentedIdentity ?? trust.identity;
  if (!identity)
    throw new CliError(
      "crypto",
      "the Member's account identity is unavailable",
      {},
      "trust_failed",
    );
  const fingerprint = await accountFingerprint(identity);
  const changed = trust.status === "identity-changed";
  // Confirming makes this identity a grant signer and a key recipient
  // (ADR 0022), so it always compares a fingerprint: one the user passed, or
  // one they read in the prompt. --force never stands in for it.
  requireExpectedFingerprint(options, parsed, fingerprint);
  if (
    parsed.fingerprint === undefined &&
    !(await confirmPrompt(
      options,
      changed
        ? `Trust the new account fingerprint ${fingerprint} for ${targetUserId}?`
        : `Confirm the account fingerprint ${fingerprint} for ${targetUserId}? Compare it with the one the Member's own dotrelay team members --fingerprints shows.`,
    ))
  )
    throw new CliInvocationError("re-trust was declined");
  let confirmed: Awaited<ReturnType<typeof confirmTeammateIdentity>>;
  try {
    confirmed = await confirmTeammateIdentity(pins, {
      serverProfileId: options.profile.pin.serverProfileId,
      userId: targetUserId,
      roster,
    });
  } catch {
    throw new CliError(
      "crypto",
      "the Member's signed Device list does not verify under the account fingerprint shown",
      {},
      "trust_failed",
    );
  }
  await saveAccountTrustPins(options, confirmed.pins);
  return {
    userId: targetUserId,
    status: "verified",
    fingerprint,
    message: changed
      ? `Trusted the new account fingerprint ${fingerprint}.`
      : `Confirmed the account fingerprint ${fingerprint}.`,
  };
};
