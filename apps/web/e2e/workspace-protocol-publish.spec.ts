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
import { trustWorkspaceServer } from "./trust-server";

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
  // A teammate authors the synthetic history: the browser verifies it
  // against the teammate's signed roster the fixture serves (ADR 0022).
  actorUserId: "00000000-0000-4000-8000-000000000071",
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

for (const lostResponse of [false, true])
  test(`edits made in flight stay unpublished (lost finalize response: ${lostResponse})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    let devicePublicKey: Uint8Array | null = null;
    let syncPage: Uint8Array | null = null;
    const finalizeDelayMs = 4_000;
    let finalizeCalls = 0;
    let committedRevision: string | null = null;
    let cancellations = 0;
    await page.route(/\/api\/v1\/operations\/[^/]+$/, async (route) => {
      if (route.request().method() === "DELETE") {
        cancellations++;
        await route.fulfill({ json: {} });
        return;
      }
      await route.fulfill({
        json: { status: "COMMITTED", revisionIds: [committedRevision] },
      });
    });

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
      finalizeCalls++;
      committedRevision = (
        route.request().postDataJSON() as { revision: { id: string } }
      ).revision.id;
      if (lostResponse) await route.abort("failed");
      else await route.fulfill({ json: { revisionId: committedRevision } });
    });

    await page.goto("/workspace");
    await trustWorkspaceServer(page);
    await openFirstProject(page);

    await page
      .locator("aside")
      .getByRole("button", { name: "Devices" })
      .click();
    await page.getByRole("button", { name: "Set up browser" }).click();
    await page
      .locator("aside")
      .getByRole("button", { name: "LSP-Software / DotRelay" })
      .click();

    const editor = activeEditor(page);
    await expect(
      editor.getByRole("heading", { name: "Variables" }),
    ).toBeVisible({
      timeout: 10_000,
    });
    const optionalRow = () =>
      editor.getByTestId("environment-variable-OPTIONAL_FLAG");
    const featureRow = () =>
      editor.getByTestId("environment-variable-FEATURE_GATE");
    await expect(optionalRow()).toBeVisible({ timeout: 30_000 });
    await expect(featureRow()).toBeVisible();
    await expect(editor.getByLabel("OPTIONAL_FLAG Value")).toBeEnabled();

    // The verified history identifies the synced Revision by its change kind
    // and names its author from the signed Revision: here, the teammate who
    // authored the fixture's history, whose name this page has not loaded.
    await editor.getByRole("tab", { name: "History" }).click();
    await expect(
      editor.getByText("Unknown member", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText("Changed OPTIONAL_FLAG, FEATURE_GATE", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText("First publish", { exact: true }),
    ).toBeVisible();

    await editor.getByRole("tab", { name: "Variables" }).click();
    await editor.getByLabel("OPTIONAL_FLAG Value").fill("submitted-value");
    await expect(optionalRow()).toContainText("Not published");

    await editor.getByRole("button", { name: "Review and publish" }).click();
    const reviewDialog = page.getByRole("dialog", {
      name: /^Publish \d+ change/,
    });
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
    await expect(featureRow()).toContainText("Not published");

    await expect(
      page.getByText(/^Published .* as revision \S+\.$/),
    ).toBeVisible({
      timeout: 15_000,
    });

    // The message names the revision by the same short id the history uses,
    // and the published Revision joins the history as Current with its
    // verified context and the acting User as its author.
    const publishedMessage =
      (await page
        .getByText(/^Published .* as revision \S+\.$/)
        .first()
        .textContent()) ?? "";
    const shortId = /as revision (\S+)\.$/.exec(publishedMessage)?.[1] ?? "";
    expect(shortId).toHaveLength(8);
    await editor.getByRole("tab", { name: "History" }).click();
    const publishedRow = editor
      .getByTestId(/history-revision-/)
      .filter({ hasText: "Current" });
    await expect(publishedRow).toBeVisible();
    await expect(
      publishedRow.getByText(shortId, { exact: true }),
    ).toBeVisible();
    await expect(
      publishedRow.getByText("Changed OPTIONAL_FLAG", { exact: true }),
    ).toBeVisible();
    await expect(publishedRow.getByText("You", { exact: true })).toBeVisible();
    await expect(
      publishedRow.getByText("Update", { exact: true }),
    ).toBeVisible();

    await editor.getByRole("tab", { name: "Variables" }).click();
    // The submitted lane is published and no longer a draft; the newer edit made
    // while the publication was in flight remains visibly unpublished.
    await expect(optionalRow()).not.toContainText("Not published");
    await expect(featureRow()).toContainText("Not published");
    expect(finalizeCalls).toBe(1);
    expect(cancellations).toBe(0);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("dotrelay-publication:"),
        ),
      ),
    ).toHaveLength(0);
  });
