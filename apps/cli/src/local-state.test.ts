import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenLocalState } from "./local-state";
import { profileCatalogPath } from "./profile";
import type { WorkflowOptions } from "./workflow-core";
import { readRecoveryCode } from "./workflow-account-key";

const posix = process.platform !== "win32";
const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0))
    await rm(path, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "dotrelay-local-state-"));
  cleanup.push(directory);
  return directory;
};

const mode = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777;

describe.if(posix)("local state permissions", () => {
  test("tightens existing directories to 0700 and files to 0600", async () => {
    const root = await scratch();
    const state = join(root, "dotrelay");
    await mkdir(join(state, "credentials"), { recursive: true });
    await writeFile(join(state, "profiles.json"), "{}");
    await writeFile(join(state, "notes.txt"), "mine");
    await chmod(join(state, "notes.txt"), 0o644);
    await writeFile(join(state, "credentials", "key"), "00");
    await chmod(state, 0o755);
    await chmod(join(state, "credentials"), 0o775);
    await chmod(join(state, "profiles.json"), 0o644);
    await chmod(join(state, "credentials", "key"), 0o640);
    // A link inside the state directory is never followed.
    const outside = join(root, "outside.txt");
    await writeFile(outside, "x");
    await chmod(outside, 0o644);
    await symlink(outside, join(state, "link"));

    await hardenLocalState(state);

    expect(await mode(state)).toBe(0o700);
    expect(await mode(join(state, "credentials"))).toBe(0o700);
    expect(await mode(join(state, "profiles.json"))).toBe(0o600);
    expect(await mode(join(state, "credentials", "key"))).toBe(0o600);
    expect(await mode(outside)).toBe(0o644);
    // Files the CLI did not write keep their modes.
    expect(await mode(join(state, "notes.txt"))).toBe(0o644);
  });

  test("a state directory that does not exist yet is left alone", async () => {
    const root = await scratch();
    await hardenLocalState(join(root, "missing"));
  });
});

describe("the state directory never falls back to the working directory", () => {
  test("requires an absolute home", () => {
    if (process.platform === "win32") return;
    expect(() => profileCatalogPath({})).toThrow("HOME");
    expect(() => profileCatalogPath({ HOME: "relative/home" })).toThrow("HOME");
    expect(profileCatalogPath({ HOME: "/home/me" })).toBe(
      "/home/me/.config/dotrelay/profiles.json",
    );
  });

  test("ignores a relative XDG_CONFIG_HOME, as the XDG spec requires", () => {
    if (process.platform === "win32") return;
    expect(
      profileCatalogPath({ HOME: "/home/me", XDG_CONFIG_HOME: "config" }),
    ).toBe("/home/me/.config/dotrelay/profiles.json");
    expect(
      profileCatalogPath({ HOME: "/home/me", XDG_CONFIG_HOME: "/xdg" }),
    ).toBe("/xdg/dotrelay/profiles.json");
  });

  test("an explicit DOTRELAY_CONFIG_DIR is resolved to an absolute path", () => {
    expect(profileCatalogPath({ DOTRELAY_CONFIG_DIR: "/state" })).toBe(
      join("/state", "profiles.json"),
    );
    expect(
      profileCatalogPath({ DOTRELAY_CONFIG_DIR: "state" }).startsWith(
        process.cwd(),
      ),
    ).toBe(true);
  });
});

describe.if(posix)("--recovery-code-file", () => {
  test("a symlink to a 0600 file never qualifies", async () => {
    const root = await scratch();
    const real = join(root, "code.txt");
    await writeFile(real, "ABCD-EFGH\n", { mode: 0o600 });
    await chmod(real, 0o600);
    const link = join(root, "link.txt");
    await symlink(real, link);
    await expect(
      readRecoveryCode({} as WorkflowOptions, link),
    ).rejects.toMatchObject({ code: "recovery_code_file_invalid" });
  });
});
