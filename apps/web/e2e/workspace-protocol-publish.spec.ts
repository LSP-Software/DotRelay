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
  for (let index = 0; index < value.length; index += 1)
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

const openFirstProject = async (page: Page) => {
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
};

const activeEditor = (page: Page): Locator =>
  page.getByTestId("editor-context-active");

test("edits made while a publication is in flight stay unpublished after it succeeds", async ({
  page,
}) => {
  test.setTimeout(90_000);
  let devicePublicKey: Uint8Array | null = null;
  let syncPage: Uint8Array | null = null;
  const finalizeDelayMs = 4_000;

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
  await page.route(/\/api\/v1\/environments\/.*\/sync/, async (route) => {
    if (!devicePublicKey) {
      await route.abort();
      return;
    }
    if (!syncPage) syncPage = await buildVerifiedFixturePage(devicePublicKey);
    await route.fulfill({ body: Buffer.from(syncPage), status: 200 });
  });
  await page.route(/\/api\/v1\/operations\/.*\/begin/, (route) =>
    route.fulfill({
      json: {
        operationId: "in-flight",
        status: "ACCEPTED",
        idempotent: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  );
  await page.route(/\/api\/v1\/operations\/.*\/staging\/.*/, (route) =>
    route.fulfill({ status: 200 }),
  );
  await page.route(/\/api\/v1\/operations\/.*\/finalize/, async (route) => {
    // Hold the finalize open long enough to edit again while the publication
    // is still in flight.
    await new Promise((resolve) => setTimeout(resolve, finalizeDelayMs));
    await route.fulfill({ json: {} });
  });

  await page.goto("/workspace");
  await openFirstProject(page);

  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();

  const editor = activeEditor(page);
  await expect(editor.getByRole("heading", { name: "Variables" })).toBeVisible({
    timeout: 10_000,
  });
  const optionalRow = () =>
    editor.getByTestId("environment-variable-OPTIONAL_FLAG");
  const featureRow = () =>
    editor.getByTestId("environment-variable-FEATURE_GATE");
  await expect(optionalRow()).toBeVisible({ timeout: 30_000 });
  await expect(featureRow()).toBeVisible();
  await expect(editor.getByLabel("OPTIONAL_FLAG Value")).toBeEnabled();

  await editor.getByLabel("OPTIONAL_FLAG Value").fill("submitted-value");
  await expect(optionalRow()).toContainText("Draft change");

  await editor.getByRole("button", { name: "Save changes" }).click();
  const reviewDialog = page.getByRole("dialog", { name: "Save changes" });
  await expect(reviewDialog).toBeVisible();
  await reviewDialog.getByRole("button", { name: "Publish" }).click();
  await expect(
    reviewDialog.getByRole("button", { name: "Publishing…" }),
  ).toBeVisible();

  // Close the review dialog while the publication is still in flight, then
  // make a newer edit that the submitted snapshot does not contain.
  await page.keyboard.press("Escape");
  await expect(reviewDialog).toBeHidden();
  await editor.getByLabel("FEATURE_GATE Value").fill("newer-value");
  await expect(featureRow()).toContainText("Draft change");

  await expect(page.getByText(/Published as /)).toBeVisible({
    timeout: 15_000,
  });

  // The submitted lane is published and no longer a draft; the newer edit made
  // while the publication was in flight remains visibly unpublished.
  await expect(optionalRow()).not.toContainText("Draft change");
  await expect(featureRow()).toContainText("Draft change");
});
