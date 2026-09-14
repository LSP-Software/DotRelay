import { expect, type Locator, type Page, test } from "@playwright/test";

const LONG_NAME =
  "PAYMENTS_STAGING_SHARED_SERVICE_ORIGIN_WITH_REGION_LOAD_POOL_CERT_BUNDLE_AND_ROTATING_SIGNING_MATERIAL_FOR_CLI";
const LONG_DESCRIPTION =
  "Shared origin for the payments team's staging services: the region, the load balancer pool, and the certificate bundle the CLI uses when it rotates signing material on schedule.";

const openProtectedEditor = async (page: Page) => {
  await page.goto("/workspace?preview=protected");
  await expect(page.getByRole("heading", { name: "Variables" })).toBeVisible();
};

const addLongVariable = async (page: Page) => {
  await page.getByRole("button", { name: "Add Variable" }).click();
  await page.getByLabel("Variable name").fill(LONG_NAME);
  await page.getByLabel("Description (optional)").fill(LONG_DESCRIPTION);
  await page.getByText("Shared Value", { exact: true }).last().click();
  await page.getByLabel("Initial Value").fill("wrap-check-value");
  await page.getByRole("button", { name: "Add Variable" }).last().click();
};

const assertReadableWithoutHover = async (locator: Locator) => {
  await expect(locator).toBeVisible();
  // The full text must be rendered; a title tooltip is a hover-only reveal.
  await expect(locator).not.toHaveAttribute("title");
  // Wrapping keeps the text unclipped: no hidden overflow in either axis.
  await expect
    .poll(async () =>
      locator.evaluate(
        (el) =>
          el.scrollWidth <= el.clientWidth &&
          el.scrollHeight <= el.clientHeight,
      ),
    )
    .toBe(true);
  const styles = await locator.evaluate((el) => {
    const css = getComputedStyle(el);
    return { whiteSpace: css.whiteSpace, textOverflow: css.textOverflow };
  });
  expect(styles.whiteSpace).not.toBe("nowrap");
  expect(styles.textOverflow).not.toBe("ellipsis");
};

test("long Variable names and descriptions are fully visible without hover", async ({
  page,
}) => {
  await openProtectedEditor(page);
  await addLongVariable(page);

  const row = page.getByTestId(`environment-variable-${LONG_NAME}`);
  await expect(row).toBeVisible();
  await assertReadableWithoutHover(row.getByText(LONG_NAME, { exact: true }));
  await assertReadableWithoutHover(
    row.getByText(LONG_DESCRIPTION, { exact: true }),
  );
});

test("a long name stays distinguishable next to its Value and delete controls", async ({
  page,
}) => {
  await openProtectedEditor(page);
  await addLongVariable(page);

  const row = page.getByTestId(`environment-variable-${LONG_NAME}`);
  await expect(row.getByText(LONG_NAME, { exact: true })).toBeVisible();
  await expect(row.getByLabel(`${LONG_NAME} Value`)).toBeVisible();
  await expect(
    row.getByRole("button", { name: `Delete ${LONG_NAME}` }),
  ).toBeVisible();
  await expect(row.getByText("Draft change", { exact: true })).toBeVisible();
});

test("text zoom and a phone viewport keep names, descriptions, and badges readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProtectedEditor(page);
  await addLongVariable(page);

  const row = page.getByTestId(`environment-variable-${LONG_NAME}`);
  await expect(row).toBeVisible();
  await assertReadableWithoutHover(row.getByText(LONG_NAME, { exact: true }));
  await assertReadableWithoutHover(
    row.getByText(LONG_DESCRIPTION, { exact: true }),
  );

  await page.addStyleTag({ content: "html { zoom: 1.5; }" });

  await expect
    .poll(async () => row.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBe(true);
  await assertReadableWithoutHover(row.getByText(LONG_NAME, { exact: true }));
  await assertReadableWithoutHover(
    row.getByText(LONG_DESCRIPTION, { exact: true }),
  );
  await expect(row.getByText("Shared Value", { exact: true })).toBeVisible();
  await expect(row.getByText("Draft change", { exact: true })).toBeVisible();
});

test("the Save changes review shows full long names without hover", async ({
  page,
}) => {
  await openProtectedEditor(page);
  await addLongVariable(page);

  await page.getByRole("button", { name: "Save changes" }).click();
  const reviewDialog = page.getByRole("dialog", { name: "Save changes" });
  await assertReadableWithoutHover(
    reviewDialog.getByText(LONG_NAME, { exact: true }),
  );
});
