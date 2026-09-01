import { type ParsedArguments, parseArguments } from "./args";
import {
  createSessionStore,
  loginWithDeviceAuthorization,
  openVerificationPage,
} from "./auth";
import { detectGitHubRepository, type GitRemote } from "./context";
import {
  createNativeCredentialStore,
  type NativeCredentialStore,
} from "./credentials";
import { CliError, diagnosticForError, EXIT_CODES } from "./errors";
import {
  addServerProfile,
  createFileProfileCatalog,
  type FetchFunction,
  profileCatalogPath,
  resolveServerProfile,
  useServerProfile,
} from "./profile";

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
    "  device enroll|recover               Manage an authorized Device",
    "",
    "Context and protected workflows:",
    "  context                             Detect the GitHub Repository",
    "  project link --team <team>          Link a Project explicitly",
    "  env use <name>                      Select an Environment",
    "  init <environment> --from <file>    Create a reviewed genesis Revision",
    "  push --from <file>                  Publish a reviewed Revision",
    "  pull --output <file>                Safely export locally decrypted Values",
    "  history | rollback <revision>       Verify history or append a Rollback",
    "  status                              Show non-secret local state",
    "",
    "Global options: --profile, --environment, --json, --no-input",
    "Output: --stdout requires --reveal when stdout is a terminal; Values are never diagnostic data.",
    "Security: --insecure and credential-bearing flags are not supported.",
  ].join("\n");
};

export const main = (args: string[]): string => {
  if (args.includes("--version")) return version;
  return renderHelp();
};

export type CliRuntime = Readonly<{
  readonly profilePath?: string;
  readonly credentials?: NativeCredentialStore;
  readonly fetch?: FetchFunction;
  readonly open?: (url: string) => Promise<void>;
  readonly readGitRemotes?: () => Promise<readonly GitRemote[]>;
  readonly stdoutIsTerminal?: boolean;
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
    throw new Error("could not read Git remotes");
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
        .map(([key, entry]) => `${key}: ${String(entry)}`)
        .join("\n")}\n`;

const execute = async (
  args: readonly string[],
  runtime: CliRuntime,
): Promise<Readonly<{ value: Record<string, unknown> }>> => {
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
    const profile = await addServerProfile(
      store,
      name,
      origin,
      runtime.fetch ? { fetch: runtime.fetch } : {},
    );
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
    const selected = catalog.selected
      ? catalog.profiles.find((profile) => profile.name === catalog.selected)
      : undefined;
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
        noOpen: parsed.noOpen,
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
    return {
      value: {
        profile: profile.name,
        repository: `${repository.host}/${repository.owner}/${repository.name}`,
        remoteNames: repository.remoteNames,
      },
    };
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
      stdout: renderSuccess(parsed, result.value),
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
