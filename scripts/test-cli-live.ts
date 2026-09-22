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
  generateAccountMasterKey,
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
import { createFileCredentialStore } from "../apps/cli/src/credentials";
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
  recoveryWrapper?: {
    readonly wrapperId: string;
    readonly object: string;
  };
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

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const decodeBase64 = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

// A public key a client registers with the Server Profile, in the hex format
// the boundary reports it in.
const registeredKey = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const bytes = decodeBase64(value);
  return bytes.length === 32 ? toHex(bytes) : null;
};

// The Server Profile resolves one Device at a time. The boundary reports that
// Device's id alongside the public keys registered for it.
const resolveDevice = (
  deviceId: string,
  encryptionPublicKey: string,
  signingPublicKey: string,
) => {
  state.deviceId = deviceId;
  state.encryptionPublicKey = encryptionPublicKey;
  state.signingPublicKey = signingPublicKey;
};

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
  // Like the real Server Profile, the boundary names the Device's id and
  // registered public keys only while that Device is active.
  device: {
    active: state.active,
    label: state.active ? "Active Device" : "No active Device",
    ...(state.active && state.deviceId
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
  catalog: { teams: [], projects: [] },
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
    url.pathname === "/api/v1/github-repositories/resolve" &&
    request.method === "GET"
  ) {
    const owner = url.searchParams.get("owner");
    const name = url.searchParams.get("name");
    if (url.searchParams.get("host") !== "github.com" || !owner || !name)
      return problemResponse("invalid_request");
    return jsonResponse({
      host: "github.com",
      owner,
      name,
      githubRepositoryId: "1311418611",
    });
  }
  if (url.pathname === "/api/v1/projects" && request.method === "GET") {
    const githubRepositoryId = url.searchParams.get("githubRepositoryId");
    if (!githubRepositoryId) return problemResponse("invalid_request");
    return jsonResponse({
      project: {
        id: projectId,
        teamId,
        githubRepositoryId,
        lifecycle: "active",
      },
    });
  }
  if (
    url.pathname === `/api/v1/projects/${projectId}/environments` &&
    request.method === "GET"
  )
    return jsonResponse({
      environments: [
        {
          id: environmentId,
          projectId,
          label: "live",
          lifecycle: "active",
          currentHeadId: state.revisions.at(-1)?.id ?? null,
        },
      ],
    });
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
    const previous = state.revisions.at(-1);
    if (revision.mutation === 1 && previous)
      return problemResponse("genesis_exists");
    if (revision.mutation !== 1 && !previous)
      return problemResponse("invalid_request");
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
    resolveDevice(body.deviceId, body.x25519PublicKey, body.ed25519PublicKey);
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
    url.pathname === "/api/v1/account-keys/wrappers" &&
    request.method === "GET"
  )
    return state.recoveryWrapper
      ? jsonResponse({
          wrappers: [
            {
              wrapperId: state.recoveryWrapper.wrapperId,
              type: "recovery-code",
              object: state.recoveryWrapper.object,
            },
          ],
        })
      : jsonResponse({ wrappers: [] });
  if (
    url.pathname === "/api/v1/account-keys/wrappers" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (request.headers.get("X-DotRelay-Device-Id") !== state.deviceId)
      return problemResponse("forbidden");
    if (
      typeof body.object !== "string" ||
      body.object.length === 0 ||
      typeof body.wrapperId !== "string" ||
      body.wrapperId.length === 0
    )
      return problemResponse("invalid_request");
    state.recoveryWrapper = {
      wrapperId: body.wrapperId,
      object: body.object,
    };
    return jsonResponse({ wrapperId: body.wrapperId, idempotent: false }, 201);
  }
  if (
    url.pathname === "/api/v1/account-keys/envelopes" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (request.headers.get("X-DotRelay-Device-Id") !== state.deviceId)
      return problemResponse("forbidden");
    if (
      typeof body.object !== "string" ||
      body.object.length === 0 ||
      typeof body.projectId !== "string" ||
      typeof body.projectEpoch !== "string"
    )
      return problemResponse("invalid_request");
    state.grantsReady = true;
    return jsonResponse({ objectId: body.objectId, idempotent: false }, 201);
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
    const x25519PublicKey = registeredKey(body.x25519PublicKey);
    const ed25519PublicKey = registeredKey(body.ed25519PublicKey);
    if (
      request.headers.get("X-DotRelay-Device-Id") !== state.deviceId ||
      !state.enrollmentApproved ||
      body.deviceId !== state.pendingDeviceId ||
      typeof body.certificateObject !== "string" ||
      typeof body.enrollmentObject !== "string" ||
      enrollmentMatch[1] !== state.enrollmentId ||
      x25519PublicKey === null ||
      ed25519PublicKey === null
    )
      return problemResponse("invalid_request");
    // Completing an enrollment registers the new Device's public keys on the
    // Server Profile, so its boundary must report them from now on.
    state.active = true;
    resolveDevice(body.deviceId as string, x25519PublicKey, ed25519PublicKey);
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
  const transferAccept =
    /^\/api\/v1\/account-keys\/transfers\/([^/]+)\/accept$/u.exec(
      url.pathname,
    );
  if (transferAccept && request.method === "POST") {
    if (!activeDevice(request)) return problemResponse("forbidden");
    state.recoveryCount += 1;
    return problemResponse("state_conflict");
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
const isolatedDirectory = await mkdtemp(join(tmpdir(), "dotrelay-cli-live-"));
// The packaged binary roots its credential store in DOTRELAY_CONFIG_DIR, so
// the harness seeds the same directory to share session and device material.
const credentials = createFileCredentialStore(
  join(isolatedDirectory, "credentials"),
);
const sessions = createSessionStore(credentials);
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
  // Keys the Server Profile registered for the initial Device at bootstrap.
  const initialEncryptionPublicKey = state.encryptionPublicKey;
  const initialSigningPublicKey = state.signingPublicKey;
  if (!initialEncryptionPublicKey || !initialSigningPublicKey)
    throw new Error("packaged CLI bootstrap did not register Device keys");
  try {
    await deviceStorage.load({
      pin,
      deviceId: uuidBytes(initialDeviceId),
    });
  } catch (error) {
    throw new Error(
      `native Device storage round trip failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const dotenvPath = join(isolatedDirectory, "source.env");
  await Bun.write(dotenvPath, "SHARED_VALUE=one\nUSER_VALUE=secret\nEMPTY=\n");
  const initialized = await runJson(
    [
      "init",
      environmentId,
      "--profile",
      "live",
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
    (process.platform !== "win32" && outputMode !== 0o600)
  )
    throw new Error("packaged CLI safe pull contract failed");
  const matchingDiff = await runJson(
    [
      "diff",
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
    !Array.isArray(matchingDiff.added) ||
    matchingDiff.added.length !== 0 ||
    !Array.isArray(matchingDiff.updated) ||
    matchingDiff.updated.length !== 0 ||
    !Array.isArray(matchingDiff.removed) ||
    matchingDiff.removed.length !== 0 ||
    JSON.stringify(matchingDiff).includes("secret")
  )
    throw new Error("packaged CLI matching diff contract failed");
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
      ],
      environment,
    );
    const terminalOutput = terminal.stdout + terminal.stderr;
    if (
      terminal.exitCode !== 2 ||
      !terminalOutput.includes("Refusing to write Values to terminal stdout") ||
      terminalOutput.includes('USER_VALUE="secret"') ||
      terminalOutput.includes('SHARED_VALUE="two"')
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
  await Bun.write(
    dotenvPath,
    "SHARED_VALUE=two\nUSER_VALUE=secret\nEMPTY=\nNEW_VALUE=added\n",
  );
  const driftedDiff = await runJson(
    [
      "diff",
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
    !Array.isArray(driftedDiff.added) ||
    driftedDiff.added.length !== 1 ||
    driftedDiff.added[0] !== "NEW_VALUE" ||
    JSON.stringify(driftedDiff).includes("secret")
  )
    throw new Error("packaged CLI drifted diff contract failed");
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
    !missingClassification.stderr.includes('"code":"invocation"') ||
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
  // Keys the Server Profile registered for the approver Device when that
  // installation enrolled, so the boundary can report them for it.
  const approverEncryptionPublicKey = toHex(approver.x25519PublicKey);
  const approverSigningPublicKey = toHex(approver.ed25519PublicKey);

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
  // The approver's installation is the one approving: the Server Profile
  // resolves the approver Device, with the keys it registered for it.
  resolveDevice(
    approverDeviceId,
    approverEncryptionPublicKey,
    approverSigningPublicKey,
  );
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
  // The initiator's installation completes the handoff: the Server Profile
  // resolves the initial Device again, with the keys it registered for it.
  resolveDevice(
    initialDeviceId,
    initialEncryptionPublicKey,
    initialSigningPublicKey,
  );
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

  // An installation must verify that its saved bundle matches the keys the
  // Server Profile registered for this Device. Corrupt the registration and
  // the CLI must refuse to act on the stale bundle.
  const enrolledEncryptionPublicKey = state.encryptionPublicKey;
  const enrolledSigningPublicKey = state.signingPublicKey;
  if (!enrolledEncryptionPublicKey || !enrolledSigningPublicKey)
    throw new Error(
      "packaged CLI enrollment completion did not register Device keys",
    );
  state.encryptionPublicKey = initialEncryptionPublicKey;
  const mismatchedBackup = await runBinary(
    [
      "device",
      "backup",
      "--profile",
      "live",
      "--no-input",
      "--json",
    ],
    environment,
  );
  state.encryptionPublicKey = enrolledEncryptionPublicKey;
  state.signingPublicKey = enrolledSigningPublicKey;
  // The stale bundle is an integrity failure: it keeps the documented crypto
  // category and exit code 5, so automation can tell it apart from a
  // retryable transient service failure (exit code 7).
  if (
    mismatchedBackup.exitCode !== 5 ||
    !mismatchedBackup.stderr.includes('"category":"crypto"') ||
    !mismatchedBackup.stderr.includes('"code":"device_bundle_invalid"') ||
    !mismatchedBackup.stderr.includes(
      "does not match the keys registered on this Server Profile",
    )
  )
    throw new Error(
      "packaged CLI bundle/registration mismatch contract failed",
    );

  // The Account Master Key is established out of band (the web app or an
  // earlier CLI run); the harness seeds it so the Device is unlocked. This
  // section is self-contained: it resets the Server Profile to the initial
  // Device and the matching keys it registered, so the recovery round trip
  // does not depend on the enrollment handoff's device choreography.
  resolveDevice(
    initialDeviceId,
    initialEncryptionPublicKey,
    initialSigningPublicKey,
  );
  state.active = true;
  state.grantsReady = true;
  await writeDeviceId(
    deviceMetadataPath(isolatedDirectory, pin),
    pin,
    initialDeviceId,
  );
  const accountMasterKey = await generateAccountMasterKey();
  const accountScope = { pin, deviceId: uuidBytes(initialDeviceId) };

  // A Device that is not unlocked cannot create a Recovery Code wrapper.
  const lockedBackup = await runBinary(
    ["device", "backup", "--profile", "live", "--no-input", "--json"],
    environment,
  );
  if (
    lockedBackup.exitCode !== 6 ||
    !lockedBackup.stderr.includes('"category":"authentication"') ||
    !lockedBackup.stderr.includes('"code":"account_key_not_unlocked"')
  )
    throw new Error("packaged CLI locked-device backup contract failed");

  await deviceStorage.saveAccountKey(accountScope, accountMasterKey);
  const backup = await runJson(
    ["device", "backup", "--profile", "live", "--no-input", "--json"],
    environment,
  );
  const recoveryCode = requireString(backup.recoveryCode, "recovery code");
  const backupWrapperId = requireString(backup.wrapperId, "recovery wrapper id");
  if (state.recoveryWrapper?.wrapperId !== backupWrapperId)
    throw new Error("packaged CLI recovery wrapper backup contract failed");

  // A recovery code that is not 13 groups of 4 Crockford characters is
  // rejected before any key material is touched or transmitted.
  const malformedRecovery = await runBinary(
    [
      "device",
      "recover",
      "--profile",
      "live",
      "--recovery-code",
      "!!!not-a-valid-recovery-code!!!",
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (
    malformedRecovery.exitCode !== 2 ||
    !malformedRecovery.stderr.includes('"category":"invocation"') ||
    !malformedRecovery.stderr.includes('"code":"recovery_code_malformed"')
  )
    throw new Error("packaged CLI malformed recovery code contract failed");

  // Losing the Account Master Key is recovered from the Recovery Code: the
  // wrapper is fetched and unwrapped locally, so the code never leaves the
  // machine and the key lands back on this Device.
  await deviceStorage.clearAccountKey(accountScope);
  const recovered = await runJson(
    [
      "device",
      "recover",
      "--profile",
      "live",
      "--recovery-code",
      recoveryCode,
      "--no-input",
      "--json",
    ],
    environment,
  );
  if (
    recovered.via !== "recovery-code" ||
    recovered.deviceId !== initialDeviceId
  )
    throw new Error("packaged CLI recovery-code round trip contract failed");
  const restoredKey = await deviceStorage
    .loadAccountKey(accountScope)
    .catch(() => null);
  if (
    restoredKey === null ||
    restoredKey.length !== accountMasterKey.length ||
    !restoredKey.every((byte, index) => byte === accountMasterKey[index])
  )
    throw new Error("packaged CLI did not restore the Account Master Key");
  const requiredRequests = [
    "GET /api/v1/capabilities",
    "POST /api/v1/devices/bootstrap",
    `POST /api/v1/environments/${environmentId}/sync`,
    "POST /api/v1/operations/",
    "POST /api/v1/devices/enrollments",
    "POST /api/v1/account-keys/wrappers",
    "GET /api/v1/account-keys/wrappers",
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
