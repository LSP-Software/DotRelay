import { describe, expect, test } from "bun:test";
import {
  isProcessControlName,
  processControlPullWarning,
  unallowedProcessControlNames,
} from "./env-safety";

describe("process-control Variable names", () => {
  test("flags loader, interpreter, and shell-control names", () => {
    for (const name of [
      "PATH",
      "Path",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "BASH_ENV",
      "ENV",
      "PROMPT_COMMAND",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "PERL5OPT",
      "PERL5LIB",
      "RUBYOPT",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_GLOBAL",
      "JAVA_TOOL_OPTIONS",
      "BASH_FUNC_ls%%",
      "npm_config_script_shell",
    ])
      expect(isProcessControlName(name)).toBe(true);
  });

  test("flags toolchain and launcher hooks", () => {
    for (const name of [
      // Go runs -toolexec programs and downloads toolchains.
      "GOFLAGS",
      "GOTOOLCHAIN",
      "GOPROXY",
      "CGO_CFLAGS",
      "CGO_LDFLAGS",
      // C and C++ compilers and flags.
      "CC",
      "CXX",
      "LDFLAGS",
      "MAKEFLAGS",
      // Rust.
      "RUSTC_WRAPPER",
      "RUSTC_WORKSPACE_WRAPPER",
      "RUSTFLAGS",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER",
      // Openers and configuration directories.
      "BROWSER",
      "XDG_CONFIG_HOME",
      "XDG_CONFIG_DIRS",
      // JVM build tools, package managers, TLS trust.
      "MAVEN_OPTS",
      "GRADLE_OPTS",
      "YARN_YARN_PATH",
      "PIP_INDEX_URL",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "OPENSSL_CONF",
      "SSL_CERT_FILE",
      "KUBECONFIG",
    ])
      expect(isProcessControlName(name)).toBe(true);
  });

  test("leaves application configuration alone", () => {
    for (const name of [
      "NODE_ENV",
      "node_env",
      "DATABASE_URL",
      "API_KEY",
      "PORT",
      "ENVIRONMENT",
      "PATHNAME_PREFIX",
      "GITHUB_TOKEN",
      "GOOGLE_API_KEY",
      "DOTNET_ENVIRONMENT",
      "CCV_SECRET",
      "CACHE_URL",
      "UV_THREADPOOL_SIZE",
    ])
      expect(isProcessControlName(name)).toBe(false);
  });

  test("an explicit allowance covers exactly the named Variables", () => {
    expect(
      unallowedProcessControlNames(
        ["PATH", "NODE_OPTIONS", "API_KEY"],
        ["node_options"],
      ),
    ).toEqual(["PATH"]);
  });

  test("pull warns about new process-control Variables only", () => {
    expect(processControlPullWarning(["API_KEY", "PORT"])).toBeNull();
    const warning = processControlPullWarning(["API_KEY", "NODE_OPTIONS"]);
    expect(warning).toContain("NODE_OPTIONS controls how programs");
    expect(warning).toContain("dotrelay history");
  });
});
