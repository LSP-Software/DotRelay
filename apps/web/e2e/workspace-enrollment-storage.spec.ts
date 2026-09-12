import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPublicationArtifacts,
  type PublicationVariable,
} from "@dotrelay/client";
import {
  encodeSyncPage,
  importSigningPrivateKey,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
import { expect, type Locator, type Page, test } from "@playwright/test";

// Private key paired with E2E_REVISION_SIGNING_TRUST_KEY in
// apps/web/lib/workspace-boundary.ts. It signs the synthetic sync page below
// so the browser session can verify the initial read, while the lanes are
// sealed to the enrolled browser Device's key (captured from its bootstrap
// request) so that same session can decrypt the Variables.
const REVISION_SIGNING_PRIVATE_KEY =
  "302e020100300506032b657004220420f324c9e7c9d895e589d126c472bc8d36c5b0ca19313c3821ca37fc4f8aa94fae";

const fixtureIds = {
  serverProfileId: "00000000-0000-4000-8000-000000000062",
  teamId: "00000000-0000-4000-8000-000000000011",
  projectId: "00000000-0000-4000-8000-000000000021",
  environmentId: "00000000-0000-4000-8000-000000000031",
  actorUserId: "00000000-0000-4000-8000-000000000061",
  actorDeviceId: "00000000-0000-4000-8000-000000000040",
};

const fixtureVariables: readonly PublicationVariable[] = [
  {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "OPTIONAL_FLAG",
    description: "Optional rollout toggle.",
    ownership: "USER_DEFINED_VALUE",
    value: null,
    required: false,
    hasDraftChange: true,
  },
  {
    id: "00000000-0000-4000-8000-0000000000a2",
    name: "FEATURE_GATE",
    description: "Feature rollout gate.",
    ownership: "SHARED_VALUE",
    value: null,
    required: false,
    hasDraftChange: true,
  },
];

const hexToBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

const asBufferSource = (input: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
};

const buildVerifiedFixturePage = async (
  devicePublicKey: Uint8Array,
): Promise<Uint8Array> => {
  const signer = await importSigningPrivateKey(
    hexToBytes(REVISION_SIGNING_PRIVATE_KEY),
  );
  const valueRecipientPublicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    asBufferSource(devicePublicKey),
    { name: "X25519" },
    false,
    [],
  );
  const artifacts = await createPublicationArtifacts(fixtureVariables, {
    ...fixtureIds,
    projectEpoch: 1,
    expectedHeadId: null,
    expectedHeadHash: null,
    valueRecipientPublicKey,
    userDefinedValueRecipientPublicKey: valueRecipientPublicKey,
    signingPrivateKey: signer,
    mutation: "GENESIS",
  });
  const revisionObject = artifacts.stagedObjects.find(
    (object) => object.objectId === artifacts.request.revision.protocolObjectId,
  );
  if (!revisionObject) throw new Error("revision object is missing");
  const revision = parseProtocolObject(revisionObject.bytes);
  const revisionDigest = await sha384(revisionObject.bytes);
  return encodeSyncPage({
    environmentId: fixtureIds.environmentId,
    trustedRevisionId: fixtureIds.environmentId,
    trustedRevisionHash: new Uint8Array(48),
    currentHeadId: artifacts.request.revision.id,
    currentHeadHash: revisionDigest,
    projectEpoch: 1n,
    revisions: [
      {
        id: artifacts.request.revision.id,
        digest: revisionDigest,
        parentId: fixtureIds.environmentId,
        parentHash: new Uint8Array(48),
        mutation: revision.get(35) as number,
        projectEpoch: BigInt(revision.get(30) as number),
        authoredAtMs: BigInt(revision.get(34) as number),
        rollbackTargetId: null,
        objects: await Promise.all(
          artifacts.stagedObjects.map(async (object) => ({
            objectId: object.objectId,
            canonicalBytes: object.bytes,
            digest: await sha384(object.bytes),
          })),
        ),
      },
    ],
    nextCursor: null,
  });
};

const openDevicesView = async (page: Page): Promise<void> => {
  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
};

const openFirstProject = async (page: Page): Promise<void> => {
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
};

const activeEditor = (page: Page): Locator =>
  page.getByTestId("editor-context-active");

const interceptBootstrap = async (
  page: Page,
  seen: {
    readonly bodies: Array<Record<string, string>>;
  },
) => {
  await page.route("**/api/v1/devices/bootstrap**", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postData();
      if (body) seen.bodies.push(JSON.parse(body) as Record<string, string>);
    }
    return route.fulfill({ json: {} });
  });
  // The intercepted Device does not exist on the Server Profile, so the
  // grant bootstrap the shell sends after durable enrollment is stubbed too.
  await page.route("**/api/v1/grants/bootstrap**", (route) =>
    route.fulfill({ json: {} }),
  );
};

test("enrollment is blocked before a Device is created when IndexedDB is unavailable", async ({
  page,
}) => {
  const seen: { bodies: Array<Record<string, string>> } = { bodies: [] };
  await interceptBootstrap(page, seen);
  // indexedDB is a getter-only property on Window.prototype, so a plain
  // assignment is a silent no-op; shadow it with an own data property.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });
  await page.goto("/workspace");
  await openDevicesView(page);
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await expect(
    page.getByText("use persistent storage (IndexedDB)"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator("#devices").getByText("Enroll this browser", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#devices").getByText("This browser is enrolled", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(seen.bodies).toHaveLength(0);
});

test("enrollment is blocked before a Device is created when local storage is denied", async ({
  page,
}) => {
  const seen: { bodies: Array<Record<string, string>> } = { bodies: [] };
  await interceptBootstrap(page, seen);
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (String(key).startsWith("dotrelay"))
        throw new DOMException("local storage is denied", "SecurityError");
      return originalSetItem.call(this, key, value);
    };
  });
  await page.goto("/workspace");
  await openDevicesView(page);
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await expect(page.getByText("blocks local storage")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator("#devices").getByText("Enroll this browser", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#devices").getByText("This browser is enrolled", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(seen.bodies).toHaveLength(0);
});

test("a storage rejection after server creation keeps the pending Device for retry", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seen: { bodies: Array<Record<string, string>> } = { bodies: [] };
  await interceptBootstrap(page, seen);
  await page.addInitScript(() => {
    (globalThis as { __FAKE_IDB_CONFIG__?: unknown }).__FAKE_IDB_CONFIG__ = {
      install: true,
      mode: "abort-device-writes",
    };
  });
  const fakeSource = await readFile(
    join(__dirname, "../../../packages/client/src/storage/fake-indexeddb.js"),
    "utf8",
  );
  await page.addInitScript({ content: fakeSource });
  await page.goto("/workspace");
  await openDevicesView(page);

  await page.getByRole("button", { name: "Enroll browser" }).click();
  // The Device was created on the Server Profile, but the fake backend
  // aborts the record write, so durable enrollment cannot be claimed.
  await expect(page.getByText(/will not survive a reload/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator("#devices").getByText("This browser is enrolled", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(seen.bodies).toHaveLength(1);

  // Retrying replays the same keys and operation identity instead of
  // creating a duplicate remote Device.
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await expect(page.getByText(/will not survive a reload/)).toBeVisible();
  expect(seen.bodies).toHaveLength(2);
  for (const field of ["operationId", "deviceId", "certificate"]) {
    expect(seen.bodies[1]?.[field]).toBe(seen.bodies[0]?.[field]);
  }

  // Once the storage backend recovers, the same pending enrollment
  // completes without a new Device.
  await page.evaluate((next: string) => {
    const handle = (
      globalThis as {
        __fakeIndexedDb?: { readonly setMode: (mode: string) => void };
      }
    ).__fakeIndexedDb;
    handle?.setMode(next);
  }, "healthy");
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await expect(
    page
      .locator("#devices")
      .getByText("This browser is enrolled. Keys stay on this machine."),
  ).toBeVisible({ timeout: 15_000 });
  expect(seen.bodies).toHaveLength(3);
  for (const field of ["operationId", "deviceId", "certificate"]) {
    expect(seen.bodies[2]?.[field]).toBe(seen.bodies[0]?.[field]);
  }
});

test("a successful enrollment survives a reload and a fresh storage instance", async ({
  page,
}) => {
  test.setTimeout(90_000);
  let devicePublicKey: Uint8Array | null = null;
  let syncPage: Uint8Array | null = null;
  await page.route("**/api/v1/devices/bootstrap**", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postData();
      if (body) {
        const { x25519PublicKey } = JSON.parse(body) as {
          readonly x25519PublicKey?: string;
        };
        if (x25519PublicKey) devicePublicKey = hexToBytes(x25519PublicKey);
      }
    }
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/v1/grants/bootstrap**", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route(/\/api\/v1\/environments\/.*\/sync/, async (route) => {
    if (!devicePublicKey) {
      await route.abort();
      return;
    }
    if (!syncPage) syncPage = await buildVerifiedFixturePage(devicePublicKey);
    await route.fulfill({ body: Buffer.from(syncPage), status: 200 });
  });

  await page.goto("/workspace");
  await openFirstProject(page);
  await openDevicesView(page);
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await expect(
    page
      .locator("#devices")
      .getByText("This browser is enrolled. Keys stay on this machine."),
  ).toBeVisible({ timeout: 15_000 });

  // The enrolled session can verify and decrypt the Environment. With a
  // project already selected the sidebar offers it as a button, not a
  // heading.
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
  const editor = activeEditor(page);
  await expect(editor.getByRole("heading", { name: "Variables" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    editor.getByTestId("environment-variable-OPTIONAL_FLAG"),
  ).toBeVisible({ timeout: 30_000 });

  // A reload replaces the page and every storage instance; the stored Device
  // id and the committed record must be enough to recover the enrollment.
  await page.reload();
  await expect(
    page.getByTestId("editor-context-active").getByRole("heading", {
      name: "Variables",
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByTestId("editor-context-active")
      .getByTestId("environment-variable-OPTIONAL_FLAG"),
  ).toBeVisible({ timeout: 30_000 });
  await openDevicesView(page);
  await expect(
    page.locator("#devices").getByText("This browser is enrolled", {
      exact: true,
    }),
  ).toBeVisible();
});
