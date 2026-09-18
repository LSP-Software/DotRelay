import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCredentialStore } from "./credentials";
import { CliError } from "./errors";

const encoder = new TextEncoder();

const stepSecret = (length: number): Uint8Array => {
  const secret = new Uint8Array(length);
  for (let i = 0; i < secret.length; i += 1) secret[i] = i;
  return secret;
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, i) => byte === right[i]);

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const thrownCode = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof CliError) return error.code;
    throw error;
  }
  throw new Error("expected the store operation to fail");
};

let directory = "";

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

const freshStore = async () => {
  directory = await mkdtemp(join(tmpdir(), "dotrelay-credentials-"));
  const storeDirectory = join(directory, "credentials");
  return { store: createFileCredentialStore(storeDirectory), storeDirectory };
};

describe("file credential store", () => {
  test("returns null from a store that holds nothing", async () => {
    const { store } = await freshStore();
    expect(await store.get("dotrelay-session", "v1:account")).toBeNull();
  });

  test("round-trips text and binary secrets", async () => {
    const { store } = await freshStore();
    const binary = stepSecret(300);
    await store.set("dotrelay-session", "v1:text", encoder.encode("session"));
    await store.set("dotrelay-device-wrap", "v1:wrap", binary);
    expect(await store.get("dotrelay-session", "v1:text")).toEqual(
      encoder.encode("session"),
    );
    const wrap = await store.get("dotrelay-device-wrap", "v1:wrap");
    expect(wrap !== null && sameBytes(wrap, binary)).toBe(true);
  });

  test("round-trips an empty secret", async () => {
    const { store } = await freshStore();
    await store.set("dotrelay-session", "v1:empty", new Uint8Array(0));
    const value = await store.get("dotrelay-session", "v1:empty");
    expect(value?.length).toBe(0);
  });

  test("isolates services and accounts and replaces on save", async () => {
    const { store } = await freshStore();
    await store.set("one", "a", encoder.encode("one-a"));
    await store.set("one", "b", encoder.encode("one-b"));
    await store.set("two", "a", encoder.encode("two-a"));
    await store.set("one", "a", encoder.encode("one-a-again"));
    expect(await store.get("one", "a")).toEqual(encoder.encode("one-a-again"));
    expect(await store.get("one", "b")).toEqual(encoder.encode("one-b"));
    expect(await store.get("two", "a")).toEqual(encoder.encode("two-a"));
    expect(await store.get("two", "b")).toBeNull();
  });

  test("removes entries and tolerates missing ones", async () => {
    const { store } = await freshStore();
    await store.set(
      "dotrelay-session",
      "v1:account",
      encoder.encode("session"),
    );
    await store.delete("dotrelay-session", "v1:account");
    expect(await store.get("dotrelay-session", "v1:account")).toBeNull();
    await store.delete("dotrelay-session", "v1:account");
  });

  test("stores the key and entries with owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const { store, storeDirectory } = await freshStore();
    await store.set(
      "dotrelay-session",
      "v1:account",
      encoder.encode("session"),
    );
    const listing = await readdir(storeDirectory);
    expect(listing).toContain("key");
    const entry = listing.find((name) => name.endsWith(".enc"));
    if (entry === undefined) throw new Error("the entry file is missing");
    const mode = async (path: string): Promise<number> =>
      (await stat(join(storeDirectory, path))).mode & 0o777;
    expect(await mode("key")).toBe(0o600);
    expect(await mode(entry)).toBe(0o600);
    expect((await stat(storeDirectory)).mode & 0o777).toBe(0o700);
  });

  test("reports a corrupted entry as an invalid credential", async () => {
    const { store, storeDirectory } = await freshStore();
    await store.set(
      "dotrelay-session",
      "v1:account",
      encoder.encode("session"),
    );
    const name = (await readdir(storeDirectory)).find((item) =>
      item.endsWith(".enc"),
    );
    if (name === undefined) throw new Error("the entry file is missing");
    const bytes = new Uint8Array(await readFile(join(storeDirectory, name)));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await writeFile(join(storeDirectory, name), bytes);
    expect(await thrownCode(store.get("dotrelay-session", "v1:account"))).toBe(
      "credential_store_invalid",
    );
  });

  test("reports a malformed key file as an invalid credential", async () => {
    const { store, storeDirectory } = await freshStore();
    await store.set(
      "dotrelay-session",
      "v1:account",
      encoder.encode("session"),
    );
    await writeFile(join(storeDirectory, "key"), "not-a-hex-key\n", "utf8");
    expect(await thrownCode(store.get("dotrelay-session", "v1:account"))).toBe(
      "credential_store_invalid",
    );
  });

  test("rejects an entry replayed under another account", async () => {
    const { store, storeDirectory } = await freshStore();
    const first = "v1:first";
    const second = "v1:second";
    await store.set("dotrelay-session", first, encoder.encode("first"));
    await store.set("dotrelay-session", second, encoder.encode("second"));
    const firstFile = join(
      storeDirectory,
      `${await sha256Hex(`dotrelay-session\0${first}`)}.enc`,
    );
    const secondFile = join(
      storeDirectory,
      `${await sha256Hex(`dotrelay-session\0${second}`)}.enc`,
    );
    await rename(firstFile, secondFile);
    expect(await thrownCode(store.get("dotrelay-session", second))).toBe(
      "credential_store_invalid",
    );
  });

  test("fails to save when the state directory is not writable", async () => {
    if (process.platform === "win32" || (process.getuid?.() ?? 1) === 0) return;
    const { store, storeDirectory } = await freshStore();
    await store.set(
      "dotrelay-session",
      "v1:account",
      encoder.encode("session"),
    );
    await chmod(storeDirectory, 0o500);
    try {
      expect(
        await thrownCode(
          store.set("dotrelay-session", "v1:other", encoder.encode("other")),
        ),
      ).toBe("credential_store_write_failed");
    } finally {
      await chmod(storeDirectory, 0o700);
    }
  });
});
