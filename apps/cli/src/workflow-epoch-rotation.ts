import {
  createAccountKeyEnvelope,
  createEpochRotationArtifacts,
  createProjectEpochGrantBootstrap,
  ProtocolTransportError,
} from "@dotrelay/client";
import {
  encodeProtocolObject,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import { listEnvironments, type EnvironmentSummary } from "./admin";
import type { ParsedArguments } from "./args";
import { CliError, CliInvocationError } from "./errors";
import { loadAccountMasterKey } from "./workflow-account-key";
import {
  base64,
  confirmSilent,
  createDeviceAdmin,
  hexToBytes,
  rawPublicKey,
  safeProjectEpoch,
  type WorkflowOptions,
} from "./workflow-core";
import { syncWorkflow } from "./workflow-session";

const ROTATE_QUESTION = "Rotate this project's keys?";

export type RotationTarget = Readonly<{
  readonly environmentId: string;
  readonly expectedHeadId: string;
  readonly expectedHeadHash: Uint8Array;
}>;

// A project epoch bump is project-wide, so a rotation advances every active
// Environment in one shared operation. The operator must act from one of the
// active Environments, and every active Environment needs a head to chain the
// transition from.
export const planEpochRotation = (
  environments: readonly EnvironmentSummary[],
  currentEnvironmentId: string,
): RotationTarget[] => {
  const active = environments.filter(
    (environment) => environment.lifecycle === "active",
  );
  if (
    active.length < 1 ||
    !active.some((environment) => environment.id === currentEnvironmentId)
  )
    throw new CliError(
      "conflict",
      "this project has no active environment to rotate from. Activate an environment, or switch to one, before rotating the project's keys",
      { activeEnvironments: active.length },
      "epoch_rotation_unsupported",
    );
  const empty = active.find(
    (environment) => environment.currentHeadId === null,
  );
  if (empty)
    throw new CliError(
      "conflict",
      `the active environment ${empty.label} has no revision yet. Run dotrelay init in it before rotating the project's keys`,
      { environmentId: empty.id },
      "environment_empty",
    );
  return active.map((environment) => ({
    environmentId: environment.id,
    expectedHeadId: environment.currentHeadId as string,
    expectedHeadHash: hexToBytes(environment.currentHeadHash as string),
  }));
};

export const rotateProjectEpoch = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<
  Readonly<{
    readonly projectEpoch: string;
    readonly previousEpoch: number;
    readonly environmentId: string;
    readonly environmentIds: readonly string[];
    readonly message: string;
  }>
> => {
  if (options.noInput && !options.force)
    throw new CliInvocationError(
      "project rotate changes the project's keys; re-run with --force to confirm",
    );
  // Verify the session, Device, and project context before asking for the
  // destructive confirmation, so a missing login or enrollment is reported
  // instead of prompting first (publication confirms after syncing too).
  const synced = await syncWorkflow(options, parsed);
  if (!options.noInput && !(await confirmSilent(options, ROTATE_QUESTION)))
    throw new CliInvocationError("project key rotation was declined");
  const context = synced.workflow.publicationContext;
  const admin = createDeviceAdmin(options, synced.workflow.deviceId);
  const environments = await listEnvironments(admin, context.projectId);
  const rotationEnvironments = planEpochRotation(
    environments,
    context.environmentId,
  );
  const previousEpoch = safeProjectEpoch(synced.page.projectEpoch);
  const artifacts = await createEpochRotationArtifacts({
    serverProfileId: context.serverProfileId,
    teamId: context.teamId,
    projectId: context.projectId,
    actorUserId: context.actorUserId,
    actorDeviceId: context.actorDeviceId,
    expectedEpoch: previousEpoch,
    environments: rotationEnvironments,
    signingPrivateKey: context.signingPrivateKey,
  });
  const operationId = crypto.randomUUID();
  let rotated: { readonly projectEpoch: string };
  try {
    await synced.workflow.transport.begin({
      operationId,
      deviceId: synced.workflow.deviceId,
      kind: "EPOCH_ROTATION",
      commandBytes: artifacts.commandBytes,
      commandDigest: await sha384(artifacts.commandBytes),
    });
    for (const staged of artifacts.stagedObjects)
      await synced.workflow.transport.stage({
        operationId,
        deviceId: synced.workflow.deviceId,
        objectId: staged.objectId,
        bytes: staged.bytes,
      });
    rotated = await synced.workflow.transport.epochRotate({
      operationId,
      deviceId: synced.workflow.deviceId,
      request: artifacts.request,
    });
  } catch (error) {
    await synced.workflow.transport
      .cancel({ operationId, deviceId: synced.workflow.deviceId })
      .catch(() => undefined);
    if (error instanceof CliError || error instanceof CliInvocationError)
      throw error;
    const code =
      error instanceof ProtocolTransportError
        ? error.problem.code
        : "service_unavailable";
    throw new CliError(
      code === "stale_epoch" ||
        code === "stale_head" ||
        code === "state_conflict"
        ? "conflict"
        : code === "invalid_crypto_object"
          ? "crypto"
          : "transient",
      code === "stale_epoch"
        ? "the project epoch changed before this rotation landed. Run dotrelay pull, then try again"
        : "the Server Profile did not rotate the project keys",
      {},
      code,
    );
  }
  await storeRotatedEpochKey(options, synced.workflow, previousEpoch + 1);
  const environmentIds = rotationEnvironments.map(
    (target) => target.environmentId,
  );
  return {
    projectEpoch: rotated.projectEpoch,
    previousEpoch,
    environmentId: context.environmentId,
    environmentIds,
    message:
      environmentIds.length > 1
        ? `Rotated the project to epoch ${rotated.projectEpoch} across all ${environmentIds.length} of its active environments. Devices that still hold only the previous epoch key can read later shared values after the next dotrelay pull.`
        : `Rotated the project to epoch ${rotated.projectEpoch}. Devices that still hold only the previous epoch key can read later shared values after the next dotrelay pull.`,
  };
};

const storeRotatedEpochKey = async (
  options: WorkflowOptions,
  workflow: Awaited<ReturnType<typeof syncWorkflow>>["workflow"],
  projectEpoch: number,
): Promise<void> => {
  const epochKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const accountMasterKey = await loadAccountMasterKey(
      options,
      workflow.deviceId,
    );
    const userId = workflow.boundary.session.userId;
    const projectId = workflow.boundary.environment.projectId;
    const teamId = workflow.boundary.environment.teamId;
    if (!userId || !projectId || !teamId)
      throw new CliError(
        "conflict",
        "the project epoch advanced, but this device has no account key to store the new project epoch key. Run dotrelay pull. Do not run project rotate again",
        {},
        "epoch_key_not_stored",
      );
    if (accountMasterKey) {
      const envelope = await createAccountKeyEnvelope({
        serverProfileId: options.profile.pin.serverProfileId,
        userId: uuidToBytes(userId),
        deviceId: uuidToBytes(workflow.deviceId),
        createdAtMs: Date.now(),
        accountMasterKey,
        signingPrivateKey: workflow.keys.signingPrivateKey,
        kind: {
          type: "projectEpochKey",
          projectId: uuidToBytes(projectId),
          projectEpoch,
          contentKey: epochKey,
        },
      });
      const operationId = crypto.randomUUID();
      try {
        await createDeviceAdmin(options, workflow.deviceId).post(
          "/api/v1/account-keys/envelopes",
          {
            operationId,
            objectId: crypto.randomUUID(),
            object: base64(encodeProtocolObject(envelope.object)),
            projectId,
            projectEpoch: String(projectEpoch),
            ciphertextHash: sha384ToHex(await sha384(envelope.ciphertext)),
            ciphertextLength: envelope.ciphertext.length,
          },
          ["objectId", "idempotent"],
          { idempotencyKey: operationId },
        );
      } catch (error) {
        if (error instanceof CliError && error.code === "state_conflict")
          return;
        throw new CliError(
          "transient",
          "the project epoch advanced, but this device did not store the new project epoch key. Run dotrelay pull. Do not run project rotate again",
          {},
          "epoch_key_not_stored",
        );
      }
    }
    if (!workflow.keys.encryptionPublicKey)
      throw new CliError(
        "crypto",
        "the project epoch advanced, but this device has no encryption key to seal the new project epoch key. Run dotrelay pull. Do not run project rotate again",
        {},
        "epoch_key_not_stored",
      );
    const admin = createDeviceAdmin(options, workflow.deviceId);
    const recipients = [
      {
        id: workflow.deviceId,
        publicKey: await rawPublicKey(workflow.keys.encryptionPublicKey),
      },
      ...workflow.boundary.peerDevices.map((peer) => ({
        id: peer.id,
        publicKey: hexToBytes(peer.encryptionPublicKey),
      })),
    ];
    for (const recipient of recipients) {
      if (recipient.publicKey.length !== 32) continue;
      try {
        const recipientEncryptionPublicKey = await crypto.subtle.importKey(
          "raw",
          new Uint8Array(recipient.publicKey),
          { name: "X25519" },
          true,
          [],
        );
        const grant = await createProjectEpochGrantBootstrap({
          serverProfileId: options.profile.pin.serverProfileId,
          teamId,
          projectId,
          projectEpoch,
          senderDeviceId: workflow.deviceId,
          recipientDeviceId: recipient.id,
          recipientX25519PublicKey: recipient.publicKey,
          recipientEncryptionPublicKey,
          signingPrivateKey: workflow.keys.signingPrivateKey,
          plaintextKey: epochKey,
        });
        const operationId = crypto.randomUUID();
        await admin.post(
          "/api/v1/grants/bootstrap",
          {
            operationId,
            teamId,
            projectId,
            objectId: grant.objectId,
            digest: Buffer.from(await sha384(grant.canonicalBytes)).toString(
              "base64",
            ),
            grant: Buffer.from(grant.canonicalBytes).toString("base64"),
          },
          ["grantObjectId", "idempotent"],
          { idempotencyKey: operationId },
        );
      } catch (error) {
        if (recipient.id === workflow.deviceId && accountMasterKey === null)
          throw new CliError(
            "transient",
            "the project epoch advanced, but this device did not store the new project epoch key. Run dotrelay pull. Do not run project rotate again",
            {},
            "epoch_key_not_stored",
          );
        if (error instanceof CliError && error.code === "epoch_key_not_stored")
          throw error;
      }
    }
  } finally {
    epochKey.fill(0);
  }
};
