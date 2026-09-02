import { describe, expect, test } from "bun:test";
import {
  createCorrelationId,
  createDiagnosticEvent,
  createExplicitCrashReport,
  createLocalDiagnosticStore,
  createPrivateTrace,
  DIAGNOSTIC_RETENTION_MS,
  DiagnosticBoundaryError,
  metricDimensionsFromEvent,
  OPTIONAL_TRACE_RETENTION_MS,
  redactDiagnosticEvent,
  serializeDiagnosticEvent,
} from "./event";

describe("value-blind diagnostics", () => {
  test("accepts only allowlisted diagnostic fields", () => {
    const event = createDiagnosticEvent({
      eventName: "client.storage.load",
      correlationId: createCorrelationId(),
      durationMs: 12,
      outcome: "failure",
      problemCode: "stale_head",
    });
    expect(event.eventName).toBe("client.storage.load");
    expect(serializeDiagnosticEvent(event)).not.toContain("secret");
  });

  test("rejects arbitrary diagnostic content", () => {
    expect(() =>
      createDiagnosticEvent({
        eventName: "client.test",
        // @ts-expect-error arbitrary metadata is forbidden
        secret: "value",
      }),
    ).toThrow(DiagnosticBoundaryError);
  });

  test("creates fresh opaque Correlation IDs and a versioned envelope", () => {
    const first = createCorrelationId();
    const second = createCorrelationId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).not.toBe(first);

    const serialized = JSON.parse(
      serializeDiagnosticEvent(
        createDiagnosticEvent({
          eventName: "client.storage.load",
          correlationId: first,
        }),
      ),
    ) as Record<string, unknown>;
    expect(serialized).toMatchObject({
      schemaVersion: 1,
      eventName: "client.storage.load",
      correlationId: first,
    });
    expect(
      serializeDiagnosticEvent(
        createDiagnosticEvent({
          eventName: "client.storage.load",
          correlationId: first,
        }),
      ),
    ).toBe(
      `{"schemaVersion":1,"eventName":"client.storage.load","correlationId":"${first}"}`,
    );
    expect(Object.keys(serialized).sort()).toMatchInlineSnapshot(`
      [
        "correlationId",
        "eventName",
        "schemaVersion",
      ]
    `);
  });

  test("bounds safe fields and rejects malformed values", () => {
    expect(() =>
      createDiagnosticEvent({
        eventName: "x".repeat(129),
      }),
    ).toThrow("exceeds");
    expect(() =>
      createDiagnosticEvent({
        eventName: "client.storage.load",
        durationMs: -1,
      }),
    ).toThrow("durationMs");
    expect(() =>
      createDiagnosticEvent({
        eventName: "client.storage.load",
        correlationId: "user id" as never,
      }),
    ).toThrow("correlationId");
    expect(() =>
      createDiagnosticEvent({
        eventName: "client.sync.failed",
        problemCode: "invalid_crypto_object",
      }),
    ).toThrow("problem code");
  });

  test("redacts forbidden fields without allowing them into an event", () => {
    const forbiddenFields = [
      "plaintext",
      "ciphertext",
      "privateKey",
      "recoveryKit",
      "bearerCredential",
      "authorization",
      "ipAddress",
      "userId",
      "environmentId",
      "stack",
    ];
    const hostilePayloads = Array.from({ length: 128 }, (_, index) => ({
      eventName: "client.storage.load",
      [forbiddenFields[index % forbiddenFields.length] as string]:
        "forbidden-value",
      context: { nested: { ciphertext: "ciphertext" } },
    }));
    for (const payload of hostilePayloads)
      expect(redactDiagnosticEvent(payload)).toEqual({
        eventName: "client.storage.load",
      });
    expect(redactDiagnosticEvent({ secret: "plaintext" })).toBeNull();
    expect(DIAGNOSTIC_RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test("fuzzes nested and forbidden diagnostic payloads fail-closed", () => {
    const fields = [
      "plaintext",
      "ciphertext",
      "privateKey",
      "recoveryKit",
      "bearerCredential",
      "authorization",
      "ipAddress",
      "userId",
      "environmentId",
      "stack",
    ];
    const randomBytes = crypto.getRandomValues(new Uint8Array(256));
    for (let index = 0; index < randomBytes.length; index += 1) {
      const field = fields[(randomBytes[index] ?? 0) % fields.length] as string;
      const payload = {
        eventName: "client.sync",
        [field]: {
          nested: ["plaintext", { ciphertext: "ciphertext" }],
        },
      };
      expect(redactDiagnosticEvent(payload)).toEqual({
        eventName: "client.sync",
      });
    }
  });

  test("keeps metrics, private traces, and explicit crash reports value-blind", () => {
    const correlationId = createCorrelationId();
    const event = createDiagnosticEvent({
      eventName: "client.sync.failed",
      correlationId,
      outcome: "failure",
      problemCode: "stale_head",
    });
    expect(metricDimensionsFromEvent(event)).toEqual({
      eventName: "client.sync.failed",
      outcome: "failure",
      problemCode: "stale_head",
    });
    expect(
      createPrivateTrace({
        enabled: false,
        traceName: "client.sync",
        correlationId,
        durationMs: 3,
      }),
    ).toBeNull();
    expect(
      createExplicitCrashReport(
        {
          correlationId,
          problemCode: "service_unavailable",
        },
        0,
      ),
    ).toEqual({
      schemaVersion: 1,
      eventName: "client.crash.reported",
      correlationId: event.correlationId,
      problemCode: "service_unavailable",
      expiresAt: OPTIONAL_TRACE_RETENTION_MS,
    });
    const store = createLocalDiagnosticStore(() => 0);
    store.addCrashReport(
      createExplicitCrashReport(
        {
          correlationId,
          problemCode: "service_unavailable",
        },
        0,
      ),
    );
    expect(store.crashReports(OPTIONAL_TRACE_RETENTION_MS)).toEqual([]);
  });

  test("rejects forged local trace and crash records at the storage seam", () => {
    const correlationId = createCorrelationId();
    const store = createLocalDiagnosticStore(() => 0);
    store.addTrace({
      schemaVersion: 1,
      traceName: "client.sync",
      correlationId,
      durationMs: 1,
      expiresAt: OPTIONAL_TRACE_RETENTION_MS,
      // @ts-expect-error adversarial fields are rejected at runtime
      secret: "plaintext",
    });
    store.addCrashReport({
      schemaVersion: 1,
      eventName: "client.crash.reported",
      correlationId,
      problemCode: "service_unavailable",
      expiresAt: OPTIONAL_TRACE_RETENTION_MS + 1,
    });
    expect(store.traces()).toEqual([]);
    expect(store.crashReports()).toEqual([]);
  });
});
