import { dirname, isAbsolute, resolve } from "node:path";
import type { CliDeviceStorage } from "@dotrelay/client";
import {
  createStrictJsonClient,
  findDefaultTeam,
  findProjectByRepository,
  linkProject,
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
import {
  approveDeviceEnrollment,
  beginDeviceEnrollment,
  completeDeviceEnrollment,
  createRecoveryBackup,
  enrollDevice,
  restoreRecoveryKit,
  runProtectedWorkflow,
} from "./workflow";

export const version = "0.0.0-foundation";

export const renderHelp = (): string => {
  return [
    "dotrelay — DotRelay standalone CLI",
    "",
    "Usage: dotrelay <command> [options]",
    "",
    "Server Profile and authentication:",
    "  profile add <name> <https-origin>   Trust and save a Server Profile",
    "  profile use <name>                  Select the global Server Profile",
    "  profile list                        List saved Server Profiles",
    "  login [--profile <name>]            Authenticate in a browser",
    "  logout [--profile <name>]           Remove the local session",
    "  device enroll                         Bootstrap or begin Device enrollment",
    "  device begin --output <file>         Begin dual-control enrollment",
    "  device approve --from <file>         Approve an enrollment handoff",
    "  device complete --from <file>        Complete an approved enrollment",
    "  device backup --output <file>         Create and store a Recovery Kit",
    "  device recover --from <file>         Restore a Device from a Recovery Kit",
    "",
    "Context and protected workflows:",
    "  context                             Detect the GitHub Repository",
    "  project link --team <team>          Link a Project explicitly",
    "  env use <environment-id>            Select an Environment by opaque id",
    "  init [environment]                   Set up or use the Project, then create a genesis Revision from .env",
    "  push --from <file>                  Publish a reviewed Revision",
    "  pull --output <file>                Safely export locally decrypted Values",
    "  history | rollback <revision>       Verify history or append a Rollback",
    "  status                              Show non-secret local state",
    "",
    "Global options: --profile, --environment, --json, --no-input",
    "Publication options: --classify NAME=shared|user-defined",
    "Rollback options: --variable <id> (repeat for lane-scoped Rollback)",
    "Profile trust: profile add requires --accept-profile <server-profile-id>",
    "Output: --stdout requires --reveal when stdout is a terminal; Values are never diagnostic data.",
    "Security: --insecure and credential-bearing flags are not supported.",
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

const renderSuccess = (
  parsed: ParsedArguments,
  value: Record<string, unknown>,
): string =>
  parsed.json
    ? json({ ok: true, ...value })
    : `${Object.entries(value)
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
  if (parsed.command === "profile" && parsed.subcommand === "add") {
    const [name, origin] = parsed.positionals;
    if (!name || !origin)
      throw new Error("profile add requires a name and origin");
    const profile = await addServerProfile(store, name, origin, {
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      confirm: async (candidate) =>
        parsed.acceptProfile === candidate.pin.serverProfileId,
    });
    return {
      value: {
        profile: profile.name,
        origin: profile.origin,
        serverProfileId: profile.pin.serverProfileId,
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
    return {
      value: {
        profile: selected?.name ?? null,
        origin: selected?.origin ?? null,
        authenticated,
        device: "not loaded",
      },
    };
  }
  if (parsed.command === "login") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    const login = await loginWithDeviceAuthorization(
      profile.pin,
      createSessionStore(credentials),
      {
        noOpen: parsed.noOpen || parsed.noInput,
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        open: runtime.open ?? openVerificationPage,
      },
    );
    return {
      value: {
        profile: profile.name,
        userCode: login.userCode,
        verificationUri: login.verificationUri,
        device: "not enrolled",
        next: "dotrelay device enroll",
      },
    };
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
      },
    );
    return {
      value: {
        profile: profile.name,
        projectId: project.id,
        repository: `${repository.host}/${repository.owner}/${repository.name}`,
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
    "history",
    "rollback",
  ]);
  if (protectedCommands.has(parsed.command)) {
    const hasExplicitEnvironment =
      parsed.environment !== undefined ||
      (parsed.command === "init" && parsed.positionals.length === 1);
    if (parsed.noInput && (!parsed.profile || !hasExplicitEnvironment))
      throw new CliInvocationError(
        "--no-input requires explicit --profile and --environment context",
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
    if (!parsed.noInput && !runtime.admin) {
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
        });
      const project = await findProjectByRepository(
        admin,
        repository.githubRepositoryId ?? "",
      );
      if (!project && parsed.command !== "init")
        throw new CliInvocationError(
          "this GitHub Repository is not linked to an accessible Project; run dotrelay init first",
        );
      const initializedProject =
        project ??
        (await linkProject(admin, {
          teamId: parsed.team ?? (await findDefaultTeam(admin)).id,
          repository: {
            ...repository,
            githubRepositoryId: repository.githubRepositoryId ?? "",
          },
        }));
      if (localContext && localContext.projectId !== initializedProject.id)
        throw new CliInvocationError(
          "the saved Project does not match this GitHub Repository",
        );
      await writeWorktreeContext(contextPath, {
        serverProfileId: profile.pin.serverProfileId,
        projectId: initializedProject.id,
        ...(localContext?.environmentId
          ? { environmentId: localContext.environmentId }
          : {}),
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
    const diagnostic = diagnosticForError(error);
    const parsed = args.includes("--json");
    return {
      exitCode: diagnostic.exitCode,
      stdout: "",
      stderr: parsed ? json(diagnostic) : `${diagnostic.detail}\n`,
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
  process.exitCode = result.exitCode;
}
