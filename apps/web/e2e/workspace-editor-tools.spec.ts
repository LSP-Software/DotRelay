import { readFile } from "node:fs/promises";
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
// apps/web/lib/workspace-boundary.ts; see workspace-role-permissions.spec.ts.
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

const apiUrl = {
  id: "00000000-0000-4000-8000-0000000000c1",
  name: "API_URL",
  description: "Service origin.",
  ownership: "SHARED_VALUE" as const,
  required: true,
};
const token = {
  id: "00000000-0000-4000-8000-0000000000c2",
  name: "TOKEN",
  description: "Service token.",
  ownership: "SHARED_VALUE" as const,
  required: true,
};
const unset = {
  id: "00000000-0000-4000-8000-0000000000c3",
  name: "UNSET_FLAG",
  description: "Optional flag.",
  ownership: "SHARED_VALUE" as const,
  required: false,
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

type BuiltRevision = Awaited<ReturnType<typeof buildRevision>>;

const buildRevision = async (
  variables: readonly PublicationVariable[],
  context: Readonly<{
    readonly actorUserId: string;
    readonly parent: BuiltRevision | null;
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
    expectedHeadId: context.parent?.id ?? null,
    expectedHeadHash: context.parent?.digest ?? null,
    valueRecipientPublicKey,
    userDefinedValueRecipientPublicKey: valueRecipientPublicKey,
    signingPrivateKey: signer,
    mutation: context.parent ? "MANIFEST_UPDATE" : "GENESIS",
  });
  const revisionObject = artifacts.stagedObjects.find(
    (object) => object.objectId === artifacts.request.revision.protocolObjectId,
  );
  if (!revisionObject) throw new Error("revision object is missing");
  const revision = parseProtocolObject(revisionObject.bytes);
  const digest = await sha384(revisionObject.bytes);
  return {
    id: artifacts.request.revision.id,
    digest,
    parentId: context.parent?.id ?? fixtureIds.environmentId,
    parentHash: context.parent?.digest ?? new Uint8Array(48),
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
  };
};

const page = (
  trusted: BuiltRevision | null,
  revisions: readonly BuiltRevision[],
): Uint8Array => {
  const head = revisions.at(-1) ?? trusted;
  return encodeSyncPage({
    environmentId: fixtureIds.environmentId,
    trustedRevisionId: trusted?.id ?? fixtureIds.environmentId,
    trustedRevisionHash: trusted?.digest ?? new Uint8Array(48),
    currentHeadId: head?.id ?? null,
    currentHeadHash: head?.digest ?? null,
    projectEpoch: 1n,
    revisions,
    nextCursor: null,
  });
};

type Fixture = {
  // The revision a teammate publishes "later", changing TOKEN only.
  publishTeammateChange: () => void;
  syncCalls: number;
};

// Serves a verified environment: a genesis revision with API_URL, TOKEN and
// an unset flag. Once publishTeammateChange() runs, reads see a second
// revision by another member that changes TOKEN.
const installEnvironment = async (target: Page): Promise<Fixture> => {
  let devicePublicKey: Uint8Array | null = null;
  let genesis: BuiltRevision | null = null;
  let teammate: BuiltRevision | null = null;
  let teammateVisible = false;
  const fixture: Fixture = {
    publishTeammateChange: () => {
      teammateVisible = true;
    },
    syncCalls: 0,
  };
  await target.route("**/api/v1/devices/bootstrap**", (route) => {
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
  await target.route(/\/api\/v1\/environments\/.*\/sync/, async (route) => {
    if (!devicePublicKey) {
      await route.abort();
      return;
    }
    fixture.syncCalls += 1;
    genesis ??= await buildRevision(
      [
        { ...apiUrl, value: "https://api.test", hasDraftChange: true },
        { ...token, value: "t0k$n", hasDraftChange: true },
        { ...unset, value: null, hasDraftChange: true },
      ],
      { actorUserId: fixtureIds.actorUserId, parent: null },
      devicePublicKey,
    );
    if (teammateVisible)
      teammate ??= await buildRevision(
        [{ ...token, value: "rotated-token", hasDraftChange: true }],
        { actorUserId: OTHER_USER_ID, parent: genesis },
        devicePublicKey,
      );
    const { trustedRevisionId } = route.request().postDataJSON() as {
      readonly trustedRevisionId: string;
    };
    const body =
      trustedRevisionId === genesis.id
        ? page(genesis, teammate ? [teammate] : [])
        : page(null, teammate ? [genesis, teammate] : [genesis]);
    await route.fulfill({ body: Buffer.from(body), status: 200 });
  });
  return fixture;
};

const activeEditor = (target: Page): Locator =>
  target.getByTestId("editor-context-active");

const openEditor = async (target: Page): Promise<Locator> => {
  await target.goto("/workspace");
  await trustWorkspaceServer(target);
  await target
    .getByRole("heading", { name: "LSP-Software / DotRelay" })
    .click();
  await target
    .locator("aside")
    .getByRole("button", { name: "Devices" })
    .click();
  await target.getByRole("button", { name: "Set up browser" }).click();
  await target
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
  const editor = activeEditor(target);
  await expect(editor.getByTestId("environment-variable-TOKEN")).toBeVisible({
    timeout: 30_000,
  });
  return editor;
};

const tokenValue = async (editor: Locator) => {
  const field = editor.getByLabel("TOKEN Value");
  if ((await field.getAttribute("type")) === "password")
    await editor.getByRole("button", { name: "Reveal TOKEN" }).click();
  return field;
};

test("the variable filter narrows rows by name", async ({ page: target }) => {
  test.setTimeout(90_000);
  await installEnvironment(target);
  const editor = await openEditor(target);
  const filter = editor.getByLabel("Filter variables by name");
  await filter.fill("tok");
  await expect(editor.getByTestId("environment-variable-TOKEN")).toBeVisible();
  await expect(editor.getByTestId("environment-variable-API_URL")).toHaveCount(
    0,
  );
  await filter.fill("nothing-like-this");
  await expect(editor.getByText(/No variables match/)).toBeVisible();
  await filter.fill("");
  await expect(
    editor.getByTestId("environment-variable-API_URL"),
  ).toBeVisible();
});

test("an imported .env is reviewed, then staged into the draft", async ({
  page: target,
}) => {
  test.setTimeout(90_000);
  await installEnvironment(target);
  const editor = await openEditor(target);
  await editor.getByRole("button", { name: "Import .env" }).click();
  const dialog = target.getByTestId("import-dotenv-dialog");
  const text = dialog.getByLabel(".env contents");

  // A malformed file is refused with its line, and nothing can be staged.
  await text.fill("TOKEN=one\nTOKEN=two");
  await expect(dialog.getByRole("alert")).toContainText("TOKEN appears twice");
  await expect(
    dialog.getByRole("button", { name: "Add to draft" }),
  ).toBeDisabled();

  await text.fill(
    "# pasted\nAPI_URL=https://api.test\nTOKEN=new-token\nexport NEW_VAR='fresh value'\n",
  );
  const preview = dialog.getByRole("list", { name: "Import preview" });
  await expect(
    preview.getByRole("listitem").filter({ hasText: "TOKEN" }),
  ).toContainText("Update");
  await expect(
    preview.getByRole("listitem").filter({ hasText: "NEW_VAR" }),
  ).toContainText("Add");
  await expect(
    preview.getByRole("listitem").filter({ hasText: "API_URL" }),
  ).toContainText("No change");
  // A new variable needs an explicit sharing choice before staging.
  await expect(
    dialog.getByRole("button", { name: "Add to draft" }),
  ).toBeDisabled();
  await dialog.getByRole("radio", { name: /Shared value/ }).check();
  await dialog.getByRole("button", { name: "Add to draft" }).click();
  await expect(dialog).toBeHidden();

  await expect(editor.getByTestId("environment-variable-TOKEN")).toContainText(
    "Draft change",
  );
  await expect(
    editor.getByTestId("environment-variable-NEW_VAR"),
  ).toContainText("Draft change");
  await expect(
    editor.getByTestId("environment-variable-API_URL"),
  ).not.toContainText("Draft change");
  await expect(await tokenValue(editor)).toHaveValue("new-token");
  await expect(
    editor.getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();

  // Reopening starts empty: the pasted secrets were not kept.
  await editor.getByRole("button", { name: "Import .env" }).click();
  await expect(dialog.getByLabel(".env contents")).toHaveValue("");
});

test("downloading .env warns first and writes the readable published values", async ({
  page: target,
}) => {
  test.setTimeout(90_000);
  await installEnvironment(target);
  const editor = await openEditor(target);
  await editor.getByRole("button", { name: "Download .env" }).click();
  const dialog = target.getByTestId("download-dotenv-dialog");
  await expect(dialog).toContainText("plain text");
  await expect(dialog).toContainText("1 variable has no value");
  const downloadPromise = target.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("production.env");
  const path = await download.path();
  expect(await readFile(path, "utf8")).toBe(
    "API_URL='https://api.test'\nTOKEN=\"t0k\\$n\"\n",
  );
});

test("Refresh loads a teammate's change and keeps the draft", async ({
  page: target,
}) => {
  test.setTimeout(90_000);
  const fixture = await installEnvironment(target);
  const editor = await openEditor(target);
  await editor.getByLabel("API_URL Value").fill("https://draft.test");
  await expect(
    editor.getByTestId("environment-variable-API_URL"),
  ).toContainText("Draft change");

  fixture.publishTeammateChange();
  const before = fixture.syncCalls;
  await editor.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => fixture.syncCalls).toBeGreaterThan(before);
  await expect(await tokenValue(editor)).toHaveValue("rotated-token");
  await expect(editor.getByLabel("API_URL Value")).toHaveValue(
    "https://draft.test",
  );
  await expect(
    editor.getByTestId("environment-variable-API_URL"),
  ).toContainText("Draft change");
});

test("a publish failure says what happened and that the draft is kept", async ({
  page: target,
}) => {
  test.setTimeout(90_000);
  await installEnvironment(target);
  let failure: "offline" | "unavailable" = "unavailable";
  await target.route(/\/api\/v1\/operations\/.*\/begin/, (route) =>
    failure === "offline"
      ? route.abort("internetdisconnected")
      : route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          json: {
            type: "https://dotrelay.dev/problems/v1",
            title: "Service unavailable",
            status: 503,
            code: "service_unavailable",
            detail: "Unavailable.",
          },
        }),
  );
  const editor = await openEditor(target);
  await editor.getByLabel("API_URL Value").fill("https://draft.test");
  const publish = async () => {
    await editor.getByRole("button", { name: "Save changes" }).click();
    await target
      .getByRole("dialog", { name: "Save changes" })
      .getByRole("button", { name: "Publish" })
      .click();
  };

  await publish();
  await expect(editor.getByText(/unavailable right now/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(editor.getByText(/Your draft is kept/)).toBeVisible();
  await expect(editor.getByText(/Refresh and try again/)).toHaveCount(0);

  failure = "offline";
  await target.keyboard.press("Escape");
  await publish();
  await expect(editor.getByText(/Couldn't reach the server/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(editor.getByLabel("API_URL Value")).toHaveValue(
    "https://draft.test",
  );
});

test("after a stale-head publish without conflicts, others' values are shown fresh", async ({
  page: target,
}) => {
  test.setTimeout(90_000);
  const fixture = await installEnvironment(target);
  await target.route(/\/api\/v1\/operations\/.*\/begin/, (route) =>
    route.fulfill({
      json: {
        operationId: "in-flight",
        status: "ACCEPTED",
        idempotent: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  );
  await target.route(/\/api\/v1\/operations\/.*\/staging\/.*/, (route) =>
    route.fulfill({ status: 200 }),
  );
  await target.route(/\/api\/v1\/operations\/[^/]+$/, (route) =>
    route.fulfill({ json: {} }),
  );
  await target.route(/\/api\/v1\/operations\/.*\/finalize/, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: {
        type: "https://dotrelay.dev/problems/v1",
        title: "Stale head",
        status: 409,
        code: "stale_head",
        detail: "The head moved.",
      },
    }),
  );
  const editor = await openEditor(target);
  await expect(await tokenValue(editor)).toHaveValue("t0k$n");
  await editor.getByLabel("API_URL Value").fill("https://draft.test");

  fixture.publishTeammateChange();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await target
    .getByRole("dialog", { name: "Save changes" })
    .getByRole("button", { name: "Publish" })
    .click();
  await expect(
    editor.getByText(/Someone else published changes to other variables/),
  ).toBeVisible({ timeout: 15_000 });
  // The teammate's TOKEN change is on screen; the draft is untouched.
  await expect(editor.getByLabel("TOKEN Value")).toHaveValue("rotated-token");
  await expect(
    editor.getByTestId("environment-variable-TOKEN"),
  ).not.toContainText("Draft change");
  await expect(editor.getByLabel("API_URL Value")).toHaveValue(
    "https://draft.test",
  );
});
