import {
  createBrowserDeviceStorage,
  createMembershipProvisioning,
  loadDeviceKeyMaterial,
  type MembershipProvisioningPlan,
  openProjectEpochGrant,
  uuidToBytes,
} from "@dotrelay/client";
import {
  type AccountKeyWrapperEntry,
  fromBase64,
  openProjectEpochEnvelope,
} from "./account-keys";
import { accountKeyVerification } from "./account-recovery";
import {
  BROWSER_DEVICE_ID_HEADER,
  fetchWorkspaceBoundary,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
} from "./workspace-boundary";

export const provisionTeamMember = async (
  input: Readonly<{
    apiOrigin: string;
    profileId: WorkspaceProfileId;
    boundary: WorkspaceBoundary;
    teamId: string;
    membershipId: string;
    accountMasterKey: Uint8Array | null;
    wrappers: readonly AccountKeyWrapperEntry[];
  }>,
): Promise<void> => {
  const { boundary } = input;
  const deviceId = boundary.device.id;
  const serverProfileId = boundary.profile.serverProfileId;
  if (!deviceId || !serverProfileId || !input.accountMasterKey)
    throw new Error("Unlock this browser before sharing project keys.");
  const path = `/api/v1/teams/${input.teamId}/memberships/${input.membershipId}/provision`;
  const headers = { [BROWSER_DEVICE_ID_HEADER]: deviceId };
  const response = await fetch(`${input.apiOrigin}${path}`, {
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error(
      problem?.code === "device_not_active"
        ? "Ask this member to set up a browser or CLI Device, then try again."
        : "We couldn't prepare this member's access. Refresh and try again.",
    );
  }
  const plan = (await response.json()) as MembershipProvisioningPlan;
  if (
    plan.teamId !== input.teamId ||
    plan.membershipId !== input.membershipId ||
    !Array.isArray(plan.projects) ||
    !Array.isArray(plan.devices) ||
    plan.projects.length * plan.devices.length > 128
  )
    throw new Error("The server returned an invalid provisioning plan.");
  const pin = { origin: boundary.profile.origin, serverProfileId };
  const bundle = await createBrowserDeviceStorage(pin).load({
    pin,
    deviceId: uuidToBytes(deviceId),
  });
  const keys = await loadDeviceKeyMaterial(bundle);
  const projectKeys = new Map<string, Uint8Array>();
  try {
    for (const project of plan.projects) {
      const scoped = await fetchWorkspaceBoundary(input.profileId, {
        deviceId,
        environmentId: project.environmentId,
      });
      if (
        scoped.profile.serverProfileId !== serverProfileId ||
        scoped.session.userId !== boundary.session.userId ||
        scoped.device.id !== deviceId ||
        scoped.environment.projectId !== project.id ||
        scoped.environment.teamId !== input.teamId ||
        Number(scoped.environment.projectEpoch) !== project.epoch
      )
        throw new Error("Project access changed. Refresh and try again.");
      const verification = accountKeyVerification(scoped, input.wrappers);
      let key: Uint8Array | null = null;
      if (verification)
        key = await openProjectEpochEnvelope(
          scoped.accountKeyEnvelope,
          input.accountMasterKey,
          {
            ...verification,
            projectId: project.id,
            projectEpoch: project.epoch,
          },
        );
      if (!key && scoped.epochGrant)
        key = await openProjectEpochGrant(
          fromBase64(scoped.epochGrant),
          keys.encryptionPrivateKey,
        );
      if (!key)
        throw new Error(
          "This browser is missing a project's keys. Open each project on a Device with access, then try again.",
        );
      projectKeys.set(project.id, key);
    }
    const request = await createMembershipProvisioning({
      serverProfileId,
      deviceId,
      signingPrivateKey: keys.signingPrivateKey,
      plan,
      projectKeys,
    });
    const committed = await fetch(`${input.apiOrigin}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Idempotency-Key": request.operationId,
      },
      body: JSON.stringify(request),
    });
    if (!committed.ok)
      throw new Error(
        "Access couldn't be activated. Refresh the member list before trying again.",
      );
  } finally {
    for (const key of projectKeys.values()) key.fill(0);
  }
};
