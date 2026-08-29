import { describe, expect, test } from "bun:test";
import {
  createDiagnosticEvent,
  DiagnosticBoundaryError,
  serializeDiagnosticEvent,
} from "./event";

describe("value-blind diagnostics", () => {
  test("accepts only allowlisted diagnostic fields", () => {
    const event = createDiagnosticEvent({
      eventName: "client.storage.load",
      correlationId: "abc",
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
});
