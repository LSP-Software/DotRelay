// A minimal IndexedDB double shared by the client unit tests and the web e2e
// specs. It is a self-contained classic script: the e2e specs inline it with
// page.addInitScript, and the unit tests import it for its side effects.
//
// Modes:
//   healthy            — transactions commit normally.
//   hold-commits       — transactions wait for commitAll() before committing,
//                        so tests can observe that work is not durable yet.
//   abort-device-writes — readwrite transactions that put a non-probe record
//                        abort with a quota-style error, modelling quota
//                        exhaustion or an aborted write transaction.
(() => {
  const records = new Map();
  const pendingCommits = new Set();
  let mode = "healthy";

  const schedule = (fn) => setTimeout(fn, 0);

  const makeRequest = () => ({
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  });

  const isProbeKey = (key) =>
    typeof key === "string" && key.startsWith("dotrelay.storage-probe\0");

  const quotaError = () =>
    new Error(
      "QuotaExceededError: the fake IndexedDB backend has no room for this record",
    );

  const createDatabase = () => ({
    close: () => {},
    // Good enough for upgrade handlers in unrelated page code (for example
    // the Next.js dev overlay), which may create stores and indexes.
    createObjectStore: () => ({ createIndex: () => ({}) }),
    transaction: (_name, modeName) =>
      createTransaction(modeName === "readwrite"),
  });

  const createTransaction = (readwrite) => {
    const transaction = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => objectStore,
    };
    let finished = false;
    const finish = (kind, error) => {
      if (finished) return;
      finished = true;
      transaction.error = error ?? null;
      const run = () => {
        if (kind === "complete") transaction.oncomplete?.();
        else if (kind === "abort") transaction.onabort?.();
        else transaction.onerror?.();
      };
      if (kind !== "abort" && mode === "hold-commits") {
        pendingCommits.add(run);
      } else {
        schedule(run);
      }
    };
    const runOrHold = (run) => {
      if (mode === "hold-commits") pendingCommits.add(run);
      else schedule(run);
    };
    const objectStore = {
      get: (key) => {
        const request = makeRequest();
        request.result = records.get(key);
        runOrHold(() => {
          if (finished) return;
          request.onsuccess?.();
          finish("complete");
        });
        return request;
      },
      put: (value) => {
        const request = makeRequest();
        runOrHold(() => {
          const shouldAbort =
            readwrite &&
            mode === "abort-device-writes" &&
            !isProbeKey(value?.key);
          if (shouldAbort) {
            const error = quotaError();
            request.error = error;
            request.onerror?.();
            finish("abort", error);
            return;
          }
          records.set(value.key, value);
          request.result = value.key;
          request.onsuccess?.();
          finish("complete");
        });
        return request;
      },
      delete: (key) => {
        const request = makeRequest();
        runOrHold(() => {
          records.delete(key);
          request.result = undefined;
          request.onsuccess?.();
          finish("complete");
        });
        return request;
      },
      getAll: () => {
        const request = makeRequest();
        runOrHold(() => {
          request.result = [...records.entries()].map(([key, value]) => ({
            ...value,
            key,
          }));
          request.onsuccess?.();
          finish("complete");
        });
        return request;
      },
    };
    return transaction;
  };

  const createFactory = () => ({
    open: () => {
      const request = makeRequest();
      request.onupgradeneeded = null;
      schedule(() => {
        request.result = createDatabase();
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  });

  // Browsers expose indexedDB as a getter-only property on Window.prototype,
  // so a plain assignment is a silent no-op; shadow it with an own property.
  const setIndexedDb = (value) => {
    Object.defineProperty(globalThis, "indexedDB", {
      value,
      writable: true,
      configurable: true,
    });
  };

  const install = (nextMode = "healthy") => {
    mode = nextMode;
    setIndexedDb(createFactory());
    globalThis.__fakeIndexedDb = {
      setMode: (next) => {
        mode = next;
      },
      commitAll: () => {
        const queued = [...pendingCommits];
        pendingCommits.clear();
        for (const run of queued) run();
      },
      reset: () => records.clear(),
    };
  };

  const uninstall = () => {
    delete globalThis.indexedDB;
    delete globalThis.__fakeIndexedDb;
  };

  globalThis.__dotrelayFakeIndexedDb = { install, uninstall };

  const config = globalThis.__FAKE_IDB_CONFIG__;
  if (config?.install) install(config.mode ?? "healthy");
})();
