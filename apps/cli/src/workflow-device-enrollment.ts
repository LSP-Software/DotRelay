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
  parseProtocolObject,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import { createStrictJsonClient } from "./admin";
import { createSessionStore } from "./auth";
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
        }),
      },
      options.networkPolicy ?? defaultNetworkPolicy,
    );
  } catch (error) {
    if (error instanceof NetworkAttemptError)
      throw networkFailureCliError(
        error,
        "the Device enrollment endpoint",
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
      "Device enrollment was rejected",
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
        "the Device handoff file is too large",
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
      "could not read the Device handoff file",
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
      "the enrollment handoff file has an unsupported format",
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
      "the enrollment handoff has an invalid identity generation",
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
  }>
> => {
  const sessions = createSessionStore(options.credentials);
  const token = await sessions.get(options.profile.pin);
  if (!token)
    throw new CliError(
      "authentication",
      "login is required before Device enrollment",
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
        "the Server Profile returned no User identity",
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
        "the local Device is not active on this Server Profile; run dotrelay device enroll or dotrelay device recover",
      );
      return { deviceId: localDeviceId, active: true, existing: true };
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
      "the Server Profile returned no User identity",
      {},
      "session_invalid",
    );
  const userId = requiredString(session.user.id, "User id");
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
  return { deviceId: bootstrap.deviceId, active: true, existing: false };
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
  }>
> => {
  const first = await enrollFirstDevice(options);
  if (first.existing) return beginDeviceEnrollment(options, output);
  return { deviceId: first.deviceId, active: first.active };
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
    "initiator signing public key",
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
      "the enrollment handoff is bound to a different identity",
      {},
      "enrollment_binding_mismatch",
    );
  const transcriptHash = await sha384(transcriptBytes);
  if (sha384ToHex(transcriptHash) !== artifact.transcriptHash.toLowerCase())
    throw new CliError(
      "crypto",
      "the enrollment handoff transcript hash is invalid",
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
      certificateBytes: fromBase64(artifact.certificate, "Device certificate"),
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
  }>
> => {
  const authorized = await loadAuthorizedDevice(options);
  if (!authorized.keys.signingPublicKey)
    throw new CliError(
      "crypto",
      "the active Device has no signing public key",
      {},
      "device_bundle_invalid",
    );
  const expiresAtMs = Date.now() + 10 * 60 * 1000;
  const request = await createDeviceEnrollmentRequest({
    serverProfileId: options.profile.pin.serverProfileId,
    origin: options.profile.origin,
    userId: authorized.userId,
    identityGeneration: authorized.bundle.userIdentityGeneration,
    initiatorDeviceId: authorized.deviceId,
    initiatorSigningPrivateKey: authorized.keys.signingPrivateKey,
    initiatorSigningPublicKey: await exportSigningPublicKey(
      authorized.keys.signingPublicKey,
    ),
    expiresAtMs,
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
  const storage = resolveDeviceStorage(options);
  await storage.save(request.bundle);
  const response = await authorized.admin.post(
    "/api/v1/devices/enrollments",
    {
      operationId,
      enrollmentId: request.ids.enrollmentId,
      userId: authorized.userId,
      transcriptHash: sha384ToHex(request.transcriptHash),
      challengeHash: sha384ToHex(await sha384(request.challenge)),
      expiresAt: artifact.expiresAt,
    },
    ["enrollmentId", "expiresAt", "idempotent"],
    { idempotencyKey: operationId },
  );
  if (
    response.enrollmentId !== undefined &&
    requiredString(response.enrollmentId, "enrollment id") !==
      request.ids.enrollmentId
  )
    throw new CliError(
      "crypto",
      "the Server Profile returned the wrong enrollment id",
      {},
      "response_invalid",
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
  };
};

export const approveDeviceEnrollment = async (
  options: WorkflowOptions,
  path: string,
): Promise<
  Readonly<{ enrollmentId: string; deviceId: string; approved: boolean }>
> => {
  const artifact = await readEnrollmentArtifact(path);
  if (
    artifact.serverProfileId.toLowerCase() !==
    options.profile.pin.serverProfileId
  )
    throw new CliError(
      "authentication",
      "the enrollment handoff belongs to another Server Profile",
      {},
      "profile_mismatch",
    );
  const authorized = await loadAuthorizedDevice(options);
  if (artifact.userId.toLowerCase() !== authorized.userId.toLowerCase())
    throw new CliError(
      "authentication",
      "the enrollment handoff belongs to another User",
      {},
      "user_mismatch",
    );
  const parsed = await requestForApproval(artifact).catch((error) => {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "crypto",
      "the enrollment handoff could not be verified",
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
    },
    ["approved", "idempotent"],
    { idempotencyKey: operationId },
  );
  return {
    enrollmentId: artifact.enrollmentId,
    deviceId: artifact.deviceId,
    approved: true,
  };
};

export const completeDeviceEnrollment = async (
  options: WorkflowOptions,
  path: string,
): Promise<
  Readonly<{ enrollmentId: string; deviceId: string; active: boolean }>
> => {
  const artifact = await readEnrollmentArtifact(path);
  if (
    artifact.serverProfileId.toLowerCase() !==
    options.profile.pin.serverProfileId
  )
    throw new CliError(
      "authentication",
      "the enrollment handoff belongs to another Server Profile",
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
      "this Device cannot complete the enrollment handoff",
      {},
      "device_mismatch",
    );
  const transcript = await parseDeviceEnrollmentTranscript(
    fromBase64(artifact.transcript, "enrollment transcript"),
    fromBase64(
      artifact.initiatorSigningPublicKey,
      "initiator signing public key",
    ),
  );
  if (
    transcript.enrollmentId !== artifact.enrollmentId.toLowerCase() ||
    transcript.deviceId !== artifact.deviceId.toLowerCase()
  )
    throw new CliError(
      "crypto",
      "the enrollment handoff is invalid",
      {},
      "enrollment_binding_mismatch",
    );
  const certificateBytes = fromBase64(
    artifact.certificate,
    "Device certificate",
  );
  const certificate = parseProtocolObject(certificateBytes);
  if (
    certificate.get(1) !== 2 ||
    certificate.get(28) !== artifact.identityGeneration
  )
    throw new CliError(
      "crypto",
      "the enrollment certificate is invalid",
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
      "the pending Device bundle has no public key material",
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
      "the enrollment certificate does not match the pending Device",
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
      "the enrollment certificate signature is invalid",
      {},
      "enrollment_certificate_invalid",
    );
  }
  const operationId = crypto.randomUUID();
  await authorized.admin.post(
    `/api/v1/devices/enrollments/${encodeURIComponent(artifact.enrollmentId)}/complete`,
    {
      operationId,
      enrollmentObjectId: artifact.enrollmentObjectId,
      enrollmentObject: base64(
        fromBase64(artifact.transcript, "enrollment transcript"),
      ),
      certificateObjectId: artifact.certificateObjectId,
      certificateObject: base64(certificateBytes),
      deviceId: artifact.deviceId,
      identityGeneration: String(artifact.identityGeneration),
      x25519PublicKey: base64(x25519PublicKey),
      ed25519PublicKey: base64(ed25519PublicKey),
      keyId: base64(await sha384(x25519PublicKey)),
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
