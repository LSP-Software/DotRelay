import {
  createProjectEpochGrantBootstrap,
  type DeviceKeyMaterial,
  sendWithDeviceProof,
} from "@dotrelay/client";
import { sha384 } from "@dotrelay/contracts";
import { CliError } from "./errors";
import {
  defaultNetworkPolicy,
  fetchWithDeadline,
  NetworkAttemptError,
  networkFailureCliError,
} from "./network";
import {
  type Boundary,
  createDeviceAdmin,
  hexToBytes,
  rawPublicKey,
  responseJson,
  safeProjectEpoch,
  type WorkflowOptions,
} from "./workflow-core";
export const bootstrapProjectGrant = async (
  options: WorkflowOptions,
  token: string,
  boundary: Boundary,
  deviceId: string,
  keys: DeviceKeyMaterial,
): Promise<Uint8Array> => {
  if (!boundary.environment.projectId || !boundary.environment.teamId)
    throw new CliError(
      "conflict",
      "the server didn't send the project details for this environment, so this device can't set up the project key",
      {},
      "environment_context_missing",
    );
  if (!keys.encryptionPublicKey)
    throw new CliError(
      "crypto",
      "this device's encryption key is missing",
      {},
      "device_bundle_invalid",
    );
  const recipientKey = await rawPublicKey(keys.encryptionPublicKey);
  const grant = await createProjectEpochGrantBootstrap({
    serverProfileId: options.profile.pin.serverProfileId,
    teamId: boundary.environment.teamId,
    projectId: boundary.environment.projectId,
    projectEpoch: safeProjectEpoch(boundary.environment.projectEpoch),
    senderDeviceId: deviceId,
    recipientDeviceId: deviceId,
    recipientX25519PublicKey: recipientKey,
    recipientEncryptionPublicKey: keys.encryptionPublicKey,
    signingPrivateKey: keys.signingPrivateKey,
  });
  await submitEpochGrant(options, token, boundary, deviceId, grant);
  return grant.plaintextKey;
};

// Peer provisioning is optional: it must never abort a read this Device can
// already verify, and a peer that holds the current epoch grant is reused
// rather than re-provisioned. The peers come from this User's verified
// roster, and any active Member may seal the key to their own Devices.
export const wrapEpochKeyToPeers = async (
  options: WorkflowOptions,
  token: string,
  boundary: Boundary,
  deviceId: string,
  keys: DeviceKeyMaterial,
  epochKey: Uint8Array,
): Promise<readonly string[]> => {
  if (
    !keys.encryptionPublicKey ||
    !boundary.environment.projectId ||
    !boundary.environment.teamId
  )
    return [];
  const pending: string[] = [];
  for (const peer of boundary.peerDevices) {
    if (peer.id === deviceId) continue;
    if (peer.hasEpochGrant) continue;
    try {
      const recipientX25519PublicKey = hexToBytes(peer.encryptionPublicKey);
      if (recipientX25519PublicKey.length !== 32) continue;
      const recipientEncryptionPublicKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(recipientX25519PublicKey),
        { name: "X25519" },
        true,
        [],
      );
      const grant = await createProjectEpochGrantBootstrap({
        serverProfileId: options.profile.pin.serverProfileId,
        teamId: boundary.environment.teamId ?? "",
        projectId: boundary.environment.projectId ?? "",
        projectEpoch: safeProjectEpoch(boundary.environment.projectEpoch),
        senderDeviceId: deviceId,
        recipientDeviceId: peer.id,
        recipientX25519PublicKey,
        recipientEncryptionPublicKey,
        signingPrivateKey: keys.signingPrivateKey,
        plaintextKey: epochKey,
      });
      await submitEpochGrant(options, token, boundary, deviceId, grant);
    } catch {
      pending.push(
        // The peer is another of this User's own Devices (the service lists
        // no one else's); that Device can still read the key from the
        // account key once it is unlocked.
        `Your device ${peer.id} doesn't have the project key yet, and this device couldn't share it. On that device, run dotrelay device recover if it's locked, then dotrelay pull. If it still can't read the project, a team owner or admin can share the project keys with you from the Members view in the DotRelay web app ("Share project keys").`,
      );
    }
  }
  return Object.freeze(pending);
};

const submitEpochGrant = async (
  options: WorkflowOptions,
  token: string,
  boundary: Boundary,
  deviceId: string,
  grant: Awaited<ReturnType<typeof createProjectEpochGrantBootstrap>>,
): Promise<void> => {
  let response: Response;
  const body = JSON.stringify({
    operationId: crypto.randomUUID(),
    teamId: boundary.environment.teamId,
    projectId: boundary.environment.projectId,
    objectId: grant.objectId,
    digest: Buffer.from(await sha384(grant.canonicalBytes)).toString("base64"),
    grant: Buffer.from(grant.canonicalBytes).toString("base64"),
  });
  // Deadline only: this mutation carries a fresh operation id, so it must
  // never be repeated automatically. A refused Device proof is the one
  // exception: the service rejected the request before reading it.
  const send = (proofHeaders: Readonly<Record<string, string>>) =>
    fetchWithDeadline(
      options.fetch ?? fetch,
      `${options.profile.origin}/api/v1/grants/bootstrap`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-DotRelay-Device-Id": deviceId,
          ...proofHeaders,
        },
        body,
      },
      options.networkPolicy ?? defaultNetworkPolicy,
    );
  const deviceProof = createDeviceAdmin(options, deviceId).deviceProof;
  try {
    response = deviceProof
      ? await sendWithDeviceProof(deviceProof, send)
      : await send({});
  } catch (error) {
    if (error instanceof NetworkAttemptError)
      throw networkFailureCliError(
        error,
        `the server at ${options.profile.origin}`,
        "grant_bootstrap_unavailable",
      );
    throw error;
  }
  if (!response.ok) {
    const body = await responseJson(response).catch(() => undefined);
    const code =
      typeof body?.code === "string" ? body.code : "grant_bootstrap_failed";
    throw new CliError(
      ["stale_epoch", "operation_conflict", "state_conflict"].includes(code)
        ? "conflict"
        : code === "invalid_crypto_object"
          ? "crypto"
          : "authentication",
      "the server refused to store the project key for this device",
      {},
      code,
    );
  }
};
