import { DEVICE_ID_HEADER, PROTOCOL_MEDIA_TYPE } from "./protocol-api";

const problemContent = Object.freeze({
  "application/problem+json": Object.freeze({
    schema: Object.freeze({ $ref: "#/components/schemas/Problem" }),
  }),
});

const problemResponses = Object.freeze({
  "400": Object.freeze({
    description: "Invalid request",
    content: problemContent,
  }),
  "401": Object.freeze({
    description: "Authentication required",
    content: problemContent,
  }),
  "403": Object.freeze({
    description: "Forbidden",
    content: problemContent,
  }),
  "404": Object.freeze({
    description: "Resource not found",
    content: problemContent,
  }),
  "409": Object.freeze({
    description: "State conflict",
    content: problemContent,
  }),
  "413": Object.freeze({
    description: "Payload too large",
    content: problemContent,
  }),
  "415": Object.freeze({
    description: "Unsupported media type",
    content: problemContent,
  }),
  "429": Object.freeze({
    description: "Rate limited",
    content: problemContent,
  }),
  "503": Object.freeze({
    description: "Service unavailable",
    content: problemContent,
  }),
});

const noStoreJsonResponse = Object.freeze({
  "200": Object.freeze({
    description: "Success",
    headers: Object.freeze({
      "Cache-Control": Object.freeze({
        schema: Object.freeze({ type: "string", const: "no-store" }),
      }),
    }),
    content: Object.freeze({
      "application/json": Object.freeze({
        schema: Object.freeze({
          $ref: "#/components/schemas/StrictJsonObject",
        }),
      }),
    }),
  }),
  ...problemResponses,
});

const protocolParameters = Object.freeze({
  OperationId: Object.freeze({
    name: "operationId",
    in: "path",
    required: true,
    schema: Object.freeze({ type: "string", format: "uuid" }),
  }),
  ObjectId: Object.freeze({
    name: "objectId",
    in: "path",
    required: true,
    schema: Object.freeze({ type: "string", format: "uuid" }),
  }),
  EnvironmentId: Object.freeze({
    name: "environmentId",
    in: "path",
    required: true,
    schema: Object.freeze({ type: "string", format: "uuid" }),
  }),
  DeviceIdHeader: Object.freeze({
    name: DEVICE_ID_HEADER,
    in: "header",
    required: true,
    schema: Object.freeze({ type: "string", format: "uuid" }),
  }),
  OperationKindHeader: Object.freeze({
    name: "X-DotRelay-Operation-Kind",
    in: "header",
    required: true,
    schema: Object.freeze({
      type: "string",
      enum: Object.freeze([
        "REVISION_PUBLICATION",
        "ROLLBACK",
        "EPOCH_ROTATION",
      ]),
    }),
  }),
});

export const PROTOCOL_OPENAPI_PARAMETERS = protocolParameters;

export const PROTOCOL_OPENAPI_SECURITY = Object.freeze([
  Object.freeze({ bearerAuth: Object.freeze([] as const) }),
]);

const authenticatedOperation = <T extends Record<string, unknown>>(
  operation: T,
) =>
  Object.freeze({
    ...operation,
    security: PROTOCOL_OPENAPI_SECURITY,
  });

export const PROTOCOL_OPENAPI_PATHS = Object.freeze({
  "/api/v1/operations/{operationId}/begin": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "beginOperation",
        parameters: Object.freeze([
          protocolParameters.OperationId,
          protocolParameters.DeviceIdHeader,
          protocolParameters.OperationKindHeader,
          Object.freeze({ $ref: "#/components/parameters/IdempotencyHeader" }),
        ]),
        requestBody: Object.freeze({
          required: true,
          content: Object.freeze({
            [PROTOCOL_MEDIA_TYPE]: Object.freeze({
              schema: Object.freeze({
                $ref: "#/components/schemas/ProtocolObject",
              }),
            }),
          }),
        }),
        responses: noStoreJsonResponse,
      }),
    ),
  }),
  "/api/v1/operations/{operationId}/staging/{objectId}": Object.freeze({
    put: authenticatedOperation(
      Object.freeze({
        operationId: "stageOperationObject",
        parameters: Object.freeze([
          protocolParameters.OperationId,
          protocolParameters.ObjectId,
          protocolParameters.DeviceIdHeader,
        ]),
        requestBody: Object.freeze({
          required: true,
          content: Object.freeze({
            [PROTOCOL_MEDIA_TYPE]: Object.freeze({
              schema: Object.freeze({
                $ref: "#/components/schemas/ProtocolObject",
              }),
            }),
          }),
        }),
        responses: noStoreJsonResponse,
      }),
    ),
  }),
  "/api/v1/operations/{operationId}": Object.freeze({
    delete: authenticatedOperation(
      Object.freeze({
        operationId: "cancelOperation",
        parameters: Object.freeze([
          protocolParameters.OperationId,
          protocolParameters.DeviceIdHeader,
        ]),
        responses: Object.freeze({
          "204": Object.freeze({
            description: "Operation cancelled",
            headers: Object.freeze({
              "Cache-Control": Object.freeze({
                schema: Object.freeze({ type: "string", const: "no-store" }),
              }),
            }),
          }),
          ...problemResponses,
        }),
      }),
    ),
  }),
  "/api/v1/operations/{operationId}/finalize": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "finalizeOperation",
        parameters: Object.freeze([
          protocolParameters.OperationId,
          protocolParameters.DeviceIdHeader,
        ]),
        requestBody: Object.freeze({
          required: true,
          content: Object.freeze({
            "application/json": Object.freeze({
              schema: Object.freeze({
                $ref: "#/components/schemas/StrictJsonObject",
              }),
            }),
          }),
        }),
        responses: noStoreJsonResponse,
      }),
    ),
  }),
  "/api/v1/operations/{operationId}/epoch-transitions": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "finalizeEpochTransition",
        parameters: Object.freeze([
          protocolParameters.OperationId,
          protocolParameters.DeviceIdHeader,
        ]),
        requestBody: Object.freeze({
          required: true,
          content: Object.freeze({
            "application/json": Object.freeze({
              schema: Object.freeze({
                $ref: "#/components/schemas/StrictJsonObject",
              }),
            }),
          }),
        }),
        responses: noStoreJsonResponse,
      }),
    ),
  }),
  "/api/v1/environments/{environmentId}/sync": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "synchronizeEnvironment",
        parameters: Object.freeze([
          protocolParameters.EnvironmentId,
          protocolParameters.DeviceIdHeader,
        ]),
        requestBody: Object.freeze({
          required: true,
          content: Object.freeze({
            "application/json": Object.freeze({
              schema: Object.freeze({
                $ref: "#/components/schemas/StrictJsonObject",
              }),
            }),
          }),
        }),
        responses: Object.freeze({
          "200": Object.freeze({
            description: "Synchronization page",
            headers: Object.freeze({
              "Cache-Control": Object.freeze({
                schema: Object.freeze({ type: "string", const: "no-store" }),
              }),
            }),
            content: Object.freeze({
              [PROTOCOL_MEDIA_TYPE]: Object.freeze({
                schema: Object.freeze({
                  $ref: "#/components/schemas/ProtocolObject",
                }),
              }),
            }),
          }),
          ...problemResponses,
        }),
      }),
    ),
  }),
});
