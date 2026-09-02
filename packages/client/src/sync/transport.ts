import {
  DEVICE_ID_HEADER,
  decodeSyncPage,
  type FinalizePublicationRequest,
  PROTOCOL_MEDIA_TYPE,
  type Problem,
  parseProblem,
  type SyncPageWire,
  type SyncRequest,
  sha384ToHex,
} from "@dotrelay/contracts";

export class ProtocolTransportError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail);
    this.name = "ProtocolTransportError";
    this.problem = problem;
  }
}

export type ProtocolTransport = Readonly<{
  begin(input: BeginInput): Promise<BeginResult>;
  stage(input: StageInput): Promise<void>;
  finalize(input: FinalizeInput): Promise<FinalizeResult>;
  cancel(input: CancelInput): Promise<void>;
  sync(input: SyncInput): Promise<SyncPageWire>;
  syncAll(input: SyncInput): Promise<SyncPageWire>;
}>;

export type BeginInput = Readonly<{
  readonly operationId: string;
  readonly deviceId: string;
  readonly kind: "REVISION_PUBLICATION" | "ROLLBACK" | "EPOCH_ROTATION";
  readonly commandBytes: Uint8Array;
  readonly commandDigest: Uint8Array;
  readonly expiresAt?: string;
}>;

export type BeginResult = Readonly<{
  readonly operationId: string;
  readonly status: string;
  readonly idempotent: boolean;
  readonly expiresAt: string;
}>;

export type StageInput = Readonly<{
  readonly operationId: string;
  readonly deviceId: string;
  readonly objectId: string;
  readonly bytes: Uint8Array;
}>;

export type FinalizeInput = Readonly<{
  readonly operationId: string;
  readonly deviceId: string;
  readonly request: FinalizePublicationRequest;
}>;

export type CancelInput = Readonly<{
  readonly operationId: string;
  readonly deviceId: string;
}>;

export type FinalizeResult = Readonly<Record<string, unknown>>;

export type SyncInput = Readonly<{
  readonly environmentId: string;
  readonly deviceId: string;
  readonly request: SyncRequest;
}>;

type ResponseLike = Readonly<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const MAX_SYNC_PAGES = 1024;
const MAX_SYNC_BYTES = 64 * 1024 * 1024;

type RequestInitLike = Readonly<{
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: ArrayBuffer | string;
  readonly credentials?: string;
}>;

type FetchLike = (
  input: string,
  init?: RequestInitLike,
) => Promise<ResponseLike>;

const requestBody = (bytes: Uint8Array): ArrayBuffer =>
  new Uint8Array(bytes).buffer as ArrayBuffer;

const jsonHeaders = (deviceId: string): Readonly<Record<string, string>> => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  [DEVICE_ID_HEADER]: deviceId,
});

const protocolHeaders = (
  deviceId: string,
): Readonly<Record<string, string>> => ({
  Accept: PROTOCOL_MEDIA_TYPE,
  "Content-Type": PROTOCOL_MEDIA_TYPE,
  [DEVICE_ID_HEADER]: deviceId,
});

const syncHeaders = (deviceId: string): Readonly<Record<string, string>> => ({
  Accept: PROTOCOL_MEDIA_TYPE,
  "Content-Type": "application/json",
  [DEVICE_ID_HEADER]: deviceId,
});

const readProblem = async (
  response: ResponseLike,
): Promise<ProtocolTransportError> => {
  try {
    return new ProtocolTransportError(parseProblem(await response.json()));
  } catch {
    return new ProtocolTransportError({
      type: "https://dotrelay.dev/problems/v1",
      title: "Protocol request failed",
      status: response.status,
      code: "service_unavailable",
      detail: `Protocol request failed with HTTP ${response.status}.`,
    });
  }
};

const fetchSyncPage = async (
  fetcher: FetchLike,
  endpoint: (path: string) => string,
  request: SyncInput,
): Promise<SyncPageWire> => {
  const response = await fetcher(
    endpoint(`/api/v1/environments/${request.environmentId}/sync`),
    {
      method: "POST",
      headers: syncHeaders(request.deviceId),
      body: JSON.stringify({
        trustedRevisionId: request.request.trustedRevisionId,
        trustedRevisionHash: hex(request.request.trustedRevisionHash),
        pagination: request.request.pagination,
      }),
      credentials: "include",
    },
  );
  await requireOk(response);
  return decodeSyncPage(new Uint8Array(await response.arrayBuffer()));
};

const requireOk = async (response: ResponseLike): Promise<void> => {
  if (!response.ok) throw await readProblem(response);
};

const hex = (bytes: Uint8Array): string => sha384ToHex(bytes);

const serializeFinalize = (
  request: FinalizePublicationRequest,
): Record<string, unknown> => ({
  environmentId: request.environmentId,
  expectedHeadId: request.expectedHeadId,
  revision: {
    ...request.revision,
    ...(request.revision.parentHash
      ? { parentHash: hex(request.revision.parentHash) }
      : {}),
  },
  descriptor: {
    ...request.descriptor,
    descriptorHash: hex(request.descriptor.descriptorHash),
  },
  lanes: request.lanes.map((lane) => ({
    ...lane,
    ciphertextHash: hex(lane.ciphertextHash),
  })),
  commitments: request.commitments.map((commitment) => ({
    ...commitment,
    objectHash: hex(commitment.objectHash),
  })),
});

export const createProtocolTransport = (
  input: Readonly<{
    readonly origin: string;
    readonly fetch?: FetchLike;
  }>,
): ProtocolTransport => {
  const fetcher =
    input.fetch ??
    ((url, init) =>
      fetch(url, init as never) as unknown as Promise<ResponseLike>);
  const endpoint = (path: string): string =>
    `${input.origin.replace(/\/$/, "")}${path}`;

  return Object.freeze({
    begin: async (request) => {
      const response = await fetcher(
        endpoint(`/api/v1/operations/${request.operationId}/begin`),
        {
          method: "POST",
          headers: {
            ...protocolHeaders(request.deviceId),
            "Idempotency-Key": request.operationId,
            "X-DotRelay-Operation-Kind": request.kind,
            ...(request.expiresAt
              ? { "X-DotRelay-Expires-At": request.expiresAt }
              : {}),
          },
          body: requestBody(request.commandBytes),
          credentials: "include",
        },
      );
      await requireOk(response);
      return (await response.json()) as BeginResult;
    },
    stage: async (request) => {
      const response = await fetcher(
        endpoint(
          `/api/v1/operations/${request.operationId}/staging/${request.objectId}`,
        ),
        {
          method: "PUT",
          headers: protocolHeaders(request.deviceId),
          body: requestBody(request.bytes),
          credentials: "include",
        },
      );
      await requireOk(response);
    },
    finalize: async (request) => {
      const response = await fetcher(
        endpoint(`/api/v1/operations/${request.operationId}/finalize`),
        {
          method: "POST",
          headers: jsonHeaders(request.deviceId),
          body: JSON.stringify(serializeFinalize(request.request)),
          credentials: "include",
        },
      );
      await requireOk(response);
      return (await response.json()) as FinalizeResult;
    },
    cancel: async (request) => {
      const response = await fetcher(
        endpoint(`/api/v1/operations/${request.operationId}`),
        {
          method: "DELETE",
          headers: jsonHeaders(request.deviceId),
          credentials: "include",
        },
      );
      await requireOk(response);
    },
    sync: async (request) => {
      return fetchSyncPage(fetcher, endpoint, request);
    },
    syncAll: async (request) => {
      const revisions: SyncPageWire["revisions"][number][] = [];
      const seenCursors = new Set<string>();
      let pageCount = 0;
      let accumulatedBytes = 0;
      let page = await fetchSyncPage(fetcher, endpoint, request);
      while (true) {
        pageCount += 1;
        accumulatedBytes += page.revisions.reduce(
          (total, revision) =>
            total +
            revision.objects.reduce(
              (objectTotal, object) =>
                objectTotal + object.canonicalBytes.length,
              0,
            ),
          0,
        );
        if (pageCount > MAX_SYNC_PAGES || accumulatedBytes > MAX_SYNC_BYTES)
          throw new Error("protocol sync pagination budget exceeded");
        revisions.push(...page.revisions);
        if (page.nextCursor === null) break;
        if (seenCursors.has(page.nextCursor))
          throw new Error("protocol sync returned a repeating cursor");
        seenCursors.add(page.nextCursor);
        page = await fetchSyncPage(fetcher, endpoint, {
          ...request,
          request: {
            ...request.request,
            pagination: {
              ...request.request.pagination,
              cursor: page.nextCursor,
            },
          },
        });
      }
      return Object.freeze({
        ...page,
        revisions: Object.freeze(revisions),
        nextCursor: null,
      });
    },
  });
};
