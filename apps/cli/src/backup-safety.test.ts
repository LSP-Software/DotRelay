import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
