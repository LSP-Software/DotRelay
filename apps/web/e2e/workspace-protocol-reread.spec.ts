import {
  createPublicationArtifacts,
  type PublicationVariable,
} from "@dotrelay/client";
import {
  encodeSyncPage,
  generateEncryptionKeyPair,
  importSigningPrivateKey,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
import { expect, type Locator, type Page, test } from "@playwright/test";

// Private key paired with E2E_REVISION_SIGNING_TRUST_KEY in
// apps/web/lib/workspace-boundary.ts. It signs the synthetic sync pages
// below so the browser session can verify the initial read.
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

const buildVerifiedFixturePage = async (): Promise<Uint8Array> => {
  const signer = await importSigningPrivateKey(
    hexToBytes(REVISION_SIGNING_PRIVATE_KEY),
  );
  const recipient = await generateEncryptionKeyPair();
  const artifacts = await createPublicationArtifacts(fixtureVariables, {
    ...fixtureIds,
    projectEpoch: 1,
    expectedHeadId: null,
    expectedHeadHash: null,
    valueRecipientPublicKey: recipient.publicKey,
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

const expectLockedEditor = async (editor: Locator) => {
  await expect(
    editor.getByRole("button", { name: "Add Variable" }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await expect(editor.getByLabel("OPTIONAL_FLAG Value")).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "Set absent" }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "Delete OPTIONAL_FLAG" }),
  ).toBeDisabled();
  await expect(
    editor
      .getByTestId("environment-variable-FEATURE_GATE")
      .getByText("This Variable is marked for deletion."),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Undo delete" }),
  ).toBeDisabled();
  await expect(editor.getByTestId("environment-retry-read")).toBeVisible();
};

test("a verified read that later fails keeps Variables visible but locked", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const syncPage = await buildVerifiedFixturePage();
  let blockSync = false;
  await page.route("**/api/v1/devices/bootstrap**", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route(/\/api\/v1\/environments\/.*\/sync/, async (route) => {
    if (blockSync) {
      await route.abort();
      return;
    }
    await route.fulfill({
      body: Buffer.from(syncPage),
      status: 200,
    });
  });

  await page.goto("/workspace");
  await openFirstProject(page);

  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();

  const editor = () => page.getByTestId("editor-context-active");
  await expect(
    editor().getByRole("heading", { name: "Variables" }),
  ).toBeVisible({
    timeout: 10_000,
  });
  const optionalRow = () =>
    editor().getByTestId("environment-variable-OPTIONAL_FLAG");
  const featureRow = () =>
    editor().getByTestId("environment-variable-FEATURE_GATE");
  await expect(optionalRow()).toBeVisible({ timeout: 30_000 });
  await expect(featureRow()).toBeVisible();
  await expect(
    editor().getByText("Add a Variable to start this Manifest."),
  ).toHaveCount(0);
  await expect(editor().getByLabel("OPTIONAL_FLAG Value")).toBeEnabled();

  await editor().getByLabel("OPTIONAL_FLAG Value").fill("local-edit");
  await editor().getByRole("button", { name: "Delete FEATURE_GATE" }).click();
  await expect(
    featureRow().getByText("This Variable is marked for deletion."),
  ).toBeVisible();

  // A later read fails: switch away (keeping the draft) and back, which
  // re-verifies the Environment while sync is blocked.
  blockSync = true;
  await page.getByRole("tab", { name: "staging" }).click();
  await expect(page.getByTestId("switch-draft-prompt")).toBeVisible();
  await page.getByTestId("switch-keep-draft").click();
  await page.getByRole("tab", { name: "production" }).click();

  await expect(
    editor().getByText("This Device could not read the current Environment."),
  ).toBeVisible({
    timeout: 30_000,
  });

  await expect(optionalRow()).toBeVisible();
  await expect(featureRow()).toBeVisible();
  await expect(
    editor().getByText("Add a Variable to start this Manifest."),
  ).toHaveCount(0);
  await expectLockedEditor(editor());
});
