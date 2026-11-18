import {
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
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type BrowserDeviceKeys,
  createOwnAccountRoster,
  E2E_HISTORY_DEVICE_ID,
} from "./account-roster";
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
  actorUserId: "00000000-0000-4000-8000-000000000061",
  actorDeviceId: "00000000-0000-4000-8000-000000000040",
};

const OTHER_USER_ID = "00000000-0000-4000-8000-000000000071";

const otherShared = {
  id: "00000000-0000-4000-8000-0000000000b1",
  name: "OTHER_SHARED",
  description: "Provided by another member.",
  ownership: "SHARED_VALUE" as const,
  required: true,
};
const mineShared = {
  id: "00000000-0000-4000-8000-0000000000b2",
  name: "MINE_SHARED",
  description: "Provided by this member.",
  ownership: "SHARED_VALUE" as const,
  required: true,
};
const myToken = {
  id: "00000000-0000-4000-8000-0000000000b3",
  name: "MY_TOKEN",
  description: "Owned by this member.",
  ownership: "USER_DEFINED_VALUE" as const,
  required: true,
};

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

const buildRevision = async (
  variables: readonly PublicationVariable[],
  context: Readonly<{
    readonly actorUserId: string;
    readonly expectedHeadId: string | null;
    readonly expectedHeadHash: Uint8Array | null;
    readonly mutation: "GENESIS" | "MANIFEST_UPDATE";
  }>,
  devicePublicKey: Uint8Array,
) => {
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
  const artifacts = await createPublicationArtifacts(variables, {
    ...fixtureIds,
    actorUserId: context.actorUserId,
    projectEpoch: 1,
    expectedHeadId: context.expectedHeadId,
    expectedHeadHash: context.expectedHeadHash,
    valueRecipientPublicKey,
    userDefinedValueRecipientPublicKey: valueRecipientPublicKey,
    signingPrivateKey: signer,
    mutation: context.mutation,
  });
  const revisionObject = artifacts.stagedObjects.find(
    (object) => object.objectId === artifacts.request.revision.protocolObjectId,
  );
  if (!revisionObject) throw new Error("revision object is missing");
  const revision = parseProtocolObject(revisionObject.bytes);
  const revisionDigest = await sha384(revisionObject.bytes);
  return {
    id: artifacts.request.revision.id,
    digest: revisionDigest,
    mutation: revision.get(35) as number,
    projectEpoch: revision.get(30) as number,
    authoredAtMs: revision.get(34) as number,
    objects: await Promise.all(
      artifacts.stagedObjects.map(async (object) => ({
        objectId: object.objectId,
        canonicalBytes: object.bytes,
        digest: await sha384(object.bytes),
      })),
    ),
  };
};

const buildVerifiedFixturePage = async (devicePublicKey: Uint8Array) => {
  const genesis = await buildRevision(
    [{ ...otherShared, value: "v1", hasDraftChange: true }],
    {
      actorUserId: OTHER_USER_ID,
      expectedHeadId: null,
      expectedHeadHash: null,
      mutation: "GENESIS",
    },
    devicePublicKey,
  );
  const mine = await buildRevision(
    [
      { ...mineShared, value: "mine-value", hasDraftChange: true },
      { ...myToken, value: "my-token", hasDraftChange: true },
    ],
    {
      actorUserId: fixtureIds.actorUserId,
      expectedHeadId: genesis.id,
      expectedHeadHash: genesis.digest,
      mutation: "MANIFEST_UPDATE",
    },
    devicePublicKey,
  );
  const head = await buildRevision(
    [{ ...otherShared, value: "v3", hasDraftChange: true }],
    {
      actorUserId: OTHER_USER_ID,
      expectedHeadId: mine.id,
      expectedHeadHash: mine.digest,
      mutation: "MANIFEST_UPDATE",
    },
    devicePublicKey,
  );
  return encodeSyncPage({
    environmentId: fixtureIds.environmentId,
    trustedRevisionId: fixtureIds.environmentId,
    trustedRevisionHash: new Uint8Array(48),
    currentHeadId: head.id,
    currentHeadHash: head.digest,
    projectEpoch: 1n,
    revisions: [
      {
        ...genesis,
        parentId: fixtureIds.environmentId,
        parentHash: new Uint8Array(48),
        projectEpoch: BigInt(genesis.projectEpoch),
        authoredAtMs: BigInt(genesis.authoredAtMs),
        rollbackTargetId: null,
      },
      {
        ...mine,
        parentId: genesis.id,
        parentHash: genesis.digest,
        projectEpoch: BigInt(mine.projectEpoch),
        authoredAtMs: BigInt(mine.authoredAtMs),
        rollbackTargetId: null,
      },
      {
        ...head,
        parentId: mine.id,
        parentHash: mine.digest,
        projectEpoch: BigInt(head.projectEpoch),
        authoredAtMs: BigInt(head.authoredAtMs),
        rollbackTargetId: null,
      },
    ],
    nextCursor: null,
  });
};

// The signed-in Member's own Revisions come from the account's other Device.
// A browser trusts that Device only once it holds the account's key and the
// signed roster lists it (ADR 0022), so each spec unlocks with a Recovery
// Code before reading, as every live session must.
const installRoutes = async (page: Page) => {
  let devicePublicKey: Uint8Array | null = null;
  let deviceKeys: BrowserDeviceKeys | null = null;
  let syncPage: Uint8Array | null = null;
  const accountMasterKey = generateAccountMasterKey();
  const recoveryCode = generateRecoveryCode();
  const ownRoster = createOwnAccountRoster({
    accountMasterKey: () => accountMasterKey,
    deviceKeys: () => deviceKeys,
  });
  await ownRoster.install(page);
  await page.route("**/api/v1/devices/bootstrap**", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postData();
      if (body) {
        const { deviceId, x25519PublicKey, ed25519PublicKey } = JSON.parse(
          body,
        ) as {
          readonly deviceId?: string;
          readonly x25519PublicKey?: string;
          readonly ed25519PublicKey?: string;
        };
        if (x25519PublicKey) devicePublicKey = hexToBytes(x25519PublicKey);
        if (deviceId && x25519PublicKey && ed25519PublicKey)
          deviceKeys = {
            id: deviceId,
            encryptionPublicKey: x25519PublicKey,
            signingPublicKey: ed25519PublicKey,
          };
      }
    }
    return route.fulfill({ json: {} });
  });
  // The service reports the keys this browser enrolled with, and the
  // account's roster once the browser can verify it.
  await page.route("**/api/workspace/boundary**", async (route) => {
    let body: Record<string, unknown>;
    try {
      body = (await (await route.fetch()).json()) as Record<string, unknown>;
    } catch {
      await route.abort().catch(() => {});
      return;
    }
    const device = body.device as Record<string, unknown> | undefined;
    if (device?.active === true && deviceKeys) {
      device.encryptionPublicKey = deviceKeys.encryptionPublicKey;
      device.signingPublicKey = deviceKeys.signingPublicKey;
    }
    await ownRoster.inject(body);
    await route.fulfill({ json: body });
  });
  await page.route("**/api/v1/account-keys/wrappers**", async (route) => {
    if (route.request().method() !== "GET")
      return route.fulfill({ json: { wrapperId: "", idempotent: false } });
    const wrapper = await createAccountKeyWrapper({
      serverProfileId: fixtureIds.serverProfileId,
      userId: hexToBytes(fixtureIds.actorUserId.replaceAll("-", "")),
      deviceId: hexToBytes(E2E_HISTORY_DEVICE_ID.replaceAll("-", "")),
      userIdentityGeneration: 1,
      createdAtMs: Date.now(),
      accountMasterKey,
      signingPrivateKey: await importSigningPrivateKey(
        hexToBytes(REVISION_SIGNING_PRIVATE_KEY),
      ),
      kind: { type: "recoveryCode", recoveryCode },
    });
    return route.fulfill({
      json: {
        wrappers: [
          {
            wrapperId: Buffer.from(wrapper.wrapperId).toString("hex"),
            type: "recovery-code",
            object: Buffer.from(canonicalEncode(wrapper.object)).toString(
              "base64",
            ),
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
  });
  await page.route(/\/api\/v1\/environments\/.*\/sync/, async (route) => {
    if (!devicePublicKey) {
      await route.abort();
      return;
    }
    if (!syncPage) syncPage = await buildVerifiedFixturePage(devicePublicKey);
    await route.fulfill({ body: Buffer.from(syncPage), status: 200 });
  });
  return { recoveryCode: encodeRecoveryCode(recoveryCode) };
};

// Unlocks this browser's account key with the Recovery Code, then returns
// to the Project.
const unlockAccount = async (page: Page, recoveryCode: string) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Recovery" })
    .click();
  const unlock = page.getByTestId("recovery-unlock");
  await expect(unlock).toBeVisible();
  await unlock.getByTestId("recovery-code-input").fill(recoveryCode);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("recovery-status")).toBeVisible({
    timeout: 30_000,
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
};

const openFirstProject = async (page: Page) => {
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
};

const enrollBrowserAndReturn = async (page: Page) => {
  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  await page.getByRole("button", { name: "Set up browser" }).click();
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
};

const setPreviewRole = async (page: Page, value: string) => {
  await page.locator("aside").getByRole("button", { name: "Members" }).click();
  await page.getByLabel("Preview role").selectOption(value);
};

const activeEditor = (page: Page): Locator =>
  page.getByTestId("editor-context-active");

const editorReady = async (page: Page) => {
  const editor = activeEditor(page);
  await expect(editor.getByRole("heading", { name: "Variables" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    editor.getByTestId("environment-variable-OTHER_SHARED"),
  ).toBeVisible({ timeout: 30_000 });
  return editor;
};

test("a Member reads every Value but edits only the Values they provided or own", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { recoveryCode } = await installRoutes(page);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  // Setting the preview role switches the main view to the Team page, which
  // hides the Projects list heading, so open the project from the sidebar
  // navigation instead of the Projects view.
  await setPreviewRole(page, "MEMBER");
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
  await enrollBrowserAndReturn(page);
  await unlockAccount(page, recoveryCode);
  const editor = await editorReady(page);

  await expect(editor.getByTestId("member-permissions-note")).toBeVisible();

  const otherRow = editor.getByTestId("environment-variable-OTHER_SHARED");
  const tokenRow = editor.getByTestId("environment-variable-MY_TOKEN");
  // A read-only value is a read-only input, not a disabled one, so it can
  // still be focused, selected, and copied; the reason is on screen and
  // announced with the field.
  const otherValue = editor.getByLabel("OTHER_SHARED Value");
  await expect(otherValue).toBeEnabled();
  await expect(otherValue).not.toBeEditable();
  await expect(otherRow.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(
    otherRow.getByText(
      "Only the person who provided it, or a team admin, can change it.",
    ),
  ).toBeVisible();
  await expect(otherValue).toHaveAccessibleDescription(
    "Only the person who provided it, or a team admin, can change it.",
  );
  await otherRow.getByRole("button", { name: "Reveal OTHER_SHARED" }).click();
  await expect(otherValue).toHaveAttribute("type", "text");
  await expect(otherValue).toHaveValue("v3");
  // Copy puts the value on the clipboard and confirms in place.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await otherRow.getByRole("button", { name: "Copy OTHER_SHARED" }).click();
  await expect(otherRow.getByText("Copied OTHER_SHARED")).toBeAttached();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("v3");
  await expect(editor.getByLabel("MINE_SHARED Value")).toBeEnabled();
  await expect(editor.getByLabel("MY_TOKEN Value")).toBeEnabled();
  await expect(
    editor.getByRole("button", { name: "Add Variable" }),
  ).toBeDisabled();

  await editor.getByLabel("MY_TOKEN Value").fill("member-token");
  await expect(tokenRow).toContainText("Not published");
  await expect(
    editor.getByRole("button", { name: "Review and publish" }),
  ).toBeEnabled();
  await editor.getByRole("button", { name: "Review and publish" }).click();
  const reviewDialog = page.getByRole("dialog", {
    name: /^Publish \d+ change/,
  });
  await expect(reviewDialog).toBeVisible();
  await expect(
    reviewDialog.getByText("MY_TOKEN", { exact: true }),
  ).toBeVisible();
  await expect(
    reviewDialog.getByText("OTHER_SHARED", { exact: true }),
  ).toBeHidden();
  await reviewDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(reviewDialog).toBeHidden();

  await editor.getByRole("tab", { name: "History" }).click();
  // History is newest first; the oldest revision is the teammate's.
  await editor
    .getByTestId(/history-revision-/)
    .getByRole("button", { name: "Roll back" })
    .last()
    .click();
  const rollbackDialog = page.getByRole("dialog", { name: "Roll back" });
  await expect(rollbackDialog).toBeVisible();
  await expect(
    rollbackDialog.getByText("0 of 1 variables selected"),
  ).toBeVisible();
  await expect(rollbackDialog.getByRole("checkbox")).toBeDisabled();
  await expect(
    rollbackDialog.getByText(
      "Only the person who provided it, or a team admin, can change it.",
    ),
  ).toBeVisible();
  await expect(
    rollbackDialog.getByRole("button", { name: "Add to my changes" }),
  ).toBeDisabled();
  await rollbackDialog.getByRole("button", { name: "Cancel" }).click();
});

test("demoting to Member mid-draft removes the Values the new role cannot publish", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { recoveryCode } = await installRoutes(page);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await openFirstProject(page);
  await enrollBrowserAndReturn(page);
  await unlockAccount(page, recoveryCode);
  const editor = await editorReady(page);

  await expect(editor.getByTestId("member-permissions-note")).toBeHidden();
  await expect(editor.getByLabel("OTHER_SHARED Value")).toBeEnabled();
  await editor.getByLabel("OTHER_SHARED Value").fill("hijacked-value");
  await expect(
    editor.getByTestId("environment-variable-OTHER_SHARED"),
  ).toContainText("Not published");
  await editor.getByLabel("MY_TOKEN Value").fill("kept-token");
  await expect(
    editor.getByTestId("environment-variable-MY_TOKEN"),
  ).toContainText("Not published");

  await setPreviewRole(page, "MEMBER");
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();

  await expect(
    page.getByText(/removed OTHER_SHARED from your draft/),
  ).toBeVisible({
    timeout: 15_000,
  });
  const otherRow = editor.getByTestId("environment-variable-OTHER_SHARED");
  const tokenRow = editor.getByTestId("environment-variable-MY_TOKEN");
  await expect(editor.getByLabel("OTHER_SHARED Value")).not.toBeEditable();
  await expect(otherRow.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(otherRow).not.toContainText("Not published");
  await expect(tokenRow).toContainText("Not published");
  await expect(
    editor.getByRole("button", { name: "Add Variable" }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "Review and publish" }),
  ).toBeEnabled();

  await editor.getByRole("button", { name: "Review and publish" }).click();
  const reviewDialog = page.getByRole("dialog", {
    name: /^Publish \d+ change/,
  });
  await expect(reviewDialog).toBeVisible();
  await expect(
    reviewDialog.getByText("MY_TOKEN", { exact: true }),
  ).toBeVisible();
  await expect(
    reviewDialog.getByText("OTHER_SHARED", { exact: true }),
  ).toBeHidden();
  await reviewDialog.getByRole("button", { name: "Cancel" }).click();
});

test("an Owner edits every Value, adds Variables, and may roll back any Value", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { recoveryCode } = await installRoutes(page);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await openFirstProject(page);
  await enrollBrowserAndReturn(page);
  await unlockAccount(page, recoveryCode);
  const editor = await editorReady(page);

  await expect(editor.getByTestId("member-permissions-note")).toBeHidden();
  await expect(editor.getByLabel("OTHER_SHARED Value")).toBeEnabled();
  await expect(
    editor.getByRole("button", { name: "Add Variable" }),
  ).toBeEnabled();

  await editor.getByRole("tab", { name: "History" }).click();
  await editor
    .getByTestId(/history-revision-/)
    .getByRole("button", { name: "Roll back" })
    .first()
    .click();
  const rollbackDialog = page.getByRole("dialog", { name: "Roll back" });
  await expect(rollbackDialog).toBeVisible();
  await expect(
    rollbackDialog.getByText("1 of 1 variables selected"),
  ).toBeVisible();
  await expect(rollbackDialog.getByRole("checkbox")).toBeEnabled();
  await rollbackDialog.getByRole("button", { name: "Cancel" }).click();
});

test("history names each revision's author from the Team's members", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { recoveryCode } = await installRoutes(page);
  await page.route("**/api/v1/teams/*/memberships", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      json: {
        memberships: [
          {
            membershipId: "mem-self",
            userId: fixtureIds.actorUserId,
            name: "Ari Stone",
            image: null,
            githubSubject: "18473192",
            role: "OWNER",
            lifecycle: "ACTIVE",
          },
          {
            membershipId: "mem-other",
            userId: OTHER_USER_ID,
            name: "Olive Other",
            image: null,
            githubSubject: "200707",
            role: "MEMBER",
            lifecycle: "ACTIVE",
          },
        ],
        invitations: [],
      },
    });
  });
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await openFirstProject(page);
  await enrollBrowserAndReturn(page);
  await unlockAccount(page, recoveryCode);
  const editor = await editorReady(page);

  await editor.getByRole("tab", { name: "History" }).click();
  const rows = editor.getByTestId(/history-revision-/);
  await expect(rows).toHaveCount(3);
  // Newest first or oldest first, each row names who published it and
  // which variables it changed.
  const otherRows = rows.filter({ hasText: "Olive Other" });
  await expect(otherRows).toHaveCount(2);
  await expect(
    otherRows.filter({ hasText: "Changed OTHER_SHARED" }),
  ).toHaveCount(2);
  await expect(
    rows
      .filter({ hasText: "You" })
      .getByText("Changed MINE_SHARED, MY_TOKEN", { exact: true }),
  ).toBeVisible();
  await expect(editor.getByText("Author unavailable")).toHaveCount(0);
});
