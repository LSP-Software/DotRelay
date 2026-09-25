import {
  type APIResponse,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

// A 320 CSS-pixel phone rendered at 200% zoom lays out in 160 CSS pixels.
const ZOOMED_VIEWPORT = { width: 160, height: 240 };
const SHORT_PHONE_VIEWPORT = { width: 320, height: 500 };
const MOBILE_VIEWPORT = { width: 390, height: 700 };
// A phone viewport shortened by an on-screen keyboard approximates the
// visual-viewport shrink that dvh-based dialog constraints track.
const KEYBOARD_VIEWPORT = { width: 320, height: 340 };

const expectInViewport = async (page: Page, locator: Locator) => {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        if (box === null) return false;
        return (
          box.x >= -1 &&
          box.y >= -1 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1
        );
      },
      { message: "element should be inside the viewport", timeout: 5_000 },
    )
    .toBe(true);
};

// The dialog footer stays pinned to the dialog's bottom edge, so a field
// must clear the footer's top edge to be visible, not just the page's.
const expectAboveDialogFooter = async (dialog: Locator, field: Locator) => {
  await expect
    .poll(
      async () => {
        const [fieldBox, footerBox] = await Promise.all([
          field.boundingBox(),
          dialog.locator('[data-slot="dialog-footer"]').boundingBox(),
        ]);
        if (fieldBox === null || footerBox === null) return false;
        return fieldBox.y + fieldBox.height <= footerBox.y + 1;
      },
      {
        message: "field should be visible above the dialog footer",
        timeout: 5_000,
      },
    )
    .toBe(true);
};

const setDialogScroll = (dialog: Locator, value: number) =>
  dialog.evaluate((element, next) => {
    element.scrollTop = next;
  }, value);

const addLongProjectList = async (page: Page, projectCount: number) => {
  await page.route("**/api/workspace/boundary*", async (route) => {
    // Same teardown race as the device-summary spec: an in-flight
    // route.fetch rejects with "Test ended" and fails the next test.
    let response: APIResponse;
    try {
      response = await route.fetch();
    } catch {
      await route.abort().catch(() => {});
      return;
    }
    const body = (await response.json()) as {
      catalog?: {
        teams?: readonly unknown[];
        projects?: readonly Record<string, unknown>[];
      };
    };
    const projects = body.catalog?.projects ?? [];
    const longList = Array.from({ length: projectCount }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(100000 + index).padStart(8, "0")}`,
      teamId: "00000000-0000-4000-8000-000000000011",
      githubRepositoryId: String(900000 + index),
      lifecycle: "ACTIVE",
      environments: [
        {
          id: `00000000-0000-4000-8000-${String(200000 + index).padStart(8, "0")}`,
          label: "production",
          lifecycle: "ACTIVE",
          currentHeadId: null,
        },
      ],
    }));
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify({
        ...body,
        catalog: {
          ...body.catalog,
          projects: [...longList, ...projects],
        },
      }),
    });
  });
};

const openAddVariableDialog = (page: Page): Locator => {
  const dialog = page.getByRole("dialog");
  void page.getByRole("button", { name: "Add Variable" }).click();
  return dialog;
};

test("the Add Variable form stays reachable on a short phone viewport", async ({
  page,
}) => {
  await page.setViewportSize(SHORT_PHONE_VIEWPORT);
  await page.goto("/workspace?preview=protected");
  const dialog = openAddVariableDialog(page);
  await expect(dialog).toBeVisible();

  // The dialog is constrained to the viewport instead of spilling past its edges.
  await expectInViewport(page, dialog);

  // The form is taller than the dialog, so the dialog must scroll internally.
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);

  // The footer actions stay visible while the form body scrolls.
  const add = dialog.getByRole("button", { name: "Add Variable" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expectInViewport(page, add);
  await expectInViewport(page, cancel);

  // Every field group is reachable: the name at the top, the description and
  // ownership choices in the middle, and the value and Value-presence
  // checkboxes at the bottom.
  await setDialogScroll(dialog, 0);
  await expectInViewport(page, dialog.getByLabel("Variable name"));

  await dialog.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  });
  await expectInViewport(page, dialog.getByLabel("Description (optional)"));
  await expectInViewport(
    page,
    dialog.getByText("Shared value", { exact: true }),
  );

  await setDialogScroll(dialog, Number.MAX_SAFE_INTEGER);
  const initial = dialog.getByRole("textbox", { name: "Initial value" });
  await expectInViewport(page, initial);
  await expectInViewport(page, dialog.getByText("Require a value"));
  await expectInViewport(page, add);
  await expectInViewport(page, cancel);

  // Focusing a field scrolls it into view above the pinned footer.
  await initial.focus();
  await expectInViewport(page, initial);
  await expectAboveDialogFooter(dialog, initial);
  await expectInViewport(page, add);
  await expectInViewport(page, cancel);
});

test("the Add Variable form stays reachable at 200% zoom", async ({ page }) => {
  await page.setViewportSize(ZOOMED_VIEWPORT);
  await page.goto("/workspace?preview=protected");
  const dialog = openAddVariableDialog(page);
  await expect(dialog).toBeVisible();
  await expectInViewport(page, dialog);

  const add = dialog.getByRole("button", { name: "Add Variable" });
  await expectInViewport(page, add);
  const name = dialog.getByLabel("Variable name");
  await expectInViewport(page, name);

  // The pinned footer never covers a focused field: focusing the Initial
  // Value field scrolls it fully above the footer actions.
  const initial = dialog.getByRole("textbox", { name: "Initial value" });
  await initial.focus();
  await expectInViewport(page, initial);
  await expectAboveDialogFooter(dialog, initial);
  await expectInViewport(page, add);

  // The dialog opened focused on the first field, so blur it first: focusing
  // an element that already has focus fires no focus event to scroll on.
  await name.blur();
  await name.focus();
  await expectInViewport(page, name);
  await expectAboveDialogFooter(dialog, name);
});

test("a focused field and the submit action stay visible over the keyboard", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/workspace?preview=protected");
  const dialog = openAddVariableDialog(page);
  await expect(dialog).toBeVisible();
  await expectInViewport(page, dialog);

  const add = dialog.getByRole("button", { name: "Add Variable" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });

  // Focusing a mid-form field keeps both the field and the submit action on
  // screen, with the field clear of the pinned footer.
  const initial = dialog.getByRole("textbox", { name: "Initial value" });
  await initial.focus();
  await expectInViewport(page, initial);
  await expectAboveDialogFooter(dialog, initial);
  await expectInViewport(page, add);
  await expectInViewport(page, cancel);

  // Focus the last field, then let the keyboard raise. Playwright cannot
  // shrink only the visual viewport, so the on-screen keyboard is
  // approximated by resizing the layout viewport, which dvh-based dialog
  // constraints track; the focused field must stay visible above the pinned
  // footer and the submit action must stay on screen.
  const requiresValue = dialog.getByLabel("Require a value");
  await requiresValue.focus();
  await expectInViewport(page, requiresValue);
  await expectAboveDialogFooter(dialog, requiresValue);
  await expectInViewport(page, add);
  await expectInViewport(page, cancel);

  await page.setViewportSize(KEYBOARD_VIEWPORT);
  await expectInViewport(page, dialog);
  await expectInViewport(page, requiresValue);
  await expectAboveDialogFooter(dialog, requiresValue);
  await expectInViewport(page, add);
  await expectInViewport(page, cancel);

  // Focusing a field while the keyboard is up scrolls it into view; blur
  // first because focusing the already-focused field fires no focus event
  // to scroll on.
  await requiresValue.blur();
  await requiresValue.focus();
  await expectInViewport(page, requiresValue);
  await expectAboveDialogFooter(dialog, requiresValue);
  await expectInViewport(page, add);
  await expectInViewport(page, cancel);
});

test("a long Project list keeps desktop navigation reachable", async ({
  page,
}) => {
  await addLongProjectList(page, 60);
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();

  const sidebar = page.locator("aside");
  const devices = sidebar.getByRole("button", { name: "Devices" });
  await devices.scrollIntoViewIfNeeded();
  await expectInViewport(page, devices);

  const recovery = sidebar.getByRole("button", { name: "Recovery" });
  await recovery.scrollIntoViewIfNeeded();
  await expectInViewport(page, recovery);

  // The brand header and account block stay fixed while the middle scrolls.
  await expectInViewport(page, sidebar.getByText("DotRelay", { exact: true }));
  await expectInViewport(page, sidebar.getByText("Ari Stone", { exact: true }));

  await devices.click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
});

test("a long Project list keeps mobile navigation reachable", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await addLongProjectList(page, 60);
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open navigation" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  const recovery = sheet.getByRole("button", { name: "Recovery" });
  await recovery.scrollIntoViewIfNeeded();
  await expectInViewport(page, recovery);

  // The close button stays pinned while the navigation list scrolls.
  await expectInViewport(page, sheet.getByRole("button", { name: "Close" }));

  await recovery.click();
  await expect(page.getByRole("heading", { name: "Recovery" })).toBeVisible();
});
