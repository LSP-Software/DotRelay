import { afterEach, describe, expect, jest, test } from "bun:test";
import { generateSigningKeyPair } from "@dotrelay/contracts";
import { createAccountKeyWrapper, generateAccountMasterKey } from "../index";

type WorkerHost = { __DOTRELAY_ARGON2_WORKER_SOURCE__?: string };

const setWorkerSource = (source: string | undefined): void => {
  (globalThis as WorkerHost).__DOTRELAY_ARGON2_WORKER_SOURCE__ = source;
};

const createPasswordWrapper = async (signingPrivateKey?: CryptoKey) =>
  createAccountKeyWrapper({
    serverProfileId: "11111111-1111-4111-8111-111111111111",
    userId: new Uint8Array(16).fill(7),
    deviceId: new Uint8Array(16).fill(9),
    userIdentityGeneration: 1,
    createdAtMs: 1_700_000_000_000,
    accountMasterKey: generateAccountMasterKey(),
    signingPrivateKey:
      signingPrivateKey ?? (await generateSigningKeyPair()).privateKey,
    kind: {
      type: "password",
      password: new TextEncoder().encode("pw"),
      kdf: { memoryKiB: 8, iterations: 1, parallelism: 1 },
    },
  });

// A stand-in worker that answers with a fixed key: enough to prove a fresh
// worker is used once a failed one has been discarded.
const ANSWERING_WORKER = `self.onmessage = (event) => {
  self.postMessage({ id: event.data.id, ikm: new Uint8Array(32) });
};`;

afterEach(() => {
  jest.useRealTimers();
  setWorkerSource(undefined);
});

describe("Argon2 worker failure", () => {
  test("a crashing worker rejects the pending unlock and is replaced", async () => {
    setWorkerSource(`self.onmessage = () => { throw new Error("oom"); };`);
    await expect(createPasswordWrapper()).rejects.toThrow(
      "password key derivation failed",
    );
    setWorkerSource(ANSWERING_WORKER);
    const wrapper = await createPasswordWrapper();
    expect(wrapper.wrapperType).toBeDefined();
  });

  test("a worker that never answers rejects after the timeout", async () => {
    const { privateKey } = await generateSigningKeyPair();
    jest.useFakeTimers();
    setWorkerSource(`self.onmessage = () => {};`);
    // With the signing key in hand, the request reaches the worker (and arms
    // its timeout) synchronously.
    const pending = createPasswordWrapper(privateKey);
    jest.advanceTimersByTime(120_000);
    await expect(pending).rejects.toThrow("password key derivation timed out");
    jest.useRealTimers();
    setWorkerSource(ANSWERING_WORKER);
    expect((await createPasswordWrapper()).wrapperType).toBeDefined();
  });
});
