import { expect, test } from "bun:test";
import { bootstrapFailureMessage } from "./device-provisioning";

test("a signed-out bootstrap failure points at sign-in", () => {
  expect(bootstrapFailureMessage("authentication_required")).toBe(
    "Sign in before setting up this browser.",
  );
});

test("a conflicting bootstrap keeps the plain retry line", () => {
  expect(bootstrapFailureMessage("state_conflict")).toBe(
    "We couldn't set up this browser. Try again.",
  );
});

test("an unavailable server names the retry", () => {
  expect(bootstrapFailureMessage("service_unavailable")).toBe(
    "The server couldn't finish setting up this browser right now. Try again in a moment.",
  );
});

test("a rate-limited bootstrap tells the browser to wait", () => {
  expect(bootstrapFailureMessage("rate_limited")).toBe(
    "The server is limiting requests from this browser right now. Wait a moment, then try again.",
  );
});

test("a revoked device points at the Devices list", () => {
  expect(bootstrapFailureMessage("device_not_active")).toBe(
    "This browser's device is no longer active on the server. It may have been revoked; check the Devices list, then try again.",
  );
});

test("an incompatible server names browser compatibility", () => {
  for (const code of [
    "unsupported_api_version",
    "unsupported_crypto_suite",
    "unsupported_crypto_runtime",
  ] as const)
    expect(bootstrapFailureMessage(code)).toBe(
      "This server uses an API or cryptography this browser can't use. Try a current version of your browser.",
    );
});

test("an invalid bootstrap asks for a retry", () => {
  for (const code of ["invalid_request", "invalid_crypto_object"] as const)
    expect(bootstrapFailureMessage(code)).toBe(
      "The server didn't accept this browser's setup. Try again; if it keeps happening, this browser may not be compatible with the server.",
    );
});

test("an unknown or missing code falls back to a neutral retry", () => {
  for (const code of [null, "some_future_code"] as const)
    expect(bootstrapFailureMessage(code)).toBe(
      "We couldn't set up this browser. Try again; if it keeps failing, the server or your connection may be the problem.",
    );
});

test("repair of an initialized project never publishes a fresh random epoch key", async () => {
  const { createBrowserDeviceStorage, createDeviceBootstrap, uuidToBytes } =
    await import("@dotrelay/client");
  const { e2eWorkspaceBoundary } = await import("./workspace-boundary");
  const { browserDeviceIdKey } = await import("./browser-storage");
  const { repairStaleEpoch } = await import("./device-provisioning");
  const pin = {
    origin: "https://relay.example",
    serverProfileId: crypto.randomUUID(),
  };
  const userId = crypto.randomUUID();
  const bootstrap = await createDeviceBootstrap({ pin, userId });
  const storage = createBrowserDeviceStorage(pin);
  await storage.save(bootstrap.bundle);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const entries = new Map([
    [browserDeviceIdKey(pin.origin, pin.serverProfileId), bootstrap.deviceId],
  ]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: (key: string) => entries.get(key) ?? null },
    },
  });
  const originalFetch = globalThis.fetch;
  const initial = e2eWorkspaceBoundary("hosted");
  const boundary = {
    ...initial,
    profile: { ...initial.profile, ...pin },
    session: { ...initial.session, userId },
    device: {
      ...initial.device,
      active: true,
      id: bootstrap.deviceId,
      encryptionPublicKey: Buffer.from(bootstrap.x25519PublicKey).toString(
        "hex",
      ),
    },
    grantsReady: false,
    epochCurrent: false,
    peerDevices: [],
  };
  let mutations = 0;
  const messages: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") mutations++;
    return Response.json(boundary);
  }) as typeof fetch;
  try {
    await repairStaleEpoch({
      apiOrigin: pin.origin,
      profileId: "hosted",
      boundary,
      selectedEnvironmentId: null,
      environmentId: null,
      selectedTeamName: null,
      onMessage: (message) => {
        messages.push(message);
      },
      onInProgress: () => {},
      onCommit: () => {},
      onOffline: () => {},
      onReplacementNeeded: () => {},
    });
    expect(mutations).toBe(0);
    expect(
      messages.some(
        (message) =>
          typeof message === "string" &&
          message.includes("Recover the existing project key"),
      ),
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
    await storage.remove({ pin, deviceId: uuidToBytes(bootstrap.deviceId) });
  }
});

test("repair proposes replacement when a refreshed boundary revokes the Device", async () => {
  const { e2eWorkspaceBoundary } = await import("./workspace-boundary");
  const { repairStaleEpoch } = await import("./device-provisioning");
  const boundary = e2eWorkspaceBoundary("hosted", {
    deviceId: crypto.randomUUID(),
  });
  const originalFetch = globalThis.fetch;
  let replacements = 0;
  let mutations = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") mutations++;
    return Response.json({
      ...boundary,
      device: { ...boundary.device, active: false },
    });
  }) as typeof fetch;
  try {
    await repairStaleEpoch({
      apiOrigin: boundary.profile.origin,
      profileId: "hosted",
      boundary,
      selectedEnvironmentId: null,
      environmentId: null,
      selectedTeamName: null,
      onMessage: () => {},
      onInProgress: () => {},
      onCommit: () => {},
      onOffline: () => {},
      onReplacementNeeded: () => {
        replacements++;
      },
    });
    expect(replacements).toBe(1);
    expect(mutations).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
