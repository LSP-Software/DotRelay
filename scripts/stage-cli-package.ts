import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const targetPlatform = process.env.DOTRELAY_TARGET_PLATFORM ?? process.platform;
const targetArch = process.env.DOTRELAY_TARGET_ARCH ?? process.arch;
const binaryName = targetPlatform === "win32" ? "dotrelay.exe" : "dotrelay";
const platformDirectory = `${targetPlatform}-${targetArch}`;
const root = join(import.meta.dir, "..");
const source =
  process.env.DOTRELAY_BINARY_SOURCE ??
  join(root, "apps", "cli", "dist", binaryName);
const destination = join(
  root,
  "packages",
  "dotrelay",
  "dist",
  platformDirectory,
  binaryName,
);

export const stageCliPackage = async (): Promise<string> => {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
  return destination;
};

if (import.meta.main) {
  await stageCliPackage();
  console.log(`staged ${platformDirectory}/${binaryName}`);
}
