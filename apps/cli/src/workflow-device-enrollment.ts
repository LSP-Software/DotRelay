import { readFile, unlink } from "node:fs/promises";
import {
  createDeviceBootstrap,
  createDeviceEnrollmentApproval,
  createDeviceEnrollmentRequest,
  type DeviceEnrollmentRequest,
  exportSigningPublicKey,
  loadDeviceKeyMaterial,
  parseDeviceEnrollmentTranscript,
  verifySignedProtocolObject,
} from "@dotrelay/client";
import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import { createStrictJsonClient } from "./admin";
import { createSessionStore } from "./auth";
import { describeCliClient } from "./device-describe";
import {
  deviceMetadataPath,
  readDeviceId,
  writeDeviceId,
} from "./device-storage";
import { CliError, categoryForProblem } from "./errors";
import {
  defaultNetworkPolicy,
  fetchWithDeadline,
  NetworkAttemptError,
  networkFailureCliError,
} from "./network";
import { atomicWriteProtectedFile } from "./output";
import { establishAccountTrust } from "./workflow-account-trust";
import {
  base64,
  bytesToHex,
  createDeviceAdmin,
  fromBase64,
  isRecord,
  loadAuthorizedDevice,
  parseBoundary,
  rawPublicKey,
  requiredString,
  resolveDeviceStorage,
  responseJson,
  verifyDeviceBundle,
  type WorkflowOptions,
  workspaceBoundaryFields,
} from "./workflow-core";

const postBootstrap = async (
  options: WorkflowOptions,
  token: string,
  input: Readonly<{
    readonly operationId: string;
    readonly deviceId: string;
    readonly certificateId: string;
    readonly identityGeneration: number;
    readonly x25519PublicKey: Uint8Array;
    readonly ed25519PublicKey: Uint8Array;
    readonly keyId: Uint8Array;
    readonly certificate: Uint8Array;
  }>,
): Promise<void> => {
  const client = describeCliClient();
  let response: Response;
  try {
    // Deadline only: an enrollment attempt names a pending operation, so a
    // stalled request is surfaced instead of being repeated.
    response = await fetchWithDeadline(
      options.fetch ?? fetch,
      `${options.profile.origin}/api/v1/devices/bootstrap`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          operationId: input.operationId,
          deviceId: input.deviceId,
          certificateId: input.certificateId,
          identityGeneration: input.identityGeneration,
          x25519PublicKey: bytesToHex(input.x25519PublicKey),
          ed25519PublicKey: [...input.ed25519PublicKey]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          keyId: sha384ToHex(input.keyId),
          certificate: Buffer.from(input.certificate).toString("base64"),
          client: {
            displayName: client.displayName,
            clientKind: client.clientKind,
            ...(client.osName ? { osName: client.osName } : {}),
            ...(client.clientSummary
              ? { clientSummary: client.clientSummary }
              : {}),
          },
        }),
      },
      options.networkPolicy ?? defaultNetworkPolicy,
    );
  } catch (error) {
    if (error instanceof NetworkAttemptError)
      throw networkFailureCliError(
        error,
        `the server at ${options.profile.origin}`,
        "device_enrollment_unavailable",
      );
    throw error;
  }
  if (!response.ok) {
    const body = await responseJson(response).catch(() => undefined);
    const code =
      typeof body?.code === "string" ? body.code : "device_enrollment_failed";
    throw new CliError(
      categoryForProblem(code),
      "The server refused to enroll this device.",
      {},
      code,
    );
  }
};

type EnrollmentArtifact = Readonly<{
  readonly version: 1;
  readonly kind: "dotrelay-device-enrollment-request";
  readonly serverProfileId: string;
  readonly userId: string;
  readonly initiatorDeviceId: string;
  readonly enrollmentId: string;
  readonly deviceId: string;
  readonly identityGeneration: number;
  readonly operationId: string;
  readonly enrollmentObjectId: string;
  readonly expiresAt: string;
  readonly transcript: string;
  readonly transcriptHash: string;
  readonly initiatorSigningPublicKey: string;
  readonly certificate: string;
  readonly certificateObjectId: string;
}>;

const artifactObject = async (
  path: string,
): Promise<Record<string, unknown>> => {
  try {
    const source = await readFile(path);
    if (source.byteLength > 8 * 1024 * 1024)
      throw new CliError(
        "local-io",
        "The enrollment request file is too large. Check that you passed the right file.",
        {},
        "artifact_too_large",
      );
    const value: unknown = JSON.parse(new TextDecoder().decode(source));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "local-io",
      "Couldn't read the enrollment request file. Check the path, and that the file is the JSON dotrelay device enroll wrote.",
      {},
      "artifact_read_failed",
    );
  }
};

const requiredArtifactString = (
  value: Record<string, unknown>,
  field: string,
): string => requiredString(value[field], `handoff ${field}`);

const readEnrollmentArtifact = async (
  path: string,
): Promise<EnrollmentArtifact> => {
  const value = await artifactObject(path);
  if (
    value.version !== 1 ||
    value.kind !== "dotrelay-device-enrollment-request"
  )
    throw new CliError(
      "crypto",
      "The enrollment request file isn't in a format this CLI supports.",
      {},
      "artifact_invalid",
    );
  const identityGeneration = value.identityGeneration;
  if (
    typeof identityGeneration !== "number" ||
    !Number.isSafeInteger(identityGeneration) ||
    identityGeneration < 0
  )
    throw new CliError(
      "crypto",
      "The enrollment request file is damaged. Its identity generation isn't valid.",
      {},
      "artifact_invalid",
    );
  return Object.freeze({
    version: 1,
    kind: "dotrelay-device-enrollment-request",
    serverProfileId: requiredArtifactString(value, "serverProfileId"),
    userId: requiredArtifactString(value, "userId"),
    initiatorDeviceId: requiredArtifactString(value, "initiatorDeviceId"),
    enrollmentId: requiredArtifactString(value, "enrollmentId"),
    deviceId: requiredArtifactString(value, "deviceId"),
    identityGeneration,
    operationId: requiredArtifactString(value, "operationId"),
    enrollmentObjectId: requiredArtifactString(value, "enrollmentObjectId"),
    expiresAt: requiredArtifactString(value, "expiresAt"),
    transcript: requiredArtifactString(value, "transcript"),
    transcriptHash: requiredArtifactString(value, "transcriptHash"),
    initiatorSigningPublicKey: requiredArtifactString(
      value,
      "initiatorSigningPublicKey",
    ),
    certificate: requiredArtifactString(value, "certificate"),
    certificateObjectId: requiredArtifactString(value, "certificateObjectId"),
  });
};

export const enrollFirstDevice = async (
  options: WorkflowOptions,
): Promise<
  Readonly<{
    deviceId: string;
    active: boolean;
    existing: boolean;
    deviceName?: string;
  }>
> => {
  const sessions = createSessionStore(options.credentials);
  const token = await sessions.get(options.profile.pin);
  if (!token)
    throw new CliError(
      "authentication",
      "Sign in before you enroll this device. Run dotrelay login.",
      {},
      "authentication_required",
    );
  const localDeviceId =
    options.deviceId ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  if (localDeviceId) {
    // This installation already holds a Device. Claim it only after the
    // Server Profile confirms it is this session's active Device and the
    // matching bundle loads from local storage.
    const admin = createDeviceAdmin(options, localDeviceId);
    const session = await admin.get("/api/v1/session", [
      "authenticated",
      "user",
    ]);
    if (!isRecord(session.user))
      throw new CliError(
        "authentication",
        "The server didn't say which user you're signed in as. Run dotrelay login to sign in again.",
        {},
        "session_invalid",
      );
    const boundary = parseBoundary(
      await admin.get("/api/v1/workspace/boundary", workspaceBoundaryFields),
    );
    try {
      await verifyDeviceBundle(
        options,
        boundary,
        localDeviceId,
        "This machine's device isn't active on this server. Run dotrelay device enroll or dotrelay device recover.",
      );
      return {
        deviceId: localDeviceId,
        active: true,
        existing: true,
        deviceName: describeCliClient().displayName,
      };
    } catch (error) {
      // The recorded Device is not usable for this session: it was revoked
      // or replaced, or the Server Profile reports a different Device.
      // Never claim a remote Device; fall through and enroll this
      // installation's own replacement Device.
      if (!(error instanceof CliError && error.code === "device_not_active"))
        throw error;
    }
  }
  const admin =
    options.admin ??
    createStrictJsonClient(options.profile.pin, options.credentials, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.networkPolicy
        ? { networkPolicy: options.networkPolicy }
        : {}),
    });
  const session = await admin.get("/api/v1/session", ["authenticated", "user"]);
  if (!isRecord(session.user))
    throw new CliError(
      "authentication",
      "The server didn't say which user you're signed in as. Run dotrelay login to sign in again.",
      {},
      "session_invalid",
    );
  const userId = requiredString(session.user.id, "user id");
  const bootstrap = await createDeviceBootstrap({
    pin: options.profile.pin,
    userId,
  });
  await postBootstrap(options, token, {
    operationId: crypto.randomUUID(),
    deviceId: bootstrap.deviceId,
    certificateId: bootstrap.certificate.id,
    identityGeneration: bootstrap.identityGeneration,
    x25519PublicKey: bootstrap.x25519PublicKey,
    ed25519PublicKey: bootstrap.ed25519PublicKey,
    keyId: bootstrap.keyId,
    certificate: bootstrap.certificate.canonicalBytes,
  });
  const storage = resolveDeviceStorage(options);
  await storage.save(bootstrap.bundle);
  await writeDeviceId(
    deviceMetadataPath(options.stateDirectory, options.profile.pin),
    options.profile.pin,
    bootstrap.deviceId,
  );
  return {
    deviceId: bootstrap.deviceId,
    active: true,
    existing: false,
    deviceName: describeCliClient().displayName,
  };
};

export const enrollDevice = async (
  options: WorkflowOptions,
  output?: string,
): Promise<
  Readonly<{
    deviceId: string;
    active: boolean;
    enrollmentId?: string;
    request?: string;
    deviceName?: string;
  }>
> => {
  let first;
  try {
    first = await enrollFirstDevice(options);
  } catch (error) {
    // Bootstrap creates the User's first Device only; when the User already
    // has an active Device this installation joins through enrollment.
    if (!(error instanceof CliError) || error.code !== "state_conflict")
      throw error;
    return beginDeviceEnrollment(options, output);
  }
  if (first.existing) return beginDeviceEnrollment(options, output);
  return {
    deviceId: first.deviceId,
    active: first.active,
    ...(first.deviceName ? { deviceName: first.deviceName } : {}),
  };
};

const enrollmentStatePath = (directory: string, enrollmentId: string): string =>
  `${directory}/enrollment-${enrollmentId}.json`;

const enrollmentArtifactFromRequest = (
  request: DeviceEnrollmentRequest,
  operationId: string,
  enrollmentObjectId: string,
  certificateObjectId: string,
): EnrollmentArtifact => ({
  version: 1,
  kind: "dotrelay-device-enrollment-request",
  serverProfileId: request.ids.serverProfileId,
  userId: request.ids.userId,
  initiatorDeviceId: request.ids.initiatorDeviceId,
  enrollmentId: request.ids.enrollmentId,
  deviceId: request.ids.deviceId,
  identityGeneration: request.bundle.userIdentityGeneration,
  operationId,
  enrollmentObjectId,
  expiresAt: new Date(request.expiresAtMs).toISOString(),
  transcript: base64(request.transcriptBytes),
  transcriptHash: sha384ToHex(request.transcriptHash),
  initiatorSigningPublicKey: base64(request.initiatorSigningPublicKey),
  certificate: base64(request.certificateBytes),
  certificateObjectId,
});

const writeEnrollmentArtifact = async (
  options: WorkflowOptions,
  artifact: EnrollmentArtifact,
  output?: string,
): Promise<string> => {
  const statePathForEnrollment = enrollmentStatePath(
    options.stateDirectory,
    artifact.enrollmentId,
  );
  const contents = `${JSON.stringify(artifact)}\n`;
  await atomicWriteProtectedFile(statePathForEnrollment, contents);
  if (output && output !== statePathForEnrollment)
    await atomicWriteProtectedFile(output, contents);
  return output ?? statePathForEnrollment;
};

const requestForApproval = async (
  artifact: EnrollmentArtifact,
): Promise<
  Readonly<{ artifact: EnrollmentArtifact; request: DeviceEnrollmentRequest }>
> => {
  const transcriptBytes = fromBase64(
    artifact.transcript,
    "enrollment transcript",
  );
  const initiatorSigningPublicKey = fromBase64(
    artifact.initiatorSigningPublicKey,
    "new device's signing key",
  );
  const transcript = await parseDeviceEnrollmentTranscript(
    transcriptBytes,
    initiatorSigningPublicKey,
  );
  if (
    transcript.serverProfileId !== artifact.serverProfileId.toLowerCase() ||
    transcript.userId !== artifact.userId.toLowerCase() ||
    transcript.enrollmentId !== artifact.enrollmentId.toLowerCase() ||
    transcript.deviceId !== artifact.deviceId.toLowerCase()
  )
    throw new CliError(
      "crypto",
      "The enrollment request doesn't match the user, device or server it names. Nothing was approved.",
      {},
      "enrollment_binding_mismatch",
    );
  const transcriptHash = await sha384(transcriptBytes);
  if (sha384ToHex(transcriptHash) !== artifact.transcriptHash.toLowerCase())
    throw new CliError(
      "crypto",
      "The enrollment request's hash doesn't match its contents. Nothing was approved.",
      {},
      "enrollment_binding_mismatch",
    );
  return {
    artifact,
    request: {
      ids: {
        serverProfileId: transcript.serverProfileId,
        userId: transcript.userId,
        enrollmentId: transcript.enrollmentId,
        deviceId: transcript.deviceId,
        initiatorDeviceId: artifact.initiatorDeviceId,
      },
      challenge: transcript.challenge,
      expiresAtMs: transcript.expiresAtMs,
      transcriptBytes,
      transcriptHash,
      bundle: undefined as never,
      keyMaterial: undefined as never,
      initiatorSigningPublicKey,
      certificateBytes: fromBase64(artifact.certificate, "device certificate"),
    } as DeviceEnrollmentRequest,
  };
};

export const beginDeviceEnrollment = async (
  options: WorkflowOptions,
  output?: string,
): Promise<
  Readonly<{
    enrollmentId: string;
    deviceId: string;
    active: boolean;
    request: string;
    deviceName?: string;
  }>
> => {
  // The prospective (not yet active) Device starts its own enrollment: it
  // generates its keys, self-signs the request, and hands the artifact to an
  // existing Device for approval, so a login alone is enough here.
  const sessions = createSessionStore(options.credentials);
  const token = await sessions.get(options.profile.pin);
  if (!token)
    throw new CliError(
      "authentication",
      "Sign in before you enroll this device. Run dotrelay login.",
      {},
      "authentication_required",
    );
  const admin =
    options.admin ??
    createStrictJsonClient(options.profile.pin, options.credentials, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.networkPolicy
        ? { networkPolicy: options.networkPolicy }
        : {}),
    });
  const session = await admin.get("/api/v1/session", ["authenticated", "user"]);
  if (!isRecord(session.user))
    throw new CliError(
      "authentication",
      "The server didn't say which user you're signed in as. Run dotrelay login to sign in again.",
      {},
      "session_invalid",
    );
  const userId = requiredString(session.user.id, "user id");
  const deviceId = crypto.randomUUID();
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const keyMaterial = Object.freeze({
    encryptionPrivateKey: encryption.privateKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    signingPublicKey: signing.publicKey,
  });
  const expiresAtMs = Date.now() + 10 * 60 * 1000;
  const request = await createDeviceEnrollmentRequest({
    serverProfileId: options.profile.pin.serverProfileId,
    origin: options.profile.origin,
    userId,
    identityGeneration: 1,
    initiatorDeviceId: deviceId,
    initiatorSigningPrivateKey: signing.privateKey,
    initiatorSigningPublicKey: await exportSigningPublicKey(signing.publicKey),
    expiresAtMs,
    deviceId,
    keyMaterial,
  });
  const operationId = crypto.randomUUID();
  const certificateObjectId = crypto.randomUUID();
  const enrollmentObjectId = crypto.randomUUID();
  const artifact = enrollmentArtifactFromRequest(
    request,
    operationId,
    enrollmentObjectId,
    certificateObjectId,
  );
  const completeArtifact = Object.freeze({
    ...artifact,
  });
  const x25519PublicKey = await rawPublicKey(encryption.publicKey);
  const ed25519PublicKey = await rawPublicKey(signing.publicKey);
  const client = describeCliClient();
  let response: Response;
  try {
    response = await fetchWithDeadline(
      options.fetch ?? fetch,
      `${options.profile.origin}/api/v1/devices/enrollments`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": operationId,
        },
        body: JSON.stringify({
          operationId,
          enrollmentId: request.ids.enrollmentId,
          userId,
          transcriptHash: sha384ToHex(request.transcriptHash),
          challengeHash: sha384ToHex(await sha384(request.challenge)),
          expiresAt: artifact.expiresAt,
          deviceId: request.ids.deviceId,
          identityGeneration: String(request.bundle.userIdentityGeneration),
          x25519PublicKey: base64(x25519PublicKey),
          ed25519PublicKey: base64(ed25519PublicKey),
          keyId: base64(await sha384(x25519PublicKey)),
          certificateObjectId,
          certificateObject: base64(request.certificateBytes),
          client: {
            displayName: client.displayName,
            clientKind: client.clientKind,
            ...(client.osName ? { osName: client.osName } : {}),
            ...(client.clientSummary
              ? { clientSummary: client.clientSummary }
              : {}),
          },
        }),
      },
      options.networkPolicy ?? defaultNetworkPolicy,
    );
  } catch (error) {
    if (error instanceof NetworkAttemptError)
      throw networkFailureCliError(
        error,
        `the server at ${options.profile.origin}`,
        "device_enrollment_unavailable",
      );
    throw error;
  }
  if (!response.ok) {
    const body = await responseJson(response).catch(() => undefined);
    const code =
      typeof body?.code === "string" ? body.code : "device_enrollment_failed";
    throw new CliError(
      categoryForProblem(code),
      "The server refused to enroll this device.",
      {},
      code,
    );
  }
  const storage = resolveDeviceStorage(options);
  await storage.save(request.bundle);
  // The new Device becomes this installation's Device: it is pending until
  // an existing Device approves it.
  await writeDeviceId(
    deviceMetadataPath(options.stateDirectory, options.profile.pin),
    options.profile.pin,
    deviceId,
  );
  const requestPath = await writeEnrollmentArtifact(
    options,
    completeArtifact,
    output,
  );
  return {
    enrollmentId: request.ids.enrollmentId,
    deviceId: request.ids.deviceId,
    active: false,
    request: requestPath,
    deviceName: describeCliClient().displayName,
  };
};

export const approveDeviceEnrollment = async (
  options: WorkflowOptions,
  path: string,
): Promise<
  Readonly<{
    enrollmentId: string;
    deviceId: string;
    approved: boolean;
    message: string;
  }>
> => {
  const artifact = await readEnrollmentArtifact(path);
  if (
    artifact.serverProfileId.toLowerCase() !==
    options.profile.pin.serverProfileId
  )
    throw new CliError(
      "authentication",
      "This enrollment request was made for a different server. Nothing was changed.",
      {},
      "profile_mismatch",
    );
  const authorized = await loadAuthorizedDevice(options);
  if (artifact.userId.toLowerCase() !== authorized.userId.toLowerCase())
    throw new CliError(
      "authentication",
      "This enrollment request was made by a different user. Nothing was approved.",
      {},
      "user_mismatch",
    );
  const parsed = await requestForApproval(artifact).catch((error) => {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "crypto",
      "Couldn't verify the enrollment request. Nothing was approved.",
      {},
      "enrollment_binding_mismatch",
    );
  });
  const approval = await createDeviceEnrollmentApproval({
    request: parsed.request,
    approverDeviceId: authorized.deviceId,
    approverSigningPrivateKey: authorized.keys.signingPrivateKey,
  });
  const operationId = crypto.randomUUID();
  await authorized.admin.post(
    `/api/v1/devices/enrollments/${encodeURIComponent(artifact.enrollmentId)}/approve`,
    {
      operationId,
      enrolledDeviceId: artifact.deviceId,
      objectId: crypto.randomUUID(),
      object: base64(approval.canonicalBytes),
      // The approval activates the enrolled Device and records its
      // self-signed certificate, so the handoff's certificate travels with
      // it.
      certificateObjectId: artifact.certificateObjectId,
      certificateObject: base64(
        fromBase64(artifact.certificate, "device certificate"),
      ),
    },
    ["approved", "idempotent"],
    { idempotencyKey: operationId },
  );
  // The user carried this request from the new Device, so its keys are the
  // ones they approved. An approver that holds the Account Master Key adds
  // that Device to the account's signed roster now (ADR 0022): a roster that
  // lists it is the anchor the new Device checks when it receives the key.
  const accountMasterKey = await resolveDeviceStorage(options)
    .loadAccountKey({
      pin: options.profile.pin,
      deviceId: uuidToBytes(authorized.deviceId),
    })
    .catch(() => null);
  let listed = false;
  if (accountMasterKey) {
    const transcript = await parseDeviceEnrollmentTranscript(
      parsed.request.transcriptBytes,
      parsed.request.initiatorSigningPublicKey,
    );
    const trust = await establishAccountTrust({
      options,
      boundary: authorized.boundary,
      userId: authorized.userId,
      deviceId: authorized.deviceId,
      accountMasterKey,
      encryptionPublicKey: await rawPublicKey(
        authorized.keys.encryptionPublicKey as CryptoKey,
      ),
      signingPublicKey: await rawPublicKey(
        authorized.keys.signingPublicKey as CryptoKey,
      ),
      approved: [
        {
          deviceId: transcript.deviceId,
          encryptionPublicKey: transcript.encryptionPublicKey,
          signingPublicKey: transcript.signingPublicKey,
          addedAtMs: Date.now(),
        },
      ],
    });
    listed =
      trust.resolution.users
        .get(authorized.userId)
        ?.roster?.devices.some(
          (device) =>
            device.deviceId === transcript.deviceId &&
            device.revokedAtMs === undefined,
        ) === true;
  }
  return {
    enrollmentId: artifact.enrollmentId,
    deviceId: artifact.deviceId,
    approved: true,
    message: listed
      ? "Approved the new device and added it to your signed device roster. Send it the account key with dotrelay device transfer."
      : "Approved the new device. This device doesn't hold the account key, so the new device joins your signed device roster once it has the account key.",
  };
};

export const completeDeviceEnrollment = async (
  options: WorkflowOptions,
  path: string,
): Promise<
  Readonly<{
    enrollmentId: string;
    deviceId: string;
    active: boolean;
    deviceName?: string;
  }>
> => {
  const artifact = await readEnrollmentArtifact(path);
  if (
    artifact.serverProfileId.toLowerCase() !==
    options.profile.pin.serverProfileId
  )
    throw new CliError(
      "authentication",
      "This enrollment request was made for a different server. Nothing was changed.",
      {},
      "profile_mismatch",
    );
  const authorized = await loadAuthorizedDevice(options);
  if (
    artifact.userId.toLowerCase() !== authorized.userId.toLowerCase() ||
    artifact.initiatorDeviceId.toLowerCase() !==
      authorized.deviceId.toLowerCase()
  )
    throw new CliError(
      "authentication",
      "This device didn't start this enrollment, so it can't complete it. Run the command on the device that made the request.",
      {},
      "device_mismatch",
    );
  const transcript = await parseDeviceEnrollmentTranscript(
    fromBase64(artifact.transcript, "enrollment transcript"),
    fromBase64(artifact.initiatorSigningPublicKey, "new device's signing key"),
  );
  if (
    transcript.enrollmentId !== artifact.enrollmentId.toLowerCase() ||
    transcript.deviceId !== artifact.deviceId.toLowerCase()
  )
    throw new CliError(
      "crypto",
      "The enrollment request is damaged. Its ids don't match its signed contents.",
      {},
      "enrollment_binding_mismatch",
    );
  const certificateBytes = fromBase64(
    artifact.certificate,
    "device certificate",
  );
  const certificate = parseProtocolObject(certificateBytes);
  if (
    certificate.get(1) !== 2 ||
    certificate.get(28) !== artifact.identityGeneration
  )
    throw new CliError(
      "crypto",
      "The device certificate in the enrollment request isn't valid.",
      {},
      "enrollment_certificate_invalid",
    );
  const storage = resolveDeviceStorage(options);
  const bundle = await storage.load({
    pin: options.profile.pin,
    deviceId: uuidToBytes(artifact.deviceId),
  });
  const keys = await loadDeviceKeyMaterial(bundle);
  if (!keys.encryptionPublicKey || !keys.signingPublicKey)
    throw new CliError(
      "crypto",
      "This device's saved keys are incomplete. The public keys are missing.",
      {},
      "device_bundle_invalid",
    );
  const x25519PublicKey = await rawPublicKey(keys.encryptionPublicKey);
  const ed25519PublicKey = await rawPublicKey(keys.signingPublicKey);
  const profileBytes = uuidToBytes(options.profile.pin.serverProfileId);
  const userBytes = uuidToBytes(authorized.userId);
  const deviceBytes = uuidToBytes(artifact.deviceId);
  const certificateProfile = certificate.get(8);
  const certificateUser = certificate.get(9);
  const certificateDevice = certificate.get(10);
  const certificateEncryptionKey = certificate.get(39);
  const certificateSigningKey = certificate.get(41);
  if (
    !(certificateProfile instanceof Uint8Array) ||
    !(certificateUser instanceof Uint8Array) ||
    !(certificateDevice instanceof Uint8Array) ||
    !(certificateEncryptionKey instanceof Uint8Array) ||
    !(certificateSigningKey instanceof Uint8Array) ||
    bytesToHex(certificateProfile) !== bytesToHex(profileBytes) ||
    bytesToHex(certificateUser) !== bytesToHex(userBytes) ||
    bytesToHex(certificateDevice) !== bytesToHex(deviceBytes) ||
    bytesToHex(certificateEncryptionKey) !== bytesToHex(x25519PublicKey) ||
    bytesToHex(certificateSigningKey) !== bytesToHex(ed25519PublicKey)
  )
    throw new CliError(
      "crypto",
      "The device certificate in the enrollment request doesn't match this device's keys.",
      {},
      "enrollment_certificate_invalid",
    );
  try {
    await verifySignedProtocolObject(
      certificateBytes,
      await exportSigningPublicKey(keys.signingPublicKey),
    );
  } catch {
    throw new CliError(
      "crypto",
      "The device certificate's signature doesn't verify.",
      {},
      "enrollment_certificate_invalid",
    );
  }
  const operationId = crypto.randomUUID();
  const client = describeCliClient();
  // The Device and its certificate were recorded when the enrollment was
  // started and approved; completion only confirms the self-signed request.
  await authorized.admin.post(
    `/api/v1/devices/enrollments/${encodeURIComponent(artifact.enrollmentId)}/complete`,
    {
      operationId,
      enrollmentObjectId: artifact.enrollmentObjectId,
      enrollmentObject: base64(
        fromBase64(artifact.transcript, "enrollment transcript"),
      ),
      client: {
        displayName: client.displayName,
        clientKind: client.clientKind,
        ...(client.osName ? { osName: client.osName } : {}),
        ...(client.clientSummary
          ? { clientSummary: client.clientSummary }
          : {}),
      },
    },
    ["deviceId", "active", "idempotent"],
    { idempotencyKey: operationId },
  );
  await writeDeviceId(
    deviceMetadataPath(options.stateDirectory, options.profile.pin),
    options.profile.pin,
    artifact.deviceId,
  );
  await unlink(
    enrollmentStatePath(options.stateDirectory, artifact.enrollmentId),
  ).catch(() => undefined);
  return {
    enrollmentId: artifact.enrollmentId,
    deviceId: artifact.deviceId,
    active: true,
    deviceName: client.displayName,
  };
};

// A Device recovers the User's Account Master Key by exactly one of:
// unwrapping an active Recovery Code wrapper with a code entered on the
// Device (the wrapper object is service-visible; the code is never sent),
// or accepting an Account Key Transfer sealed to the Device's X25519 key by
// a trusted Device or browser. A passkey or encryption password still
// unlocks in a browser, which then hands the AMK to a CLI Device as a
// transfer. Once recovered, the AMK is stored in the Device's credential
// scope so the Device can open the Account Key Envelopes the service holds
// without any other Device.
