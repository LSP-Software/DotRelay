import {
  createAccountKeyEnvelope,
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  createPublicationArtifacts,
  encodeRecoveryCode,
  generateAccountMasterKey,
  generateRecoveryCode,
  type PublicationVariable,
} from "@dotrelay/client";
import {
  canonicalEncode,
  encodeSyncPage,
  importSigningPrivateKey,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
import { type APIResponse, expect, type Page, test } from "@playwright/test";
import {
  type AccountKeyWrapperEntry,
  accountKeyTrustedKeys,
  accountKeyVerificationContext,
  bytesToHex,
  hexToBytes,
  openProjectEpochEnvelope,
  unlockWithRecoveryCode,
} from "../lib/account-keys";
import { e2eWorkspaceBoundary } from "../lib/workspace-boundary";
import { trustWorkspaceServer } from "./trust-server";

// The fixture's account key objects are signed by the paired private key,
// whose public key the fixture boundary lists as a signing trust key, so
// every wrapper, envelope, and transfer the spec mints verifies in the
// browser the same way objects from a live Device would.
const REVISION_SIGNING_PRIVATE_KEY =
  "302e020100300506032b657004220420f324c9e7c9d895e589d126c472bc8d36c5b0ca19313c3821ca37fc4f8aa94fae";

// The fixture boundary reports this key so account-key objects it names as
// creator can be verified by the browser.
const E2E_REVISION_SIGNING_TRUST_KEY =
  "302a300506032b65700321003106030b2495aaa5b5cdf8c65c723e8f81717a8eeebd45db288714034c80a978";

const fixtureIds = {
  serverProfileId: "00000000-0000-4000-8000-000000000062",
  teamId: "00000000-0000-4000-8000-000000000011",
  projectId: "00000000-0000-4000-8000-000000000021",
  environmentId: "00000000-0000-4000-8000-000000000031",
  actorUserId: "00000000-0000-4000-8000-000000000061",
  actorDeviceId: "00000000-0000-4000-8000-000000000040",
};

// The Project Epoch Key the spec seals the synthetic sync page's shared-value
// lanes to: a browser that opens the matching Account Key Envelope recovers
// exactly this key and decrypts the page.
const EPOCH_KEY = hexToBytes(
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
);

const fixtureVariables: readonly PublicationVariable[] = [
  {
    id: "00000000-0000-4000-8000-0000000000b1",
    name: "RECOVERY_SECRET",
    description: "Shared value sealed to the project epoch key.",
    ownership: "SHARED_VALUE",
    value: "s3cr3t-from-envelope",
    required: false,
    hasDraftChange: true,
  },
  {
    id: "00000000-0000-4000-8000-0000000000b2",
    name: "OPTIONAL_FLAG",
    description: "User value sealed to the Device's key.",
    ownership: "USER_DEFINED_VALUE",
    value: "device-only-value",
    required: false,
    hasDraftChange: true,
  },
];

type DeviceKeys = Readonly<{
  readonly id: string;
  readonly encryptionPublicKey: string;
  readonly signingPublicKey: string;
}>;

type WrapperEntry = Readonly<{
  readonly wrapperId: string;
  readonly type: "recovery-code" | "password" | "passkey-prf";
  readonly object: string;
  readonly createdAt: string;
}>;

type RecoveryScenario = {
  deviceKeys: DeviceKeys | null;
  wrappers: WrapperEntry[];
  /** Account Key Envelope the boundary reports; null until one exists. */
  envelopeB64: string | null;
  syncPage: Uint8Array | null;
  /**
   * Builds the sync page on the first read when it is not known up front:
   * a journey whose browser establishes the project's key itself only learns
   * the epoch key after it completes unlock.
   */
  buildSyncPage: (() => Promise<Uint8Array>) | null;
  abortBoundary: boolean;
  /**
   * True while the browser must establish the project's key itself: the
   * fixture's peer would otherwise report an epoch grant that makes the
   * browser skip the self-mint that would hand it a real epoch key.
   */
  forceNoPeerEpochGrant: boolean;
  wrapperPublishFailuresRemaining: number;
  envelopePublishFailuresRemaining: number;
  publishedWrapperIds: string[];
  onWrapperPublish: (body: Record<string, unknown>) => void;
};

const bytesToBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const asBufferSource = (input: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
};

const importSigningKey = async (): Promise<CryptoKey> =>
  importSigningPrivateKey(hexToBytes(REVISION_SIGNING_PRIVATE_KEY));

const importX25519PublicKey = async (hex: string): Promise<CryptoKey> =>
  globalThis.crypto.subtle.importKey(
    "raw",
    asBufferSource(hexToBytes(hex)),
    { name: "X25519" },
    false,
    [],
  );

// The account's recovery code wrapper, sealed the way setup on any device
// would publish it: the browser unlocks the Account Master Key from the code
// text alone, so this entry is all the service needs to store.
const buildRecoveryCodeWrapper = async (
  options: Readonly<{
    readonly accountMasterKey: Uint8Array;
    readonly recoveryCode: Uint8Array;
    readonly deviceId: string;
    readonly signer: CryptoKey;
  }>,
): Promise<WrapperEntry> => {
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: fixtureIds.serverProfileId,
    userId: hexToBytes(fixtureIds.actorUserId.replaceAll("-", "")),
    deviceId: hexToBytes(options.deviceId.replaceAll("-", "")),
    userIdentityGeneration: 1,
    createdAtMs: Date.now(),
    accountMasterKey: options.accountMasterKey,
    signingPrivateKey: options.signer,
    kind: { type: "recoveryCode", recoveryCode: options.recoveryCode },
  });
  return {
    wrapperId: bytesToHex(wrapper.wrapperId),
    type: "recovery-code",
    object: bytesToBase64(canonicalEncode(wrapper.object)),
    createdAt: new Date().toISOString(),
  };
};

// The Account Key Envelope that hands the project's current epoch key to a
// browser that unlocked the account key: the browser opens it in place of a
// per-Device epoch grant.
const buildEpochEnvelopeB64 = async (
  options: Readonly<{
    readonly accountMasterKey: Uint8Array;
    readonly deviceId: string;
    readonly signer: CryptoKey;
  }>,
): Promise<string> => {
  const envelope = await createAccountKeyEnvelope({
    serverProfileId: fixtureIds.serverProfileId,
    userId: hexToBytes(fixtureIds.actorUserId.replaceAll("-", "")),
    deviceId: hexToBytes(options.deviceId.replaceAll("-", "")),
    createdAtMs: Date.now(),
    accountMasterKey: options.accountMasterKey,
    signingPrivateKey: options.signer,
    kind: {
      type: "projectEpochKey",
      projectId: hexToBytes(fixtureIds.projectId.replaceAll("-", "")),
      projectEpoch: 1,
      contentKey: EPOCH_KEY,
    },
  });
  return bytesToBase64(canonicalEncode(envelope.object));
};

// The synthetic sync page the browser verifies and decrypts after unlock:
// signed by the revision trust key the boundary lists, with the shared-value
// lanes sealed to the project's epoch key and the user lanes to the Device's
// own key — exactly the two keys an unlocked browser holds.
const buildVerifiedFixturePage = async (
  devicePublicKeyHex: string,
  sharedValueSecret: Uint8Array = EPOCH_KEY,
): Promise<Uint8Array> => {
  const signer = await importSigningKey();
  const valueRecipientPublicKey =
    await importX25519PublicKey(devicePublicKeyHex);
  const artifacts = await createPublicationArtifacts(fixtureVariables, {
    ...fixtureIds,
    projectEpoch: 1,
    expectedHeadId: null,
    expectedHeadHash: null,
    valueRecipientPublicKey,
    userDefinedValueRecipientPublicKey: valueRecipientPublicKey,
    sharedValueSecret,
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

// The test stands in for the service when the browser itself established the
// account's key: the dialog's code text unlocks the wrapper the browser
// published, and the key that opens recovers the epoch key from the envelope
// the browser sealed. Both objects verify against the same trust set the
// browser used, built from the captured Device's real keys.
const testSideProjectKeys = async (
  keys: DeviceKeys,
  codeText: string,
  entry: AccountKeyWrapperEntry,
  envelopeB64: string,
): Promise<Uint8Array> => {
  const boundary = e2eWorkspaceBoundary("hosted", {
    deviceId: keys.id,
    accountKeyEnvelope: envelopeB64,
  });
  const verification = {
    trustedKeys: accountKeyTrustedKeys(
      boundary,
      hexToBytes(keys.signingPublicKey),
    ),
    context: accountKeyVerificationContext(boundary),
  };
  const opened = await unlockWithRecoveryCode(entry, codeText, verification);
  const contentKey = await openProjectEpochEnvelope(
    envelopeB64,
    opened.accountMasterKey,
    {
      trustedKeys: verification.trustedKeys,
      context: verification.context,
      projectId: fixtureIds.projectId,
      projectEpoch: 1,
    },
  );
  if (!contentKey)
    throw new Error("the published envelope did not open with the code");
  return contentKey;
};

// The account-key routes live on the API origin; the test environment points
// the workspace at its own origin, so the spec fulfils them here and the
// scenario decides what the service reports.
const installRecoveryRoutes = async (
  page: Page,
  scenario: RecoveryScenario,
): Promise<void> => {
  await page.route("**/api/v1/devices/bootstrap**", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postData();
      if (body) {
        const parsed = JSON.parse(body) as {
          readonly deviceId?: string;
          readonly x25519PublicKey?: string;
          readonly ed25519PublicKey?: string;
        };
        if (
          parsed.deviceId &&
          parsed.x25519PublicKey &&
          parsed.ed25519PublicKey &&
          scenario.deviceKeys === null
        ) {
          scenario.deviceKeys = {
            id: parsed.deviceId,
            encryptionPublicKey: parsed.x25519PublicKey,
            signingPublicKey: parsed.ed25519PublicKey,
          };
        }
      }
    }
    return route.fulfill({ json: {} });
  });
  // The intercepted Device does not exist on the Server Profile, so the
  // grant bootstrap the shell sends after durable enrollment is stubbed too.
  await page.route("**/api/v1/grants/bootstrap**", (route) =>
    route.fulfill({ json: {} }),
  );
  // The fixture boundary reports the enrolled Device's keys as the boundary's
  // own (hard-coded) placeholders; the real keys from the bootstrap capture
  // are what the browser's verification actually needs.
  await page.route("**/api/workspace/boundary**", async (route) => {
    if (scenario.abortBoundary) {
      await route.abort();
      return;
    }
    let real: APIResponse | undefined;
    try {
      real = await route.fetch();
    } catch {
      // A reload can dispose the in-flight request before the fetch settles.
      await route.abort();
      return;
    }
    if (!real) return;
    let body: Record<string, unknown>;
    try {
      body = (await real.json()) as Record<string, unknown>;
    } catch {
      // A reload can dispose the fetched response before its body is read.
      await route.abort().catch(() => {});
      return;
    }
    const device = body.device as Record<string, unknown> | undefined;
    if (device && device.active === true && scenario.deviceKeys) {
      device.encryptionPublicKey = scenario.deviceKeys.encryptionPublicKey;
      device.signingPublicKey = scenario.deviceKeys.signingPublicKey;
    }
    // Every recovery journey establishes the project's key through the
    // Account Key Envelope, never through the per-Device grant tally the
    // fixture's device option would otherwise report as ready.
    body.grantsReady = false;
    if (scenario.forceNoPeerEpochGrant) {
      const peers = body.peerDevices as
        | ReadonlyArray<Record<string, unknown>>
        | undefined;
      if (Array.isArray(peers))
        for (const peer of peers) peer.hasEpochGrant = false;
    }
    if (scenario.envelopeB64 !== null)
      body.accountKeyEnvelope = scenario.envelopeB64;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: body,
    });
  });
  await page.route("**/api/v1/account-keys/wrappers**", (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { wrappers: scenario.wrappers },
      });
    }
    const body = (route.request().postDataJSON() ?? {}) as Record<
      string,
      unknown
    >;
    if (scenario.wrapperPublishFailuresRemaining > 0) {
      scenario.wrapperPublishFailuresRemaining -= 1;
      return route.abort();
    }
    if (typeof body.wrapperId === "string")
      scenario.publishedWrapperIds.push(body.wrapperId);
    scenario.onWrapperPublish(body);
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      json: {
        wrapperId: typeof body.wrapperId === "string" ? body.wrapperId : "",
        idempotent: false,
      },
    });
  });
  await page.route("**/api/v1/account-keys/wrappers/revoke", (route) => {
    const body = (route.request().postDataJSON() ?? {}) as {
      readonly wrapperId?: string;
    };
    scenario.wrappers = scenario.wrappers.filter(
      (wrapper) => wrapper.wrapperId !== body.wrapperId,
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { revoked: true, idempotent: false },
    });
  });
  // The browser seals its choice of the project's epoch key into an envelope
  // it publishes here; capturing the object is how the test learns the key a
  // browser-chosen journey will use to read existing content. A User Value
  // Key envelope is a different object: the first publish wins, and a later
  // one is the same conflict the service returns so the page opens that key
  // instead of sealing later values to a second key.
  let userValueEnvelope: {
    readonly object: string;
    readonly ownerUserId: string;
    readonly valueGeneration: string;
  } | null = null;
  await page.route("**/api/v1/account-keys/envelopes", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          envelopes: userValueEnvelope
            ? [
                {
                  envelopeType: "user-value-key",
                  object: userValueEnvelope.object,
                  ownerUserId: userValueEnvelope.ownerUserId,
                  valueGeneration: userValueEnvelope.valueGeneration,
                },
              ]
            : [],
        },
      });
    }
    if (scenario.envelopePublishFailuresRemaining > 0) {
      scenario.envelopePublishFailuresRemaining -= 1;
      return route.abort();
    }
    const body = (route.request().postDataJSON() ?? {}) as {
      readonly object?: string;
      readonly projectId?: string;
      readonly ownerUserId?: string;
      readonly valueGeneration?: string;
    };
    if (
      typeof body.object === "string" &&
      typeof body.ownerUserId === "string"
    ) {
      if (userValueEnvelope) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          json: { code: "state_conflict" },
        });
      }
      userValueEnvelope = {
        object: body.object,
        ownerUserId: body.ownerUserId,
        valueGeneration:
          typeof body.valueGeneration === "string" ? body.valueGeneration : "1",
      };
    }
    if (typeof body.object === "string" && typeof body.projectId === "string")
      scenario.envelopeB64 = body.object;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      json: { objectId: "", idempotent: false },
    });
  });
  await page.route("**/api/v1/account-keys/transfers", (route) => {
    const body = (route.request().postDataJSON() ?? {}) as {
      readonly transferId?: string;
      readonly recipientDeviceId?: string;
      readonly expiresAt?: string;
    };
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      json: {
        transferId: body.transferId ?? "",
        recipientDeviceId: body.recipientDeviceId ?? "",
        expiresAt:
          body.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        idempotent: false,
      },
    });
  });
  // Tests that redeem transfers register their own route later, so it wins;
  // the generic endpoint refuses every redeem.
  await page.route("**/api/v1/account-keys/transfers/*/accept", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: {
        type: "about:blank",
        title: "Transfer not found",
        status: 409,
        code: "state_conflict",
      },
    }),
  );
  // A live Server always has the page; the test builds it lazily (it may
  // depend on a key the browser only learns by unlocking), so the stand-in
  // waits for it instead of failing the read. The wait is bounded, and a
  // request the page disposed (a reload) ends it.
  await page.route(/\/api\/v1\/environments\/.*\/sync/, async (route) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (!scenario.syncPage && scenario.buildSyncPage) {
        scenario.syncPage = await scenario.buildSyncPage();
        scenario.buildSyncPage = null;
      }
      if (scenario.syncPage) {
        await route
          .fulfill({
            body: Buffer.from(scenario.syncPage),
            status: 200,
          })
          .catch(() => {});
        return;
      }
      if (Date.now() > deadline) {
        await route.abort().catch(() => {});
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
};

// Enroll this browser's Device (intercepted), so the boundary reports an
// active Device whose keys the scenario captured. Desktop navigation only.
const enrollDevice = async (page: Page): Promise<void> => {
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  await page.getByRole("button", { name: "Set up browser" }).click();
  await expect(
    page
      .locator("#devices")
      .getByText(
        "This browser is set up. Its private keys stay on this machine.",
      ),
  ).toBeVisible({ timeout: 15_000 });
};

// Same enrollment through the mobile sheet, where the sidebar is hidden.
const enrollDeviceMobile = async (page: Page): Promise<void> => {
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Devices" })
    .click();
  await page.getByRole("button", { name: "Set up browser" }).click();
  await expect(
    page
      .locator("#devices")
      .getByText(
        "This browser is set up. Its private keys stay on this machine.",
      ),
  ).toBeVisible({ timeout: 15_000 });
};

// Desktop navigation: the sidebar is visible at the default viewport.
const openRecoveryView = async (page: Page): Promise<void> => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Recovery" })
    .click();
  await expect(page.getByTestId("recovery-area")).toBeVisible();
};

// Mobile navigation: below the lg breakpoint the sidebar is hidden and the
// same links live in a sheet the header button opens.
const openRecoveryViewMobile = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Recovery" }).click();
  await expect(page.getByTestId("recovery-area")).toBeVisible();
};

// The decrypted value lives in a masked input, not in text: assert the DOM
// value through the row's screen-reader label instead.
const sharedValueVisible = (page: Page): Promise<void> =>
  expect(
    page
      .getByTestId("editor-context-active")
      .getByTestId("environment-variable-RECOVERY_SECRET")
      .getByLabel("RECOVERY_SECRET value"),
  ).toHaveValue("s3cr3t-from-envelope", { timeout: 30_000 });

// Enters the method input and clicks Unlock. A previous attempt can leave the
// button briefly busy (or, for an unentered method, disabled until the input
// lands), so the fill is retried until the click can actually take effect.
const unlockWith = async (
  page: Page,
  scenario: "recovery-code" | "password" | "transfer",
  value: string,
): Promise<void> => {
  const unlock = page.getByTestId("recovery-unlock");
  await expect(unlock).toBeVisible();
  const input = unlock.getByTestId(
    scenario === "password"
      ? "unlock-password"
      : scenario === "transfer"
        ? "transfer-id-input"
        : "recovery-code-input",
  );
  if (scenario === "recovery-code") {
    await input.fill(value);
    await unlock.getByRole("button", { name: "Unlock" }).click();
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    await input.fill(value);
    const button = unlock.getByRole("button", { name: "Unlock" });
    if (await button.isEnabled()) {
      await button.click();
      return;
    }
    await page.waitForTimeout(250);
  }
  await unlock.getByRole("button", { name: "Unlock" }).click();
};

const scenarioBase = (
  options?: Readonly<{
    readonly forceNoPeerEpochGrant?: boolean;
    readonly onWrapperPublish?: (body: Record<string, unknown>) => void;
  }>,
): RecoveryScenario => ({
  deviceKeys: null,
  wrappers: [],
  envelopeB64: null,
  syncPage: null,
  buildSyncPage: null,
  abortBoundary: false,
  forceNoPeerEpochGrant: options?.forceNoPeerEpochGrant ?? false,
  wrapperPublishFailuresRemaining: 0,
  envelopePublishFailuresRemaining: 0,
  publishedWrapperIds: [],
  onWrapperPublish: options?.onWrapperPublish ?? (() => {}),
});
const installPasskeySimulation = async (
  page: Page,
  mode: "prf" | "unsupported" | "cancelled",
): Promise<void> => {
  await page.addInitScript({
    content: `globalThis.__dotrelayPasskeyMode = ${JSON.stringify(mode)};`,
  });
  await page.addInitScript({
    path: "apps/web/e2e/passkey-platform-simulation.js",
  });
};

const rememberPublishedWrapper = (
  scenario: RecoveryScenario,
  body: Record<string, unknown>,
): void => {
  if (typeof body.wrapperId !== "string" || typeof body.object !== "string")
    return;
  const bytes = new Uint8Array(Buffer.from(body.object, "base64"));
  const wrapperType = parseProtocolObject(bytes).get(86);
  const type =
    wrapperType === 1
      ? "passkey-prf"
      : wrapperType === 2
        ? "password"
        : "recovery-code";
  scenario.wrappers = [
    ...scenario.wrappers,
    {
      wrapperId: body.wrapperId,
      type,
      object: body.object,
      createdAt: new Date().toISOString(),
    },
  ];
};

const prepareUnlockedRecovery = async (
  page: Page,
  scenario: RecoveryScenario,
  surface: "desktop" | "phone" = "desktop",
): Promise<Readonly<{ readonly recoveryCode: string }>> => {
  await installRecoveryRoutes(page, scenario);
  if (surface === "phone") await enrollDeviceMobile(page);
  else await enrollDevice(page);
  const deviceKeys = capturedDeviceKeys(scenario);
  const accountMasterKey = await generateAccountMasterKey();
  const recoveryCode = await generateRecoveryCode();
  const signer = await importSigningKey();
  scenario.wrappers = [
    await buildRecoveryCodeWrapper({
      accountMasterKey,
      recoveryCode,
      deviceId: deviceKeys.id,
      signer,
    }),
  ];
  scenario.envelopeB64 = await buildEpochEnvelopeB64({
    accountMasterKey,
    deviceId: deviceKeys.id,
    signer,
  });
  scenario.syncPage = await buildVerifiedFixturePage(
    deviceKeys.encryptionPublicKey,
  );
  await page.reload();
  if (surface === "phone") await openRecoveryViewMobile(page);
  else await openRecoveryView(page);
  await unlockWith(page, "recovery-code", encodeRecoveryCode(recoveryCode));
  await expect(page.getByTestId("recovery-status")).toBeVisible({
    timeout: 30_000,
  });
  return { recoveryCode: encodeRecoveryCode(recoveryCode) };
};

const capturedDeviceKeys = (scenario: RecoveryScenario): DeviceKeys => {
  const keys = scenario.deviceKeys;
  if (!keys) throw new Error("bootstrap capture missing");
  return keys;
};

test.describe("workspace recovery", () => {
  test("setup shows the recovery code once, and a later visit unlocks and decrypts with it", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const scenario = scenarioBase({
      // The fixture's peer holds the epoch grant by default; the journey
      // needs the browser to establish the key itself, which the browser
      // skips while a peer owns it.
      forceNoPeerEpochGrant: true,
      // Record the wrapper the browser publishes, so the next page offers
      // the recovery-code method and the test can stand in for the service.
      onWrapperPublish: (body) => {
        if (
          typeof body.wrapperId === "string" &&
          typeof body.object === "string"
        ) {
          scenario.wrappers = [
            {
              wrapperId: body.wrapperId,
              type: "recovery-code",
              object: body.object,
              createdAt: new Date().toISOString(),
            },
          ];
        }
      },
    });
    await installRecoveryRoutes(page, scenario);

    // ---- first visit: the account has no recovery methods ----
    await enrollDevice(page);
    await page.reload();
    await openRecoveryView(page);
    const setup = page.getByTestId("recovery-setup");
    await expect(setup).toBeVisible();
    await expect(
      setup.getByRole("button", { name: "Create recovery code" }),
    ).toBeVisible();

    await setup.getByRole("button", { name: "Create recovery code" }).click();
    const codeDialog = page.getByTestId("recovery-code-dialog");
    await expect(codeDialog).toBeVisible({ timeout: 30_000 });
    // Accessibility: the one-time display is an alertdialog and the code
    // itself is readable text, so a screen reader announces the secret the
    // user must save.
    await expect(codeDialog).toHaveAttribute("role", "alertdialog");
    const codeText = (
      await codeDialog.getByTestId("recovery-code-value").innerText()
    ).trim();
    expect(codeText).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){12}$/,
    );
    await codeDialog.getByRole("button", { name: "I saved it" }).click();
    await expect(codeDialog).toBeHidden();
    // The status view replaces the one-time display: the code is never
    // shown again.
    const status = page.getByTestId("recovery-status");
    await expect(status).toBeVisible();
    await expect(status).not.toContainText(codeText);

    // ---- the next visit starts locked and unlocks with the code ----
    // The Account Master Key only ever lived in that first page's memory, so
    // the second visit must recover it from the published wrapper. The test
    // stands in for the service: the same code text unlocks the wrapper the
    // browser published, and that key opens the envelope the browser sealed,
    // recovering the epoch key the page's lanes are sealed to.
    await page.reload();
    await openRecoveryView(page);
    const unlock = page.getByTestId("recovery-unlock");
    await expect(unlock).toBeVisible();
    // A wrong secret fails with one uniform message and never reveals which
    // check rejected it.
    await unlockWith(page, "recovery-code", "WRONG-CODE");
    await expect(
      page
        .getByTestId("recovery-area")
        .getByRole("alert")
        .filter({ hasText: "couldn't unlock" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(unlock.getByTestId("recovery-code-input")).toHaveValue("");

    await unlockWith(page, "recovery-code", codeText);
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });

    const deviceKeys = capturedDeviceKeys(scenario);
    const entry: AccountKeyWrapperEntry | undefined = scenario.wrappers[0];
    if (!entry || scenario.envelopeB64 === null)
      throw new Error("the recovery journey published no wrapper or envelope");
    const contentKey = await testSideProjectKeys(
      deviceKeys,
      codeText,
      entry,
      scenario.envelopeB64,
    );
    // The first editor read can precede the test building the page, so the
    // page is built on first read instead of the read failing and needing a
    // retry.
    scenario.buildSyncPage = () =>
      buildVerifiedFixturePage(deviceKeys.encryptionPublicKey, contentKey);

    // Back in the editor the unlocked key opens the project's envelope, so
    // the shared value the first visit sealed is readable.
    await page
      .locator("aside")
      .getByRole("button", { name: "LSP-Software / DotRelay" })
      .click();
    await sharedValueVisible(page);
  });

  test("the recovery code can be rotated, and the retired code stops working", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const accountMasterKey = await generateAccountMasterKey();
    const firstCode = await generateRecoveryCode();
    const signer = await importSigningKey();
    const scenario = scenarioBase({
      onWrapperPublish: (body) => {
        // Rotation: the service retires the code being replaced, leaving
        // only the wrapper the browser just published.
        if (
          typeof body.wrapperId === "string" &&
          typeof body.object === "string"
        ) {
          scenario.wrappers = [
            {
              wrapperId: body.wrapperId,
              type: "recovery-code",
              object: body.object,
              createdAt: new Date().toISOString(),
            },
          ];
        }
      },
    });
    await installRecoveryRoutes(page, scenario);

    await enrollDevice(page);
    const deviceKeys = capturedDeviceKeys(scenario);
    scenario.wrappers = [
      await buildRecoveryCodeWrapper({
        accountMasterKey,
        recoveryCode: firstCode,
        deviceId: deviceKeys.id,
        signer,
      }),
    ];
    scenario.envelopeB64 = await buildEpochEnvelopeB64({
      accountMasterKey,
      deviceId: deviceKeys.id,
      signer,
    });
    scenario.syncPage = await buildVerifiedFixturePage(
      deviceKeys.encryptionPublicKey,
    );

    await page.reload();
    await openRecoveryView(page);

    // Unlock with the first code.
    await unlockWith(page, "recovery-code", encodeRecoveryCode(firstCode));
    const status = page.getByTestId("recovery-status");
    await expect(status).toBeVisible({ timeout: 30_000 });

    // Rotate: the new code is shown once, the old one retires on commit.
    await status.getByTestId("rotate-recovery-code").click();
    const codeDialog = page.getByTestId("recovery-code-dialog");
    await expect(codeDialog).toBeVisible({ timeout: 30_000 });
    const rotatedCode = (
      await codeDialog.getByTestId("recovery-code-value").innerText()
    ).trim();
    expect(rotatedCode).not.toBe(encodeRecoveryCode(firstCode));
    await codeDialog.getByRole("button", { name: "I saved it" }).click();

    // The retired code is rejected; the rotation is permanent, so the next
    // visit unlocks with the new code only.
    await page.reload();
    await openRecoveryView(page);
    await unlockWith(page, "recovery-code", encodeRecoveryCode(firstCode));
    await expect(
      page
        .getByTestId("recovery-area")
        .getByRole("alert")
        .filter({ hasText: "couldn't unlock" }),
    ).toBeVisible({ timeout: 30_000 });
    await unlockWith(page, "recovery-code", rotatedCode);
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("an encryption password can be added, used after a reload, and removed", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const accountMasterKey = await generateAccountMasterKey();
    const recoveryCode = await generateRecoveryCode();
    const password = "correct-horse-battery-9";
    const signer = await importSigningKey();
    const scenario = scenarioBase({
      onWrapperPublish: (body) => {
        // This journey's only publish is the password wrapper the browser
        // just created; keeping it lets the next page offer that method.
        if (
          typeof body.wrapperId === "string" &&
          typeof body.object === "string"
        ) {
          scenario.wrappers = [
            ...scenario.wrappers,
            {
              wrapperId: body.wrapperId,
              type: "password",
              object: body.object,
              createdAt: new Date().toISOString(),
            },
          ];
        }
      },
    });
    await installRecoveryRoutes(page, scenario);

    await enrollDevice(page);
    const deviceKeys = capturedDeviceKeys(scenario);
    scenario.wrappers = [
      await buildRecoveryCodeWrapper({
        accountMasterKey,
        recoveryCode,
        deviceId: deviceKeys.id,
        signer,
      }),
    ];
    scenario.envelopeB64 = await buildEpochEnvelopeB64({
      accountMasterKey,
      deviceId: deviceKeys.id,
      signer,
    });
    scenario.syncPage = await buildVerifiedFixturePage(
      deviceKeys.encryptionPublicKey,
    );
    await page.reload();
    await openRecoveryView(page);

    // Unlock with the code, then add the password from the status view.
    await unlockWith(page, "recovery-code", encodeRecoveryCode(recoveryCode));
    const status = page.getByTestId("recovery-status");
    await expect(status).toBeVisible({ timeout: 30_000 });

    await status.getByTestId("add-encryption-password").click();
    await page.getByTestId("add-encryption-password-input").fill(password);
    await page.getByTestId("add-encryption-password-confirm").click();
    await expect(
      page.getByRole("status").filter({ hasText: "encryption password" }),
    ).toBeVisible({ timeout: 90_000 });

    // A fresh page unlocks with the password alone: the browser derives the
    // key material from it through the wrapper's KDF.
    await page.reload();
    await openRecoveryView(page);
    await page
      .getByTestId("recovery-unlock")
      .getByTestId("recovery-method-password")
      .click();
    await unlockWith(page, "password", password);
    const reStatus = page.getByTestId("recovery-status");
    await expect(reStatus).toBeVisible({ timeout: 90_000 });

    // Removing the password retires its wrapper; the code still works.
    await reStatus.getByTestId("remove-encryption-password").click();
    const removeDialog = page.getByTestId("remove-password-dialog");
    await expect(removeDialog).toBeVisible();
    await expect(removeDialog).toHaveAttribute("role", "alertdialog");
    await page.getByTestId("remove-password-confirm").click();
    await expect(
      page.getByRole("status").filter({ hasText: "no longer unlocks" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await openRecoveryView(page);
    const final = page.getByTestId("recovery-unlock");
    await expect(final).toBeVisible();
    await expect(final.getByTestId("recovery-method-password")).toBeDisabled();
    await unlockWith(page, "recovery-code", encodeRecoveryCode(recoveryCode));
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a device sends its key to another, which redeems it as a one-time transfer", async ({
    browser,
    page,
  }) => {
    test.setTimeout(240_000);
    const accountMasterKey = await generateAccountMasterKey();
    const recoveryCode = await generateRecoveryCode();
    const signer = await importSigningKey();
    const sender = scenarioBase({});
    const receiver = scenarioBase({});
    // Pre-allocated so the redeem URL's id is known before the transfer is
    // minted; the expired id proves a stale redeem is surfaced as such.
    const activeTransferId = "0123456789abcdef0123456789abcdef";
    const expiredTransferId = "0".repeat(32);
    let activeTransferB64 = "";

    const problemJson = {
      type: "about:blank",
      title: "Transfer expired or already used",
      status: 409,
      code: "state_conflict",
    };

    await installRecoveryRoutes(page, sender);
    await enrollDevice(page);
    const senderDeviceKeys = capturedDeviceKeys(sender);
    sender.wrappers = [
      await buildRecoveryCodeWrapper({
        accountMasterKey,
        recoveryCode,
        deviceId: senderDeviceKeys.id,
        signer,
      }),
    ];
    sender.envelopeB64 = await buildEpochEnvelopeB64({
      accountMasterKey,
      deviceId: senderDeviceKeys.id,
      signer,
    });
    await page.reload();
    await openRecoveryView(page);
    await unlockWith(page, "recovery-code", encodeRecoveryCode(recoveryCode));
    const status = page.getByTestId("recovery-status");
    await expect(status).toBeVisible({ timeout: 30_000 });

    // Stage the transfer toward one of the account's other devices.
    await page.locator("#transfer-target").selectOption({ index: 1 });
    await status.getByTestId("send-transfer-confirm").click();
    const transferNotice = page
      .getByRole("status")
      .filter({ hasText: "Redeemable until" });
    await expect(transferNotice).toBeVisible({ timeout: 30_000 });
    expect(await transferNotice.innerText()).toMatch(/\b[0-9a-f]{32}\b/);

    // ---- the receiving browser: a fresh device on the same account ----
    const receiverContext = await browser.newContext();
    const receiverPage = await receiverContext.newPage();
    await installRecoveryRoutes(receiverPage, receiver);
    // The redeem endpoint is scenario-driven: the active id hands over the
    // transfer object, anything else reports the conflict. Registered after
    // the generic route, so it wins.
    await receiverPage.route(
      "**/api/v1/account-keys/transfers/*/accept",
      (route) => {
        const path = new URL(route.request().url()).pathname;
        const transferId = path.split("/").filter(Boolean).at(-2) ?? "";
        if (transferId === activeTransferId && activeTransferB64) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            json: {
              accepted: true,
              object: activeTransferB64,
              creatorPublicKey: E2E_REVISION_SIGNING_TRUST_KEY,
            },
          });
        }
        return route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          json: problemJson,
        });
      },
    );

    await receiverPage.goto("/workspace");
    await trustWorkspaceServer(receiverPage);
    await receiverPage
      .getByRole("heading", { name: "LSP-Software / DotRelay" })
      .click();
    await receiverPage
      .locator("aside")
      .getByRole("button", { name: "Devices" })
      .click();
    await receiverPage.getByRole("button", { name: "Set up browser" }).click();
    await expect(
      receiverPage
        .locator("#devices")
        .getByText(
          "This browser is set up. Its private keys stay on this machine.",
        ),
    ).toBeVisible({ timeout: 15_000 });
    const receiverDeviceKeys = capturedDeviceKeys(receiver);

    // The transfer the sender staged is sealed to the receiver's key; the
    // service returns it (and only it) to a redeem for this Device.
    const recipientKey = await importX25519PublicKey(
      receiverDeviceKeys.encryptionPublicKey,
    );
    const transfer = await createAccountKeyTransfer({
      serverProfileId: fixtureIds.serverProfileId,
      userId: hexToBytes(fixtureIds.actorUserId.replaceAll("-", "")),
      deviceId: hexToBytes(receiverDeviceKeys.id.replaceAll("-", "")),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 5 * 60 * 1000,
      accountMasterKey,
      recipientDeviceId: receiverDeviceKeys.id,
      recipientEncryptionPublicKey: recipientKey,
      signingPrivateKey: signer,
      transferId: hexToBytes(activeTransferId),
    });
    activeTransferB64 = bytesToBase64(canonicalEncode(transfer.object));
    receiver.wrappers = [
      await buildRecoveryCodeWrapper({
        accountMasterKey,
        recoveryCode,
        deviceId: receiverDeviceKeys.id,
        signer,
      }),
    ];
    receiver.envelopeB64 = await buildEpochEnvelopeB64({
      accountMasterKey,
      deviceId: receiverDeviceKeys.id,
      signer,
    });
    receiver.syncPage = await buildVerifiedFixturePage(
      receiverDeviceKeys.encryptionPublicKey,
    );
    await receiverPage.reload();
    await openRecoveryView(receiverPage);
    await receiverPage
      .getByTestId("recovery-unlock")
      .getByTestId("recovery-method-transfer")
      .click();

    // An expired or unknown transfer is surfaced as such, not as a generic
    // failure.
    await unlockWith(receiverPage, "transfer", expiredTransferId);
    await expect(
      receiverPage
        .getByTestId("recovery-area")
        .getByRole("alert")
        .filter({ hasText: "expired or was already used" }),
    ).toBeVisible({ timeout: 30_000 });

    // The staged transfer redeems and unlocks the receiving browser.
    await unlockWith(receiverPage, "transfer", activeTransferId);
    await expect(receiverPage.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
    await receiverPage
      .locator("aside")
      .getByRole("button", { name: "LSP-Software / DotRelay" })
      .click();
    await sharedValueVisible(receiverPage);
    await receiverContext.close();
  });

  test("an offline service offers retry from the recovery area", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const scenario = scenarioBase({});
    await installRecoveryRoutes(page, scenario);
    await enrollDevice(page);
    const deviceKeys = capturedDeviceKeys(scenario);
    const accountMasterKey = await generateAccountMasterKey();
    const recoveryCode = await generateRecoveryCode();
    const signer = await importSigningKey();
    scenario.wrappers = [
      await buildRecoveryCodeWrapper({
        accountMasterKey,
        recoveryCode,
        deviceId: deviceKeys.id,
        signer,
      }),
    ];
    await page.reload();
    await openRecoveryView(page);
    await expect(page.getByTestId("recovery-unlock")).toBeVisible();

    // The service drops: the recovery area says so plainly and offers the
    // retry that reconnects instead of leaving the user at a dead end.
    scenario.abortBoundary = true;
    await page.getByTestId("recovery-offline").waitFor({ timeout: 30_000 });
    await page
      .getByTestId("recovery-offline")
      .getByRole("button", { name: "Try again" })
      .click();
    scenario.abortBoundary = false;
    await expect(page.getByTestId("recovery-unlock")).toBeVisible({
      timeout: 30_000,
    });
  });
  test("a simulated passkey adds, reloads, unlocks, and decrypts", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    let publishedBody: Record<string, unknown> | null = null;
    const scenario = scenarioBase({
      onWrapperPublish: (body) => {
        publishedBody = body;
        rememberPublishedWrapper(scenario, body);
      },
    });
    await installPasskeySimulation(page, "prf");
    await prepareUnlockedRecovery(page, scenario);

    const status = page.getByTestId("recovery-status");
    await status.getByTestId("add-passkey").click();
    await expect(
      page.getByRole("status").filter({
        hasText: "You can now unlock this account with the passkey",
      }),
    ).toBeVisible({ timeout: 90_000 });
    const passkey = scenario.wrappers.find(
      (wrapper) => wrapper.type === "passkey-prf",
    );
    expect(passkey).toBeDefined();
    expect(publishedBody).not.toBeNull();
    expect(publishedBody).not.toHaveProperty("prfOutput");
    const passkeyObject = parseProtocolObject(
      new Uint8Array(Buffer.from(passkey?.object ?? "", "base64")),
    );
    expect(passkeyObject.get(86)).toBe(1);
    expect(passkeyObject.get(93)).toBeInstanceOf(Uint8Array);
    expect(passkeyObject.get(94)).toBeInstanceOf(Uint8Array);

    await page.reload();
    await openRecoveryView(page);
    const unlock = page.getByTestId("recovery-unlock");
    const passkeyMethod = unlock.getByTestId("recovery-method-passkey-prf");
    await expect(passkeyMethod).toBeEnabled();
    await passkeyMethod.click();
    await unlock.getByTestId("unlock-account").click();
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
    await page
      .locator("aside")
      .getByRole("button", { name: "LSP-Software / DotRelay" })
      .click();
    await sharedValueVisible(page);
  });

  test("a simulated passkey can be removed while the recovery code still works", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const scenario = scenarioBase({
      onWrapperPublish: (body) => rememberPublishedWrapper(scenario, body),
    });
    await installPasskeySimulation(page, "prf");
    const { recoveryCode } = await prepareUnlockedRecovery(page, scenario);

    const status = page.getByTestId("recovery-status");
    await status.getByTestId("add-passkey").click();
    await expect(status.getByTestId("remove-passkey")).toBeVisible({
      timeout: 90_000,
    });
    await status.getByTestId("remove-passkey").click();
    const dialog = page.getByTestId("remove-passkey-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("remove-passkey-confirm").click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "The passkey no longer unlocks this account" }),
    ).toBeVisible({ timeout: 30_000 });
    expect(
      scenario.wrappers.some((wrapper) => wrapper.type === "passkey-prf"),
    ).toBe(false);

    await page.reload();
    await openRecoveryView(page);
    const unlock = page.getByTestId("recovery-unlock");
    await expect(
      unlock.getByTestId("recovery-method-passkey-prf"),
    ).toBeDisabled();
    await unlockWith(page, "recovery-code", recoveryCode);
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a simulated authenticator without PRF leaves recovery unchanged", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const scenario = scenarioBase({
      onWrapperPublish: (body) => rememberPublishedWrapper(scenario, body),
    });
    await installPasskeySimulation(page, "unsupported");
    const { recoveryCode } = await prepareUnlockedRecovery(page, scenario);

    await page
      .getByTestId("recovery-status")
      .getByTestId("add-passkey")
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "can't generate the key material" }),
    ).toBeVisible({ timeout: 30_000 });
    expect(
      scenario.wrappers.some((wrapper) => wrapper.type === "passkey-prf"),
    ).toBe(false);

    await page.reload();
    await openRecoveryView(page);
    await unlockWith(page, "recovery-code", recoveryCode);
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a cancelled simulated passkey prompt leaves recovery unchanged", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const scenario = scenarioBase({
      onWrapperPublish: (body) => rememberPublishedWrapper(scenario, body),
    });
    await installPasskeySimulation(page, "cancelled");
    const { recoveryCode } = await prepareUnlockedRecovery(page, scenario);

    await page
      .getByTestId("recovery-status")
      .getByTestId("add-passkey")
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "The passkey prompt was cancelled" }),
    ).toBeVisible({ timeout: 30_000 });
    expect(
      scenario.wrappers.some((wrapper) => wrapper.type === "passkey-prf"),
    ).toBe(false);

    await page.reload();
    await openRecoveryView(page);
    await unlockWith(page, "recovery-code", recoveryCode);
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("closing the tab before confirming a new recovery code leaves the account unchanged", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    let publishes = 0;
    const scenario = scenarioBase({
      forceNoPeerEpochGrant: true,
      onWrapperPublish: () => {
        publishes += 1;
      },
    });
    await installRecoveryRoutes(page, scenario);
    await enrollDevice(page);
    await page.reload();
    await openRecoveryView(page);
    await page
      .getByTestId("recovery-setup")
      .getByRole("button", { name: "Create recovery code" })
      .click();
    await expect(page.getByTestId("recovery-code-dialog")).toBeVisible({
      timeout: 30_000,
    });
    expect(publishes).toBe(0);
    await page.reload();
    await openRecoveryView(page);
    await expect(page.getByTestId("recovery-setup")).toBeVisible();
    expect(publishes).toBe(0);
    expect(scenario.wrappers).toHaveLength(0);
  });

  test("a lost recovery-code publish is retried as the same code", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const scenario = scenarioBase({
      forceNoPeerEpochGrant: true,
      onWrapperPublish: (body) => {
        if (
          typeof body.wrapperId === "string" &&
          typeof body.object === "string"
        ) {
          scenario.wrappers = [
            {
              wrapperId: body.wrapperId,
              type: "recovery-code",
              object: body.object,
              createdAt: new Date().toISOString(),
            },
          ];
        }
      },
    });
    scenario.wrapperPublishFailuresRemaining = 1;
    await installRecoveryRoutes(page, scenario);
    await enrollDevice(page);
    await page.reload();
    await openRecoveryView(page);
    await page
      .getByTestId("recovery-setup")
      .getByRole("button", { name: "Create recovery code" })
      .click();
    const codeDialog = page.getByTestId("recovery-code-dialog");
    await expect(codeDialog).toBeVisible({ timeout: 30_000 });
    const codeText = (
      await codeDialog.getByTestId("recovery-code-value").innerText()
    ).trim();
    await codeDialog.getByTestId("recovery-code-saved").click();
    await expect(codeDialog).toBeVisible();
    await expect(
      page
        .getByTestId("recovery-code-dialog")
        .getByRole("alert")
        .filter({ hasText: "was not activated" }),
    ).toBeVisible({ timeout: 30_000 });
    await codeDialog.getByTestId("recovery-code-saved").click();
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
    expect(scenario.publishedWrapperIds).toHaveLength(1);
    await page.reload();
    await openRecoveryView(page);
    await unlockWith(page, "recovery-code", codeText);
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("reloading before a recovery-code rotation is confirmed keeps the previous code", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const accountMasterKey = await generateAccountMasterKey();
    const firstCode = await generateRecoveryCode();
    const signer = await importSigningKey();
    let publishes = 0;
    const scenario = scenarioBase({
      onWrapperPublish: () => {
        publishes += 1;
      },
    });
    await installRecoveryRoutes(page, scenario);
    await enrollDevice(page);
    const deviceKeys = capturedDeviceKeys(scenario);
    scenario.wrappers = [
      await buildRecoveryCodeWrapper({
        accountMasterKey,
        recoveryCode: firstCode,
        deviceId: deviceKeys.id,
        signer,
      }),
    ];
    scenario.envelopeB64 = await buildEpochEnvelopeB64({
      accountMasterKey,
      deviceId: deviceKeys.id,
      signer,
    });
    await page.reload();
    await openRecoveryView(page);
    await unlockWith(page, "recovery-code", encodeRecoveryCode(firstCode));
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("rotate-recovery-code").click();
    const codeDialog = page.getByTestId("recovery-code-dialog");
    await expect(codeDialog).toBeVisible({ timeout: 30_000 });
    const replacement = (
      await codeDialog.getByTestId("recovery-code-value").innerText()
    ).trim();
    expect(publishes).toBe(0);
    await page.reload();
    await openRecoveryView(page);
    await unlockWith(page, "recovery-code", replacement);
    await expect(
      page.getByRole("alert").filter({ hasText: "couldn't unlock" }),
    ).toBeVisible({ timeout: 30_000 });
    await unlockWith(page, "recovery-code", encodeRecoveryCode(firstCode));
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
    expect(publishes).toBe(0);
  });

  test("a failed project-key publish retries the same recovery code", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const scenario = scenarioBase({
      forceNoPeerEpochGrant: true,
      onWrapperPublish: (body) => {
        if (
          typeof body.wrapperId === "string" &&
          typeof body.object === "string"
        ) {
          scenario.wrappers = [
            {
              wrapperId: body.wrapperId,
              type: "recovery-code",
              object: body.object,
              createdAt: new Date().toISOString(),
            },
          ];
        }
      },
    });
    scenario.envelopePublishFailuresRemaining = 1;
    await installRecoveryRoutes(page, scenario);
    await enrollDevice(page);
    await page.reload();
    await openRecoveryView(page);
    await page
      .getByTestId("recovery-setup")
      .getByRole("button", { name: "Create recovery code" })
      .click();
    const codeDialog = page.getByTestId("recovery-code-dialog");
    await expect(codeDialog).toBeVisible({ timeout: 30_000 });
    const codeText = (
      await codeDialog.getByTestId("recovery-code-value").innerText()
    ).trim();
    await codeDialog.getByTestId("recovery-code-saved").click();
    await expect(
      page
        .getByTestId("recovery-code-dialog")
        .getByRole("alert")
        .filter({ hasText: "project key was not stored" }),
    ).toBeVisible({ timeout: 30_000 });
    expect(scenario.publishedWrapperIds).toHaveLength(1);
    await codeDialog.getByTestId("recovery-code-saved").click();
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
    expect(scenario.envelopeB64).not.toBeNull();
    expect(scenario.publishedWrapperIds).toHaveLength(1);
    await page.reload();
    await openRecoveryView(page);
    await unlockWith(page, "recovery-code", codeText);
    await expect(page.getByTestId("recovery-status")).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe("workspace recovery at phone width", () => {
  test.use({ viewport: { width: 390, height: 700 } });

  test("setup and one-time display hold at a phone viewport", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const scenario = scenarioBase({
      onWrapperPublish: (body) => {
        if (
          typeof body.wrapperId === "string" &&
          typeof body.object === "string"
        ) {
          scenario.wrappers = [
            {
              wrapperId: body.wrapperId,
              type: "recovery-code",
              object: body.object,
              createdAt: new Date().toISOString(),
            },
          ];
        }
      },
    });
    await installRecoveryRoutes(page, scenario);
    await enrollDeviceMobile(page);
    await page.reload();
    await openRecoveryViewMobile(page);

    const setup = page.getByTestId("recovery-setup");
    await expect(setup).toBeVisible();
    await expect(
      setup.getByRole("button", { name: "Create recovery code" }),
    ).toBeVisible();
    await setup.getByRole("button", { name: "Create recovery code" }).click();
    const codeDialog = page.getByTestId("recovery-code-dialog");
    await expect(codeDialog).toBeVisible({ timeout: 30_000 });
    const codeText = (
      await codeDialog.getByTestId("recovery-code-value").innerText()
    ).trim();
    expect(codeText).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){12}$/,
    );
    // The dialog content stays inside the phone viewport, so the one-time
    // code is fully readable without horizontal scrolling.
    const box = await codeDialog.boundingBox();
    expect(box, "dialog bounds").not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390 + 1);
    await codeDialog.getByRole("button", { name: "I saved it" }).click();
    await expect(page.getByTestId("recovery-status")).toBeVisible();
    // No horizontal overflow anywhere in the recovery area at this width.
    const metrics = await page
      .getByTestId("recovery-area")
      .evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });
  test("a simulated passkey fits and activates at a phone viewport", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const scenario = scenarioBase({
      onWrapperPublish: (body) => rememberPublishedWrapper(scenario, body),
    });
    await installPasskeySimulation(page, "prf");
    await prepareUnlockedRecovery(page, scenario, "phone");

    const status = page.getByTestId("recovery-status");
    await status.getByTestId("add-passkey").click();
    await expect(status.getByTestId("remove-passkey")).toBeVisible({
      timeout: 90_000,
    });
    await expect(status).toContainText("Active");
    const metrics = await page
      .getByTestId("recovery-area")
      .evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });
});
