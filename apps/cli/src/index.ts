import { dirname, isAbsolute, resolve } from "node:path";
import type { CliDeviceStorage } from "@dotrelay/client";
import {
  createEnvironment,
  createStrictJsonClient,
  findProjectByRepository,
  linkProject,
  listEnvironments,
  resolveTeamForProject,
  type StrictJsonClient,
  selectEnvironment,
} from "./admin";
import {
  type ParsedArguments,
  parseArguments,
  rejectForbiddenFlags,
} from "./args";
import {
  createSessionStore,
  loginWithDeviceAuthorization,
  openVerificationPage,
} from "./auth";
import {
  detectGitHubRepository,
  type GitRemote,
  readWorktreeContext,
  resolveEnvironmentSelection,
  resolveGitHubRepository,
  worktreeConfigPath,
  writeWorktreeContext,
} from "./context";
import {
  createNativeCredentialStore,
  type NativeCredentialStore,
} from "./credentials";
import { deviceMetadataPath, readDeviceId } from "./device-storage";
import {
  CliError,
  CliInvocationError,
  diagnosticForError,
  EXIT_CODES,
  humanDetailForError,
  sanitizeCliText,
} from "./errors";
import {
  addServerProfile,
  createFileProfileCatalog,
  type FetchFunction,
  profileCatalogPath,
  resolveServerProfile,
  useServerProfile,
} from "./profile";
import type { TerminalIo } from "./terminal";
import {
  approveDeviceEnrollment,
  beginDeviceEnrollment,
  completeDeviceEnrollment,
  createRecoveryBackup,
  enrollDevice,
  enrollFirstDevice,
  restoreRecoveryKit,
  runProtectedWorkflow,
} from "./workflow";
import { paint, renderStep, rewriteRegion, writeNotice } from "./ui";

export type { TerminalIo };

export const version = "0.0.0-foundation";

export const renderHelp = (): string => {
  return [
    "Usage: dotrelay <command>",
    "",
    "  setup <origin>   Trust this Server Profile, sign in, enroll this machine",
    "  login            Sign in and enroll this machine",
    "  init             Publish this repo's .env for the first time",
    "  push             Publish changes from .env",
    "  pull             Write decrypted Values to .env",
    "  diff             Compare .env with the Environment",
    "  status           Show this machine's connection",
    "",
    "More commands: dotrelay help",
    "Automation: --json  --no-input  --debug",
  ].join("\n");
};

export const renderPowerHelp = (): string => {
  return [
    "Usage: dotrelay <command>",
    "",
    "Everyday:",
    "  setup <origin>   Trust this Server Profile, sign in, enroll this machine",
    "  login            Sign in and enroll this machine",
    "  init             Publish this repo's .env for the first time",
    "  push             Publish changes from .env",
    "  pull             Write decrypted Values to .env",
    "  diff             Compare .env with the Environment",
    "  status           Show this machine's connection",
    "",
    "Power:",
    "  profile add <name> <origin>   Trust and save a Server Profile",
    "  profile use <name>            Select the global Server Profile",
    "  profile list                  List saved Server Profiles",
    "  logout                        Remove the local session",
    "  device enroll                 Bootstrap or begin Device enrollment",
    "  device begin --output <file>  Begin dual-control enrollment",
    "  device approve --from <file>  Approve an enrollment handoff",
    "  device complete --from <file> Complete an approved enrollment",
    "  device backup --output <file> Create a Recovery Kit",
    "  device recover --from <file>  Restore a Device from a Recovery Kit",
    "  context                       Detect the GitHub Repository",
    "  project link --team <team>    Link a Project explicitly",
    "  env use <environment-id>      Select an Environment by opaque id",
    "  history                       List verified Revision metadata",
    "  rollback <revision>           Append a lane-scoped Rollback",
    "",
    "Global: --profile  --environment  --json  --debug  --no-input",
    "Publish: --classify NAME=shared|user-defined  --from <file>  --team <id>",
    "Pull: --output <file>  --stdout  --reveal",
    "Diff: --from <file>  --reveal",
    "Profile trust: setup and profile add accept --accept-profile <id> under --no-input.",
    "Values are never diagnostic data. --insecure and credential flags are not supported.",
  ].join("\n");
};

export const main = (args: string[]): string => {
  rejectForbiddenFlags(args);
  if (args.includes("--version")) return version;
  return renderHelp();
};

export type CliRuntime = Readonly<{
  readonly profilePath?: string;
  readonly credentials?: NativeCredentialStore;
  readonly fetch?: FetchFunction;
  readonly githubFetch?: FetchFunction;
  readonly deviceId?: string;
  readonly open?: (url: string) => Promise<void>;
  readonly readGitRemotes?: () => Promise<readonly GitRemote[]>;
  readonly worktreeConfig?: string;
  readonly admin?: StrictJsonClient;
  readonly stdoutIsTerminal?: boolean;
  readonly prompt?: (question: string) => Promise<string>;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly terminal?: TerminalIo;
  readonly deviceStorage?: CliDeviceStorage;
  readonly stateDirectory?: string;
}>;

export type CliRunResult = Readonly<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

const readGitRemotes = async (): Promise<readonly GitRemote[]> => {
  try {
    const child = Bun.spawn(
      ["git", "config", "--get-regexp", "^remote\\..*\\.url$"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (exitCode !== 0 && exitCode !== 1) throw new Error("git config failed");
    return Object.freeze(
      stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const separator = line.indexOf(" ");
          return Object.freeze({
            name: line.slice("remote.".length, separator).replace(/\.url$/, ""),
            url: line.slice(separator + 1),
          });
        }),
    );
  } catch {
    throw new CliError(
      "local-io",
      "could not read Git remotes",
      {},
      "repository_detection_failed",
    );
  }
};

const defaultWorktreeConfigPath = async (): Promise<string> => {
  try {
    const child = Bun.spawn(["git", "rev-parse", "--git-dir"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [directory, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error("git directory unavailable");
    const gitDirectory = directory.trim();
    if (!gitDirectory) throw new Error("git directory unavailable");
    return worktreeConfigPath(
      isAbsolute(gitDirectory) ? gitDirectory : resolve(gitDirectory),
    );
  } catch {
    throw new CliInvocationError("could not locate the Git worktree context");
  }
};

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

const renderStatusCard = (value: Record<string, unknown>): string => {
  const profile =
    typeof value.profile === "string" ? value.profile : "No Server Profile";
  const origin =
    typeof value.origin === "string"
      ? value.origin
      : "run dotrelay setup <origin>";
  const signedIn = value.authenticated === true;
  const enrolled = value.device === "enrolled";
  return [
    `  ${paint("·", "wax")}  ${paint(profile, "paper")}`,
    `     ${paint(origin, "graphite")}`,
    `     ${paint(signedIn ? "Signed in" : "Not signed in", signedIn ? "ok" : "dim")}`,
    `     ${paint(enrolled ? "Device enrolled" : "No Device", enrolled ? "ok" : "dim")}`,
    "",
  ].join("\n");
};

const renderSuccess = (
  parsed: ParsedArguments,
  value: Record<string, unknown>,
): string => {
  if (parsed.json) return json({ ok: true, ...value });
  if (parsed.command === "status") return renderStatusCard(value);
  if (typeof value.message === "string")
    return `${sanitizeCliText(value.message)}\n`;
  return `${Object.entries(value)
    .map(([key, entry]) => {
      const rendered =
        typeof entry === "string"
          ? entry
          : entry !== null && typeof entry === "object"
            ? JSON.stringify(entry)
            : String(entry);
      return `${sanitizeCliText(key)}: ${sanitizeCliText(rendered ?? "")}`;
    })
    .join("\n")}\n`;
};

const profileNameFromOrigin = (origin: string): string => {
  let host = "default";
  try {
    host = new URL(origin).hostname;
  } catch {
    throw new CliInvocationError(
      "Server Profile origin must be an absolute URL",
    );
  }
  const normalized = host
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)
    ? normalized
    : "default";
};

const confirmProfileTrust = async (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  candidate: Readonly<{
    readonly origin: string;
    readonly pin: { readonly serverProfileId: string };
  }>,
): Promise<boolean> => {
  if (parsed.acceptProfile === candidate.pin.serverProfileId) return true;
  if (parsed.noInput) return false;
  const output = runtime.terminal?.output ?? process.stderr;
  output.write(
    renderStep("Trust this Server Profile?", [
      candidate.origin,
      candidate.pin.serverProfileId,
    ]),
  );
  if (runtime.confirm) return runtime.confirm(`Trust ${candidate.origin}?`);
  const { readTerminalLine } = await import("./terminal");
  const answer = runtime.prompt
    ? await runtime.prompt(`Trust ${candidate.origin}? [Y/n]`)
    : await readTerminalLine(`Trust ${candidate.origin}? [Y/n]`, runtime.terminal);
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "" || trimmed === "y" || trimmed === "yes";
};

const deviceWorkflowOptions = (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  profile: Awaited<ReturnType<typeof resolveServerProfile>>,
  credentials: NativeCredentialStore,
) => {
  const stateDirectory =
    runtime.stateDirectory ??
    dirname(runtime.profilePath ?? profileCatalogPath());
  return {
    profile,
    credentials,
    ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    ...(runtime.deviceStorage ? { deviceStorage: runtime.deviceStorage } : {}),
    ...(runtime.admin ? { admin: runtime.admin } : {}),
    ...(runtime.deviceId ? { deviceId: runtime.deviceId } : {}),
    stateDirectory,
    contextPath: runtime.worktreeConfig ?? "",
    ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
    ...(runtime.confirm ? { confirm: runtime.confirm } : {}),
    ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
    noInput: parsed.noInput,
    stdoutIsTerminal: runtime.stdoutIsTerminal ?? false,
  };
};

const loginAndEnroll = async (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  profile: Awaited<ReturnType<typeof resolveServerProfile>>,
): Promise<Record<string, unknown>> => {
  const credentials = runtime.credentials ?? createNativeCredentialStore();
  const output = runtime.terminal?.output ?? process.stderr;
  let waitLines = 0;
  const login = await loginWithDeviceAuthorization(
    profile.pin,
    createSessionStore(credentials),
    {
      noOpen: parsed.noOpen || parsed.noInput,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      open: runtime.open ?? openVerificationPage,
      onAuthorization: async (authorization) => {
        if (parsed.json) return;
        waitLines = rewriteRegion(
          output,
          0,
          renderStep("Allow this CLI?", [authorization.userCode], "Waiting for the browser"),
        );
      },
    },
  );
  if (!parsed.json) {
    waitLines = rewriteRegion(output, waitLines, "");
    writeNotice(output, "Signed in");
  }
  const enrollment = await enrollFirstDevice(
    deviceWorkflowOptions(parsed, runtime, profile, credentials),
  );
  if (!parsed.json)
    writeNotice(
      output,
      enrollment.existing ? "Device already enrolled" : "Device enrolled",
    );
  return {
    profile: profile.name,
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    deviceId: enrollment.deviceId,
    device: enrollment.active ? "enrolled" : "not enrolled",
    message: enrollment.existing
      ? "Signed in. Device already enrolled."
      : "Signed in. Device enrolled.",
  };
};

const execute = async (
  args: readonly string[],
  runtime: CliRuntime,
): Promise<
  Readonly<{ value: Record<string, unknown> | { stdout: string } }>
> => {
  const parsed = parseArguments(
    args,
    runtime.stdoutIsTerminal === undefined
      ? {}
      : { stdoutIsTerminal: runtime.stdoutIsTerminal },
  );
  const store = createFileProfileCatalog(
    runtime.profilePath ?? profileCatalogPath(),
  );
  if (parsed.command === "help")
    return { value: { stdout: `${renderPowerHelp()}\n` } };
  if (parsed.command === "setup") {
    const origin = parsed.positionals[0];
    if (!origin) throw new CliInvocationError("setup requires an origin");
    const catalog = await store.read();
    const existing = catalog.profiles.find(
      (profile) => profile.origin === origin,
    );
    const profile =
      existing ??
      (await addServerProfile(store, profileNameFromOrigin(origin), origin, {
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        confirm: (candidate) =>
          confirmProfileTrust(parsed, runtime, candidate),
      }));
    const selected = (await store.read()).selected;
    if (selected !== profile.name) await useServerProfile(store, profile.name);
    return { value: await loginAndEnroll(parsed, runtime, profile) };
  }
  if (parsed.command === "profile" && parsed.subcommand === "add") {
    const [name, origin] = parsed.positionals;
    if (!name || !origin)
      throw new Error("profile add requires a name and origin");
    const profile = await addServerProfile(store, name, origin, {
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      confirm: (candidate) => confirmProfileTrust(parsed, runtime, candidate),
    });
    return {
      value: {
        profile: profile.name,
        origin: profile.origin,
        serverProfileId: profile.pin.serverProfileId,
        message: `Trusted ${profile.origin}`,
      },
    };
  }
  if (parsed.command === "profile" && parsed.subcommand === "use") {
    const name = parsed.positionals[0];
    if (!name) throw new Error("profile use requires a name");
    const profile = await useServerProfile(store, name);
    return {
      value: { profile: profile.name, origin: profile.origin, selected: true },
    };
  }
  if (parsed.command === "profile" && parsed.subcommand === "list") {
    const catalog = await store.read();
    return {
      value: {
        profiles: catalog.profiles.map(({ name, origin, pin }) => ({
          name,
          origin,
          serverProfileId: pin.serverProfileId,
        })),
        ...(catalog.selected ? { selected: catalog.selected } : {}),
      },
    };
  }
  if (parsed.command === "status") {
    const catalog = await store.read();
    const selected = parsed.profile
      ? catalog.profiles.find((profile) => profile.name === parsed.profile)
      : catalog.selected
        ? catalog.profiles.find((profile) => profile.name === catalog.selected)
        : undefined;
    if (parsed.profile && !selected)
      await resolveServerProfile(store, parsed.profile);
    const authenticated = selected
      ? Boolean(
          await createSessionStore(
            runtime.credentials ?? createNativeCredentialStore(),
          ).get(selected.pin),
        )
      : false;
    const stateDirectory =
      runtime.stateDirectory ??
      dirname(runtime.profilePath ?? profileCatalogPath());
    const enrolled = selected
      ? Boolean(
          await readDeviceId(deviceMetadataPath(stateDirectory, selected.pin)),
        )
      : false;
    return {
      value: {
        profile: selected?.name ?? null,
        origin: selected?.origin ?? null,
        authenticated,
        device: enrolled ? "enrolled" : "not enrolled",
      },
    };
  }
  if (parsed.command === "login") {
    const profile = await resolveServerProfile(store, parsed.profile);
    return { value: await loginAndEnroll(parsed, runtime, profile) };
  }
  if (parsed.command === "logout") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    await createSessionStore(credentials).remove(profile.pin);
    return { value: { profile: profile.name, loggedOut: true } };
  }
  if (parsed.command === "context") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const repository = detectGitHubRepository(
      await (runtime.readGitRemotes ?? readGitRemotes)(),
    );
    const resolvedRepository = await resolveGitHubRepository(repository, {
      ...(runtime.githubFetch ? { fetch: runtime.githubFetch } : {}),
    });
    const context = await readWorktreeContext(
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath()),
    );
    if (context && context.serverProfileId !== profile.pin.serverProfileId)
      throw new CliInvocationError(
        "worktree context belongs to a different Server Profile",
      );
    return {
      value: {
        profile: profile.name,
        repository: `${resolvedRepository.host}/${resolvedRepository.owner}/${resolvedRepository.name}`,
        remoteNames: resolvedRepository.remoteNames,
        githubRepositoryId: resolvedRepository.githubRepositoryId,
        ...(context ? { projectId: context.projectId } : {}),
        ...(context?.environmentId
          ? { environmentId: context.environmentId }
          : {}),
        ...(resolveEnvironmentSelection(parsed.environment, context)
          ? {
              environment: resolveEnvironmentSelection(
                parsed.environment,
                context,
              )?.value,
            }
          : {}),
      },
    };
  }
  if (parsed.command === "project" && parsed.subcommand === "link") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const team = parsed.team;
    if (!team)
      throw new CliInvocationError("project link requires --team <team-id>");
    const repository = await resolveGitHubRepository(
      detectGitHubRepository(
        await (runtime.readGitRemotes ?? readGitRemotes)(),
      ),
      { ...(runtime.githubFetch ? { fetch: runtime.githubFetch } : {}) },
    );
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    const admin =
      runtime.admin ??
      createStrictJsonClient(profile.pin, credentials, {
        ...(runtime.deviceId ? { deviceId: runtime.deviceId } : {}),
      });
    const project = await linkProject(admin, {
      teamId: team,
      repository: {
        ...repository,
        githubRepositoryId:
          repository.githubRepositoryId ??
          (() => {
            throw new CliError(
              "transient",
              "GitHub repository identity was not resolved",
              {},
              "repository_resolution_failed",
            );
          })(),
      },
    });
    await writeWorktreeContext(
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath()),
      {
        serverProfileId: profile.pin.serverProfileId,
        projectId: project.id,
        ...(project.environment
          ? { environmentId: project.environment.id }
          : {}),
      },
    );
    return {
      value: {
        profile: profile.name,
        projectId: project.id,
        repository: `${repository.host}/${repository.owner}/${repository.name}`,
        ...(project.environment
          ? { environmentId: project.environment.id }
          : {}),
        message: `Linked ${repository.owner}/${repository.name}`,
      },
    };
  }
  if (parsed.command === "env" && parsed.subcommand === "use") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const context = await readWorktreeContext(contextPath);
    if (!context)
      throw new CliInvocationError(
        "No Project selected; use project link before selecting an Environment",
      );
    if (context.serverProfileId !== profile.pin.serverProfileId)
      throw new CliInvocationError(
        "worktree Project belongs to a different Server Profile",
      );
    const environmentId = parsed.environment ?? parsed.positionals[0];
    if (!environmentId) throw new Error("env use requires an Environment id");
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    const admin =
      runtime.admin ??
      createStrictJsonClient(profile.pin, credentials, {
        ...(runtime.deviceId ? { deviceId: runtime.deviceId } : {}),
      });
    const environment = await selectEnvironment(
      admin,
      context.projectId,
      environmentId,
    );
    await writeWorktreeContext(contextPath, {
      ...context,
      environmentId: environment.id,
    });
    return {
      value: {
        profile: profile.name,
        environmentId: environment.id,
        selected: true,
      },
    };
  }
  const deviceTrustCommands = new Set([
    "enroll",
    "begin",
    "approve",
    "complete",
    "backup",
    "recover",
  ]);
  if (
    parsed.command === "device" &&
    deviceTrustCommands.has(parsed.subcommand ?? "")
  ) {
    if (parsed.noInput && !parsed.profile)
      throw new CliInvocationError(
        "--no-input requires explicit --profile for Device trust commands",
      );
    const profile = await resolveServerProfile(store, parsed.profile);
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    const stateDirectory =
      runtime.stateDirectory ??
      dirname(runtime.profilePath ?? profileCatalogPath());
    const workflowOptions = {
      profile,
      credentials,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      ...(runtime.deviceStorage
        ? { deviceStorage: runtime.deviceStorage }
        : {}),
      ...(runtime.admin ? { admin: runtime.admin } : {}),
      ...(runtime.deviceId ? { deviceId: runtime.deviceId } : {}),
      stateDirectory,
      contextPath: runtime.worktreeConfig ?? "",
      ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
      ...(runtime.confirm ? { confirm: runtime.confirm } : {}),
      ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
      noInput: parsed.noInput,
      stdoutIsTerminal: runtime.stdoutIsTerminal ?? false,
    };
    if (parsed.subcommand === "enroll")
      return {
        value: await enrollDevice(workflowOptions, parsed.output),
      };
    if (parsed.subcommand === "begin")
      return {
        value: await beginDeviceEnrollment(workflowOptions, parsed.output),
      };
    if (parsed.subcommand === "approve")
      return {
        value: await approveDeviceEnrollment(
          workflowOptions,
          parsed.from ?? "",
        ),
      };
    if (parsed.subcommand === "complete")
      return {
        value: await completeDeviceEnrollment(
          workflowOptions,
          parsed.from ?? "",
        ),
      };
    if (parsed.subcommand === "backup")
      return {
        value: await createRecoveryBackup(workflowOptions, parsed.output ?? ""),
      };
    return {
      value: await restoreRecoveryKit(workflowOptions, parsed.from ?? ""),
    };
  }
  const protectedCommands = new Set([
    "init",
    "push",
    "pull",
    "diff",
    "history",
    "rollback",
  ]);
  if (protectedCommands.has(parsed.command)) {
    const hasExplicitEnvironment =
      parsed.environment !== undefined ||
      (parsed.command === "init" && parsed.positionals.length === 1);
    if (parsed.noInput && !parsed.profile)
      throw new CliInvocationError(
        "--no-input requires explicit --profile",
      );
    if (
      parsed.noInput &&
      parsed.command !== "init" &&
      parsed.command !== "push" &&
      !hasExplicitEnvironment
    )
      throw new CliInvocationError(
        "--no-input requires explicit --environment context",
      );
    const profile = await resolveServerProfile(store, parsed.profile);
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const stateDirectory =
      runtime.stateDirectory ??
      dirname(runtime.profilePath ?? profileCatalogPath());
    const deviceId =
      runtime.deviceId ??
      (await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin)));
    if (!runtime.admin) {
      const localContext = await readWorktreeContext(contextPath);
      const repository = await resolveGitHubRepository(
        detectGitHubRepository(
          await (runtime.readGitRemotes ?? readGitRemotes)(),
        ),
        { ...(runtime.githubFetch ? { fetch: runtime.githubFetch } : {}) },
      );
      const credentials = runtime.credentials ?? createNativeCredentialStore();
      const admin =
        runtime.admin ??
        createStrictJsonClient(profile.pin, credentials, {
          ...(deviceId ? { deviceId } : {}),
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        });
      const existingProject = await findProjectByRepository(
        admin,
        repository.githubRepositoryId ?? "",
      );
      if (
        !existingProject &&
        parsed.command !== "init" &&
        parsed.command !== "push"
      )
        throw new CliInvocationError(
          "this GitHub Repository is not linked; run dotrelay init first",
        );
      const ask = async (question: string): Promise<string> => {
        if (runtime.prompt) return runtime.prompt(question);
        const { readTerminalLine } = await import("./terminal");
        return readTerminalLine(question, runtime.terminal);
      };
      const write = (message: string): void => {
        const output = runtime.terminal?.output ?? process.stderr;
        output.write(message);
      };
      const initializedProject =
        existingProject ??
        (await linkProject(admin, {
          teamId: (
            await resolveTeamForProject(admin, {
              ...(parsed.team ? { teamId: parsed.team } : {}),
              suggestedName: repository.owner,
              noInput: parsed.noInput,
              prompt: ask,
              write,
              ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
            })
          ).id,
          repository: {
            ...repository,
            githubRepositoryId: repository.githubRepositoryId ?? "",
          },
        }));
      if (localContext && localContext.projectId !== initializedProject.id)
        throw new CliInvocationError(
          "the saved Project does not match this GitHub Repository",
        );
      let environmentId =
        parsed.environment ??
        (parsed.command === "init" ? parsed.positionals[0] : undefined) ??
        localContext?.environmentId ??
        initializedProject.environment?.id;
      if (!environmentId) {
        const environments = await listEnvironments(
          admin,
          initializedProject.id,
        );
        environmentId = environments[0]?.id;
      }
      if (
        !environmentId &&
        (parsed.command === "init" || parsed.command === "push")
      )
        environmentId = (await createEnvironment(admin, initializedProject.id))
          .id;
      await writeWorktreeContext(contextPath, {
        serverProfileId: profile.pin.serverProfileId,
        projectId: initializedProject.id,
        ...(environmentId ? { environmentId } : {}),
      });
    }
    const workflowResult = await runProtectedWorkflow(
      {
        profile,
        credentials: runtime.credentials ?? createNativeCredentialStore(),
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        ...(runtime.deviceStorage
          ? { deviceStorage: runtime.deviceStorage }
          : {}),
        ...(runtime.admin ? { admin: runtime.admin } : {}),
        ...(deviceId ? { deviceId } : {}),
        stateDirectory,
        contextPath,
        ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
        ...(runtime.confirm ? { confirm: runtime.confirm } : {}),
        ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
        noInput: parsed.noInput,
        stdoutIsTerminal: runtime.stdoutIsTerminal ?? false,
      },
      parsed,
    );
    return { value: workflowResult };
  }
  throw new CliError(
    "invocation",
    `command ${parsed.command}${parsed.subcommand ? ` ${parsed.subcommand}` : ""} is not available in this foundation build`,
    {},
    "command_unavailable",
  );
};

export const run = async (
  args: readonly string[],
  runtime: CliRuntime = {},
): Promise<CliRunResult> => {
  try {
    rejectForbiddenFlags(args);
    if (args.includes("--help") || args.length === 0)
      return {
        exitCode: EXIT_CODES.success,
        stdout: `${renderHelp()}\n`,
        stderr: "",
      };
    if (args.includes("--version"))
      return {
        exitCode: EXIT_CODES.success,
        stdout: `${version}\n`,
        stderr: "",
      };
    const result = await execute(args, runtime);
    const parsed = parseArguments(
      args,
      runtime.stdoutIsTerminal === undefined
        ? {}
        : { stdoutIsTerminal: runtime.stdoutIsTerminal },
    );
    return {
      exitCode: EXIT_CODES.success,
      stdout:
        "stdout" in result.value
          ? String(result.value.stdout)
          : renderSuccess(parsed, result.value),
      stderr: "",
    };
  } catch (error) {
    const diagnostic = diagnosticForError(error, {
      debug: args.includes("--debug"),
    });
    const parsed = args.includes("--json");
    return {
      exitCode: diagnostic.exitCode,
      stdout: "",
      stderr: parsed
        ? json(diagnostic)
        : `${humanDetailForError(error, {
            debug: args.includes("--debug"),
          })}\n`,
    };
  }
};

if (import.meta.main) {
  const result = await run(
    Bun.argv.slice(2),
    process.stdout.isTTY === undefined
      ? {}
      : { stdoutIsTerminal: process.stdout.isTTY },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (typeof process.stdin.setRawMode === "function")
    process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(result.exitCode);
}
