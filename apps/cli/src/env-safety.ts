import { CliError, sanitizeCliLine } from "./errors";

// Variable names that change how a program, its loader, its interpreter, or
// a shell starts, rather than configuring the application itself. Any active
// Member can publish a Variable, so `dotrelay run` and `export --format
// shell` refuse these names unless the user allows each one by name with
// --allow-env: a Member who sets NODE_OPTIONS, PATH, LD_PRELOAD or BASH_ENV
// would otherwise run code as every teammate who starts a command through
// DotRelay. Names are compared case-insensitively because Windows treats
// environment names that way.
const PROCESS_CONTROL_NAMES: ReadonlySet<string> = new Set([
  // Command lookup, home-relative configuration, and shells.
  "PATH",
  "HOME",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "PS1",
  "PS4",
  "SHELLOPTS",
  "BASHOPTS",
  "IFS",
  "CDPATH",
  "ZDOTDIR",
  // Node.js, Bun, and Deno.
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "BUN_OPTIONS",
  "DENO_DIR",
  // Ruby, Perl, PHP, Lua, Java, .NET.
  "RUBYOPT",
  "RUBYLIB",
  "PERLLIB",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "LUA_INIT",
  "LUA_PATH",
  "LUA_CPATH",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
  "DOTNET_STARTUP_HOOKS",
  // The C library and helpers that tools start on the user's behalf.
  "GCONV_PATH",
  "LOCPATH",
  "HOSTALIASES",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "LESSOPEN",
  "LESSCLOSE",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
]);

const PROCESS_CONTROL_PREFIXES: readonly string[] = [
  "LD_",
  "DYLD_",
  "BASH_FUNC_",
  "PYTHON",
  "PERL5",
  "GIT_",
  "NPM_CONFIG_",
  "COR_",
  "CORECLR_",
];

export const isProcessControlName = (name: string): boolean => {
  const upper = name.toUpperCase();
  return (
    PROCESS_CONTROL_NAMES.has(upper) ||
    PROCESS_CONTROL_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
};

// The process-control names among `names` that the user did not allow.
export const unallowedProcessControlNames = (
  names: readonly string[],
  allowed: readonly string[] = [],
): readonly string[] => {
  const allowedUpper = new Set(allowed.map((name) => name.toUpperCase()));
  return names.filter(
    (name) =>
      isProcessControlName(name) && !allowedUpper.has(name.toUpperCase()),
  );
};

// Stops `run` or the shell export before anything starts or is printed
// when an Environment Variable would control the process rather than
// configure the application.
export const refuseProcessControlNames = (
  names: readonly string[],
  allowed: readonly string[],
  action: string,
): void => {
  const refused = unallowedProcessControlNames(names, allowed);
  if (refused.length === 0) return;
  const listed = refused.map(sanitizeCliLine).join(", ");
  const flags = refused
    .map((name) => `--allow-env ${sanitizeCliLine(name)}`)
    .join(" ");
  throw new CliError(
    "invocation",
    `${listed} would control how the command or its shell starts, and any Member of the Team can set ${refused.length === 1 ? "it" : "them"}, so nothing was ${action}. Check who set ${refused.length === 1 ? "this Variable" : "these Variables"} with dotrelay history; if you trust the ${refused.length === 1 ? "Value" : "Values"}, re-run with ${flags}.`,
    { variableNames: listed.slice(0, 512) },
    "process_control_variable",
  );
};

// The warning pull prints when a process-control Variable is new to the
// file it writes: the file itself is inert, but loading it into a shell or
// a process manager hands that Variable to every command started there.
export const processControlPullWarning = (
  names: readonly string[],
): string | null => {
  const flagged = names.filter(isProcessControlName);
  if (flagged.length === 0) return null;
  const listed = flagged.map(sanitizeCliLine).join(", ");
  return `${listed} ${flagged.length === 1 ? "controls" : "control"} how programs or shells start, not just your application. Any Member of the Team can set ${flagged.length === 1 ? "it" : "them"}; check dotrelay history before loading this file into a shell or process manager.`;
};
