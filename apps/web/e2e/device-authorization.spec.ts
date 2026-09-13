import { expect, type Page, test } from "@playwright/test";

const USER_CODE = "ABC12DEF";

type CodeStatus =
  | { readonly kind: "pending" | "approved" | "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

type SessionState = "signed-in" | "signed-out" | "unavailable";

type ApprovalOutcome =
  | "success"
  | "expired"
  | "forbidden"
  | "stale"
  | "signed-out"
  | "unavailable";

type DeviceFlowState = Readonly<{
  readonly status: CodeStatus;
  readonly session: SessionState;
  readonly approve: ApprovalOutcome;
}>;

const json = (status: number, body: unknown) => ({
  body: JSON.stringify(body),
  contentType: "application/json",
  status,
});

const unavailable = json(503, {
  code: "service_unavailable",
  detail: "Service unavailable",
});

const statusFulfill = (status: CodeStatus) => {
  switch (status.kind) {
    case "expired":
      return json(400, { error: "expired_token" });
    case "invalid":
      return json(400, { error: "invalid_request" });
    case "unavailable":
      return unavailable;
    default:
      return json(200, { user_code: USER_CODE, status: status.kind });
  }
};

const sessionFulfill = (session: SessionState) => {
  switch (session) {
    case "signed-in":
      return json(200, { session: { token: "test" }, user: { id: "u" } });
    case "signed-out":
      return json(200, null);
    default:
      return unavailable;
  }
};

const approveFulfill = (outcome: ApprovalOutcome) => {
  switch (outcome) {
    case "success":
      return json(200, { success: true });
    case "expired":
      return json(400, { error: "expired_token" });
    case "forbidden":
      return json(403, { error: "access_denied" });
    case "stale":
      return json(400, { error: "invalid_request" });
    case "signed-out":
      return json(401, { error: "unauthorized" });
    default:
      return unavailable;
  }
};

const mockDeviceFlow = async (
  page: Page,
  getState: () => DeviceFlowState,
  getSession: () => SessionState = () => getState().session,
) => {
  await page.route("**/api/auth/device**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/device")
      return route.fulfill(statusFulfill(getState().status));
    if (url.pathname === "/api/auth/device/approve")
      return route.fulfill(approveFulfill(getState().approve));
    return route.fulfill(json(404, unavailable.body));
  });
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(sessionFulfill(getSession())),
  );
};

const openDevicePage = async (page: Page) => {
  await page.goto(`/device?user_code=${USER_CODE}`);
};

test("a signed-in user allows a pending code and sees the completed outcome", async ({
  page,
}) => {
  await mockDeviceFlow(page, () => ({
    status: { kind: "pending" },
    session: "signed-in",
    approve: "success",
  }));
  await openDevicePage(page);

  await expect(page.getByTestId("device-approval-allow")).toBeVisible();
  await page.getByTestId("device-approval-allow").click();
  await expect(page.getByTestId("device-approval-approved")).toBeVisible();
  await expect(page.getByText(USER_CODE)).toBeVisible();
});

test("a signed-out user with a pending code sees only the sign-in control", async ({
  page,
}) => {
  await mockDeviceFlow(page, () => ({
    status: { kind: "pending" },
    session: "signed-out",
    approve: "success",
  }));
  await openDevicePage(page);

  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  await expect(page.getByTestId("device-approval-allow")).toHaveCount(0);
});

test("an expired code ends with return-to-CLI instructions, not sign-in", async ({
  page,
}) => {
  await mockDeviceFlow(page, () => ({
    status: { kind: "expired" },
    session: "signed-in",
    approve: "expired",
  }));
  await openDevicePage(page);

  await expect(page.getByTestId("device-approval-expired")).toBeVisible();
  await expect(page.getByText(/dotrelay login/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("device-approval-allow")).toHaveCount(0);
  await expect(page.getByText(USER_CODE)).toBeVisible();
});

test("an invalid code ends with return-to-CLI instructions, not sign-in", async ({
  page,
}) => {
  await mockDeviceFlow(page, () => ({
    status: { kind: "invalid" },
    session: "signed-in",
    approve: "stale",
  }));
  await openDevicePage(page);

  await expect(page.getByTestId("device-approval-invalid")).toBeVisible();
  await expect(page.getByText(/dotrelay login/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("device-approval-allow")).toHaveCount(0);
});

test("an already-approved code is handled as completed", async ({ page }) => {
  await mockDeviceFlow(page, () => ({
    status: { kind: "approved" },
    session: "signed-in",
    approve: "stale",
  }));
  await openDevicePage(page);

  await expect(page.getByTestId("device-approval-approved")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("device-approval-allow")).toHaveCount(0);
});

test("a connection failure preserves the code and recovers through retry", async ({
  page,
}) => {
  const state: { current: DeviceFlowState } = {
    current: {
      status: { kind: "unavailable" },
      session: "unavailable",
      approve: "unavailable",
    },
  };
  await mockDeviceFlow(page, () => state.current);
  await openDevicePage(page);

  await expect(page.getByTestId("device-approval-connection")).toBeVisible();
  await expect(page.getByText(USER_CODE)).toBeVisible();

  state.current = {
    status: { kind: "pending" },
    session: "signed-in",
    approve: "success",
  };
  await page.getByTestId("device-approval-retry").click();
  await expect(page.getByTestId("device-approval-allow")).toBeVisible();
  await expect(page.getByText(USER_CODE)).toBeVisible();
});

test("a transient approval failure preserves the code until retry succeeds", async ({
  page,
}) => {
  const state: { current: DeviceFlowState } = {
    current: {
      status: { kind: "pending" },
      session: "signed-in",
      approve: "unavailable",
    },
  };
  await mockDeviceFlow(page, () => state.current);
  await openDevicePage(page);

  await expect(page.getByTestId("device-approval-allow")).toBeVisible();
  await page.getByTestId("device-approval-allow").click();
  await expect(page.getByTestId("device-approval-connection")).toBeVisible();
  await expect(page.getByText(USER_CODE)).toBeVisible();

  state.current = {
    status: { kind: "pending" },
    session: "signed-in",
    approve: "success",
  };
  await page.getByTestId("device-approval-retry").click();
  await expect(page.getByTestId("device-approval-allow")).toBeVisible();
  await page.getByTestId("device-approval-allow").click();
  await expect(page.getByTestId("device-approval-approved")).toBeVisible();
});

test("a lapsed session during approval returns to the sign-in control", async ({
  page,
}) => {
  const state: { current: DeviceFlowState } = {
    current: {
      status: { kind: "pending" },
      session: "signed-in",
      approve: "signed-out",
    },
  };
  // The session lapses after the initial check, so only the get-session
  // route advances the counter.
  let sessionChecks = 0;
  await mockDeviceFlow(
    page,
    () => state.current,
    () => {
      sessionChecks += 1;
      return sessionChecks <= 1 ? "signed-in" : "signed-out";
    },
  );
  await openDevicePage(page);

  await expect(page.getByTestId("device-approval-allow")).toBeVisible();
  await page.getByTestId("device-approval-allow").click();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  await expect(page.getByTestId("device-approval-allow")).toHaveCount(0);
});
