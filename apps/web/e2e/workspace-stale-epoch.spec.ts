import {
  createPublicationArtifacts,
  type PublicationVariable,
} from "@dotrelay/client";
import {
  bytesToUuid,
  encodeSyncPage,
  importSigningPrivateKey,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
import { expect, type Page, test } from "@playwright/test";
import { e2eWorkspaceBoundary } from "../lib/workspace-boundary";
import { trustWorkspaceServer } from "./trust-server";

// Private key paired with E2E_REVISION_SIGNING_TRUST_KEY in
// apps/web/lib/workspace-boundary.ts. It signs the synthetic sync page below
// so the browser session can verify the initial read, while the lanes are
// sealed to the enrolled browser Device's key so that same session can
// decrypt the Variables.
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
    value: "on",
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

const bytesToHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

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

// The service state the specs script: which Device the server reports for
// this browser, whether that Device holds the current Project epoch key,
// which epoch the Project is at, and how the grant bootstrap endpoint
// answers the browser's in-place repair. Accepting a current-epoch grant
// makes the service report the Device current again.
type StaleEpochState = {
  deviceId: string | null;
  devicePublicKey: Uint8Array | null;
  epochCurrent: boolean;
  projectEpoch: string;
  grantResponse: { readonly status: number; readonly body: unknown };
};

type GrantCall = Readonly<{
  readonly deviceId: string | null;
  readonly body: Record<string, unknown>;
}>;

const installStaleEpochService = async (page: Page, state: StaleEpochState) => {
  // playwright.config.ts serves the web app and the API on this fixed origin.
  const origin = `http://${process.env.CI ? "127.0.0.1" : "localhost"}:3000`;
  await page.route("**/api/workspace/boundary**", (route) => {
    const url = new URL(route.request().url());
    const environmentId = url.searchParams.get("environment");
    // Like the service, only the Device the client presents is resolved.
    const presented = route.request().headers()["x-dotrelay-device-id"];
    const presentedDeviceId =
      state.deviceId !== null && presented === state.deviceId
        ? state.deviceId
        : null;
    const boundary = e2eWorkspaceBoundary("hosted", {
      ...(environmentId ? { environmentId } : {}),
      ...(presentedDeviceId ? { deviceId: presentedDeviceId } : {}),
    });
    // The fixture pins a placeholder public key; the service records the key
    // this Device enrolled with, and the browser re-verifies it before it
    // trusts the stored keys to sign.
    const device =
      presentedDeviceId && state.devicePublicKey
        ? {
            ...boundary.device,
            encryptionPublicKey: bytesToHex(state.devicePublicKey),
          }
        : boundary.device;
    return route.fulfill({
      json: {
        ...boundary,
        device,
        epochCurrent: state.epochCurrent,
        profile: { ...boundary.profile, origin },
        environment: {
          ...boundary.environment,
          projectEpoch: state.projectEpoch,
        },
      },
    });
  });
  await page.route("**/api/v1/devices/bootstrap**", (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        readonly deviceId?: string;
        readonly x25519PublicKey?: string;
      };
      if (body.deviceId) {
        state.deviceId = body.deviceId;
        state.devicePublicKey = body.x25519PublicKey
          ? hexToBytes(body.x25519PublicKey)
          : null;
      }
    }
    return route.fulfill({ json: {} });
  });
  const grantCalls: GrantCall[] = [];
  await page.route("**/api/v1/grants/bootstrap**", (route) => {
    if (route.request().method() === "POST") {
      grantCalls.push({
        deviceId: route.request().headers()["x-dotrelay-device-id"] ?? null,
        body: JSON.parse(route.request().postData() ?? "{}"),
      });
    }
    if (state.grantResponse.status < 400) state.epochCurrent = true;
    return route.fulfill({
      status: state.grantResponse.status,
      json: state.grantResponse.body,
    });
  });
  let syncPage: Uint8Array | null = null;
  await page.route(/\/api\/v1\/environments\/.*\/sync/, async (route) => {
    if (!state.devicePublicKey) {
      await route.abort();
      return;
    }
    if (!syncPage)
      syncPage = await buildVerifiedFixturePage(state.devicePublicKey);
    await route.fulfill({ body: Buffer.from(syncPage), status: 200 });
  });
  return { grantCalls };
};

const openDevicesView = async (page: Page): Promise<void> => {
  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
};

const openFirstProject = async (page: Page): Promise<void> => {
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
};

const activeEditor = (page: Page) => page.getByTestId("editor-context-active");

const STALE_CARD_HEADING = "This project's keys were rotated";
const RECOVER_KEYS = "Recover keys";

// Enrolls this browser, opens the Project, and waits until the verified read
// shows the Variables. Returns the state and calls for the test to script
// the rotation on.
const enrollAndReadVariables = async (page: Page) => {
  const state: StaleEpochState = {
    deviceId: null,
    devicePublicKey: null,
    epochCurrent: true,
    projectEpoch: "1",
    grantResponse: {
      status: 200,
      body: {
        grantObjectId: "00000000-0000-4000-8000-000000000099",
        idempotent: false,
      },
    },
  };
  const { grantCalls } = await installStaleEpochService(page, state);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await openDevicesView(page);
  await page.getByRole("button", { name: "Set up browser" }).click();
  await expect(
    page
      .locator("#devices")
      .getByText(
        "This browser is set up. Its private keys stay on this machine.",
      ),
  ).toBeVisible({ timeout: 15_000 });
  await openFirstProject(page);
  const editor = activeEditor(page);
  await expect(editor.getByRole("heading", { name: "Variables" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    editor.getByTestId("environment-variable-FEATURE_GATE"),
  ).toBeVisible();
  return { state, grantCalls, editor };
};

// Rotates the Project's keys on the scripted service and waits for the shell
// to surface the stale-epoch gate in the editor.
const rotateProjectKeys = async (
  state: StaleEpochState,
  editor: ReturnType<typeof activeEditor>,
) => {
  state.projectEpoch = "2";
  state.epochCurrent = false;
  await expect(
    editor.getByRole("heading", { name: STALE_CARD_HEADING }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    editor.getByRole("button", { name: RECOVER_KEYS }),
  ).toBeVisible();
};

test("stale project keys are recovered in place with the stored Device keys", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { state, grantCalls, editor } = await enrollAndReadVariables(page);
  await rotateProjectKeys(state, editor);
  const grantPostsBefore = grantCalls.length;
  const devicePostsBefore = state.deviceId;

  await editor.getByRole("button", { name: RECOVER_KEYS }).click();

  // The repair reuses the stored keys: the Device signs a fresh grant for the
  // current epoch addressed to itself, and no replacement Device is created.
  await expect
    .poll(() => grantCalls.length, { timeout: 15_000 })
    .toBe(grantPostsBefore + 1);
  const repairCall = grantCalls.at(-1);
  expect(repairCall?.deviceId).toBe(devicePostsBefore);
  const grant = parseProtocolObject(
    Buffer.from(String(repairCall?.body.grant), "base64"),
  );
  expect(bytesToUuid(new Uint8Array(grant.get(24) as Uint8Array))).toBe(
    devicePostsBefore,
  );
  expect(bytesToUuid(new Uint8Array(grant.get(25) as Uint8Array))).toBe(
    devicePostsBefore,
  );
  expect(Number(grant.get(30))).toBe(2);
  expect(state.deviceId).toBe(devicePostsBefore);

  // The unblocked editor is the result report, and the verified read works
  // again with the same session keys.
  await expect(
    editor.getByRole("heading", { name: STALE_CARD_HEADING }),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(editor.getByRole("heading", { name: "Variables" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    editor.getByTestId("environment-variable-FEATURE_GATE"),
  ).toBeVisible();
});

test("a current grant provisioned elsewhere is reused without bootstrapping", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { state, grantCalls, editor } = await enrollAndReadVariables(page);
  const grantPostsBefore = grantCalls.length;
  await rotateProjectKeys(state, editor);

  // Another of the User's Devices (or a CLI run) provisions the current grant
  // while the shell still shows the stale gate.
  state.epochCurrent = true;
  const button = editor.getByRole("button", { name: RECOVER_KEYS });
  if (await button.isVisible()) await button.click();
  await expect(
    editor.getByRole("heading", { name: STALE_CARD_HEADING }),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(editor.getByRole("heading", { name: "Variables" })).toBeVisible({
    timeout: 30_000,
  });

  // The current grant was reused: nothing was bootstrapped, no Device was
  // replaced, and no approval was asked.
  expect(grantCalls.length).toBe(grantPostsBefore);
  expect(await page.getByTestId("replace-device-dialog").count()).toBe(0);
});

test("a rejected in-place repair reports the owner or admin actions that unblock it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { state, editor } = await enrollAndReadVariables(page);
  await rotateProjectKeys(state, editor);
  state.grantResponse = { status: 403, body: { code: "forbidden" } };

  await editor.getByRole("button", { name: RECOVER_KEYS }).click();
  await expect(
    page.getByText("can't recover the project's current keys on its own"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("LSP Software's Owners and Admins can also rotate"),
  ).toBeVisible();
  await expect(
    page.getByText("Recover the account's key from the Recovery area"),
  ).toBeVisible();
  expect(await page.getByTestId("replace-device-dialog").count()).toBe(0);

  // A rotation still in progress is reported as its own retryable state.
  state.grantResponse = { status: 409, body: { code: "stale_epoch" } };
  await editor.getByRole("button", { name: RECOVER_KEYS }).click();
  await expect(
    page.getByText("Key rotation is still in progress on this project."),
  ).toBeVisible({ timeout: 15_000 });
  expect(await page.getByTestId("replace-device-dialog").count()).toBe(0);
});

test("a deactivated Device asks for approval before a replacement is enrolled", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { state, editor } = await enrollAndReadVariables(page);
  await rotateProjectKeys(state, editor);
  state.grantResponse = { status: 403, body: { code: "device_not_active" } };

  await editor.getByRole("button", { name: RECOVER_KEYS }).click();

  // The in-place repair cannot sign, so the replacement is proposed and held
  // for explicit approval: nothing is enrolled before the user confirms.
  await expect(
    page.getByTestId("replace-device-dialog").getByRole("heading", {
      name: "Replace this browser's device?",
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("This browser is set up")).toHaveCount(0);

  const deviceIdBefore = state.deviceId;
  await page.getByTestId("replace-device-confirm").click();
  await expect(page.getByTestId("replace-device-dialog")).toHaveCount(0);
  await expect(
    page.getByText(
      "This browser is set up. Its private keys stay on this machine.",
    ),
  ).toBeVisible({ timeout: 15_000 });
  expect(state.deviceId).not.toBeNull();
  expect(state.deviceId).not.toBe(deviceIdBefore);
});
