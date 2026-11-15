import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteProtectedFile, protectedTemporaryPath } from "./output";
import type { WorkflowOptions } from "./workflow-core";
import { guardPullOutputAgainstGit } from "./workflow-publication";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "dotrelay-backup-safety-"));
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", directory, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0)
      throw new Error(await new Response(child.stderr).text());
    return output.trim();
  };
  await git("init", "-q");
  return { directory, git, output: join(directory, ".env") };
};

test("pull backups stay out of git add even when only .env was ignored", async () => {
  const { directory, git, output } = await fixture();
  try {
    await writeFile(join(directory, ".gitignore"), ".env\n");
    await writeFile(output, "SECRET=old\n");
    await guardPullOutputAgainstGit({} as WorkflowOptions, output);
    await atomicWriteProtectedFile(output, "SECRET=new\n", {
      retainPrevious: true,
    });
    expect(await readFile(`${output}.previous`, "utf8")).toBe("SECRET=old\n");
    await git("add", ".");
    expect(await git("ls-files")).toBe(".gitignore");
    expect(await git("check-ignore", ".env.previous")).toBe(".env.previous");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tracked backup blocks replacement before either plaintext file changes", async () => {
  const { directory, git, output } = await fixture();
  try {
    await writeFile(output, "SECRET=original\n");
    await writeFile(`${output}.previous`, "tracked-backup\n");
    await git("add", ".env.previous");
    await expect(
      guardPullOutputAgainstGit({} as WorkflowOptions, output),
    ).rejects.toMatchObject({ code: "output_tracked" });
    expect(await readFile(output, "utf8")).toBe("SECRET=original\n");
    expect(await readFile(`${output}.previous`, "utf8")).toBe(
      "tracked-backup\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("literal Git metacharacters in plaintext output filenames remain excluded", async () => {
  const { directory, git } = await fixture();
  try {
    const output = join(directory, ".env[local]");
    await guardPullOutputAgainstGit({} as WorkflowOptions, output);
    await atomicWriteProtectedFile(output, "SECRET=old\n");
    await atomicWriteProtectedFile(output, "SECRET=new\n", {
      retainPrevious: true,
    });
    await git("add", ".");
    expect(await git("ls-files")).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("orphaned plaintext temporary files stay excluded before any write", async () => {
  const { directory, git } = await fixture();
  try {
    for (const name of [
      ".env",
      "nested/.env[local]",
      "nested/name with spaces.env",
    ]) {
      const output = join(directory, name);
      await guardPullOutputAgainstGit({} as WorkflowOptions, output);
      for (const target of [output, `${output}.previous`]) {
        const temporary = protectedTemporaryPath(target);
        await atomicWriteProtectedFile(temporary, "SECRET=interrupted-write\n");
        expect(await git("check-ignore", temporary)).toBe(temporary);
      }
    }
    await git("add", ".");
    expect(await git("ls-files")).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every rotated pull backup stays out of git add", async () => {
  const { directory, git, output } = await fixture();
  try {
    await writeFile(output, "SECRET=0\n");
    await guardPullOutputAgainstGit({} as WorkflowOptions, output);
    for (const value of ["1", "2", "3", "4"])
      await atomicWriteProtectedFile(output, `SECRET=${value}\n`, {
        retainPrevious: true,
      });
    expect(await readFile(`${output}.previous.2`, "utf8")).toBe("SECRET=1\n");
    await git("add", ".");
    expect(await git("ls-files")).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a symlinked output that points at a tracked file is refused", async () => {
  const { directory, git } = await fixture();
  try {
    await mkdir(join(directory, "config"));
    await mkdir(join(directory, "apps", "x"), { recursive: true });
    await writeFile(join(directory, "config", "dev.env"), "SHARED=1\n");
    await git("add", "config/dev.env");
    const output = join(directory, "apps", "x", ".env");
    await symlink("../../config/dev.env", output);
    await expect(
      guardPullOutputAgainstGit({} as WorkflowOptions, output),
    ).rejects.toMatchObject({ code: "output_tracked" });
    expect(await readFile(join(directory, "config", "dev.env"), "utf8")).toBe(
      "SHARED=1\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a symlink outside any repository into a tracked file is refused", async () => {
  const { directory, git } = await fixture();
  const elsewhere = await mkdtemp(join(tmpdir(), "dotrelay-link-outside-"));
  try {
    await writeFile(join(directory, "shared.env"), "SHARED=1\n");
    await git("add", "shared.env");
    const output = join(elsewhere, ".env");
    await symlink(join(directory, "shared.env"), output);
    await expect(
      guardPullOutputAgainstGit({} as WorkflowOptions, output),
    ).rejects.toMatchObject({ code: "output_tracked" });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("an untracked symlink target is excluded in its own repository", async () => {
  const { directory, git } = await fixture();
  try {
    await mkdir(join(directory, "config"));
    await mkdir(join(directory, "apps", "x"), { recursive: true });
    await writeFile(join(directory, "config", "dev.env"), "SHARED=1\n");
    const output = join(directory, "apps", "x", ".env");
    await symlink("../../config/dev.env", output);
    await guardPullOutputAgainstGit({} as WorkflowOptions, output);
    await atomicWriteProtectedFile(output, "SECRET=new\n", {
      followSymlink: true,
    });
    expect(await readFile(join(directory, "config", "dev.env"), "utf8")).toBe(
      "SECRET=new\n",
    );
    await git("add", "config");
    expect(await git("ls-files", "config")).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
