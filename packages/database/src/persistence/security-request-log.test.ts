import { describe, expect, test } from "bun:test";
import {
  SECURITY_REQUEST_ENDPOINT_TEMPLATES,
  SECURITY_REQUEST_LOG_RETENTION_MS,
  SecurityRequestLogRepository,
} from "./repositories";

describe("Security Request Log boundary", () => {
  test("accepts only a known endpoint template and bounded metadata", async () => {
    const executed: unknown[] = [];
    const database = {
      $executeRaw: async (input: unknown) => {
        executed.push(input);
        return 1;
      },
    } as never;
    const repository = new SecurityRequestLogRepository();
    const requestedAt = new Date("2026-01-01T00:00:00.000Z");
    const endpointTemplate = SECURITY_REQUEST_ENDPOINT_TEMPLATES[0];

    await repository.append(database, {
      ipAddress: "192.0.2.10",
      endpointTemplate,
      httpStatus: 401,
      transferBytes: 0n,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 1),
    });
    expect(executed).toHaveLength(1);
  });

  test("rejects arbitrary endpoint, status, size, and expiry values", async () => {
    const database = {
      securityRequestLog: { create: async () => undefined },
    } as never;
    const repository = new SecurityRequestLogRepository();
    const requestedAt = new Date("2026-01-01T00:00:00.000Z");
    const endpointTemplate = SECURITY_REQUEST_ENDPOINT_TEMPLATES[0];
    const base = {
      ipAddress: "192.0.2.10",
      endpointTemplate,
      httpStatus: 200,
      transferBytes: 0n,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 1),
    } as const;

    await expect(
      repository.append(database, {
        ...base,
        endpointTemplate: "/users/123" as never,
      }),
    ).rejects.toThrow("endpoint template");
    await expect(
      repository.append(database, { ...base, httpStatus: 99 }),
    ).rejects.toThrow("status");
    await expect(
      repository.append(database, { ...base, transferBytes: -1n }),
    ).rejects.toThrow("transfer");
    await expect(
      repository.append(database, { ...base, expiresAt: requestedAt }),
    ).rejects.toThrow("expire");
    await expect(
      repository.append(database, {
        ...base,
        expiresAt: new Date(
          requestedAt.getTime() + SECURITY_REQUEST_LOG_RETENTION_MS + 1,
        ),
      }),
    ).rejects.toThrow("30 days");
  });
});
