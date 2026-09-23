import { argon2id } from "@noble/hashes/argon2.js";

// Off-main-thread Argon2id worker entrypoint.
//
// This is the *worker* half of the account-key password KDF. It is built
// separately as a self-contained IIFE bundle (it imports only noble's
// argon2id, so the bundle embeds the KDF with no other module graph) and its
// source is handed to the runtime through
// `globalThis.__DOTRELAY_ARGON2_WORKER_SOURCE__`. `runArgon2id` (in index.ts)
// spawns a Worker from that source when it is present, moving the KDF off the
// browser main thread; otherwise it falls back to main-thread noble, which is
// the CLI/Bun and test path.
//
// Message protocol (structured-cloned both ways; the ikm buffer is transferred
// back so it is not copied):
//   main -> worker : { id, password, salt, params: { memoryKiB, iterations, parallelism } }
//   worker -> main : { id, ikm }

export type Argon2KdfParams = Readonly<{
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}>;

export type Argon2WorkerRequest = Readonly<{
  readonly id: number;
  readonly password: Uint8Array;
  readonly salt: Uint8Array;
  readonly params: Argon2KdfParams;
}>;

export type Argon2WorkerReply = Readonly<{
  readonly id: number;
  readonly ikm: Uint8Array;
}>;

// A narrow structural view of the worker global so this entrypoint typechecks
// under both lib configurations it is compiled in: the client package's DOM
// lib and, via the client's type graph, consumers such as the CLI under an
// ES-only lib (where the WebWorker `self`/`MessageEvent`/`Transferable`
// globals are not declared). In a dedicated worker `globalThis` is the
// `DedicatedWorkerGlobalScope`, so the runtime behavior is unchanged.
type Argon2WorkerScope = {
  onmessage:
    | ((event: Readonly<{ readonly data: Argon2WorkerRequest }>) => void)
    | null;
  postMessage(
    message: Argon2WorkerReply,
    transfer: readonly ArrayBuffer[],
  ): void;
};

const scope = globalThis as unknown as Argon2WorkerScope;

scope.onmessage = (event) => {
  const { id, password, salt, params } = event.data;
  const ikm = argon2id(password, salt, {
    t: params.iterations,
    m: params.memoryKiB,
    p: params.parallelism,
    dkLen: 32,
  });
  scope.postMessage({ id, ikm }, [ikm.buffer as ArrayBuffer]);
};
