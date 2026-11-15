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
    "the server returned an invalid provisioning plan",
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
      `this Member's account key changed. Compare their fingerprint (dotrelay team members --fingerprints) and run dotrelay team trust ${memberUserId} before sharing keys`,
      {},
      "trust_failed",
    );
  // Keys go only to Devices a roster signed by the Member's account key
  // lists; without one there is nothing to seal to (ADR 0022).
  if (!member || member.status !== "verified")
    throw new CliError(
      "conflict",
      "this Member has no signed Device list yet. Ask them to unlock DotRelay on one of their Devices (dotrelay device recover, or the web app), then share the keys again",
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
        "the server listed a Device that is not in this Member's signed Device list; no keys were shared",
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
      "you are not an active Member of any Team on this Server Profile",
    );
  throw new CliInvocationError(
    `you belong to several Teams; pass --team <team-id> (run dotrelay team list to see them):\n${teams
      .map((team) => `${team.name} — ${team.id}`)
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
      "name the Member by GitHub login or by the User id from dotrelay team members",
    );
  throw new CliInvocationError(
    `${JSON.stringify(reference.slice(0, 64))} is not a Member of this Team; invite them from the Members view of the DotRelay web app first, and share keys once they accept`,
  );
};

export const shareProjectKeys = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown>> => {
  const reference = parsed.positionals[0];
  if (!reference)
    throw new CliInvocationError("a GitHub login or User id is required");
  const { deviceMetadataPath, readDeviceId } = await import("./device-storage");
  const deviceId =
    options.deviceId ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  if (!deviceId)
    throw new CliError(
      "authentication",
      "no Device is enrolled for this Server Profile; run dotrelay login or dotrelay device enroll",
      {},
      "device_bundle_missing",
    );
  const admin = createDeviceAdmin(options, deviceId);
  const teamId = await resolveTeamId(options, parsed, admin);
  if (!UUID.test(teamId))
    throw new CliInvocationError("the Team id is invalid");
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
      "that Member was removed from the Team; invite them again first",
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
      "login is required for this Server Profile",
      {},
      "authentication_required",
    );
  const { keys } = await verifyDeviceBundle(
    options,
    boundary,
    deviceId,
    "the local Device is not active on this Server Profile; run dotrelay device enroll or dotrelay device recover",
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
                return fromBase64(roster, "Account roster");
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
  const question = `Share the keys for ${projectCount} Project${projectCount === 1 ? "" : "s"} with ${who} (${deviceCount} Device${deviceCount === 1 ? "" : "s"})?${
    fingerprint && !memberTrust?.confirmed
      ? ` Their account fingerprint is ${fingerprint}; compare it with them first.`
      : ""
  }`;
  if (options.noInput && !options.force)
    throw new CliInvocationError(
      "--no-input requires --force to confirm sharing the Project keys",
    );
  if (!(options.noInput && options.force)) {
    if (!(await confirmPrompt(options, question)))
      throw new CliInvocationError("sharing the Project keys was declined");
  }
  if (memberTrust && !memberTrust.confirmed && roster !== null)
    try {
      await saveAccountTrustPins(
        options,
        (
          await confirmTeammateIdentity(resolution.pins, {
            serverProfileId: options.profile.pin.serverProfileId,
            userId: plan.userId,
            roster: fromBase64(roster, "Account roster"),
          })
        ).pins,
      );
    } catch {
      throw new CliError(
        "crypto",
        "the Member's signed Device list does not verify; no keys were shared",
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
          "Project access changed while the keys were prepared; run the command again",
          {},
          "state_conflict",
        );
      const key = session.publicationContext.sharedValueSecret;
      if (!key)
        throw new CliError(
          "incomplete-export",
          `this Device cannot read Project ${project.id}, so it cannot share its key. Run dotrelay pull in that Project's repository on this Device, or share from a Device that can read every Project in the Team`,
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
      message: `Shared the keys for ${projectCount} Project${projectCount === 1 ? "" : "s"} with ${who}. They can now run dotrelay pull.`,
    };
  } finally {
    for (const key of projectKeys.values()) key.fill(0);
  }
};
