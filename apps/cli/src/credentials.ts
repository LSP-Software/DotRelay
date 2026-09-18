import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors";
import { atomicWriteProtectedFile } from "./output";

export type CredentialStore = Readonly<{
  readonly get: (
    service: string,
    account: string,
  ) => Promise<Uint8Array | null>;
  readonly set: (
    service: string,
    account: string,
    secret: Uint8Array,
  ) => Promise<void>;
  readonly delete: (service: string, account: string) => Promise<void>;
}>;

// Local credential store: session tokens and device wrapping keys are AES-
// 256-GCM files under the CLI state directory. One random wrapping key
// (0600) protects every entry, and each entry is bound to its
// (service, account) scope through associated data so a renamed file cannot
// be replayed against another account. The store has no operating-system
// dependencies, so it behaves identically on desktops, headless servers, and
// CI runners.

const STORE_INFO = new TextEncoder().encode("DotRelay\0credential-store\0v1\0");
const ENTRY_VERSION = 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 128;
const KEY_LENGTH = 32;
const HEX_KEY = /^[0-9a-f]{64}$/;

const asBufferSource = (input: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
};

const storeUnavailable = (): CliError =>
  new CliError(
    "local-io",
    "the local credential store is unavailable",
    {},
    "credential_store_unavailable",
  );

const storeInvalid = (): CliError =>
  new CliError(
    "local-io",
    "the local credential store returned an invalid credential",
    {},
    "credential_store_invalid",
  );

const storeWriteFailed = (): CliError =>
  new CliError(
    "local-io",
    "could not save a credential in the local credential store",
    {},
    "credential_store_write_failed",
  );

const storeDeleteFailed = (): CliError =>
  new CliError(
    "local-io",
    "could not remove a credential from the local credential store",
    {},
    "credential_store_delete_failed",
  );

const associatedData = (service: string, account: string): Uint8Array => {
  const scope = new TextEncoder().encode(`${service}\0${account}`);
  const output = new Uint8Array(STORE_INFO.length + scope.length);
  output.set(STORE_INFO);
  output.set(scope, STORE_INFO.length);
  return output;
};

const entryFileName = async (
  service: string,
  account: string,
): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${service}\0${account}`),
    ),
  );
  return `${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}.enc`;
};

const wrappingKey = async (material: Uint8Array): Promise<CryptoKey> => {
  try {
    return await crypto.subtle.importKey(
      "raw",
      asBufferSource(material),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw storeInvalid();
  }
};

const readWrappingKey = async (
  directory: string,
): Promise<CryptoKey | null> => {
  let text: string;
  try {
    text = await readFile(join(directory, "key"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw storeUnavailable();
  }
  const hex = text.trim();
  if (!HEX_KEY.test(hex)) throw storeInvalid();
  return wrappingKey(new Uint8Array(Buffer.from(hex, "hex")));
};

const ensureWrappingKey = async (directory: string): Promise<CryptoKey> => {
  const existing = await readWrappingKey(directory);
  if (existing) return existing;
  const material = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  const key = await wrappingKey(material);
  try {
    await atomicWriteProtectedFile(
      join(directory, "key"),
      `${Buffer.from(material).toString("hex")}\n`,
    );
  } catch {
    throw storeWriteFailed();
  }
  return key;
};

export const createFileCredentialStore = (directory: string): CredentialStore =>
  Object.freeze({
    get: async (service, account) => {
      const key = await readWrappingKey(directory);
      if (!key) return null;
      let entry: Uint8Array;
      try {
        entry = new Uint8Array(
          await readFile(
            join(directory, await entryFileName(service, account)),
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw storeUnavailable();
      }
      if (entry.length < 1 + NONCE_LENGTH + TAG_LENGTH / 8)
        throw storeInvalid();
      if (entry[0] !== ENTRY_VERSION) throw storeInvalid();
      try {
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: asBufferSource(entry.subarray(1, 1 + NONCE_LENGTH)),
              additionalData: asBufferSource(associatedData(service, account)),
              tagLength: TAG_LENGTH,
            },
            key,
            asBufferSource(entry.subarray(1 + NONCE_LENGTH)),
          ),
        );
        return plaintext;
      } catch {
        throw storeInvalid();
      }
    },
    set: async (service, account, secret) => {
      const key = await ensureWrappingKey(directory);
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
      let ciphertext: Uint8Array;
      try {
        ciphertext = new Uint8Array(
          await crypto.subtle.encrypt(
            {
              name: "AES-GCM",
              iv: asBufferSource(nonce),
              additionalData: asBufferSource(associatedData(service, account)),
              tagLength: TAG_LENGTH,
            },
            key,
            asBufferSource(secret),
          ),
        );
      } catch {
        throw storeUnavailable();
      }
      const entry = new Uint8Array(1 + NONCE_LENGTH + ciphertext.length);
      entry[0] = ENTRY_VERSION;
      entry.set(nonce, 1);
      entry.set(ciphertext, 1 + NONCE_LENGTH);
      try {
        await atomicWriteProtectedFile(
          join(directory, await entryFileName(service, account)),
          entry,
        );
      } catch {
        throw storeWriteFailed();
      }
    },
    delete: async (service, account) => {
      try {
        await unlink(join(directory, await entryFileName(service, account)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw storeDeleteFailed();
      }
    },
  });
