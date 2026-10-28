import { describe, expect, test } from "bun:test";
import { createProblem } from "@dotrelay/contracts";
import {
  AccountKeyWrapperNotActiveError,
  DeviceNotActiveError,
  EnvironmentNotActiveError,
  MembershipNotActiveError,
  ProjectNotActiveError,
  TeamNotActiveError,
} from "@dotrelay/database";
import { mapPersistenceError } from "./errors";

describe("mapPersistenceError not-active family", () => {
  test("device and membership not-active errors map to different codes", () => {
    const device = mapPersistenceError(new DeviceNotActiveError());
    const membership = mapPersistenceError(new MembershipNotActiveError());
    expect(device?.code).toBe("device_not_active");
    expect(membership?.code).toBe("membership_not_active");
    expect(device?.code).not.toBe(membership?.code);
  });

  test("device not-active variants all map to device_not_active", () => {
    expect(mapPersistenceError(new DeviceNotActiveError())?.code).toBe(
      "device_not_active",
    );
    expect(
      mapPersistenceError(
        new DeviceNotActiveError("actor device is not active"),
      )?.code,
    ).toBe("device_not_active");
    expect(
      mapPersistenceError(
        new DeviceNotActiveError("grant recipient device is not active"),
      )?.code,
    ).toBe("device_not_active");
    expect(
      mapPersistenceError(
        new DeviceNotActiveError("transfer recipient device is not active"),
      )?.code,
    ).toBe("device_not_active");
  });

  test("project, environment, and team not-active errors map to archived_resource", () => {
    expect(mapPersistenceError(new ProjectNotActiveError())?.code).toBe(
      "archived_resource",
    );
    expect(mapPersistenceError(new EnvironmentNotActiveError())?.code).toBe(
      "archived_resource",
    );
    expect(mapPersistenceError(new TeamNotActiveError())?.code).toBe(
      "archived_resource",
    );
  });

  test("account key wrapper not-active errors map to state_conflict", () => {
    expect(
      mapPersistenceError(new AccountKeyWrapperNotActiveError())?.code,
    ).toBe("state_conflict");
  });

  test("untyped not-active errors keep the generic fallback", () => {
    expect(mapPersistenceError(new Error("Device is not active"))?.code).toBe(
      "device_not_active",
    );
    expect(
      mapPersistenceError(new Error("the staging object is not active"))?.code,
    ).toBe("device_not_active");
  });
});

describe("membership_not_active problem contract", () => {
  test("carries HTTP 403 with a distinct title", () => {
    const problem = createProblem("membership_not_active");
    expect(problem.status).toBe(403);
    expect(problem.code).toBe("membership_not_active");
    expect(problem.title).toBe("Membership not active");
    expect(problem.title).not.toBe(createProblem("device_not_active").title);
  });
});
