import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const selectorDirectory = join(import.meta.dir, "..", "packages", "dotrelay");
const platformDirectory = `${process.platform}-${process.arch}`;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "DOTRELAY_BINARY"),
);

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

// A project-local install: <project>/node_modules/dotrelay with the
// selector's bin directory and, optionally, a packaged binary script.
const installSelector = async (
  binary?: string,
): Promise<Readonly<{ project: string; selector: string }>> => {
  const project = await mkdtemp(join(tmpdir(), "dotrelay-launcher-"));
  directories.push(project);
  const packageDirectory = join(project, "node_modules", "dotrelay");
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  for (const file of ["dotrelay.mjs", "is-launchable-executable.mjs"])
    await writeFile(
      join(packageDirectory, "bin", file),
      await readFile(join(selectorDirectory, "bin", file), "utf8"),
    );
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "dotrelay", version: "1.2.3" })}\n`,
  );
  if (binary !== undefined) {
    const target = join(
      packageDirectory,
      "dist",
      platformDirectory,
      "dotrelay",
    );
    await mkdir(join(packageDirectory, "dist", platformDirectory), {
      recursive: true,
    });
    await writeFile(target, binary);
    await chmod(target, 0o755);
  }
  return { project, selector: join(packageDirectory, "bin", "dotrelay.mjs") };
};

// The published selector runs under Node; fall back to Bun where Node is
// not installed so the launcher contract is still exercised.
const runtime = Bun.which("node") ?? process.execPath;

const launch = (selector: string, cwd: string, env = environment) =>
  Bun.spawn([runtime, selector, "--version"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

describe.skipIf(process.platform === "win32")("npm selector launcher", () => {
  test("never launches a binary from the surrounding project", async () => {
    const { project, selector } = await installSelector();
    const planted = join(project, "apps", "cli", "dist", "dotrelay");
    await mkdir(join(project, "apps", "cli", "dist"), { recursive: true });
    await writeFile(planted, "#!/bin/sh\necho planted-binary-ran\n");
    // The removed monorepo fallback resolved <package>/../../apps/cli/dist,
    // which for a project-local install is this file in the project itself.
    await chmod(planted, 0o755);
    const child = launch(selector, project);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout).not.toContain("planted-binary-ran");
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `no native binary is packaged for ${platformDirectory}`,
    );
  });

  test("requires DOTRELAY_BINARY to be an absolute path", async () => {
    const { project, selector } = await installSelector();
    await writeFile(
      join(project, "dotrelay"),
      "#!/bin/sh\necho relative-ran\n",
    );
    await chmod(join(project, "dotrelay"), 0o755);
    const child = launch(selector, project, {
      ...environment,
      DOTRELAY_BINARY: "./dotrelay",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout).not.toContain("relative-ran");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("DOTRELAY_BINARY must be an absolute path");
  });

  test("forwards SIGTERM to the binary and reports its exit", async () => {
    const { project, selector } = await installSelector(
      "#!/bin/sh\ntrap 'echo got-term; exit 7' TERM\necho ready\nwhile :; do sleep 0.05; done\n",
    );
    const child = launch(selector, project);
    const reader = child.stdout.getReader();
    let stdout = "";
    while (!stdout.includes("ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += new TextDecoder().decode(value);
    }
    child.kill("SIGTERM");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += new TextDecoder().decode(value);
    }
    expect(await child.exited).toBe(7);
    expect(stdout).toContain("got-term");
  });

  test("re-raises the signal that ended the binary", async () => {
    const { project, selector } = await installSelector(
      "#!/bin/sh\nkill -HUP $$\n",
    );
    const child = launch(selector, project);
    await child.exited;
    expect(child.signalCode).toBe("SIGHUP");
  });
});
