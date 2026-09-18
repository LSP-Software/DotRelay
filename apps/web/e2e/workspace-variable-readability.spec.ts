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
  await page.getByText("Shared value", { exact: true }).last().click();
  await page.getByLabel("Initial value").fill("wrap-check-value");
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

const boxesDoNotOverlap = async (a: Locator, b: Locator) => {
  await expect
    .poll(async () => {
      const [boxA, boxB] = await Promise.all([
        a.boundingBox(),
        b.boundingBox(),
      ]);
      if (!boxA || !boxB) return false;
      const touchesX =
        boxA.x < boxB.x + boxB.width - 2 && boxB.x < boxA.x + boxA.width - 2;
      const touchesY =
        boxA.y < boxB.y + boxB.height - 2 && boxB.y < boxA.y + boxA.height - 2;
      return !(touchesX && touchesY);
    })
    .toBe(true);
};

const assertRowReadable = async (row: Locator) => {
  await expect
    .poll(async () => row.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBe(true);
  const name = row.getByText(LONG_NAME, { exact: true });
  await assertReadableWithoutHover(name);
  await assertReadableWithoutHover(
    row.getByText(LONG_DESCRIPTION, { exact: true }),
  );
  const ownership = row.getByText("Shared value", { exact: true });
  const draft = row.getByText("Draft change", { exact: true });
  await expect(ownership).toBeVisible();
  await expect(draft).toBeVisible();
  // toBeVisible cannot detect overlap; assert the boxes stay disjoint.
  await boxesDoNotOverlap(name, ownership);
  await boxesDoNotOverlap(name, draft);
  await boxesDoNotOverlap(ownership, draft);
};

test("text zoom and a phone viewport keep names, descriptions, and badges readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProtectedEditor(page);
  await addLongVariable(page);

  const row = page.getByTestId(`environment-variable-${LONG_NAME}`);
  await expect(row).toBeVisible();
  await assertRowReadable(row);

  // Uniform page zoom.
  await page.addStyleTag({ content: "html { zoom: 1.5; }" });
  await assertRowReadable(row);

  // Text-size zoom: rem-based text and containers grow while the px-sized
  // ownership/draft badges keep their size, the harder no-overlap case.
  await page.addStyleTag({ content: "html { zoom: 1; font-size: 24px; }" });
  await assertRowReadable(row);
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
