import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCliDeviceStorage,
  createDeviceBootstrap,
} from "@dotrelay/client";
import {
  bytesToUuid,
  createCapabilitiesDocument,
  createProblem,
  encodeSyncPage,
  parseProtocolObject,
  type ServerProfilePin,
  type SyncPageWire,
  sha384,
  sha384ToHex,
} from "@dotrelay/contracts";
import { createSessionStore } from "../apps/cli/src/auth";
import { createNativeCredentialStore } from "../apps/cli/src/credentials";
import {
  createFileDeviceRecordStore,
  deviceMetadataPath,
  writeDeviceId,
} from "../apps/cli/src/device-storage";

const root = join(import.meta.dir, "..");
const binary = join(
  root,
  "apps",
  "cli",
  "dist",
  process.platform === "win32" ? "dotrelay.exe" : "dotrelay",
);
const serverProfileId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const otherUserId = "00000000-0000-4000-8000-000000000004";
const teamId = "00000000-0000-4000-8000-000000000005";
const projectId = "00000000-0000-4000-8000-000000000006";
const environmentId = "00000000-0000-4000-8000-000000000007";
const token = `live-cli-${crypto.randomUUID()}`;

type FixtureState = {
  active: boolean;
  grantsReady: boolean;
  deviceId?: string;
  encryptionPublicKey?: string;
  signingPublicKey?: string;
  enrollmentId?: string;
  pendingDeviceId?: string;
  enrollmentApproved: boolean;
  recoveryEnvelope: boolean;
  bootstrapCount: number;
  enrollmentCount: number;
  recoveryCount: number;
  revisions: SyncPageWire["revisions"];
  stagedObjects: Map<string, Uint8Array>;
  omitUserDefinedValue: boolean;
  discloseAsOtherUser: boolean;
  forcedProblem?: Parameters<typeof createProblem>[0];
  requests: string[];
};

type CliRunResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

const state: FixtureState = {
  active: false,
  grantsReady: false,
  enrollmentApproved: false,
  recoveryEnvelope: false,
  bootstrapCount: 0,
  enrollmentCount: 0,
  recoveryCount: 0,
  revisions: [],
  stagedObjects: new Map(),
  omitUserDefinedValue: false,
  discloseAsOtherUser: false,
  requests: [],
};

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });

const problemResponse = (
  code: Parameters<typeof createProblem>[0],
): Response => {
  const problem = createProblem(code);
  return jsonResponse(problem, problem.status);
};

const authenticated = (request: Request): boolean =>
  request.headers.get("Authorization") === `Bearer ${token}`;

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("request body is not an object");
  return value as Record<string, unknown>;
};

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" &&
  value.length === length &&
  /^[0-9a-f]+$/i.test(value);

const boundary = () => ({
  environment: {
    headRevision: state.revisions.at(-1)?.id ?? "empty-environment",
    id: environmentId,
    projectId,
    teamId,
    headHash: state.revisions.at(-1)
      ? sha384ToHex(state.revisions.at(-1)?.digest ?? new Uint8Array(48))
      : null,
    projectEpoch: "1",
  },
  session: {
    active: true,
    userId: state.discloseAsOtherUser ? otherUserId : userId,
  },
  profile: {
    name: "Live CLI fixture",
    origin: "fixture",
    pinned: true,
    serverProfileId,
  },
  device: {
    active: state.active,
    label: state.active ? "Active Device" : "No active Device",
    ...(state.deviceId
      ? {
          id: state.deviceId,
          encryptionPublicKey: state.encryptionPublicKey,
          signingPublicKey: state.signingPublicKey,
        }
      : {}),
  },
  grantsReady: state.grantsReady,
  epochCurrent: true,
  rotationRequired: false,
  crypto: { available: true },
});

const activeDevice = (request: Request): boolean =>
  state.active &&
  request.headers.get("X-DotRelay-Device-Id") === state.deviceId;

const syncPage = (trustedRevisionId: string): SyncPageWire => {
  const previous = state.revisions.at(-1);
  return Object.freeze({
    environmentId,
    trustedRevisionId,
    trustedRevisionHash: new Uint8Array(48),
    currentHeadId: previous?.id ?? null,
    currentHeadHash: previous?.digest ?? null,
    projectEpoch: 1n,
    revisions: Object.freeze(
      state.revisions.map((revision) => {
        const objects = state.omitUserDefinedValue
          ? revision.objects.filter((object) => {
              const parsed = parseProtocolObject(object.canonicalBytes);
              return !(parsed.get(1) === 13 && parsed.get(36) === 4);
            })
          : revision.objects;
        return Object.freeze({ ...revision, objects });
      }),
    ),
    nextCursor: null,
  });
};

const readBytes = async (request: Request): Promise<Uint8Array> =>
  new Uint8Array(await request.arrayBuffer());

const stagedRevision = async (
  body: Record<string, unknown>,
): Promise<SyncPageWire["revisions"][number]> => {
  const revisionBody = body.revision as Record<string, unknown>;
  const revisionObjectId = revisionBody.protocolObjectId;
  if (typeof revisionObjectId !== "string")
    throw new Error("revision object id missing");
  const revisionBytes = state.stagedObjects.get(revisionObjectId);
  if (!revisionBytes) throw new Error("revision object was not staged");
  const parsedRevision = parseProtocolObject(revisionBytes);
  const revisionId = parsedRevision.get(16);
  const mutation = parsedRevision.get(35);
  const authoredAtMs = parsedRevision.get(34);
  if (!(revisionId instanceof Uint8Array) || typeof mutation !== "number")
    throw new Error("staged revision is malformed");
  const previous = state.revisions.at(-1);
  const objects = await Promise.all(
    [...state.stagedObjects.entries()].map(async ([objectId, bytes]) =>
      Object.freeze({
        objectId,
        canonicalBytes: bytes,
        digest: await sha384(bytes),
      }),
    ),
  );
  const digest = await sha384(revisionBytes);
  return Object.freeze({
    id: bytesToUuid(revisionId),
    digest,
    parentId: previous?.id ?? null,
    parentHash: previous?.digest ?? null,
    mutation,
    projectEpoch: 1n,
    authoredAtMs:
      typeof authoredAtMs === "bigint"
        ? authoredAtMs
        : BigInt(typeof authoredAtMs === "number" ? authoredAtMs : 0),
    rollbackTargetId:
      typeof revisionBody.rollbackTargetId === "string"
        ? revisionBody.rollbackTargetId
        : null,
    objects: Object.freeze(objects),
  });
};

const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  state.requests.push(`${request.method} ${url.pathname}`);
  if (url.pathname === "/health") return jsonResponse({ ok: true });
  if (url.pathname === "/api/v1/capabilities" && request.method === "GET")
    return jsonResponse(
      createCapabilitiesDocument({
        serverProfileId,
        origin: url.origin,
      }),
    );
  if (!authenticated(request))
    return problemResponse("authentication_required");
  if (url.pathname === "/api/v1/session" && request.method === "GET")
    return jsonResponse({
      authenticated: true,
      user: { id: userId, name: "CI" },
    });
  if (url.pathname === "/api/v1/workspace/boundary" && request.method === "GET")
    return jsonResponse(boundary());
  if (
    url.pathname === "/api/v1/grants/bootstrap" &&
    request.method === "POST"
  ) {
    if (!activeDevice(request)) return problemResponse("forbidden");
    state.grantsReady = true;
    return jsonResponse({ active: true, idempotent: false }, 201);
  }
  if (
    url.pathname === `/api/v1/environments/${environmentId}/sync` &&
    request.method === "POST"
  ) {
    if (!activeDevice(request)) return problemResponse("device_not_active");
    const body = (await request.json()) as unknown;
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).trustedRevisionId !== "string"
    )
      return problemResponse("invalid_request");
    return new Response(
      encodeSyncPage(
        syncPage((body as Record<string, unknown>).trustedRevisionId as string),
      ),
      {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/vnd.dotrelay.e2ee-v3+cbor",
        },
      },
    );
  }
  const beginMatch = /^\/api\/v1\/operations\/([^/]+)\/begin$/u.exec(
    url.pathname,
  );
  if (beginMatch && request.method === "POST") {
    if (!activeDevice(request)) return problemResponse("device_not_active");
    const operationId = beginMatch[1];
    if (!operationId) return problemResponse("invalid_request");
    return jsonResponse(
      {
        operationId,
        status: "STAGED",
        idempotent: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      201,
    );
  }
  const stagingMatch =
    /^\/api\/v1\/operations\/([^/]+)\/staging\/([^/]+)$/u.exec(url.pathname);
  if (stagingMatch && request.method === "PUT") {
    if (!activeDevice(request)) return problemResponse("device_not_active");
    const objectId = stagingMatch[2];
    if (!objectId) return problemResponse("invalid_request");
    state.stagedObjects.set(objectId, await readBytes(request));
    return jsonResponse({ staged: true }, 201);
  }
  const cancelMatch = /^\/api\/v1\/operations\/([^/]+)$/u.exec(url.pathname);
  if (cancelMatch && request.method === "DELETE") {
    state.stagedObjects.clear();
    return jsonResponse({ cancelled: true });
  }
  const finalizeMatch = /^\/api\/v1\/operations\/([^/]+)\/finalize$/u.exec(
    url.pathname,
  );
  if (finalizeMatch && request.method === "POST") {
    if (!activeDevice(request)) return problemResponse("device_not_active");
    if (state.forcedProblem) return problemResponse(state.forcedProblem);
    const body = await readJson(request);
    const expectedHeadId = body.expectedHeadId;
    if (
      (state.revisions.length === 0 && expectedHeadId !== null) ||
      (state.revisions.length > 0 &&
        expectedHeadId !== state.revisions.at(-1)?.id)
    )
      return problemResponse("stale_head");
    const revision = await stagedRevision(body);
    state.revisions = Object.freeze([...state.revisions, revision]);
    state.stagedObjects.clear();
    return jsonResponse({ revisionId: revision.id, idempotent: false }, 201);
  }
  if (
    url.pathname === "/api/v1/devices/bootstrap" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (
      !uuid(body.deviceId) ||
      !hex(body.x25519PublicKey, 64) ||
      !hex(body.ed25519PublicKey, 64) ||
      !hex(body.keyId, 96) ||
      typeof body.certificate !== "string" ||
      body.certificate.length === 0
    )
      return problemResponse("invalid_request");
    state.active = true;
    state.deviceId = body.deviceId;
    state.encryptionPublicKey = body.x25519PublicKey;
    state.signingPublicKey = body.ed25519PublicKey;
    state.bootstrapCount += 1;
    return jsonResponse(
      {
        deviceId: body.deviceId,
        identityGeneration: 1,
        active: true,
      },
      201,
    );
  }
  if (
    url.pathname === "/api/v1/recovery/envelopes/current" &&
    request.method === "GET"
  )
    return state.recoveryEnvelope
      ? jsonResponse({
          envelopeId: "00000000-0000-4000-8000-000000000003",
          identityGeneration: "1",
          recoveryGeneration: "1",
          ciphertextHash: "0".repeat(96),
          ciphertextLength: 0,
          object: "fixture",
        })
      : problemResponse("resource_not_found");
  if (
    url.pathname === "/api/v1/recovery/envelopes" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (request.headers.get("X-DotRelay-Device-Id") !== state.deviceId)
      return problemResponse("forbidden");
    if (!uuid(body.envelopeId) || typeof body.object !== "string")
      return problemResponse("invalid_request");
    state.recoveryEnvelope = true;
    return jsonResponse({
      envelopeId: body.envelopeId,
      recoveryGeneration: body.recoveryGeneration,
      idempotent: false,
    });
  }
  if (
    url.pathname === "/api/v1/devices/enrollments" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (
      request.headers.get("X-DotRelay-Device-Id") !== state.deviceId ||
      !uuid(body.enrollmentId) ||
      typeof body.transcriptHash !== "string" ||
      typeof body.challengeHash !== "string" ||
      typeof body.expiresAt !== "string"
    )
      return problemResponse("invalid_request");
    state.enrollmentId = body.enrollmentId;
    state.enrollmentCount += 1;
    return jsonResponse({
      enrollmentId: body.enrollmentId,
      expiresAt: body.expiresAt,
      idempotent: false,
    });
  }
  const enrollmentPath =
    /^\/api\/v1\/devices\/enrollments\/([^/]+)\/(approve|complete)$/u;
  const enrollmentMatch = enrollmentPath.exec(url.pathname);
  if (
    enrollmentMatch &&
    enrollmentMatch[2] === "approve" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (
      request.headers.get("X-DotRelay-Device-Id") !== state.deviceId ||
      typeof body.object !== "string" ||
      !uuid(body.enrolledDeviceId) ||
      enrollmentMatch[1] !== state.enrollmentId
    )
      return problemResponse("invalid_request");
    state.pendingDeviceId = body.enrolledDeviceId;
    state.enrollmentApproved = true;
    return jsonResponse({ approved: true, idempotent: false });
  }
  if (
    enrollmentMatch &&
    enrollmentMatch[2] === "complete" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (
      request.headers.get("X-DotRelay-Device-Id") !== state.deviceId ||
      !state.enrollmentApproved ||
      body.deviceId !== state.pendingDeviceId ||
      typeof body.certificateObject !== "string" ||
      typeof body.enrollmentObject !== "string" ||
      enrollmentMatch[1] !== state.enrollmentId
    )
      return problemResponse("invalid_request");
    state.active = true;
    state.deviceId = body.deviceId as string;
    delete state.enrollmentId;
    delete state.pendingDeviceId;
    state.enrollmentApproved = false;
    return jsonResponse(
      {
        deviceId: body.deviceId,
        active: true,
        idempotent: false,
      },
      201,
    );
  }
  if (
    url.pathname === "/api/v1/recovery/restore" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (
      !uuid(body.deviceId) ||
      typeof body.proof !== "string" ||
      typeof body.certificate !== "string" ||
      typeof body.keyId !== "string" ||
      body.keyId.length === 0
    )
      return problemResponse("invalid_request");
    state.active = true;
    state.deviceId = body.deviceId;
    state.encryptionPublicKey = body.replacementEncryptionPublicKey as string;
    state.signingPublicKey = body.replacementSigningPublicKey as string;
    state.recoveryCount += 1;
    return jsonResponse(
      {
        deviceId: body.deviceId,
        active: true,
        recoveryGeneration: body.recoveryGeneration,
        idempotent: false,
      },
      201,
    );
  }
  return problemResponse("resource_not_found");
};

const runBinary = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CliRunResult> => {
  const child = Bun.spawn([binary, ...args], {
    cwd: root,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const runTerminal = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input = "",
): Promise<CliRunResult> => {
  if (process.platform === "win32")
    throw new Error("TTY packaged checks require a POSIX runner");
  const command = [binary, ...args].map(shellQuote).join(" ");
  const commandWithInput =
    input.length > 0 ? `printf %s ${shellQuote(input)} | ${command}` : command;
  const scriptArgs =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "sh", "-c", commandWithInput]
      : ["-q", "-e", "-c", commandWithInput, "/dev/null"];
  const child = Bun.spawn(["script", ...scriptArgs], {
    cwd: root,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const runJson = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> => {
  const result = await runBinary(args, environment);
  if (result.exitCode !== 0)
    throw new Error(
      `packaged CLI live command ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr.replaceAll(token, "[redacted]").trim()}; requests=${state.requests.join(",")}`,
    );
  const value: unknown = JSON.parse(result.stdout);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("packaged CLI live command returned invalid JSON");
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`packaged CLI live response omitted ${label}`);
  return value;
};

const uuidBytes = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value.replaceAll("-", ""), "hex"));

await access(binary, process.platform === "win32" ? undefined : constants.X_OK);
const server = Bun.serve({ port: 0, fetch: handle });
const origin = `http://127.0.0.1:${server.port}`;
const pin: ServerProfilePin = Object.freeze({ origin, serverProfileId });
const credentials = createNativeCredentialStore();
const sessions = createSessionStore(credentials);
const isolatedDirectory = await mkdtemp(join(tmpdir(), "dotrelay-cli-live-"));
const environment = {
  ...process.env,
  DOTRELAY_CONFIG_DIR: isolatedDirectory,
};
const deviceStorage = createCliDeviceStorage(pin, credentials, {
  recordStore: createFileDeviceRecordStore(isolatedDirectory),
});
let initialDeviceId: string | undefined;
let approverDeviceId: string | undefined;
let enrolledDeviceId: string | undefined;
let recoveredDeviceId: string | undefined;
let sessionSaved = false;
try {
  await sessions.save(pin, token);
  sessionSaved = true;
  await runJson(
    [
      "profile",
      "add",
      "live",
      origin,
      "--accept-profile",
      serverProfileId,
      "--no-input",
      "--json",
    ],
    environment,
  );
  await runJson(["profile", "use", "live", "--json"], environment);
  const enrolled = await runJson(
    ["device", "enroll", "--profile", "live", "--no-input", "--json"],
    environment,
  );
  initialDeviceId = requireString(enrolled.deviceId, "initial Device id");
  if (enrolled.active !== true || state.bootstrapCount !== 1)
    throw new Error("packaged CLI Device bootstrap contract failed");
  const dotenvPath = join(isolatedDirectory, "source.env");
  await Bun.write(dotenvPath, "SHARED_VALUE=one\nUSER_VALUE=secret\nEMPTY=\n");
  const initialized = await runJson(
    [
      "init",
      environmentId,
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--from",
      dotenvPath,
      "--classify",
      "SHARED_VALUE=shared",
      "--classify",
      "USER_VALUE=user-defined",
      "--classify",
      "EMPTY=shared",
      "--no-input",
      "--json",
    ],
    environment,
  );
  const initialRevisionId = requireString(
    initialized.revision,
    "genesis Revision id",
  );
  const initialRevision = state.revisions.find(
    (revision) => revision.id === initialRevisionId,
  );
  const initialRevisionObject = initialRevision?.objects.find((object) =>
    object.digest.every(
      (byte, index) => byte === (initialRevision?.digest[index] ?? -1),
    ),
  );
  const initialVariableId = initialRevisionObject
    ? parseProtocolObject(initialRevisionObject.canonicalBytes).get(54)
    : undefined;
  if (
    !(
      Array.isArray(initialVariableId) &&
      initialVariableId[0] instanceof Uint8Array
    )
  )
    throw new Error("packaged CLI genesis did not expose changed Variables");
  const sharedVariableId = bytesToUuid(initialVariableId[0]);
  await Bun.write(dotenvPath, "SHARED_VALUE=two\nUSER_VALUE=secret\nEMPTY=\n");
  const pushed = await runJson(
    [
      "push",
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--from",
      dotenvPath,
      "--classify",
      "SHARED_VALUE=shared",
      "--classify",
      "USER_VALUE=user-defined",
      "--classify",
      "EMPTY=shared",
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (!requireString(pushed.revision, "published Revision id"))
    throw new Error("packaged CLI push contract failed");
  const outputPath = join(isolatedDirectory, "export.env");
  await runJson(
    [
      "pull",
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--output",
      outputPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  const output = await readFile(outputPath, "utf8");
  const outputMode = (await stat(outputPath)).mode & 0o777;
  if (
    output !== 'SHARED_VALUE="two"\nUSER_VALUE="secret"\nEMPTY=""\n' ||
    outputMode !== 0o600
  )
    throw new Error("packaged CLI safe pull contract failed");
  if (process.platform !== "win32") {
    const terminal = await runTerminal(
      [
        "pull",
        "--profile",
        "live",
        "--environment",
        environmentId,
        "--stdout",
        "--no-input",
        "--json",
      ],
      environment,
    );
    if (
      terminal.exitCode !== 2 ||
      !(terminal.stdout + terminal.stderr).includes(
        "refusing to write Values to terminal stdout",
      ) ||
      (terminal.stdout + terminal.stderr).includes("secret")
    )
      throw new Error("packaged CLI TTY stdout safety contract failed");
  }
  if (process.platform !== "win32") {
    const revealed = await runTerminal(
      [
        "pull",
        "--profile",
        "live",
        "--environment",
        environmentId,
        "--stdout",
        "--reveal",
        "--json",
      ],
      environment,
      "y\n",
    );
    if (
      revealed.exitCode !== 0 ||
      !revealed.stdout.includes('USER_VALUE="secret"') ||
      revealed.stderr.includes("secret")
    )
      throw new Error("packaged CLI explicit-reveal contract failed");
  }
  const preservedPath = join(isolatedDirectory, "preserved.env");
  await mkdir(preservedPath);
  const failedOutput = await runBinary(
    [
      "pull",
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--output",
      preservedPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (failedOutput.exitCode !== 8 || !(await stat(preservedPath)).isDirectory())
    throw new Error("packaged CLI atomic-output preservation contract failed");
  const missingClassification = await runBinary(
    [
      "push",
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--from",
      dotenvPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (
    missingClassification.exitCode !== 2 ||
    !missingClassification.stderr.includes("requires interactive input") ||
    missingClassification.stderr.includes("secret")
  )
    throw new Error("packaged CLI classification-prompt contract failed");
  for (const forbidden of [
    "--insecure",
    "--token=secret",
    "--access-token=secret",
    "--device-key=secret",
    "--credentials=secret",
  ]) {
    const rejected = await runBinary(["--help", forbidden], environment);
    if (rejected.exitCode !== 2 || rejected.stderr.includes("secret"))
      throw new Error("packaged CLI credential-mode rejection contract failed");
  }
  const history = await runJson(
    [
      "history",
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (!Array.isArray(history.revisions) || history.revisions.length !== 2)
    throw new Error("packaged CLI history contract failed");
  state.omitUserDefinedValue = true;
  state.discloseAsOtherUser = true;
  const missing = await runBinary(
    [
      "pull",
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--output",
      join(isolatedDirectory, "missing.env"),
      "--no-input",
      "--json",
    ],
    environment,
  );
  state.omitUserDefinedValue = false;
  state.discloseAsOtherUser = false;
  if (
    missing.exitCode !== 3 ||
    !missing.stderr.includes('"code":"missing_values"') ||
    missing.stdout.includes("secret") ||
    missing.stderr.includes("secret")
  )
    throw new Error("packaged CLI missing-value safety contract failed");
  await access(join(isolatedDirectory, "missing.env"), constants.F_OK)
    .then(() => {
      throw new Error("missing-value export created an output file");
    })
    .catch((error) => {
      if (error instanceof Error && error.message.includes("created"))
        throw error;
    });
  const rollback = await runJson(
    [
      "rollback",
      initialRevisionId,
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--variable",
      sharedVariableId,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (!requireString(rollback.revision, "Rollback Revision id"))
    throw new Error("packaged CLI rollback contract failed");
  const rolledBack = await runBinary(
    [
      "pull",
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--stdout",
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (
    rolledBack.exitCode !== 0 ||
    !rolledBack.stdout.includes('SHARED_VALUE="one"') ||
    !rolledBack.stdout.includes('USER_VALUE="secret"') ||
    rolledBack.stderr.includes("secret")
  )
    throw new Error("packaged CLI lane rollback contract failed");
  await Bun.write(
    dotenvPath,
    'SHARED_VALUE="two"\nUSER_VALUE=secret\nEMPTY=\n',
  );
  state.forcedProblem = "stale_head";
  const conflict = await runBinary(
    [
      "push",
      "--profile",
      "live",
      "--environment",
      environmentId,
      "--from",
      dotenvPath,
      "--classify",
      "SHARED_VALUE=shared",
      "--classify",
      "USER_VALUE=user-defined",
      "--classify",
      "EMPTY=shared",
      "--no-input",
      "--json",
    ],
    environment,
  );
  delete state.forcedProblem;
  if (
    conflict.exitCode !== 4 ||
    !conflict.stderr.includes('"code":"stale_head"') ||
    conflict.stderr.includes("secret")
  )
    throw new Error("packaged CLI conflict-category contract failed");
  const approver = await createDeviceBootstrap({ pin, userId });
  await deviceStorage.save(approver.bundle);
  approverDeviceId = approver.deviceId;
  if (!initialDeviceId || !approverDeviceId)
    throw new Error("packaged CLI Device fixture setup failed");

  const enrollmentPath = join(isolatedDirectory, "enrollment.json");
  const begun = await runJson(
    [
      "device",
      "begin",
      "--profile",
      "live",
      "--output",
      enrollmentPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (
    requireString(begun.request, "enrollment handoff path") !==
      enrollmentPath ||
    state.enrollmentCount !== 1
  )
    throw new Error("packaged CLI enrollment begin contract failed");
  state.deviceId = approverDeviceId;
  await writeDeviceId(
    deviceMetadataPath(isolatedDirectory, pin),
    pin,
    approverDeviceId,
  );
  const approved = await runJson(
    [
      "device",
      "approve",
      "--profile",
      "live",
      "--from",
      enrollmentPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (approved.approved !== true || !state.enrollmentApproved)
    throw new Error("packaged CLI enrollment approval contract failed");
  state.deviceId = initialDeviceId;
  await writeDeviceId(
    deviceMetadataPath(isolatedDirectory, pin),
    pin,
    initialDeviceId,
  );
  const completed = await runJson(
    [
      "device",
      "complete",
      "--profile",
      "live",
      "--from",
      enrollmentPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  enrolledDeviceId = requireString(completed.deviceId, "enrolled Device id");
  if (!completed.active || enrolledDeviceId === initialDeviceId)
    throw new Error("packaged CLI enrollment completion contract failed");

  const recoveryPath = join(isolatedDirectory, "recovery.kit");
  const backup = await runJson(
    [
      "device",
      "backup",
      "--profile",
      "live",
      "--output",
      recoveryPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (
    requireString(backup.output, "Recovery Kit path") !== recoveryPath ||
    !state.recoveryEnvelope
  )
    throw new Error("packaged CLI Recovery Kit backup contract failed");
  const artifact = JSON.parse(await readFile(recoveryPath, "utf8")) as {
    readonly kind?: unknown;
    readonly kit?: unknown;
  };
  if (
    artifact.kind !== "dotrelay-recovery-kit" ||
    typeof artifact.kit !== "string"
  )
    throw new Error("packaged CLI Recovery Kit artifact contract failed");

  const invalidRecoveryPath = join(isolatedDirectory, "invalid-recovery.kit");
  await Bun.write(
    invalidRecoveryPath,
    JSON.stringify({ kind: "portable-plaintext", value: "secret" }),
  );
  const invalidRecovery = await runBinary(
    [
      "device",
      "recover",
      "--profile",
      "live",
      "--from",
      invalidRecoveryPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (
    invalidRecovery.exitCode !== 5 ||
    !invalidRecovery.stderr.includes('"code":"recovery_kit_invalid"') ||
    invalidRecovery.stderr.includes("secret")
  )
    throw new Error("packaged CLI portable-artifact rejection contract failed");

  state.active = false;
  const recovered = await runJson(
    [
      "device",
      "recover",
      "--profile",
      "live",
      "--from",
      recoveryPath,
      "--no-input",
      "--json",
    ],
    environment,
  );
  recoveredDeviceId = requireString(recovered.deviceId, "recovered Device id");
  if (
    recovered.active !== true ||
    recoveredDeviceId === initialDeviceId ||
    state.recoveryCount !== 1 ||
    !state.active
  )
    throw new Error("packaged CLI Recovery Kit restore contract failed");
  await deviceStorage.load({
    pin,
    deviceId: uuidBytes(recoveredDeviceId),
  });
  const requiredRequests = [
    "GET /api/v1/capabilities",
    "POST /api/v1/devices/bootstrap",
    `POST /api/v1/environments/${environmentId}/sync`,
    "POST /api/v1/operations/",
    "POST /api/v1/devices/enrollments",
    "POST /api/v1/recovery/envelopes",
    "POST /api/v1/recovery/restore",
  ];
  if (
    requiredRequests.some(
      (required) =>
        !state.requests.some((request) => request.startsWith(required)),
    )
  )
    throw new Error("packaged CLI live-service request coverage is incomplete");
  console.log(
    "✓ packaged CLI live-service workflow and safety round trip passed",
  );
} finally {
  if (initialDeviceId)
    await deviceStorage
      .remove({
        pin,
        deviceId: uuidBytes(initialDeviceId),
      })
      .catch(() => undefined);
  if (enrolledDeviceId)
    await deviceStorage
      .remove({
        pin,
        deviceId: uuidBytes(enrolledDeviceId),
      })
      .catch(() => undefined);
  if (approverDeviceId)
    await deviceStorage
      .remove({
        pin,
        deviceId: uuidBytes(approverDeviceId),
      })
      .catch(() => undefined);
  if (recoveredDeviceId)
    await deviceStorage
      .remove({
        pin,
        deviceId: uuidBytes(recoveredDeviceId),
      })
      .catch(() => undefined);
  if (sessionSaved) await sessions.remove(pin).catch(() => undefined);
  server.stop(true);
  await rm(isolatedDirectory, { recursive: true, force: true });
}
