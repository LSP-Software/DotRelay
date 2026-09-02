import { describe, expect, test } from "bun:test";
import { canonicalEncode, encodeSyncPage } from "@dotrelay/contracts";
import { createProtocolTransport, ProtocolTransportError } from "./transport";

const uuid = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const digest = new Uint8Array(48).fill(7);

describe("protocol transport", () => {
  test("uses CBOR for command and staged objects and JSON only for finalize", async () => {
    const requests: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        request.url.endsWith("/begin")
          ? {
              operationId: uuid,
              status: "STAGED",
              idempotent: false,
              expiresAt: "2026-09-01T00:00:00Z",
            }
          : {},
      );
    };
    const transport = createProtocolTransport({
      origin: "https://relay.example",
      fetch: fetcher,
    });
    const bytes = canonicalEncode(new Map([[0, 3]]));
    await transport.begin({
      operationId: uuid,
      deviceId,
      kind: "REVISION_PUBLICATION",
      commandBytes: bytes,
      commandDigest: digest,
    });
    await transport.stage({
      operationId: uuid,
      deviceId,
      objectId: "33333333-3333-4333-8333-333333333333",
      bytes,
    });
    await transport.finalize({
      operationId: uuid,
      deviceId,
      request: {
        environmentId: uuid,
        expectedHeadId: null,
        revision: {
          id: uuid,
          protocolObjectId: uuid,
          projectEpoch: 1,
          mutation: "GENESIS",
          authoredAtMs: 1,
        },
        descriptor: {
          protocolObjectId: uuid,
          schemaVersion: 1,
          descriptorHash: digest,
          laneCount: 0,
        },
        lanes: [],
        commitments: [],
      },
    });
    expect(
      requests.map((request) => request.headers.get("content-type")),
    ).toEqual([
      "application/vnd.dotrelay.e2ee-v3+cbor",
      "application/vnd.dotrelay.e2ee-v3+cbor",
      "application/json",
    ]);
    expect(requests[0]?.headers.get("X-DotRelay-Device-Id")).toBe(deviceId);
    expect(requests[0]?.headers.get("Idempotency-Key")).toBe(uuid);
    expect(await requests[2]?.text()).toContain('"environmentId"');
  });

  test("decodes a protocol sync response and preserves structured failures", async () => {
    const page = {
      environmentId: uuid,
      trustedRevisionId: uuid,
      trustedRevisionHash: digest,
      currentHeadId: null,
      currentHeadHash: null,
      projectEpoch: 1n,
      revisions: [],
      nextCursor: null,
    };
    const syncRequests: Request[] = [];
    const transport = createProtocolTransport({
      origin: "https://relay.example",
      fetch: async (input, init) => {
        syncRequests.push(new Request(input, init));
        return new Response(encodeSyncPage(page), {
          headers: { "Content-Type": "application/vnd.dotrelay.e2ee-v3+cbor" },
        });
      },
    });
    const response = await transport.sync({
      environmentId: uuid,
      deviceId,
      request: {
        trustedRevisionId: uuid,
        trustedRevisionHash: digest,
        pagination: {},
      },
    });
    expect(response.environmentId).toBe(uuid);
    expect(syncRequests[0]?.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(syncRequests[0]?.headers.get("accept")).toBe(
      "application/vnd.dotrelay.e2ee-v3+cbor",
    );

    const cancelled = createProtocolTransport({
      origin: "https://relay.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("X-DotRelay-Device-Id")).toBe(deviceId);
        return new Response(null, { status: 204 });
      },
    });
    await cancelled.cancel({ operationId: uuid, deviceId });

    const failing = createProtocolTransport({
      origin: "https://relay.example",
      fetch: async () =>
        Response.json(
          {
            type: "https://dotrelay.dev/problems/v1",
            title: "Stale head",
            status: 409,
            code: "stale_head",
            detail: "Stale head",
          },
          { status: 409 },
        ),
    });
    await expect(
      failing.cancel({ operationId: uuid, deviceId }),
    ).rejects.toBeInstanceOf(ProtocolTransportError);
    try {
      await failing.cancel({ operationId: uuid, deviceId });
    } catch (error) {
      expect((error as ProtocolTransportError).problem.code).toBe("stale_head");
    }
  });

  test("follows sync cursors and returns one complete page", async () => {
    const requests: Request[] = [];
    const firstPage = {
      environmentId: uuid,
      trustedRevisionId: uuid,
      trustedRevisionHash: digest,
      currentHeadId: uuid,
      currentHeadHash: digest,
      projectEpoch: 1n,
      revisions: [],
      nextCursor: "cursor-1",
    };
    const secondPage = { ...firstPage, nextCursor: null };
    const transport = createProtocolTransport({
      origin: "https://relay.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(
          encodeSyncPage(requests.length === 1 ? firstPage : secondPage),
          {
            headers: {
              "Content-Type": "application/vnd.dotrelay.e2ee-v3+cbor",
            },
          },
        );
      },
    });
    const complete = await transport.syncAll({
      environmentId: uuid,
      deviceId,
      request: {
        trustedRevisionId: uuid,
        trustedRevisionHash: digest,
        pagination: { limit: 1 },
      },
    });
    expect(complete.nextCursor).toBeNull();
    expect(requests).toHaveLength(2);
    const secondRequest = requests[1];
    if (!secondRequest) throw new Error("second sync request is missing");
    expect(JSON.parse(await secondRequest.text()).pagination.cursor).toBe(
      "cursor-1",
    );
  });

  test("stops pagination when the bounded sync budget is exhausted", async () => {
    let requestCount = 0;
    const transport = createProtocolTransport({
      origin: "https://relay.example",
      fetch: async () => {
        requestCount += 1;
        return new Response(
          encodeSyncPage({
            environmentId: uuid,
            trustedRevisionId: uuid,
            trustedRevisionHash: digest,
            currentHeadId: null,
            currentHeadHash: null,
            projectEpoch: 1n,
            revisions: [],
            nextCursor: `cursor-${requestCount}`,
          }),
          {
            headers: {
              "Content-Type": "application/vnd.dotrelay.e2ee-v3+cbor",
            },
          },
        );
      },
    });
    await expect(
      transport.syncAll({
        environmentId: uuid,
        deviceId,
        request: {
          trustedRevisionId: uuid,
          trustedRevisionHash: digest,
          pagination: {},
        },
      }),
    ).rejects.toThrow("pagination budget exceeded");
    expect(requestCount).toBe(1025);
  });
});
