// The release targets: one native binary, one GitHub release archive, and
// one npm platform package each. Keep this list in step with the build-cli
// matrices in .github/workflows/ci.yml and release.yml. Names use Node's
// process.platform and process.arch values so the npm selector can compute
// the package for the machine it runs on.
export type CliTarget = Readonly<{
  platform: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  // Bun's Linux builds link against glibc; npm skips the package on musl.
  libc?: "glibc";
}>;

export const CLI_TARGETS: readonly CliTarget[] = [
  { platform: "linux", arch: "x64", libc: "glibc" },
  { platform: "linux", arch: "arm64", libc: "glibc" },
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" },
];

export const SELECTOR_PACKAGE = "@dotrelay/cli";

export const cliTargetKey = (target: CliTarget): string =>
  `${target.platform}-${target.arch}`;

export const cliPlatformPackageName = (target: CliTarget): string =>
  `${SELECTOR_PACKAGE}-${cliTargetKey(target)}`;

export const cliBinaryName = (platform: string): string =>
  platform === "win32" ? "dotrelay.exe" : "dotrelay";
