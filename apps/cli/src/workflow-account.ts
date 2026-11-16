import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { accountDeletionCommand, uuidToBytes } from "@dotrelay/contracts";
import { listTeams, type StrictJsonClient } from "./admin";
import type { ParsedArguments } from "./args";
import { createSessionStore } from "./auth";
import { cliDevice } from "./device-proof";
import { deviceMetadataPath, readDeviceId } from "./device-storage";
import { CliError, CliInvocationError, sanitizeCliLine } from "./errors";
import { atomicWriteProtectedFile } from "./output";
import {
  adminClient,
  ask,
  base64,
  confirmSilent,
  createDeviceAdmin,
  isRecord,
  resolveDeviceStorage,
  type WorkflowOptions,
} from "./workflow-core";

// Leaving a Team (ADR 0019) and exporting or deleting the account (ADR
// 0018). While the account has an active Device, the service accepts these
// only from a proven Device, and deleting the account also needs that
// Device's signature over the exact command (ADR 0024). An account with no
// active Device acts from a recent sign-in instead.

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The phrase `dotrelay account delete` asks the User to type. */
export const ACCOUNT_DELETION_PHRASE = "delete my account";

// The session-only client for a machine whose Device was revoked. The
// service still wants a Device proof while the account has another active
// Device, so that refusal names the way out.
const withoutRevokedDevice = (admin: StrictJsonClient): StrictJsonClient => {
  const explain = (error: unknown): never => {
    if (error instanceof CliError && error.code === "device_proof_required")
      throw new CliError(
        "authentication",
        "this machine's Device is no longer active and your account still has an active Device; run the command on that Device, or run dotrelay device enroll to authorize this machine again",
        {},
        "device_not_active",
      );
    throw error;
  };
  return Object.freeze({
    get: (path: string, fields: readonly string[]) =>
      admin.get(path, fields).catch(explain),
    post: (
      path: string,
      body: Record<string, unknown>,
      fields: readonly string[],
      postOptions?: Readonly<{ readonly idempotencyKey?: string }>,
    ) => admin.post(path, body, fields, postOptions).catch(explain),
  });
};

// This machine's Device for the profile, when it has one, and a client that
// proves it on every request. A Device revoked since this machine stored it
// cannot prove itself; the action then goes ahead on the session alone,
// which the service accepts only while the account has no active Device and
// the sign-in is recent (ADR 0024).
const accountClient = async (
  options: WorkflowOptions,
): Promise<
  Readonly<{
    readonly deviceId: string | null;
    readonly admin: StrictJsonClient;
  }>
> => {
  const deviceId =
    options.deviceId ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  if (!deviceId) return { deviceId: null, admin: adminClient(options) };
  const admin = createDeviceAdmin(options, deviceId);
  try {
    // The client keeps this proof for the action's own requests.
    await admin.deviceProof?.headers();
    return { deviceId, admin };
  } catch (error) {
    if (!(error instanceof CliError && error.code === "device_not_active"))
      throw error;
  }
  return { deviceId: null, admin: withoutRevokedDevice(adminClient(options)) };
};

// The Device's Ed25519 signature over the account deletion command.
const signAccountDeletion = async (
  options: WorkflowOptions,
  deviceId: string,
  command: Uint8Array<ArrayBuffer>,
): Promise<string> => {
  const signer = await cliDevice({
    pin: options.profile.pin,
    credentials: options.credentials,
    stateDirectory: options.stateDirectory,
    deviceId,
    ...(options.deviceStorage ? { deviceStorage: options.deviceStorage } : {}),
  }).signer();
  return base64(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", signer.signingKey, command),
    ),
  );
};

// `dotrelay team leave <team>`: end this User's own Membership.
export const leaveTeam = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown>> => {
  const reference = parsed.positionals[0];
  if (!reference)
    throw new CliInvocationError(
      "team leave needs a Team id or name; usage: dotrelay team leave <team-id-or-name>",
    );
  const { admin } = await accountClient(options);
  const wanted = reference.trim().toLowerCase();
  const matches = (await listTeams(admin)).filter(
    (team) =>
      team.id.toLowerCase() === wanted || team.name.toLowerCase() === wanted,
  );
  if (matches.length > 1)
    throw new CliInvocationError(
      `several Teams are named ${sanitizeCliLine(reference)}; pass one of these Team ids: ${matches.map((team) => team.id).join(", ")}`,
    );
  const [team] = matches;
  // A Membership still waiting for keys is not in the Team list; its id is
  // sent as-is and the service decides.
  if (!team && !uuidPattern.test(wanted))
    throw new CliError(
      "invocation",
      `no Team matches ${sanitizeCliLine(reference)}; run dotrelay team list to see your Teams`,
      {},
      "resource_not_found",
    );
  const teamId = team?.id ?? wanted;
  const label = team ? sanitizeCliLine(team.name) : teamId;
  if (options.noInput && !options.force)
    throw new CliInvocationError(
      "--no-input requires --force to confirm leaving the Team",
    );
  if (!(options.noInput && options.force)) {
    const question = `Leave ${label}? You lose access to its Projects at once and need a new invitation to come back.`;
    if (!(await confirmSilent(options, question)))
      throw new CliInvocationError("leaving the Team was cancelled");
  }
  await admin.post(
    `/api/v1/teams/${encodeURIComponent(teamId)}/leave`,
    {},
    ["teamId", "membershipId", "lifecycle"],
    { idempotencyKey: crypto.randomUUID() },
  );
  return {
    teamId,
    ...(team ? { team: team.name } : {}),
    lifecycle: "REMOVED",
    message: `Left ${label}. Its owners should rotate each Project key (dotrelay project rotate), since this Device keeps what it already downloaded.`,
  };
};

const EXPORT_FIELDS = [
  "format",
  "exportedAt",
  "serverOrigin",
  "user",
  "profile",
  "linkedAccounts",
  "sessions",
  "memberships",
  "invitations",
  "devices",
  "accountKeyWrappers",
  "projectsCreated",
  "revisionsAuthored",
  "auditFacts",
] as const;

// `dotrelay account export`: the account metadata the service holds, as
// JSON. Without --output the document is the command's result.
export const exportAccount = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown>> => {
  const { admin } = await accountClient(options);
  const exported = await admin.get("/api/v1/account/export", EXPORT_FIELDS);
  if (!parsed.output) return exported;
  const path = resolve(parsed.output);
  await atomicWriteProtectedFile(
    path,
    `${JSON.stringify(exported, null, 2)}\n`,
  );
  return {
    output: path,
    message: `Wrote your account data to ${sanitizeCliLine(path)}. It holds no Values or keys; run dotrelay pull or dotrelay export for those.`,
  };
};

const teamNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        isRecord(entry) && typeof entry.name === "string"
          ? [sanitizeCliLine(entry.name)]
          : [],
      )
    : [];

// `dotrelay account delete`: delete this User's account on the Server
// Profile, then forget the session and this Device's local keys.
export const deleteAccount = async (
  options: WorkflowOptions,
): Promise<Record<string, unknown>> => {
  const { admin, deviceId: provingDeviceId } = await accountClient(options);
  const plan = await admin.get("/api/v1/account/deletion", [
    "userId",
    "blockingTeams",
    "teamsDeleted",
    "teamsLeft",
  ]);
  const userId = typeof plan.userId === "string" ? plan.userId : null;
  if (!userId)
    throw new CliError(
      "transient",
      "the server returned an invalid account deletion plan",
      {},
      "response_invalid",
    );
  const blocking = teamNames(plan.blockingTeams);
  if (blocking.length > 0)
    throw new CliError(
      "conflict",
      `you are the last active owner of ${blocking.join(", ")}; make another active Member an owner, or delete the Team, before deleting your account`,
      {},
      "owner_transfer_required",
    );
  const deleted = teamNames(plan.teamsDeleted);
  const left = teamNames(plan.teamsLeft);
  if (options.noInput && !options.force)
    throw new CliInvocationError(
      "--no-input requires --force to confirm deleting the account",
    );
  if (!(options.noInput && options.force)) {
    const consequences = [
      "Deleting your account cannot be undone. Every session ends, every Device stops working, and your Recovery Code, password and passkeys unlock nothing.",
      ...(deleted.length > 0
        ? [`Deleted with it (you are the only Member): ${deleted.join(", ")}.`]
        : []),
      ...(left.length > 0 ? [`You leave: ${left.join(", ")}.`] : []),
      `Type "${ACCOUNT_DELETION_PHRASE}" to confirm:`,
    ].join("\n");
    const answer = await ask(options, consequences);
    if (answer.trim() !== ACCOUNT_DELETION_PHRASE)
      throw new CliInvocationError("deleting the account was cancelled");
  }
  const operationId = crypto.randomUUID();
  const signature = provingDeviceId
    ? await signAccountDeletion(
        options,
        provingDeviceId,
        accountDeletionCommand({ userId, operationId }),
      )
    : undefined;
  await admin.post(
    "/api/v1/account/delete",
    { confirmUserId: userId, ...(signature ? { signature } : {}) },
    ["userId", "status", "deletedAt", "teamsDeleted", "teamsLeft"],
    { idempotencyKey: operationId },
  );
  // The server account is gone; what this machine still holds for the
  // Server Profile is now useless, so it is removed too.
  const metadataPath = deviceMetadataPath(
    options.stateDirectory,
    options.profile.pin,
  );
  const deviceId = options.deviceId ?? (await readDeviceId(metadataPath));
  const removed: string[] = ["session"];
  await createSessionStore(options.credentials).remove(options.profile.pin);
  if (deviceId) {
    await resolveDeviceStorage(options).remove({
      pin: options.profile.pin,
      deviceId: uuidToBytes(deviceId),
    });
    await unlink(metadataPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    removed.push("device keys");
  }
  return {
    userId,
    status: "DELETED",
    teamsDeleted: deleted,
    teamsLeft: left,
    localDataRemoved: removed,
    message: [
      `Deleted your account on ${sanitizeCliLine(options.profile.name)} and removed this machine's ${removed.join(" and ")} for it.`,
      `Still on this machine: the ${sanitizeCliLine(options.profile.name)} Server Profile entry, trusted-head and teammate pins, and worktree contexts under ${sanitizeCliLine(options.stateDirectory)}, plus any .env files you pulled. Signing in again creates a new, empty account.`,
    ].join("\n"),
  };
};
