import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const verifyReleaseFiles = async (
  root: string,
  files: Readonly<Record<string, string>>,
) => {
  for (const [name, expected] of Object.entries(files)) {
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes(":") ||
      name.split(/[\\/]/).includes("..") ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new Error("Invalid release checksum entry");
    if (digest(await readFile(join(root, name))) !== expected)
      throw new Error("Release artifact checksum mismatch");
  }
};

export const writeReleaseEvidence = async (
  root: string,
  settings: Readonly<{
    sourceCommit: string;
    approvedCommit: string;
    reviewReportSha256: string;
    tag: string;
    apiImage: string;
    webImage: string;
  }>,
) => {
  if (
    !/^[a-f0-9]{40}$/.test(settings.sourceCommit) ||
    settings.sourceCommit !== settings.approvedCommit ||
    !/^[a-f0-9]{64}$/.test(settings.reviewReportSha256)
  )
    throw new Error("Exact-source independent-review metadata is required");
  if (
    !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(settings.tag) ||
    ![settings.apiImage, settings.webImage].every((ref) =>
      /^[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(ref),
    )
  )
    throw new Error("Version and immutable image references are required");
  const files: Record<string, string> = {};
  const binaries: Record<string, string> = {};
  const collect = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Release artifacts cannot be symlinks");
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (["dotrelay", "dotrelay.exe"].includes(entry.name))
        binaries[relative(root, path).replaceAll("\\", "/")] = digest(
          await readFile(path),
        );
      else if (/^dotrelay-.*\.(?:tar\.gz|zip)$/.test(entry.name))
        files[relative(root, path).replaceAll("\\", "/")] = digest(
          await readFile(path),
        );
    }
  };
  await collect(root);
  for (const os of ["linux-", "darwin-", "win32-"])
    if (!Object.keys(binaries).some((path) => path.includes(os)))
      throw new Error("Release is missing a supported CLI platform");
  if (Object.keys(files).length !== Object.keys(binaries).length)
    throw new Error("Every CLI binary must have its uniquely named archive");
  await verifyReleaseFiles(root, files);
  const manifest = {
    version: 1,
    ...settings,
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    toolchain: JSON.parse(await readFile("ops/bun-toolchain.json", "utf8")),
    lockSha256: digest(await readFile("bun.lock")),
    files,
    binaries,
  };
  await writeFile(
    join(root, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const checksums = {
    ...files,
    "release-manifest.json": digest(
      await readFile(join(root, "release-manifest.json")),
    ),
  };
  await writeFile(
    join(root, "SHA256SUMS"),
    Object.entries(checksums)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hash]) => `${hash}  ${name}\n`)
      .join(""),
  );
  return manifest;
};

if (import.meta.main)
  await writeReleaseEvidence("release-binaries", {
    sourceCommit: process.env.GITHUB_SHA ?? "",
    approvedCommit: process.env.SECURITY_REVIEW_APPROVED_SHA ?? "",
    reviewReportSha256: process.env.SECURITY_REVIEW_REPORT_SHA256 ?? "",
    tag: process.env.RELEASE_TAG ?? "",
    apiImage: process.env.API_IMAGE_REF ?? "",
    webImage: process.env.WEB_IMAGE_REF ?? "",
  });
