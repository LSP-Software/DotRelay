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
  chmod,
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
import type { ServerProfileConfig } from "../apps/api/src/profile";
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

// The packaged CLI never accepts the Recovery Code in argv (R10), so the
// harness hands it over through a 0600 file, exactly like an automation
// caller would.
const writeRecoveryCodeFile = async (
  directory: string,
  code: string,
  name: string,
): Promise<string> => {
  const path = join(directory, `recovery-code-${name}.txt`);
  await writeFile(path, code, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
};

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

// Allocates a port and KEEPS it bound until release() is called, so no
// concurrent process can claim it while the harness is still setting up.
// The caller releases it at the last moment before binding the real server.
const reservePort = (): { port: number; release: () => void } => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  if (probe.port === undefined || probe.port === 0)
    throw new Error("could not allocate a local port for the e2e API");
  let released = false;
  return {
    port: probe.port,
    // Idempotent: cleanup may release a port the real server already took.
    release: () => {
      if (released) return;
      released = true;
      probe.stop(true);
    },
  };
};

const isPortInUse = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("EADDRINUSE") || /in use/i.test(error.message));

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
  // Start draining stdout before the stderr loop below: if the child fills
  // the stdout pipe buffer before anyone reads it, it blocks on write and
  // never closes stderr, so the loop would wait for a stream that never ends.
  const stdoutText = new Response(child.stdout).text();
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
  const stdout = await stdoutText;
  const exitCode = await child.exited;
  clearTimeout(timeout);
  if (timedOut)
    throw new Error(
      `CLI ${args.join(" ")} timed out waiting for device authorization: ${stderrText.trim()}`,
    );
  return { stdout, stderr: stderrText, exitCode, approvals };
};

// Releases the held port and binds the real server on it. The handoff window
// is a few microseconds wide, but if the port is still taken the bind is
// retried on a freshly reserved port: the profile id is stable across
// origins, so only the origin is rebound and the seeded demo rows stay valid.
const bindRealServer = async (
  api: typeof import("../apps/api/src/index"),
  initial: { port: number; release: () => void },
  initialProfile: ServerProfileConfig,
): Promise<ReturnType<typeof Bun.serve>> => {
  let held = initial;
  let profile = initialProfile;
  for (let attempt = 1; ; attempt++) {
    const auth = createAuth(createBetterAuthDatabaseAdapter(database), profile);
    const app = api.createApi({
      database,
      profile,
      auth,
      githubFetch: fakeGitHubFetch,
    });
    held.release();
    try {
      return Bun.serve({ port: held.port, fetch: app.fetch });
    } catch (error) {
      if (attempt > 2 || !isPortInUse(error)) throw error;
      console.error(
        `warning: port ${held.port} was taken between release and bind; retrying on a fresh port`,
      );
      const next = reservePort();
      process.env.SERVER_PROFILE_ORIGIN = `http://127.0.0.1:${next.port}`;
      process.env.WEB_ORIGIN = process.env.SERVER_PROFILE_ORIGIN;
      held = next;
      profile = api.loadServerProfileConfig();
      await ensureServerProfile(database, {
        id: profile.id,
        origin: profile.origin,
        allowRebind: true,
      });
      profileOrigin = profile.origin;
    }
  }
};

await access(binary, process.platform === "win32" ? undefined : constants.X_OK);

let isolatedDirectory: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
// The port held while the real server is not up yet; released on cleanup in
// case the run fails before the real server takes over the port.
let heldPort: { port: number; release: () => void } | undefined;
const database = createDatabaseClient(testDatabaseUrl.toString());
try {
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(
      `CREATE DATABASE "${testDatabaseName.replaceAll('"', '""')}"`,
    );
  } catch (error) {
    throw new Error(`could not create ${testDatabaseName}: ${String(error)}`);
  } finally {
    // The client is only needed for CREATE DATABASE; end it so its socket
    // cannot outlive the run (the cleanup phase opens its own connection).
    await admin.end();
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
  // Hold a bound port for the whole of the slow setup (migrations, seeding)
  // so a concurrent process cannot take it; the real server takes over at the
  // last moment.
  const initialHold = reservePort();
  heldPort = initialHold;
  process.env.SERVER_PROFILE_ORIGIN = `http://127.0.0.1:${initialHold.port}`;
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
  const lifecycleEnvironmentId = crypto.randomUUID();
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
      // A second Environment on the same Project, dedicated to the Account
      // Master Key lifecycle proof. It holds only shared Values, so every
      // Device that can open the Project Epoch Key (via the AMK envelope)
      // decrypts it byte-identically. The production Environment also
      // carries a User-defined Value sealed to the owner's User Value Key,
      // which a peer decrypts only after it recovers the same Account
      // Master Key and opens that envelope.
      await tx.environment.create({
        data: {
          id: lifecycleEnvironmentId,
          projectId,
          createdByUserId: demoUserId,
          label: "lifecycle",
          lifecycle: "ACTIVE",
          createdAt: projectCreatedAt,
        },
      });
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  server = await bindRealServer(api, initialHold, profile);
  // The real server now owns the port; the held port has been released.
  heldPort = undefined;

  const baseDirectory = await mkdtemp(join(tmpdir(), "dotrelay-e2e-"));
  isolatedDirectory = baseDirectory;
  const repositoryDirectory = join(baseDirectory, "repository");
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
  if (deviceAfterSetup?.lifecycle !== "ACTIVE")
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

  // Enroll Devices 2 and 3 through the real device authorization so all three
  // Devices share the same User and can exchange the AMK. Each lives in its
  // own isolated home/config directory and its own Git repository tracking
  // the same demo origin, so repository identity resolves to the same Project.
  const enrollPeerDevice = async (
    index: number,
  ): Promise<{ env: NodeJS.ProcessEnv; repo: string; deviceId: string }> => {
    const deviceHome = join(baseDirectory, `device${index}`);
    const repo = join(baseDirectory, `device${index}-repo`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: deviceHome,
      DOTRELAY_CONFIG_DIR: join(deviceHome, "cli"),
    };
    await mkdir(join(deviceHome, "cli", "credentials"), { recursive: true });
    await mkdir(repo, { recursive: true });
    const git = async (args: readonly string[]) => {
      const child = Bun.spawn(["git", ...args], {
        cwd: repo,
        env,
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
    const enrolled = await runWithDeviceApproval(
      [
        "setup",
        profileOrigin,
        "--accept-profile",
        profile.id,
        "--no-input",
        "--json",
      ],
      env,
      repo,
    );
    if (enrolled.exitCode !== 0)
      throw new Error(
        `device${index} setup failed: exit=${enrolled.exitCode} ${enrolled.stderr.trim()}`,
      );
    if (enrolled.approvals !== 1)
      throw new Error(
        `device${index} setup performed ${enrolled.approvals} authorizations`,
      );
    const result = parseJsonLines(enrolled.stdout).at(-1) ?? {};
    if (result.device !== "enrolled")
      throw new Error(
        `device${index} did not enroll: ${JSON.stringify(result)}`,
      );
    return {
      env,
      repo,
      deviceId: requireString(result.deviceId, `device${index} id`),
    };
  };

  console.log("→ CLI: simultaneous device setup (one Account Master Key wins)");
  const device2 = await enrollPeerDevice(2);
  const [setupDevice1, setupPeer] = await Promise.all([
    runBinary(
      ["device", "setup", ...profileFlag, "--no-input", "--json"],
      cliEnvironment,
      repositoryDirectory,
    ),
    runBinary(
      ["device", "setup", ...profileFlag, "--no-input", "--json"],
      device2.env,
      device2.repo,
    ),
  ]);
  const simultaneous = [
    { label: "device 1", deviceId, run: setupDevice1 },
    { label: "device 2", deviceId: device2.deviceId, run: setupPeer },
  ];
  const winners = simultaneous.filter((entry) => entry.run.exitCode === 0);
  const losers = simultaneous.filter((entry) => entry.run.exitCode !== 0);
  if (winners.length !== 1 || losers.length !== 1)
    throw new Error(
      `simultaneous device setup expected one winner and one refusal, got exits ${setupDevice1.exitCode} and ${setupPeer.exitCode}`,
    );
  const winner = winners[0];
  const loser = losers[0];
  if (!winner || !loser)
    throw new Error("simultaneous device setup did not classify a winner");
  if (loser.run.exitCode !== 4)
    throw new Error(
      `${loser.label} refusal exited ${loser.run.exitCode}, expected 4`,
    );
  if (
    parseJsonLines(loser.run.stderr).at(-1)?.code !==
    "account_key_already_exists"
  )
    throw new Error(`${loser.label} did not report account_key_already_exists`);
  if (loser.run.stdout.includes("recoveryCode"))
    throw new Error(`${loser.label} printed a recovery code after losing`);
  const setupAkResult = parseJsonLines(winner.run.stdout).at(-1) ?? {};
  const amkRecoveryCode = requireString(
    setupAkResult.recoveryCode,
    "initial recovery code",
  );
  const setupWrapperId = requireString(
    setupAkResult.wrapperId,
    "initial recovery-code wrapper id",
  );
  if (setupAkResult.deviceId !== winner.deviceId)
    throw new Error(
      `${winner.label} reported a different Device than the one that ran setup`,
    );
  let activeRecoveryWrappers = await database.accountKeyWrapperObject.findMany({
    where: {
      userId: demoUserId,
      wrapperType: "RECOVERY_CODE",
      retiredAt: null,
    },
  });
  const setupRecoveryWrapper = activeRecoveryWrappers[0];
  if (
    activeRecoveryWrappers.length !== 1 ||
    Buffer.from(setupRecoveryWrapper?.wrapperId ?? new Uint8Array(0)).toString(
      "hex",
    ) !== setupWrapperId
  )
    throw new Error(
      "simultaneous device setup did not keep exactly one active recovery-code wrapper",
    );
  // The loser discarded its candidate. Device 1 must hold the winning key
  // before the rest of the journey, so recover it when Device 1 lost.
  if (winner.deviceId !== deviceId) {
    const recoverWinner = await runBinary(
      [
        "device",
        "recover",
        ...profileFlag,
        "--recovery-code-file",
        await writeRecoveryCodeFile(
          isolatedDirectory,
          amkRecoveryCode,
          "device1-race",
        ),
        "--no-input",
        "--json",
      ],
      cliEnvironment,
      repositoryDirectory,
    );
    if (recoverWinner.exitCode !== 0)
      throw new Error(
        `device 1 could not recover the winning Account Master Key: exit=${recoverWinner.exitCode}`,
      );
    if (parseJsonLines(recoverWinner.stdout).at(-1)?.via !== "recovery-code")
      throw new Error(
        "device 1 did not recover the winning key with the recovery code",
      );
  }
  // The command is idempotent on the Device that already stores the AMK: it
  // reports the Device and mints no second wrapper.
  const setupAgain = await runBinary(
    ["device", "setup", ...profileFlag, "--no-input", "--json"],
    cliEnvironment,
    repositoryDirectory,
  );
  if (setupAgain.exitCode !== 0)
    throw new Error(
      `idempotent device setup failed: exit=${setupAgain.exitCode}`,
    );
  const setupAgainResult = parseJsonLines(setupAgain.stdout).at(-1) ?? {};
  if ("recoveryCode" in setupAgainResult || "wrapperId" in setupAgainResult)
    throw new Error("idempotent device setup leaked a new wrapper");
  if (
    (await database.accountKeyWrapperObject.count({
      where: {
        userId: demoUserId,
        wrapperType: "RECOVERY_CODE",
        retiredAt: null,
      },
    })) !== 1
  )
    throw new Error(
      "idempotent device setup minted an extra recovery-code wrapper",
    );

  const device3 = await enrollPeerDevice(3);
  const activeDeviceCount = await database.device.count({
    where: { userId: demoUserId, lifecycle: "ACTIVE" },
  });
  if (activeDeviceCount !== 3)
    throw new Error(`expected 3 active Devices, found ${activeDeviceCount}`);

  // A Device that does not store the AMK must refuse to mint a second,
  // incompatible key: the account already has one (the active wrapper proves it).
  const secondSetup = await runWithDeviceApproval(
    ["device", "setup", ...profileFlag, "--no-input", "--json"],
    device3.env,
    device3.repo,
  );
  if (secondSetup.exitCode !== 4)
    throw new Error(
      `third Device setup was not refused: exit=${secondSetup.exitCode}`,
    );
  if (
    parseJsonLines(secondSetup.stderr).at(-1)?.code !==
    "account_key_already_exists"
  )
    throw new Error(
      "third Device setup did not report account_key_already_exists",
    );

  // Device 2 recovers the AMK from the one-time recovery code, so it can
  // decrypt the shared-only lifecycle Environment independently of Device 1.
  const recoverDevice2 = await runBinary(
    [
      "device",
      "recover",
      ...profileFlag,
      "--recovery-code-file",
      await writeRecoveryCodeFile(
        isolatedDirectory,
        amkRecoveryCode,
        "device2",
      ),
      "--no-input",
      "--json",
    ],
    device2.env,
    device2.repo,
  );
  if (recoverDevice2.exitCode !== 0)
    throw new Error(
      `device2 recover failed: exit=${recoverDevice2.exitCode} ${recoverDevice2.stderr.trim()}`,
    );
  const recoverDevice2Result =
    parseJsonLines(recoverDevice2.stdout).at(-1) ?? {};
  if (recoverDevice2Result.via !== "recovery-code")
    throw new Error(
      `device2 recover used an unexpected channel: ${JSON.stringify(recoverDevice2Result)}`,
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
  if (genesisRevision?.mutation !== "GENESIS")
    throw new Error("the genesis Revision was not published on the real API");
  // With Device 1 holding the AMK and no epoch key established, the main init
  // is the Device that establishes the Project Epoch Key: it wraps a fresh
  // random key in an AMK envelope the service stores, so every later Device
  // that recovers the AMK can open the same key.
  const epochEnvelope = await database.accountKeyEnvelopeObject.findFirst({
    where: {
      userId: demoUserId,
      envelopeType: "PROJECT_EPOCH_KEY",
      projectId: linkedProject.id,
      projectEpoch: 1n,
      retiredAt: null,
    },
  });
  if (!epochEnvelope)
    throw new Error(
      "the main init did not publish the AMK-wrapped Project Epoch Key envelope",
    );

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
    parseJsonLines(pushResult.stdout).at(-1)?.revision,
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

  // Device 1 published the User-defined Value. Device 2 already recovered
  // the same Account Master Key, so it must open the generation-1 User Value
  // Key and decrypt that value. Shared Values stay on the Project Epoch Key:
  // the two lane scopes must not share a ciphertext.
  const userValueEnvelopes = await database.accountKeyEnvelopeObject.findMany({
    where: {
      userId: demoUserId,
      envelopeType: "USER_VALUE_KEY",
      ownerUserId: demoUserId,
      valueGeneration: 1n,
      retiredAt: null,
    },
  });
  if (userValueEnvelopes.length !== 1)
    throw new Error(
      `expected one active generation-1 User Value Key envelope, found ${userValueEnvelopes.length}`,
    );
  const productionLanes = await database.laneObject.findMany({
    where: { environmentId: productionEnvironment.id },
    select: { scope: true, ownerUserId: true, ciphertextHash: true },
  });
  const sharedLanes = productionLanes.filter(
    (lane) => lane.scope === "SHARED_VALUE",
  );
  const userDefinedLanes = productionLanes.filter(
    (lane) => lane.scope === "USER_DEFINED_VALUE",
  );
  if (sharedLanes.length === 0 || userDefinedLanes.length === 0)
    throw new Error(
      "production did not publish both a shared lane and a user-defined lane",
    );
  if (userDefinedLanes.some((lane) => lane.ownerUserId !== demoUserId))
    throw new Error("a user-defined lane was not owned by the publishing user");
  const sharedHashes = new Set(
    sharedLanes.map((lane) => Buffer.from(lane.ciphertextHash).toString("hex")),
  );
  if (
    userDefinedLanes.some((lane) =>
      sharedHashes.has(Buffer.from(lane.ciphertextHash).toString("hex")),
    )
  )
    throw new Error("a user-defined lane reused a shared-value ciphertext");
  console.log(
    "→ CLI: device 2 pull (User-defined Value decrypts after AMK recovery)",
  );
  const device2OutputPath = join(device2.repo, "export.env");
  const device2Pull = await runBinary(
    [
      "pull",
      ...profileFlag,
      "--environment",
      environmentId,
      "--output",
      device2OutputPath,
      "--remote",
      "origin",
      "--no-input",
      "--json",
    ],
    device2.env,
    device2.repo,
  );
  if (device2Pull.exitCode !== 0)
    throw new Error(
      `device 2 pull failed with exit code ${device2Pull.exitCode}: ${device2Pull.stderr.trim()}`,
    );
  const device1Bytes = await readFile(outputPath);
  const device2Bytes = await readFile(device2OutputPath);
  if (Buffer.compare(device1Bytes, device2Bytes) !== 0)
    throw new Error(
      "device 2 did not decrypt the same shared and user-defined values as device 1",
    );

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
    parseJsonLines(classifiedPush.stdout).at(-1)?.revision,
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
    parseJsonLines(rollbackResult.stdout).at(-1)?.revision,
    "rollback Revision id",
  );
  const rollbackRevision = await database.revision.findFirst({
    where: { id: rollbackRevisionId },
  });
  if (rollbackRevision?.mutation !== "ROLLBACK")
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
  if (parseJsonLines(logoutResult.stdout).at(-1)?.loggedOut !== true)
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

  console.log(
    "→ CLI: device lifecycle (shared Environment decrypts identically on every Device that holds the AMK)",
  );
  const lifecycleSource = join(isolatedDirectory, "lifecycle.env");
  await writeFile(lifecycleSource, "SHARED_VALUE=alpha\nEMPTY=\n");
  const lifecycleInit = await runBinary(
    [
      "init",
      lifecycleEnvironmentId,
      ...profileFlag,
      "--from",
      lifecycleSource,
      "--classify",
      "SHARED_VALUE=shared",
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
  if (lifecycleInit.exitCode !== 0)
    throw new Error(
      `lifecycle init failed: exit=${lifecycleInit.exitCode} ${lifecycleInit.stderr.trim()}`,
    );
  requireString(
    parseJsonLines(lifecycleInit.stdout).at(-1)?.revision,
    "lifecycle genesis Revision id",
  );

  const lifecyclePull = async (
    name: string,
    env: NodeJS.ProcessEnv,
    repo: string,
  ): Promise<string> => {
    const outputPath = join(repo, "lifecycle.env.out");
    const run = await runBinary(
      [
        "pull",
        ...profileFlag,
        "--environment",
        lifecycleEnvironmentId,
        "--output",
        outputPath,
        "--remote",
        "origin",
        "--no-input",
        "--json",
      ],
      env,
      repo,
    );
    if (run.exitCode !== 0)
      throw new Error(
        `device${name} lifecycle pull failed: exit=${run.exitCode} ${run.stderr.trim()}`,
      );
    return outputPath;
  };
  const device1LifecycleFile = await lifecyclePull(
    "1",
    cliEnvironment,
    repositoryDirectory,
  );
  const device2LifecycleFile = await lifecyclePull(
    "2",
    device2.env,
    device2.repo,
  );
  const device1LifecycleBytes = await readFile(device1LifecycleFile);
  const device2LifecycleBytes = await readFile(device2LifecycleFile);
  if (Buffer.compare(device1LifecycleBytes, device2LifecycleBytes) !== 0)
    throw new Error(
      "Devices 1 and 2 decrypted the shared Environment differently",
    );
  const lifecycleText = device1LifecycleBytes.toString("utf8");
  if (
    !lifecycleText.includes('SHARED_VALUE="alpha"') ||
    !lifecycleText.includes('EMPTY=""')
  )
    throw new Error(
      `lifecycle pull decoded unexpected Values: ${JSON.stringify(lifecycleText)}`,
    );

  // Device 3 does not yet hold the AMK. Device 1 seals it to Device 3 with a
  // short-lived transfer; Device 3 accepts the transfer exactly once.
  const transfer = await runBinary(
    [
      "device",
      "transfer",
      ...profileFlag,
      "--to",
      device3.deviceId,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (transfer.exitCode !== 0)
    throw new Error(
      `device transfer failed: exit=${transfer.exitCode} ${transfer.stderr.trim()}`,
    );
  const transferResult = parseJsonLines(transfer.stdout).at(-1) ?? {};
  const transferId = requireString(transferResult.transferId, "transfer id");
  if (transferResult.recipientDeviceId !== device3.deviceId)
    throw new Error(
      `transfer targeted the wrong Device: ${JSON.stringify(transferResult)}`,
    );
  const pendingTransfer = await database.accountKeyTransferObject.findFirst({
    where: {
      userId: demoUserId,
      transferId: Buffer.from(transferId, "hex"),
      status: "PENDING",
    },
  });
  if (!pendingTransfer)
    throw new Error("the transfer was not recorded as pending on the real API");

  const acceptTransfer = await runBinary(
    [
      "device",
      "recover",
      ...profileFlag,
      "--transfer",
      transferId,
      "--no-input",
      "--json",
    ],
    device3.env,
    device3.repo,
  );
  if (acceptTransfer.exitCode !== 0)
    throw new Error(
      `device3 transfer accept failed: exit=${acceptTransfer.exitCode} ${acceptTransfer.stderr.trim()}`,
    );
  const acceptResult = parseJsonLines(acceptTransfer.stdout).at(-1) ?? {};
  if (acceptResult.via !== "transfer")
    throw new Error(
      `device3 accept used an unexpected channel: ${JSON.stringify(acceptResult)}`,
    );
  const device3LifecycleFile = await lifecyclePull(
    "3",
    device3.env,
    device3.repo,
  );
  const device3LifecycleBytes = await readFile(device3LifecycleFile);
  if (Buffer.compare(device1LifecycleBytes, device3LifecycleBytes) !== 0)
    throw new Error(
      "Device 3 decrypted the shared Environment differently from Device 1",
    );
  const consumedTransfer = await database.accountKeyTransferObject.findFirst({
    where: { userId: demoUserId, transferId: Buffer.from(transferId, "hex") },
  });
  if (
    consumedTransfer?.status !== "CONSUMED" ||
    consumedTransfer?.consumedAt === null
  )
    throw new Error("the one-shot transfer was not consumed by the real API");

  // A one-shot transfer cannot be accepted twice.
  const replayTransfer = await runBinary(
    [
      "device",
      "recover",
      ...profileFlag,
      "--transfer",
      transferId,
      "--no-input",
      "--json",
    ],
    device3.env,
    device3.repo,
  );
  if (replayTransfer.exitCode !== 4)
    throw new Error(
      `one-shot transfer replay was not refused: exit=${replayTransfer.exitCode} ${replayTransfer.stderr.trim()}`,
    );
  if (parseJsonLines(replayTransfer.stderr).at(-1)?.code !== "state_conflict")
    throw new Error(
      `transfer replay reported the wrong diagnostic: ${replayTransfer.stderr.trim()}`,
    );

  // Rotating the recovery code retires the previous wrapper, so the old code
  // can no longer unlock the account and the new one can.
  const backup = await runBinary(
    ["device", "backup", ...profileFlag, "--no-input", "--json"],
    cliEnvironment,
    repositoryDirectory,
  );
  if (backup.exitCode !== 0)
    throw new Error(`device backup failed: ${backup.stderr.trim()}`);
  const backupResult = parseJsonLines(backup.stdout).at(-1) ?? {};
  const rotatedRecoveryCode = requireString(
    backupResult.recoveryCode,
    "rotated recovery code",
  );
  const backupWrapperId = requireString(
    backupResult.wrapperId,
    "backup wrapper id",
  );
  activeRecoveryWrappers = await database.accountKeyWrapperObject.findMany({
    where: {
      userId: demoUserId,
      wrapperType: "RECOVERY_CODE",
      retiredAt: null,
    },
  });
  const backupRecoveryWrapper =
    await database.accountKeyWrapperObject.findFirst({
      where: {
        userId: demoUserId,
        wrapperType: "RECOVERY_CODE",
        retiredAt: null,
      },
    });
  if (
    activeRecoveryWrappers.length !== 1 ||
    Buffer.from(backupRecoveryWrapper?.wrapperId ?? new Uint8Array(0)).toString(
      "hex",
    ) !== backupWrapperId
  )
    throw new Error(
      "rotation did not leave exactly one active recovery-code wrapper",
    );

  const staleRecover = await runBinary(
    [
      "device",
      "recover",
      ...profileFlag,
      "--recovery-code-file",
      await writeRecoveryCodeFile(isolatedDirectory, amkRecoveryCode, "stale"),
      "--no-input",
      "--json",
    ],
    device2.env,
    device2.repo,
  );
  if (staleRecover.exitCode !== 6)
    throw new Error(
      `stale recovery code was not refused: exit=${staleRecover.exitCode} ${staleRecover.stderr.trim()}`,
    );
  if (
    parseJsonLines(staleRecover.stderr).at(-1)?.code !==
    "account_key_unlock_failed"
  )
    throw new Error(
      `stale recovery code reported the wrong diagnostic: ${staleRecover.stderr.trim()}`,
    );
  const freshRecover = await runBinary(
    [
      "device",
      "recover",
      ...profileFlag,
      "--recovery-code-file",
      await writeRecoveryCodeFile(
        isolatedDirectory,
        rotatedRecoveryCode,
        "rotated",
      ),
      "--no-input",
      "--json",
    ],
    device2.env,
    device2.repo,
  );
  if (freshRecover.exitCode !== 0)
    throw new Error(
      `rotated recovery code failed: exit=${freshRecover.exitCode} ${freshRecover.stderr.trim()}`,
    );
  if (parseJsonLines(freshRecover.stdout).at(-1)?.via !== "recovery-code")
    throw new Error(
      "rotated recovery code did not unlock the Account Master Key",
    );

  // The last active recovery-code wrapper cannot be revoked: it would strand
  // the account with no way to recover the AMK, so the guard refuses.
  const revokeGuard = await runBinary(
    [
      "device",
      "revoke-wrapper",
      ...profileFlag,
      "--wrapper-id",
      backupWrapperId,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    repositoryDirectory,
  );
  if (revokeGuard.exitCode !== 4)
    throw new Error(
      `last-wrapper revocation was not guarded: exit=${revokeGuard.exitCode} ${revokeGuard.stderr.trim()}`,
    );
  if (parseJsonLines(revokeGuard.stderr).at(-1)?.code !== "state_conflict")
    throw new Error(
      `revocation guard reported the wrong diagnostic: ${revokeGuard.stderr.trim()}`,
    );
  const backupStillActive = await database.accountKeyWrapperObject.findFirst({
    where: {
      userId: demoUserId,
      wrapperId: Buffer.from(backupWrapperId, "hex"),
    },
  });
  if (backupStillActive?.retiredAt !== null)
    throw new Error(
      "the revocation guard retired the last active recovery-code wrapper",
    );

  const auditEvents = await database.auditEvent.count({
    where: { actorUserId: demoUserId },
  });
  const operations = await database.operation.findMany({
    where: { actorUserId: demoUserId },
    select: { status: true, kind: true, actorDeviceId: true, createdAt: true },
  });
  if (operations.length < 3)
    throw new Error(
      `operations were not committed: ${JSON.stringify(operations)}`,
    );
  // Two commands can be rejected after the API has staged them, and a
  // rejected command stays staged until its TTL expires. The revocation
  // guard always stages. The losing simultaneous setup stages only when it
  // passes the client pre-check and loses inside the establishment
  // transaction; a loss at the pre-check leaves no operation.
  const staged = operations
    .filter((operation) => operation.status === "STAGED")
    .sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
  const revocation = staged.at(-1);
  if (
    (staged.length !== 1 && staged.length !== 2) ||
    revocation === undefined ||
    revocation.kind !== "ACCOUNT_KEY" ||
    revocation.actorDeviceId !== deviceId
  )
    throw new Error(
      `expected the guarded revocation to be the last staged operation, found ${staged.length}`,
    );
  const losingSetup = staged.length === 2 ? staged[0] : undefined;
  if (
    losingSetup &&
    (losingSetup.kind !== "ACCOUNT_KEY" ||
      losingSetup.actorDeviceId !== loser.deviceId)
  )
    throw new Error(
      "the extra staged operation is not the losing device setup",
    );
  if (auditEvents < 1)
    throw new Error("the audit trail recorded nothing for the demo user");

  console.log(
    `✓ full-stack e2e passed: setup, init, push, pull, diff, history, rollback, TTY safety, logout/relogin, and the full Account Master Key lifecycle (3-Device cross-device decrypt, live simultaneous device setup, User-defined Value opened on a second Device after AMK recovery, one-shot transfer, rotation, revocation guard) against real API + PostgreSQL + Valkey (${operations.length} committed operations, ${auditEvents} audit events)`,
  );
} finally {
  server?.stop(true);
  heldPort?.release();
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
