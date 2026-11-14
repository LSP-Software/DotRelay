import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseFiles, writeReleaseEvidence } from "./release-evidence";

const settings = {
  sourceCommit: "a".repeat(40),
  approvedCommit: "a".repeat(40),
  reviewReportSha256: "b".repeat(64),
  tag: "v1.2.3-alpha.1",
};
test("release evidence binds all exact artifacts and rejects tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "dotrelay-release-"));
  try {
    for (const platform of ["linux-x64", "darwin-arm64", "win32-x64"]) {
      await mkdir(join(root, platform));
      await writeFile(
        join(
          root,
          platform,
          platform.startsWith("win32") ? "dotrelay.exe" : "dotrelay",
        ),
        `synthetic-${platform}`,
      );
    }
    const archive = Bun.spawn(
      [
        "python3",
        "-c",
        "import importlib.util; s=importlib.util.spec_from_file_location('p','scripts/package-release.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.package(__import__('sys').argv[1], 'v1.2.3-alpha.1')",
        root,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await archive.exited).toBe(0);
    const manifest = await writeReleaseEvidence(root, settings);
    expect(Object.keys(manifest.files)).toHaveLength(3);
    expect(manifest.hostedDeployCommit).toBe(settings.sourceCommit);
    expect(manifest).not.toHaveProperty("apiImage");
    expect(
      JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"))
        .hostedDeployCommit,
    ).toBe(settings.sourceCommit);
    expect(await readFile(join(root, "SHA256SUMS"), "utf8")).toContain(
      "release-manifest.json",
    );
    await writeFile(
      join(root, "dotrelay-v1.2.3-alpha.1-linux-x64.tar.gz"),
      "tampered",
    );
    await expect(verifyReleaseFiles(root, manifest.files)).rejects.toThrow(
      "checksum mismatch",
    );
    await expect(
      writeReleaseEvidence(root, {
        ...settings,
        approvedCommit: "e".repeat(40),
      }),
    ).rejects.toThrow("independent-review");
    await expect(
      writeReleaseEvidence(root, { ...settings, tag: "latest-stable" }),
    ).rejects.toThrow("release version tag");
    await rm(join(root, "win32-x64"), { recursive: true });
    await expect(writeReleaseEvidence(root, settings)).rejects.toThrow(
      "missing a supported",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
