import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const binaryName = process.platform === "win32" ? "dotrelay.exe" : "dotrelay";
const platformDirectory = `${process.platform}-${process.arch}`;
const root = join(import.meta.dir, "..");
const source = join(root, "apps", "cli", "dist", binaryName);
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
