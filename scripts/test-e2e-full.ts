// Full-stack end-to-end test: the packaged CLI drives a real API process
// against a fresh PostgreSQL database and a real Valkey, using demo data
// only. Everything is self-hosted by this script: no production or
// development service is contacted, and the API's only outbound dependency
// (delegated GitHub repository resolution) is served by an in-process stub.
//
// Environment:
//   DATABASE_URL      admin connection allowed to CREATE/DROP DATABASE
//   VALKEY_URL        Valkey endpoint used by the API's protocol rate limits
//   DOTRELAY_E2E_CLI  (optional) CLI binary under test; defaults to the
//                     built apps/cli/dist/dotrelay

import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createAuth } from "../apps/api/src/auth";
import {
  createBetterAuthDatabaseAdapter,
  createDatabaseClient,
  ensureServerProfile,
} from "../packages/database/src/index";

const root = join(import.meta.dir, "..");
const binary =
  process.env.DOTRELAY_E2E_CLI ??
  join(
    root,
    "apps",
    "cli",
    "dist",
    process.platform === "win32" ? "dotrelay.exe" : "dotrelay",
  );

const adminDatabaseUrl = process.env.DATABASE_URL;
if (!adminDatabaseUrl)
  throw new Error("DATABASE_URL (an admin connection) is required");
const valkeyUrl = process.env.VALKEY_URL ?? process.env.REDIS_URL;
if (!valkeyUrl)
  throw new Error(
    "VALKEY_URL is required: the full stack test exercises real rate limits",
  );

// A throwaway database this test owns end to end. It is dropped on exit, so
// nothing written here can survive into any other environment.
const testDatabaseName = `dotrelay_e2e_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const testDatabaseUrl = new URL(adminDatabaseUrl);
testDatabaseUrl.pathname = `/${testDatabaseName}`;
const adminUrl = new URL(adminDatabaseUrl);
adminUrl.pathname = "/postgres";

const DEMO_GITHUB = {
  owner: "demo-org",
  name: "demo-service",
  id: 99001122,
  token: "demo-github-token",
  accountId: "demo-github-account",
  subject: "demo-github-100001",
} as const;

// The whole run must finish in bounded time, even if a CLI process hangs
// polling for a device authorization that never completes.
const watchdog = setTimeout(
  () => {
    console.error("✗ full e2e exceeded 15 minutes");
    process.exit(3);
  },
  15 * 60 * 1000,
);
watchdog.unref?.();

const runMigrations = async () => {
  const subprocess = Bun.spawn(
    ["bun", "x", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
    {
      cwd: join(root, "packages", "database"),
      env: { ...process.env, DATABASE_URL: testDatabaseUrl.toString() },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`migration failed: ${stdout}\n${stderr}`);
};

type CliRunResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

const runBinary = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 120_000,
): Promise<CliRunResult> => {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  timeout.unref?.();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut)
      throw new Error(
        `CLI ${args.join(" ")} timed out after ${timeoutMs}ms: ${stderr.trim()}`,
      );
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const runTerminal = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
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
    cwd,
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

const parseJsonLines = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("CLI JSON line is not an object");
      return value as Record<string, unknown>;
    });

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`e2e response omitted ${label}`);
  return value;
};

// Serves the one outbound dependency the API has: resolving a GitHub
// repository identity with the demo user's delegated access. Any other URL
// means the stack reached out beyond this test.
const fakeGitHubFetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = String(input);
  const authorization = new Headers(init?.headers).get("Authorization");
  if (
    url ===
    `https://api.github.com/repos/${DEMO_GITHUB.owner}/${DEMO_GITHUB.name}`
  ) {
    if (authorization !== `Bearer ${DEMO_GITHUB.token}`)
      throw new Error(
        `demo GitHub call presented ${authorization ?? "no"} credential`,
      );
    return Response.json({
      id: DEMO_GITHUB.id,
      full_name: `${DEMO_GITHUB.owner}/${DEMO_GITHUB.name}`,
    });
  }
  if (url === `https://api.github.com/repositories/${DEMO_GITHUB.id}`)
    return Response.json({
      full_name: `${DEMO_GITHUB.owner}/${DEMO_GITHUB.name}`,
    });
  throw new Error(`unstubbed outbound call: ${url}`);
}) as typeof fetch;

const randomHex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

// Hono's signed-cookie scheme, which better-auth uses for its session cookie:
// `value` plus a base64 HMAC-SHA256 signature of it under the auth secret.
const signedSessionCookie = async (token: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const base64Signature = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  );
  return `better-auth.session_token=${encodeURIComponent(`${token}.${base64Signature}`)}`;
};

const freePort = async (): Promise<number> => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined || port === 0)
    throw new Error("could not allocate a local port for the e2e API");
  return port;
};

let profileOrigin = "";
let operatorSessionToken = "";
// better-auth signs its session cookie with HMAC-SHA256; the approving
// request must carry the signed form of the seeded session token.
let operatorSessionCookie = "";

// Runs a CLI command that performs device authorization. The command's JSON
// progress events arrive on stderr; when the device_authorization event
// shows up, the demo operator approves the code through the real
// /api/auth/device/approve endpoint, exactly like the web approval page.
const runWithDeviceApproval = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CliRunResult & { readonly approvals: number }> => {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  let approvals = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 180_000);
  timeout.unref?.();
  const handleLine = async (line: string): Promise<void> => {
    if (line.trim().length === 0) return;
    let event: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).event === "device_authorization"
      )
        event = parsed as Record<string, unknown>;
    } catch {
      // Progress lines interleaved with the JSON events are expected.
    }
    if (event) {
      const userCode = requireString(event.userCode, "device user code");
      approvals += 1;
      // Like the web approval page: the signed-in status check first claims
      // the code for the approving user, then the approval confirms it.
      const approvalHeaders = {
        "Content-Type": "application/json",
        Cookie: operatorSessionCookie,
        Origin: profileOrigin,
      };
      const statusResponse = await fetch(
        `${profileOrigin}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
        { headers: approvalHeaders, cache: "no-store" },
      );
      if (!statusResponse.ok)
        throw new Error(
          `device status claim failed with ${statusResponse.status}: ${await statusResponse.text()}`,
        );
      const response = await fetch(`${profileOrigin}/api/auth/device/approve`, {
        method: "POST",
        headers: approvalHeaders,
        body: JSON.stringify({ userCode }),
      });
      if (!response.ok)
        throw new Error(
          `device approval failed with ${response.status}: ${await response.text()}`,
        );
    }
  };
  const stderrText = await (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    let consumed = 0;
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n", consumed);
      while (newline !== -1) {
        const line = buffer.slice(consumed, newline);
        consumed = newline + 1;
        await handleLine(line);
        newline = buffer.indexOf("\n", consumed);
      }
    }
    if (buffer.length > consumed) await handleLine(buffer.slice(consumed));
    return buffer;
  })().catch((error) => {
    child.kill();
    throw error;
  });
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  clearTimeout(timeout);
  if (timedOut)
    throw new Error(
      `CLI ${args.join(" ")} timed out waiting for device authorization: ${stderrText.trim()}`,
    );
  return { stdout, stderr: stderrText, exitCode, approvals };
};

await access(binary, process.platform === "win32" ? undefined : constants.X_OK);

let isolatedDirectory: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const database = createDatabaseClient(testDatabaseUrl.toString());
try {
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(
      `CREATE DATABASE "${testDatabaseName.replaceAll('"', '""')}"`,
    );
  } catch (error) {
    throw new Error(`could not create ${testDatabaseName}: ${String(error)}`);
  }

  console.log(`→ migrating fresh database ${testDatabaseName}`);
  process.env.DATABASE_URL = testDatabaseUrl.toString();
  process.env.VALKEY_URL = valkeyUrl;
  // The API runs as a non-production profile on loopback: no TLS gate, no
  // mandatory GitHub credentials, deterministic defaults.
  delete process.env.NODE_ENV;
  delete process.env.SERVER_PROFILE_ID;
  delete process.env.SERVER_PROFILE_ORIGIN;
  delete process.env.WEB_ORIGIN;
  delete process.env.BETTER_AUTH_URL;
  const port = await freePort();
  process.env.SERVER_PROFILE_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.WEB_ORIGIN = process.env.SERVER_PROFILE_ORIGIN;
  const authSecret = randomHex(32);
  process.env.BETTER_AUTH_SECRET = authSecret;
  process.env.GITHUB_CLIENT_ID = "demo-github-client";
  process.env.GITHUB_CLIENT_SECRET = "demo-github-secret";
  await runMigrations();

  console.log("→ booting the real API (in-process) against demo data");
  const api = await import("../apps/api/src/index");
  const profile = api.loadServerProfileConfig();
  if (profile.origin !== process.env.SERVER_PROFILE_ORIGIN)
    throw new Error(`API origin mismatch: ${profile.origin}`);
  profileOrigin = profile.origin;
  operatorSessionToken = base64url(crypto.getRandomValues(new Uint8Array(48)));
  operatorSessionCookie = await signedSessionCookie(
    operatorSessionToken,
    process.env.BETTER_AUTH_SECRET ?? "",
  );
  const authUserId = crypto.randomUUID();
  const demoUserId = crypto.randomUUID();

  await database.$executeRawUnsafe(
    "GRANT dotrelay_security_response TO CURRENT_USER",
  );
  await ensureServerProfile(database, {
    id: profile.id,
    origin: profile.origin,
    allowRebind: profile.allowRebind,
  });

  // Demo data: one operator with delegated GitHub access. This session is
  // the identity that approves the CLI's device authorizations.
  await database.authUser.create({
    data: {
      id: authUserId,
      name: "Demo Operator",
      email: "demo-operator@example.invalid",
      emailVerified: true,
    },
  });
  await database.authSession.create({
    data: {
      id: crypto.randomUUID(),
      token: operatorSessionToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      userId: authUserId,
    },
  });
  await database.authAccount.create({
    data: {
      id: crypto.randomUUID(),
      accountId: DEMO_GITHUB.accountId,
      providerId: "github",
      userId: authUserId,
      accessToken: DEMO_GITHUB.token,
      scope: "user:email repo",
      issuer: "",
    },
  });
  await database.user.create({
    data: {
      id: demoUserId,
      serverProfileId: profile.id,
      authSubject: authUserId,
      githubSubject: DEMO_GITHUB.subject,
    },
  });

  // Demo data: one Team the operator owns, so init under --no-input has a
  // Team to attach the new Project to (the CLI refuses to invent one). The
  // database enforces "a Team must have an active owner" with a deferrable
  // trigger checked at commit, so the Team and its owner Membership are
  // written in one transaction, exactly as createTeamWithOwner does.
  const teamId = crypto.randomUUID();
  const teamCreatedAt = new Date();
  await database.$transaction(
    async (tx) => {
      await tx.team.create({
        data: {
          id: teamId,
          serverProfileId: profile.id,
          name: "Demo Team",
          lifecycle: "ACTIVE",
          createdAt: teamCreatedAt,
        },
      });
      await tx.membership.create({
        data: {
          id: crypto.randomUUID(),
          teamId,
          userId: demoUserId,
          role: "OWNER",
          lifecycle: "ACTIVE",
          createdAt: teamCreatedAt,
          activatedAt: teamCreatedAt,
        },
      });
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  // Demo data: one Project already linked to the demo GitHub Repository and
  // one production Environment. This mirrors the canonical test-cli-live
  // fixture: the full-stack value under test is the real device
  // authorization, device crypto, Postgres persistence, and Valkey rate
  // limits — not Project creation, which is a separate (project link) flow.
  const projectId = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  const projectCreatedAt = new Date();
  await database.$transaction(
    async (tx) => {
      await tx.project.create({
        data: {
          id: projectId,
          teamId,
          githubRepositoryId: BigInt(DEMO_GITHUB.id),
          createdByUserId: demoUserId,
          lifecycle: "ACTIVE",
          currentEpoch: 1n,
          createdAt: projectCreatedAt,
        },
      });
      await tx.environment.create({
        data: {
          id: environmentId,
          projectId,
          createdByUserId: demoUserId,
          label: "production",
          lifecycle: "ACTIVE",
          createdAt: projectCreatedAt,
        },
      });
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  const auth = createAuth(createBetterAuthDatabaseAdapter(database), profile);
  const app = api.createApi({
    database,
    profile,
    auth,
    githubFetch: fakeGitHubFetch,
  });
  server = Bun.serve({ port, fetch: app.fetch });

  isolatedDirectory = await mkdtemp(join(tmpdir(), "dotrelay-e2e-"));
  const repositoryDirectory = join(isolatedDirectory, "repository");
  const cliEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedDirectory,
    DOTRELAY_CONFIG_DIR: join(isolatedDirectory, "cli"),
  };
  await mkdir(join(isolatedDirectory, "cli", "credentials"), {
    recursive: true,
  });
  await mkdir(repositoryDirectory, { recursive: true });
  const git = async (args: readonly string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: repositoryDirectory,
      env: cliEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${stderr.trim()}`);
  };
  await git(["init", "-b", "main"]);
  await git([
    "remote",
    "add",
    "origin",
    `https://github.com/${DEMO_GITHUB.owner}/${DEMO_GITHUB.name}.git`,
  ]);

  console.log(
    "→ CLI: setup (device authorization approved through the real API)",
  );
  const setup = await runWithDeviceApproval(
    [
      "setup",
      profileOrigin,
      "--accept-profile",
      profile.id,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (setup.exitCode !== 0)
    throw new Error(
      `setup failed with exit code ${setup.exitCode}: ${setup.stderr.trim()}`,
    );
  if (setup.approvals !== 1)
    throw new Error(`setup performed ${setup.approvals} device authorizations`);
  const setupResult =
    parseJsonLines(setup.stdout).at(-1) ??
    (() => {
      throw new Error(`setup produced no JSON result: ${setup.stderr.trim()}`);
    })();
  if (setupResult.device !== "enrolled")
    throw new Error(
      `setup did not finish with an enrolled Device: ${JSON.stringify(setupResult)}`,
    );
  const deviceId = requireString(setupResult.deviceId, "Device id");
  const profileName = requireString(setupResult.profile, "Server Profile name");
  // --no-input refuses to infer a profile, so every protected-workflow
  // command names the Server Profile it was set up against.
  const profileFlag = ["--profile", profileName] as const;
  const deviceAfterSetup = await database.device.findFirst({
    where: { userId: demoUserId, id: deviceId },
  });
  if (!deviceAfterSetup || deviceAfterSetup.lifecycle !== "ACTIVE")
    throw new Error("the real API did not activate the bootstrap Device");
  // The device code is single-use: redeeming it for a session consumes the
  // record, so the durable proof is the session the flow issued.
  const operatorSessions = await database.authSession.findMany({
    where: { userId: authUserId },
  });
  if (
    !operatorSessions.some((session) => session.token !== operatorSessionToken)
  )
    throw new Error(
      "device authorization did not issue a CLI session in the real database",
    );

  const sourcePath = join(isolatedDirectory, "source.env");
  await writeFile(sourcePath, "SHARED_VALUE=one\nUSER_VALUE=secret\nEMPTY=\n");

  console.log(
    "→ CLI: init (genesis published into the pre-linked demo Environment)",
  );
  const initResult = await runBinary(
    [
      "init",
      environmentId,
      ...profileFlag,
      "--from",
      sourcePath,
      "--classify",
      "SHARED_VALUE=shared",
      "--classify",
      "USER_VALUE=user-defined",
      "--classify",
      "EMPTY=shared",
      "--remote",
      "origin",
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (initResult.exitCode !== 0)
    throw new Error(
      `init failed with exit code ${initResult.exitCode}: ${initResult.stderr.trim()}`,
    );
  const initialized = parseJsonLines(initResult.stdout).at(-1) ?? {};
  const genesisRevisionId = requireString(
    initialized.revision,
    "genesis Revision id",
  );
  const linkedProject = await database.project.findFirst({
    where: { githubRepositoryId: BigInt(DEMO_GITHUB.id) },
  });
  if (!linkedProject)
    throw new Error("the demo Project is not linked to the demo Repository");
  const productionEnvironment = await database.environment.findUnique({
    where: { id: environmentId },
  });
  if (!productionEnvironment)
    throw new Error("the pre-seeded production Environment is missing");
  const genesisRevision = await database.revision.findFirst({
    where: { id: genesisRevisionId, environmentId: productionEnvironment.id },
  });
  if (!genesisRevision || genesisRevision.mutation !== "GENESIS")
    throw new Error("the genesis Revision was not published on the real API");

  console.log("→ CLI: push (change published through the real API)");
  await writeFile(sourcePath, "SHARED_VALUE=two\nUSER_VALUE=secret\nEMPTY=\n");
  const pushResult = await runBinary(
    [
      "push",
      ...profileFlag,
      "--environment",
      environmentId,
      "--from",
      sourcePath,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (pushResult.exitCode !== 0)
    throw new Error(
      `push failed with exit code ${pushResult.exitCode}: ${pushResult.stderr.trim()}`,
    );
  requireString(
    (parseJsonLines(pushResult.stdout).at(-1) ?? {}).revision,
    "published Revision id",
  );
  const publishedCount = await database.revision.count({
    where: { environmentId: productionEnvironment.id },
  });
  if (publishedCount !== 2)
    throw new Error(`expected 2 published Revisions, found ${publishedCount}`);

  console.log("→ CLI: pull (Values decrypted and written 0600)");
  const outputPath = join(repositoryDirectory, "export.env");
  const pullResult = await runBinary(
    [
      "pull",
      ...profileFlag,
      "--environment",
      environmentId,
      "--output",
      outputPath,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (pullResult.exitCode !== 0)
    throw new Error(
      `pull failed with exit code ${pullResult.exitCode}: ${pullResult.stderr.trim()}`,
    );
  const pulled = parseJsonLines(pullResult.stdout).at(-1) ?? {};
  if (pulled.gitExclusion !== "established")
    throw new Error(
      `pull did not guard the output against Git tracking: ${JSON.stringify(pulled)}`,
    );
  const output = await readFile(outputPath, "utf8");
  const outputMode = (await stat(outputPath)).mode & 0o777;
  if (
    output !== 'SHARED_VALUE="two"\nUSER_VALUE="secret"\nEMPTY=""\n' ||
    (process.platform !== "win32" && outputMode !== 0o600)
  )
    throw new Error(`pull wrote an unexpected file: ${JSON.stringify(output)}`);
  const exclusion = await readFile(
    join(repositoryDirectory, ".git", "info", "exclude"),
    "utf8",
  ).catch(() => "");
  if (!exclusion.includes("export.env"))
    throw new Error("pull did not record a Git exclusion for the output file");

  console.log("→ CLI: diff (matching and drifted)");
  const matchingDiff = await runBinary(
    [
      "diff",
      ...profileFlag,
      "--environment",
      environmentId,
      "--from",
      sourcePath,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (matchingDiff.exitCode !== 0)
    throw new Error(`matching diff failed: ${matchingDiff.stderr.trim()}`);
  const matching = parseJsonLines(matchingDiff.stdout).at(-1) ?? {};
  if (
    !Array.isArray(matching.added) ||
    matching.added.length !== 0 ||
    !Array.isArray(matching.updated) ||
    matching.updated.length !== 0 ||
    !Array.isArray(matching.removed) ||
    matching.removed.length !== 0 ||
    JSON.stringify(matching).includes("secret")
  )
    throw new Error(
      `matching diff leaked or misreported: ${JSON.stringify(matching)}`,
    );

  await writeFile(
    sourcePath,
    "SHARED_VALUE=two\nUSER_VALUE=secret\nEMPTY=\nNEW_VALUE=added\n",
  );
  const driftedDiff = await runBinary(
    [
      "diff",
      ...profileFlag,
      "--environment",
      environmentId,
      "--from",
      sourcePath,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  const drifted = parseJsonLines(driftedDiff.stdout).at(-1) ?? {};
  if (
    !Array.isArray(drifted.added) ||
    drifted.added.length !== 1 ||
    drifted.added[0] !== "NEW_VALUE" ||
    JSON.stringify(drifted).includes("secret")
  )
    throw new Error(`drifted diff misreported: ${JSON.stringify(drifted)}`);

  console.log("→ CLI: push with an unclassified Variable is refused");
  const unclassifiedPush = await runBinary(
    [
      "push",
      ...profileFlag,
      "--environment",
      environmentId,
      "--from",
      sourcePath,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (
    unclassifiedPush.exitCode !== 2 ||
    !unclassifiedPush.stderr.includes('"code":"invocation"') ||
    unclassifiedPush.stderr.includes("secret")
  )
    throw new Error(
      `unclassified push was not refused: exit=${unclassifiedPush.exitCode} ${unclassifiedPush.stderr.trim()}`,
    );
  const classifiedPush = await runBinary(
    [
      "push",
      ...profileFlag,
      "--environment",
      environmentId,
      "--from",
      sourcePath,
      "--classify",
      "NEW_VALUE=shared",
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (classifiedPush.exitCode !== 0)
    throw new Error(`classified push failed: ${classifiedPush.stderr.trim()}`);
  requireString(
    (parseJsonLines(classifiedPush.stdout).at(-1) ?? {}).revision,
    "reclassified Revision id",
  );

  console.log("→ CLI: history and rollback (real Revision lineage)");
  const historyResult = await runBinary(
    [
      "history",
      ...profileFlag,
      "--environment",
      environmentId,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (historyResult.exitCode !== 0)
    throw new Error(`history failed: ${historyResult.stderr.trim()}`);
  const history = parseJsonLines(historyResult.stdout).at(-1) ?? {};
  if (!Array.isArray(history.revisions) || history.revisions.length !== 3)
    throw new Error(
      `history reported ${JSON.stringify(history.revisions)} Revisions`,
    );

  const rollbackResult = await runBinary(
    [
      "rollback",
      genesisRevisionId,
      ...profileFlag,
      "--environment",
      environmentId,
      "--variable",
      "SHARED_VALUE",
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (rollbackResult.exitCode !== 0)
    throw new Error(`rollback failed: ${rollbackResult.stderr.trim()}`);
  const rollbackRevisionId = requireString(
    (parseJsonLines(rollbackResult.stdout).at(-1) ?? {}).revision,
    "rollback Revision id",
  );
  const rollbackRevision = await database.revision.findFirst({
    where: { id: rollbackRevisionId },
  });
  if (!rollbackRevision || rollbackRevision.mutation !== "ROLLBACK")
    throw new Error("the rollback Revision was not recorded on the real API");

  const rolledBack = await runBinary(
    [
      "pull",
      ...profileFlag,
      "--environment",
      environmentId,
      "--stdout",
      "--no-input",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (
    rolledBack.exitCode !== 0 ||
    !rolledBack.stdout.includes('SHARED_VALUE="one"') ||
    !rolledBack.stdout.includes('USER_VALUE="secret"') ||
    rolledBack.stderr.includes("secret")
  )
    throw new Error(
      `rolled-back pull did not restore Values: exit=${rolledBack.exitCode} ${rolledBack.stderr.trim()}`,
    );

  if (process.platform !== "win32") {
    console.log(
      "→ CLI: TTY stdout safety (terminal refuses, explicit reveal prints)",
    );
    const terminal = await runTerminal(
      [
        "pull",
        ...profileFlag,
        "--environment",
        environmentId,
        "--stdout",
        "--no-input",
      ],
      cliEnvironment,
      repositoryDirectory,
    );
    const terminalOutput = terminal.stdout + terminal.stderr;
    if (
      terminal.exitCode !== 2 ||
      !terminalOutput.includes("Refusing to write Values to terminal stdout") ||
      terminalOutput.includes('USER_VALUE="secret"') ||
      terminalOutput.includes('SHARED_VALUE="one"')
    )
      throw new Error(
        `TTY stdout safety failed: exit=${terminal.exitCode} ${terminalOutput.trim()}`,
      );
    const revealed = await runTerminal(
      [
        "pull",
        ...profileFlag,
        "--environment",
        environmentId,
        "--stdout",
        "--reveal",
      ],
      cliEnvironment,
      repositoryDirectory,
      "y\n",
    );
    if (
      revealed.exitCode !== 0 ||
      !revealed.stdout.includes('USER_VALUE="secret"') ||
      revealed.stderr.includes("secret")
    )
      throw new Error("explicit reveal contract failed");
  }

  console.log("→ CLI: credential-mode flags stay refused");
  for (const forbidden of [
    "--insecure",
    "--token=secret",
    "--device-key=secret",
  ]) {
    const rejected = await runBinary(
      ["--help", forbidden],
      cliEnvironment,
      repositoryDirectory,
    );
    if (rejected.exitCode !== 2 || rejected.stderr.includes("secret"))
      throw new Error(`credential-mode rejection failed for ${forbidden}`);
  }

  console.log("→ CLI: status reports the enrolled installation");
  const statusResult = await runBinary(
    ["status", ...profileFlag, "--json"],
    cliEnvironment,
    repositoryDirectory,
  );
  if (statusResult.exitCode !== 0)
    throw new Error(`status failed: ${statusResult.stderr.trim()}`);
  const status = parseJsonLines(statusResult.stdout).at(-1) ?? {};
  if (
    status.service !== "verified" ||
    status.session !== "verified" ||
    status.device !== "active" ||
    status.environment !== "production"
  )
    throw new Error(
      `status did not report a healthy installation: ${JSON.stringify(status)}`,
    );

  console.log("→ CLI: logout and a second device authorization round trip");
  const logoutResult = await runBinary(
    ["logout", ...profileFlag, "--json"],
    cliEnvironment,
    repositoryDirectory,
  );
  if (logoutResult.exitCode !== 0)
    throw new Error(`logout failed: ${logoutResult.stderr.trim()}`);
  if ((parseJsonLines(logoutResult.stdout).at(-1) ?? {}).loggedOut !== true)
    throw new Error("logout did not confirm");
  const relogin = await runWithDeviceApproval(
    ["login", ...profileFlag, "--no-input", "--json"],
    cliEnvironment,
    repositoryDirectory,
  );
  if (relogin.exitCode !== 0)
    throw new Error(
      `login after logout failed: exit=${relogin.exitCode} ${relogin.stderr.trim()}`,
    );
  if (relogin.approvals !== 1)
    throw new Error("the re-login did not perform a device authorization");
  const relogged = parseJsonLines(relogin.stdout).at(-1) ?? {};
  if (relogged.device !== "enrolled")
    throw new Error(
      `login did not restore the existing Device: ${JSON.stringify(relogged)}`,
    );
  const deviceStillActive = await database.device.findFirst({
    where: { userId: demoUserId, id: deviceId, lifecycle: "ACTIVE" },
  });
  if (!deviceStillActive)
    throw new Error(
      "the Device stopped being active after the second device authorization",
    );

  const auditEvents = await database.auditEvent.count({
    where: { actorUserId: demoUserId },
  });
  const operations = await database.operation.findMany({
    where: { actorUserId: demoUserId },
    select: { status: true },
  });
  if (
    operations.length < 3 ||
    operations.some((operation) => operation.status === "STAGED")
  )
    throw new Error(
      `operations were not committed: ${JSON.stringify(operations)}`,
    );
  if (auditEvents < 1)
    throw new Error("the audit trail recorded nothing for the demo user");

  console.log(
    `✓ full-stack e2e passed: setup, init, push, pull, diff, history, rollback, TTY safety, logout/relogin against real API + PostgreSQL + Valkey (${operations.length} committed operations, ${auditEvents} audit events)`,
  );
} finally {
  server?.stop(true);
  await database.$disconnect().catch(() => undefined);
  try {
    const admin = postgres(adminUrl.toString(), { max: 1 });
    try {
      await admin.unsafe(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [testDatabaseName],
      );
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${testDatabaseName.replaceAll('"', '""')}"`,
      );
    } finally {
      await admin.end();
    }
  } catch (error) {
    console.error(
      `warning: could not drop ${testDatabaseName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isolatedDirectory)
    await rm(isolatedDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  clearTimeout(watchdog);
}
// The API's protocol rate limiter holds a module-level ioredis connection that
// nothing in the harness can reach to close. Every real resource (the Server,
// the Postgres pool, the admin connection, the temp tree) is released above, so
// exit explicitly instead of letting that socket keep the process alive. A
// failed run throws above and exits non-zero before reaching this line.
process.exit(0);
