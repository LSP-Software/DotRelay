import { describe, expect, test } from "bun:test";
import {
  createApiObservability,
  createInMemoryDiagnosticSink,
  createServerCorrelationId,
  endpointTemplateFor,
} from "./observability";

describe("API observability boundary", () => {
  test("sanitizes direct sink input before retaining it", () => {
    const diagnostics = createInMemoryDiagnosticSink(() => 0);
    const event = {
      schemaVersion: 1,
      eventName: "api.request.completed",
      correlationId: createServerCorrelationId(),
      retryAfterSeconds: 5,
    } as const;
    diagnostics.emit(event);
    expect(diagnostics.records()).toEqual([
      expect.objectContaining({ retryAfterSeconds: 5 }),
    ]);

    diagnostics.emit({
      ...event,
      // @ts-expect-error adversarial fields are rejected at runtime
      secret: "plaintext",
    });
    expect(diagnostics.records()).toHaveLength(1);
  });

  test("creates opaque Correlation IDs and maps paths to templates", () => {
    expect(createServerCorrelationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      endpointTemplateFor(
        "/api/v1/operations/00000000-0000-4000-8000-000000000001/begin",
      ),
    ).toBe("/api/v1/operations/:operationId/begin");
    expect(endpointTemplateFor("/api/v1/unknown?secret=value")).toBeNull();
  });

  test("emits bounded diagnostics and separately records approved request metadata", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const diagnostics = createInMemoryDiagnosticSink(() => now.getTime());
    const securityRows: unknown[] = [];
    const database = {
      securityRequestLog: {
        create: async (input: unknown) => {
          securityRows.push(input);
          return input;
        },
      },
      $transaction: async (callback: (database: unknown) => unknown) =>
        callback({
          securityRequestLog: {
            deleteMany: async () => ({ count: 2 }),
          },
        }),
    } as never;
    const observability = createApiObservability(database, {
      diagnostics,
      now: () => now,
      sampleRate: 1,
      resolveClientIp: (request) =>
        request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim() ??
        null,
    });
    const correlationId = createServerCorrelationId();

    observability.recordRequest({
      request: new Request("https://relay.example/api/v1/session", {
        headers: {
          "X-Forwarded-For": "192.0.2.10",
          "Content-Length": "17",
        },
      }),
      path: "/api/v1/session",
      status: 401,
      correlationId,
      durationMs: 4.4,
    });
    await Promise.resolve();

    expect(diagnostics.records()).toEqual([
      expect.objectContaining({
        eventName: "api.request.completed",
        correlationId,
        durationMs: 4,
        outcome: "failure",
      }),
    ]);
    expect(JSON.stringify(diagnostics.records())).not.toContain("192.0.2.10");
    expect(securityRows).toHaveLength(1);
    expect(securityRows[0]).toMatchObject({
      data: expect.objectContaining({
        endpointTemplate: "/api/v1/session",
        ipAddress: "192.0.2.10",
        httpStatus: 401,
        transferBytes: 17n,
      }),
    });
    await expect(observability.expireSecurityRequestLogs(now)).resolves.toBe(2);
  });

  test("does not let a diagnostic or security sink failure affect requests", () => {
    const observability = createApiObservability({} as never, {
      diagnostics: {
        emit: () => {
          throw new Error("sink unavailable");
        },
      },
    });
    expect(() =>
      observability.recordRequest({
        request: new Request("https://relay.example/health"),
        path: "/health",
        status: 200,
        correlationId: createServerCorrelationId(),
        durationMs: 0,
      }),
    ).not.toThrow();
  });

  test("keeps hosted and self-hosted request policy identical", async () => {
    const makeDatabase = () => {
      const rows: unknown[] = [];
      return {
        rows,
        database: {
          securityRequestLog: {
            create: async (input: unknown) => {
              rows.push(input);
              return input;
            },
          },
        } as never,
      };
    };
    const hosted = makeDatabase();
    const selfHosted = makeDatabase();
    const request = new Request("https://relay.example/api/v1/session", {
      headers: { "Content-Length": "8" },
    });
    const input = {
      request,
      path: "/api/v1/session",
      status: 401,
      correlationId: createServerCorrelationId(),
      durationMs: 2,
    } as const;
    const createPolicy = (database: never) =>
      createApiObservability(database, {
        sampleRate: 0,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        resolveClientIp: () => "192.0.2.10",
      });
    createPolicy(hosted.database).recordRequest(input);
    createPolicy(selfHosted.database).recordRequest(input);
    await Promise.resolve();
    expect(hosted.rows).toEqual(selfHosted.rows);
  });
});
