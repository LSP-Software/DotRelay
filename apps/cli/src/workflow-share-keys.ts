import {
  accountFingerprint,
  type AccountTrustResolution,
  confirmTeammateIdentity,
  createMembershipProvisioning,
  decideDeviceTrust,
  deriveAccountSigningKey,
  isBlockingStatus,
  type MembershipProvisioningPlan,
  resolveAccountTrust,
} from "@dotrelay/client";
import { listTeams } from "./admin";
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
  hexToBytes,
  isRecord,
  parseBoundary,
  requireExpectedFingerprint,
  verifyDeviceBundle,
  type WorkflowOptions,
  workspaceBoundaryFields,
} from "./workflow-core";
import { loadWorkflowSession } from "./workflow-session";

// `dotrelay team share-keys` is the CLI counterpart of the web app's
// "Share project keys" (apps/web/lib/membership-provisioning.ts): it reads
// the service's provisioning plan for one Membership, opens each Project's
// current key on this Device, seals it to every Device in the Member's
// signed roster, and posts the signed activation. It is the only way a
// teammate's Devices receive Project keys: a pull shares keys only among
// the puller's own Devices.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

type MemberEntry = Readonly<{
  membershipId: string;
  userId: string;
  name: string | null;
  githubSubject: string | null;
  githubLogin: string | null;
  role: string | null;
  lifecycle: string | null;
}>;

export const parseMembers = (value: unknown): MemberEntry[] =>
  Array.isArray(value)
    ? value.flatMap((entry): MemberEntry[] =>
        isRecord(entry) &&
        typeof entry.membershipId === "string" &&
        typeof entry.userId === "string"
          ? [
              {
                membershipId: entry.membershipId,
                userId: entry.userId,
                name: typeof entry.name === "string" ? entry.name : null,
                githubSubject:
                  typeof entry.githubSubject === "string"
                    ? entry.githubSubject
                    : null,
                githubLogin:
                  typeof entry.githubLogin === "string"
                    ? entry.githubLogin
                    : null,
                role: typeof entry.role === "string" ? entry.role : null,
                lifecycle:
                  typeof entry.lifecycle === "string" ? entry.lifecycle : null,
              },
            ]
          : [],
      )
    : [];

const invalidPlan = (): CliError =>
  new CliError(
    "transient",
    "the server returned an invalid key-sharing plan",
    {},
    "response_invalid",
  );

const parsePlan = (
  value: Record<string, unknown>,
  teamId: string,
  membershipId: string,
): MembershipProvisioningPlan => {
  const { projects, devices } = value;
  if (
    value.teamId !== teamId ||
    value.membershipId !== membershipId ||
    typeof value.userId !== "string" ||
    !UUID.test(value.userId) ||
    (value.role !== "OWNER" &&
      value.role !== "ADMIN" &&
      value.role !== "MEMBER") ||
    !Array.isArray(projects) ||
    !Array.isArray(devices) ||
    projects.length * devices.length > 128
  )
    throw invalidPlan();
  return Object.freeze({
    teamId,
    membershipId,
    userId: value.userId,
    role: value.role,
    projects: projects.map((project) => {
      if (
        !isRecord(project) ||
        typeof project.id !== "string" ||
        !UUID.test(project.id) ||
        typeof project.environmentId !== "string" ||
        !UUID.test(project.environmentId) ||
        typeof project.epoch !== "number" ||
        !Number.isSafeInteger(project.epoch) ||
        project.epoch < 1
      )
        throw invalidPlan();
      return Object.freeze({
        id: project.id,
        epoch: project.epoch,
        environmentId: project.environmentId,
      });
    }),
    devices: devices.map((device) => {
      if (
        !isRecord(device) ||
        typeof device.id !== "string" ||
        !UUID.test(device.id) ||
        typeof device.encryptionPublicKey !== "string" ||
        !/^[0-9a-f]{64}$/i.test(device.encryptionPublicKey)
      )
        throw invalidPlan();
      return Object.freeze({
        id: device.id,
        encryptionPublicKey: device.encryptionPublicKey,
      });
    }),
  });
};

// ADR 0015: keys go only to Devices in the Member's signed roster. A Member
// whose identity changed must be re-trusted before anything is shared.
export const assertShareRecipients = (
  resolution: AccountTrustResolution,
  memberUserId: string,
  devices: MembershipProvisioningPlan["devices"],
): void => {
  const member = resolution.users.get(memberUserId);
  if (member && isBlockingStatus(member.status))
    throw new CliError(
      "crypto",
      `this member's account key has changed, so no keys were shared. Compare their fingerprint with them (dotrelay team members --fingerprints). If it matches, run dotrelay team trust ${memberUserId}.`,
      {},
      "trust_failed",
    );
  // Keys go only to Devices a roster signed by the Member's account key
  // lists; without one there is nothing to seal to (ADR 0022).
  if (!member || member.status !== "verified")
    throw new CliError(
      "conflict",
      "this member has no signed device list yet, so no keys were shared. Ask them to unlock DotRelay on one of their devices (dotrelay device recover, or the web app), then share the keys again.",
      {},
      "trust_failed",
    );
  for (const device of devices) {
    const decision = decideDeviceTrust(
      resolution,
      {
        userId: memberUserId,
        deviceId: device.id,
        encryptionPublicKey: hexToBytes(device.encryptionPublicKey),
      },
      { requireActive: true },
    );
    if (!decision.trusted)
      throw new CliError(
        "crypto",
        "the server listed a device that isn't in this member's signed device list, so no keys were shared. Don't trust this server until you've checked it.",
        {},
        "trust_failed",
      );
  }
};

const resolveTeamId = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  admin: ReturnType<typeof createDeviceAdmin>,
): Promise<string> => {
  if (parsed.team) return parsed.team.toLowerCase();
  const teams = await listTeams(admin);
  const [only] = teams;
  if (teams.length === 1 && only) return only.id;
  // Several Teams: the worktree's linked Project names one.
  const { readWorktreeContext } = await import("./context");
  const context = options.contextPath
    ? await readWorktreeContext(options.contextPath).catch(() => null)
    : null;
  if (
    context?.environmentId &&
    context.serverProfileId === options.profile.pin.serverProfileId &&
    UUID.test(context.environmentId)
  ) {
    const boundary = parseBoundary(
      await admin.get(
        `/api/v1/workspace/boundary?environment=${encodeURIComponent(context.environmentId)}`,
        workspaceBoundaryFields,
      ),
    );
    if (boundary.environment.teamId) return boundary.environment.teamId;
  }
  if (teams.length === 0)
    throw new CliInvocationError(
      "you aren't an active member of any team on this server",
    );
  throw new CliInvocationError(
    `you're in more than one team. Pass --team <team-id> to pick one (dotrelay team list shows them):\n${teams
      .map((team) => `${team.name} (${team.id})`)
      .join("\n")}`,
  );
};

export const findMember = async (
  admin: ReturnType<typeof createDeviceAdmin>,
  members: readonly MemberEntry[],
  reference: string,
): Promise<MemberEntry> => {
  if (UUID.test(reference)) {
    const id = reference.toLowerCase();
    const member = members.find(
      (candidate) => candidate.userId === id || candidate.membershipId === id,
    );
    if (member) return member;
  } else if (GITHUB_LOGIN.test(reference)) {
    // The membership list carries the login each Member last signed in
    // with. It is display data that can be stale, so it only picks the
    // Member when exactly one matches; the keys still go only to that
    // Member's User id and signed roster. Otherwise the login is resolved
    // to a GitHub user id through the service.
    const login = reference.toLowerCase();
    const listed = members.filter(
      (candidate) => candidate.githubLogin?.toLowerCase() === login,
    );
    const [only] = listed;
    if (listed.length === 1 && only) return only;
    const resolved = await admin.post(
      "/api/v1/github-users/resolve",
      { login: reference },
      ["login", "githubUserId"],
    );
    const githubUserId =
      typeof resolved.githubUserId === "string" ||
      typeof resolved.githubUserId === "number"
        ? String(resolved.githubUserId)
        : null;
    const member = members.find(
      (candidate) =>
        githubUserId !== null && candidate.githubSubject === githubUserId,
    );
    if (member) return member;
  } else
    throw new CliInvocationError(
      "name the member by their GitHub login, or by the user id that dotrelay team members shows",
    );
  throw new CliInvocationError(
    `${JSON.stringify(reference.slice(0, 64))} isn't a member of this team. Invite them from the Members view in the DotRelay web app, then share keys once they accept.`,
  );
};

export const shareProjectKeys = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown>> => {
  const reference = parsed.positionals[0];
  if (!reference)
    throw new CliInvocationError(
      "say who to share with: a GitHub login or a user id",
    );
  const { deviceMetadataPath, readDeviceId } = await import("./device-storage");
  const deviceId =
    options.deviceId ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  if (!deviceId)
    throw new CliError(
      "authentication",
      "this machine isn't set up as a device on this server yet. Run dotrelay login or dotrelay device enroll.",
      {},
      "device_bundle_missing",
    );
  const admin = createDeviceAdmin(options, deviceId);
  const teamId = await resolveTeamId(options, parsed, admin);
  if (!UUID.test(teamId))
    throw new CliInvocationError("that team id isn't valid");
  const listed = await admin.get(`/api/v1/teams/${teamId}/memberships`, [
    "memberships",
    "invitations",
  ]);
  const member = await findMember(
    admin,
    parseMembers(listed.memberships),
    reference,
  );
  if (member.lifecycle === "REMOVED")
    throw new CliInvocationError(
      "that member was removed from the team. Invite them again first.",
    );
  const path = `/api/v1/teams/${teamId}/memberships/${member.membershipId}/provision`;
  const planResponse = await admin.get(path, [
    "teamId",
    "membershipId",
    "userId",
    "role",
    "projects",
    "devices",
    "accountRoster",
  ]);
  const plan = parsePlan(planResponse, teamId, member.membershipId);
  const roster =
    typeof planResponse.accountRoster === "string"
      ? planResponse.accountRoster
      : null;
  // This Device's own identity and keys come from one verified boundary.
  const boundary = parseBoundary(
    await admin.get("/api/v1/workspace/boundary", workspaceBoundaryFields),
  );
  const ownUserId = boundary.session.userId;
  if (!boundary.session.active || !ownUserId)
    throw new CliError(
      "authentication",
      "you're not signed in to this server. Run dotrelay login.",
      {},
      "authentication_required",
    );
  const { keys } = await verifyDeviceBundle(
    options,
    boundary,
    deviceId,
    "this device isn't active on this server. Run dotrelay device enroll or dotrelay device recover.",
  );
  const accountMasterKey = await loadAccountMasterKey(options, deviceId).catch(
    () => null,
  );
  const pins = await loadAccountTrustPins(options);
  const resolution = await resolveAccountTrust({
    pins,
    serverProfileId: options.profile.pin.serverProfileId,
    ownUserId,
    ownIdentity: accountMasterKey
      ? (
          await deriveAccountSigningKey(accountMasterKey, {
            serverProfileId: options.profile.pin.serverProfileId,
            userId: ownUserId,
          })
        ).identity
      : null,
    rosters: new Map([
      [
        plan.userId,
        roster === null
          ? null
          : (() => {
              try {
                return fromBase64(roster, "account device roster");
              } catch {
                return new Uint8Array();
              }
            })(),
      ],
    ]),
  });
  if (resolution.changed) await saveAccountTrustPins(options, resolution.pins);
  assertShareRecipients(resolution, plan.userId, plan.devices);
  const who = member.name ?? reference;
  const projectCount = plan.projects.length;
  const deviceCount = plan.devices.length;
  // Sharing keys is the decision that makes a new Member's account key
  // trusted for keys (ADR 0022), so the question names its fingerprint.
  const memberTrust = resolution.users.get(plan.userId);
  const fingerprint = memberTrust?.identity
    ? await accountFingerprint(memberTrust.identity)
    : null;
  const question = `Share the keys for ${projectCount} project${projectCount === 1 ? "" : "s"} with ${who} (${deviceCount} device${deviceCount === 1 ? "" : "s"})?${
    fingerprint && !memberTrust?.confirmed
      ? ` Their account fingerprint is ${fingerprint}. Compare it with them first.`
      : ""
  }`;
  // Sharing with a Member this installation has not confirmed also confirms
  // their identity, which needs a compared fingerprint (ADR 0022): without a
  // terminal only --fingerprint gives one, and --force never stands in for
  // it. A fingerprint passed for a confirmed Member must still match.
  if (memberTrust?.confirmed !== true || parsed.fingerprint !== undefined) {
    if (fingerprint === null)
      throw new CliError(
        "crypto",
        "the server didn't send this member's account identity, so no keys were shared",
        {},
        "trust_failed",
      );
    requireExpectedFingerprint(options, parsed, fingerprint);
  }
  if (options.noInput && !options.force)
    throw new CliInvocationError(
      "with --no-input, add --force to confirm sharing the project keys",
    );
  if (!(options.noInput && options.force)) {
    if (!(await confirmPrompt(options, question)))
      throw new CliInvocationError(
        "you didn't confirm, so no keys were shared",
      );
  }
  if (memberTrust && !memberTrust.confirmed && roster !== null)
    try {
      await saveAccountTrustPins(
        options,
        (
          await confirmTeammateIdentity(resolution.pins, {
            serverProfileId: options.profile.pin.serverProfileId,
            userId: plan.userId,
            roster: fromBase64(roster, "account device roster"),
          })
        ).pins,
      );
    } catch {
      throw new CliError(
        "crypto",
        "this member's signed device list doesn't verify, so no keys were shared. Don't trust this server until you've checked it.",
        {},
        "trust_failed",
      );
    }
  const projectKeys = new Map<string, Uint8Array>();
  try {
    for (const project of plan.projects) {
      // A full session for one of the Project's Environments opens its
      // current key the same way pull does (Account Key Envelope or grant).
      const session = await loadWorkflowSession(
        { ...options, environmentId: project.environmentId },
        parsed,
      );
      const scoped = session.boundary.environment;
      if (
        session.deviceId !== deviceId ||
        scoped.projectId !== project.id ||
        scoped.teamId !== teamId ||
        Number(scoped.projectEpoch) !== project.epoch
      )
        throw new CliError(
          "conflict",
          "project access changed while the keys were being prepared, so nothing was shared. Run the command again.",
          {},
          "state_conflict",
        );
      const key = session.publicationContext.sharedValueSecret;
      if (!key)
        throw new CliError(
          "incomplete-export",
          `this device can't read project ${project.id}, so it can't share that project's key. Nothing was shared. Run dotrelay pull in that project's repository on this device, or share from a device that can read every project in the team.`,
          {},
          "project_key_unavailable",
        );
      projectKeys.set(project.id, new Uint8Array(key));
    }
    const request = await createMembershipProvisioning({
      serverProfileId: options.profile.pin.serverProfileId,
      deviceId,
      signingPrivateKey: keys.signingPrivateKey,
      plan,
      projectKeys,
    });
    const committed = await admin.post(
      path,
      request,
      ["membershipId", "lifecycle"],
      { idempotencyKey: request.operationId },
    );
    return {
      teamId,
      userId: plan.userId,
      membershipId: plan.membershipId,
      lifecycle:
        typeof committed.lifecycle === "string" ? committed.lifecycle : null,
      projectCount,
      deviceCount,
      message: `Shared the keys for ${projectCount} project${projectCount === 1 ? "" : "s"} with ${who}. They can run dotrelay pull now.`,
    };
  } finally {
    for (const key of projectKeys.values()) key.fill(0);
  }
};
