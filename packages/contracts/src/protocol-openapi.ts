import {
  DEVICE_ID_HEADER,
  DEVICE_PROOF_HEADER,
  PROTOCOL_MEDIA_TYPE,
} from "./protocol-api";

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
  ProjectId: Object.freeze({
    name: "projectId",
    in: "path",
    required: true,
    schema: Object.freeze({ type: "string", format: "uuid" }),
  }),
  DeviceIdHeader: Object.freeze({
    name: DEVICE_ID_HEADER,
    in: "header",
    required: false,
    description:
      "The Device the request claims to act as; it must match the Device the proof names.",
    schema: Object.freeze({ type: "string", format: "uuid" }),
  }),
  DeviceProofHeader: Object.freeze({
    name: DEVICE_PROOF_HEADER,
    in: "header",
    required: true,
    description:
      "A Device proof from POST /api/v1/devices/proofs, bound to this session and Device (ADR 0020).",
    schema: Object.freeze({
      type: "string",
      pattern: "^[A-Za-z0-9_-]{98}$",
    }),
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

const invitationParameters = Object.freeze({
  TeamId: Object.freeze({
    name: "teamId",
    in: "path",
    required: true,
    schema: Object.freeze({ type: "string", format: "uuid" }),
  }),
  InvitationId: Object.freeze({
    name: "invitationId",
    in: "path",
    required: true,
    schema: Object.freeze({ type: "string", format: "uuid" }),
  }),
});

// 201 for the first commit, 200 for an Idempotency-Key replay, and 410 once
// the invitation is no longer pending (expired, accepted, revoked, or
// declined).
const invitationOutcomeResponses = (
  schema: Readonly<Record<string, unknown>>,
) => {
  const success = (description: string) =>
    Object.freeze({
      description,
      headers: Object.freeze({
        "Cache-Control": Object.freeze({
          schema: Object.freeze({ type: "string", const: "no-store" }),
        }),
      }),
      content: Object.freeze({
        "application/json": Object.freeze({ schema }),
      }),
    });
  return Object.freeze({
    "200": success("Replayed outcome"),
    "201": success("Committed outcome"),
    ...problemResponses,
    "410": Object.freeze({
      description: "Invitation no longer pending",
      content: problemContent,
    }),
  });
};

const noStoreJson = (
  description: string,
  schema: Readonly<Record<string, unknown>>,
) =>
  Object.freeze({
    description,
    headers: Object.freeze({
      "Cache-Control": Object.freeze({
        schema: Object.freeze({ type: "string", const: "no-store" }),
      }),
    }),
    content: Object.freeze({
      "application/json": Object.freeze({ schema }),
    }),
  });

const nullable = (schema: Readonly<Record<string, unknown>>) =>
  Object.freeze({ oneOf: Object.freeze([schema, { type: "null" }]) });

const environmentSummarySchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "id",
    "projectId",
    "label",
    "lifecycle",
    "currentHeadId",
    "currentHeadHash",
  ]),
  properties: Object.freeze({
    id: Object.freeze({ type: "string", format: "uuid" }),
    projectId: Object.freeze({ type: "string", format: "uuid" }),
    label: Object.freeze({ type: "string" }),
    lifecycle: Object.freeze({
      type: "string",
      enum: Object.freeze(["active", "archived"]),
    }),
    currentHeadId: nullable({ type: "string", format: "uuid" }),
    currentHeadHash: nullable({ type: "string", pattern: "^[0-9a-f]{96}$" }),
  }),
});

const projectWithEnvironmentSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "id",
    "teamId",
    "githubRepositoryId",
    "lifecycle",
    "environment",
  ]),
  properties: Object.freeze({
    id: Object.freeze({ type: "string", format: "uuid" }),
    teamId: Object.freeze({ type: "string", format: "uuid" }),
    githubRepositoryId: Object.freeze({ type: "string" }),
    lifecycle: Object.freeze({
      type: "string",
      enum: Object.freeze(["active", "archived"]),
    }),
    environment: environmentSummarySchema,
  }),
});

export const PROTOCOL_OPENAPI_PATHS = Object.freeze({
  // Device proof of possession (ADR 0020): a session obtains a challenge,
  // the Device signs it, and the signature buys a short-lived proof that
  // every Device-scoped route requires in DEVICE_PROOF_HEADER.
  "/api/v1/devices/proofs/challenges": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "createDeviceProofChallenge",
        responses: Object.freeze({
          "201": Object.freeze({
            description: "A challenge for this session to sign",
            content: Object.freeze({
              "application/json": Object.freeze({
                schema: Object.freeze({
                  type: "object",
                  additionalProperties: false,
                  required: Object.freeze(["challenge", "expiresIn"]),
                  properties: Object.freeze({
                    challenge: Object.freeze({
                      type: "string",
                      pattern: "^[A-Za-z0-9_-]{76}$",
                    }),
                    expiresIn: Object.freeze({ type: "integer", minimum: 1 }),
                  }),
                }),
              }),
            }),
          }),
          ...problemResponses,
        }),
      }),
    ),
  }),
  "/api/v1/devices/proofs": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "createDeviceProof",
        requestBody: Object.freeze({
          required: true,
          content: Object.freeze({
            "application/json": Object.freeze({
              schema: Object.freeze({
                type: "object",
                additionalProperties: false,
                required: Object.freeze(["deviceId", "challenge", "signature"]),
                properties: Object.freeze({
                  deviceId: Object.freeze({ type: "string", format: "uuid" }),
                  challenge: Object.freeze({
                    type: "string",
                    pattern: "^[A-Za-z0-9_-]{76}$",
                  }),
                  signature: Object.freeze({
                    type: "string",
                    contentEncoding: "base64",
                  }),
                }),
              }),
            }),
          }),
        }),
        responses: Object.freeze({
          "201": Object.freeze({
            description: "A Device proof bound to this session and Device",
            content: Object.freeze({
              "application/json": Object.freeze({
                schema: Object.freeze({
                  type: "object",
                  additionalProperties: false,
                  required: Object.freeze(["token", "deviceId", "expiresIn"]),
                  properties: Object.freeze({
                    token: Object.freeze({
                      type: "string",
                      pattern: "^[A-Za-z0-9_-]{98}$",
                    }),
                    deviceId: Object.freeze({ type: "string", format: "uuid" }),
                    expiresIn: Object.freeze({ type: "integer", minimum: 1 }),
                  }),
                }),
              }),
            }),
          }),
          ...problemResponses,
        }),
      }),
    ),
  }),
  "/api/v1/operations/{operationId}/begin": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "beginOperation",
        parameters: Object.freeze([
          protocolParameters.OperationId,
          protocolParameters.DeviceIdHeader,
          protocolParameters.DeviceProofHeader,
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
          protocolParameters.DeviceProofHeader,
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
    get: authenticatedOperation(
      Object.freeze({
        operationId: "readOperationReceipt",
        parameters: Object.freeze([
          protocolParameters.OperationId,
          protocolParameters.DeviceIdHeader,
          protocolParameters.DeviceProofHeader,
        ]),
        responses: noStoreJsonResponse,
      }),
    ),
    delete: authenticatedOperation(
      Object.freeze({
        operationId: "cancelOperation",
        parameters: Object.freeze([
          protocolParameters.OperationId,
          protocolParameters.DeviceIdHeader,
          protocolParameters.DeviceProofHeader,
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
          protocolParameters.DeviceProofHeader,
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
          protocolParameters.DeviceProofHeader,
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
  "/api/v1/projects/{projectId}/epoch-key-links": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "publishProjectEpochKeyLink",
        description:
          "Backfills one Project Epoch Key Link (ADR 0014) for an epoch rotated before links existed.",
        parameters: Object.freeze([
          protocolParameters.ProjectId,
          protocolParameters.DeviceIdHeader,
          protocolParameters.DeviceProofHeader,
          Object.freeze({ $ref: "#/components/parameters/IdempotencyHeader" }),
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
  "/api/v1/account-keys/rosters": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "publishAccountDeviceRoster",
        description:
          "Publishes the next Account Device roster version (ADR 0015), signed by the account signing key.",
        parameters: Object.freeze([
          protocolParameters.DeviceIdHeader,
          protocolParameters.DeviceProofHeader,
          Object.freeze({ $ref: "#/components/parameters/IdempotencyHeader" }),
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
  "/api/v1/teams/{teamId}/memberships": Object.freeze({
    get: authenticatedOperation(
      Object.freeze({
        operationId: "listTeamMemberships",
        description:
          "Lists the Team's Memberships for a signed-in Member (no Device needed). Owners and admins also get roles, timestamps, pending and removed Memberships, and pending invitations. githubLogin is the login the Member last signed in with (null until recorded): display data that may be stale, never an identity.",
        parameters: Object.freeze([invitationParameters.TeamId]),
        responses: Object.freeze({
          "200": noStoreJson(
            "Memberships",
            Object.freeze({
              type: "object",
              additionalProperties: false,
              required: Object.freeze(["memberships", "invitations"]),
              properties: Object.freeze({
                memberships: Object.freeze({
                  type: "array",
                  items: Object.freeze({
                    type: "object",
                    additionalProperties: false,
                    required: Object.freeze([
                      "membershipId",
                      "userId",
                      "name",
                      "image",
                      "githubSubject",
                      "githubLogin",
                      "accountRoster",
                      "lifecycle",
                    ]),
                    properties: Object.freeze({
                      membershipId: Object.freeze({
                        type: "string",
                        format: "uuid",
                      }),
                      userId: Object.freeze({ type: "string", format: "uuid" }),
                      name: nullable({ type: "string" }),
                      image: nullable({ type: "string" }),
                      githubSubject: Object.freeze({ type: "string" }),
                      githubLogin: nullable({
                        type: "string",
                        pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}$",
                      }),
                      accountRoster: nullable({
                        type: "string",
                        contentEncoding: "base64",
                      }),
                      role: Object.freeze({
                        type: "string",
                        enum: Object.freeze(["OWNER", "ADMIN", "MEMBER"]),
                      }),
                      lifecycle: Object.freeze({
                        type: "string",
                        enum: Object.freeze([
                          "ACTIVE",
                          "PENDING_KEY_GRANT",
                          "REMOVED",
                        ]),
                      }),
                      createdAt: Object.freeze({
                        type: "string",
                        format: "date-time",
                      }),
                      activatedAt: nullable({
                        type: "string",
                        format: "date-time",
                      }),
                      removedAt: nullable({
                        type: "string",
                        format: "date-time",
                      }),
                    }),
                  }),
                }),
                invitations: Object.freeze({
                  type: "array",
                  items: Object.freeze({
                    type: "object",
                    additionalProperties: false,
                    required: Object.freeze([
                      "invitationId",
                      "providerSubject",
                      "createdAt",
                      "expiresAt",
                    ]),
                    properties: Object.freeze({
                      invitationId: Object.freeze({
                        type: "string",
                        format: "uuid",
                      }),
                      providerSubject: Object.freeze({ type: "string" }),
                      createdAt: Object.freeze({
                        type: "string",
                        format: "date-time",
                      }),
                      expiresAt: Object.freeze({
                        type: "string",
                        format: "date-time",
                      }),
                    }),
                  }),
                }),
              }),
            }),
          ),
          ...problemResponses,
        }),
      }),
    ),
  }),
  "/api/v1/teams/{teamId}/invitations/{invitationId}/revoke": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "revokeMembershipInvitation",
        description:
          "An active owner or admin withdraws a pending Membership Invitation of the Team. A revoked invitation can no longer be accepted.",
        parameters: Object.freeze([
          invitationParameters.TeamId,
          invitationParameters.InvitationId,
          protocolParameters.DeviceIdHeader,
          protocolParameters.DeviceProofHeader,
          Object.freeze({ $ref: "#/components/parameters/IdempotencyHeader" }),
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
        responses: invitationOutcomeResponses(
          Object.freeze({
            type: "object",
            additionalProperties: false,
            required: Object.freeze(["invitationId", "teamId", "status"]),
            properties: Object.freeze({
              invitationId: Object.freeze({ type: "string", format: "uuid" }),
              teamId: Object.freeze({ type: "string", format: "uuid" }),
              status: Object.freeze({ type: "string", const: "REVOKED" }),
            }),
          }),
        ),
      }),
    ),
  }),
  "/api/v1/invitations/{invitationId}/decline": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "declineMembershipInvitation",
        description:
          "The User a pending Membership Invitation addresses turns it down. Needs a session, not a Device; an invitation addressed to someone else answers 404.",
        parameters: Object.freeze([
          invitationParameters.InvitationId,
          Object.freeze({ $ref: "#/components/parameters/IdempotencyHeader" }),
        ]),
        responses: invitationOutcomeResponses(
          Object.freeze({
            type: "object",
            additionalProperties: false,
            required: Object.freeze(["invitationId", "status"]),
            properties: Object.freeze({
              invitationId: Object.freeze({ type: "string", format: "uuid" }),
              status: Object.freeze({ type: "string", const: "DECLINED" }),
            }),
          }),
        ),
      }),
    ),
  }),
  "/api/v1/projects": Object.freeze({
    post: authenticatedOperation(
      Object.freeze({
        operationId: "linkProject",
        description:
          "An owner or admin links a GitHub Repository to a new Project in the Team, with its first Environment. environmentLabel names that Environment (same rules as creating one; default `default`). A Repository that already has an active Project returns it with its first active Environment and ignores the label.",
        parameters: Object.freeze([
          protocolParameters.DeviceIdHeader,
          Object.freeze({ $ref: "#/components/parameters/IdempotencyHeader" }),
        ]),
        requestBody: Object.freeze({
          required: true,
          content: Object.freeze({
            "application/json": Object.freeze({
              schema: Object.freeze({
                type: "object",
                additionalProperties: false,
                required: Object.freeze([
                  "teamId",
                  "repositoryHost",
                  "repositoryOwner",
                  "repositoryName",
                  "githubRepositoryId",
                ]),
                properties: Object.freeze({
                  teamId: Object.freeze({ type: "string", format: "uuid" }),
                  repositoryHost: Object.freeze({
                    type: "string",
                    const: "github.com",
                  }),
                  repositoryOwner: Object.freeze({
                    type: "string",
                    minLength: 1,
                  }),
                  repositoryName: Object.freeze({
                    type: "string",
                    minLength: 1,
                  }),
                  githubRepositoryId: Object.freeze({
                    type: "string",
                    pattern: "^[1-9][0-9]{0,18}$",
                  }),
                  environmentLabel: Object.freeze({
                    type: "string",
                    pattern: "^[A-Za-z][A-Za-z0-9._-]{0,62}$",
                  }),
                }),
              }),
            }),
          }),
        }),
        responses: Object.freeze({
          "200": noStoreJson("Existing Project", projectWithEnvironmentSchema),
          "201": noStoreJson("Linked Project", projectWithEnvironmentSchema),
          ...problemResponses,
        }),
      }),
    ),
  }),
  "/api/v1/projects/{projectId}/environments": Object.freeze({
    get: authenticatedOperation(
      Object.freeze({
        operationId: "listProjectEnvironments",
        description:
          "Lists the Project's Environments for an active Member, oldest first. currentHeadAuthoredAtMs is the head Revision's authored-at instant (null without a Revision); a Project rotation floors its signing time on the latest one.",
        parameters: Object.freeze([
          protocolParameters.ProjectId,
          protocolParameters.DeviceIdHeader,
        ]),
        responses: Object.freeze({
          "200": noStoreJson(
            "Environments",
            Object.freeze({
              type: "object",
              additionalProperties: false,
              required: Object.freeze(["environments"]),
              properties: Object.freeze({
                environments: Object.freeze({
                  type: "array",
                  items: Object.freeze({
                    ...environmentSummarySchema,
                    required: Object.freeze([
                      ...environmentSummarySchema.required,
                      "currentHeadAuthoredAtMs",
                    ]),
                    properties: Object.freeze({
                      ...environmentSummarySchema.properties,
                      currentHeadAuthoredAtMs: nullable({
                        type: "integer",
                        minimum: 0,
                      }),
                    }),
                  }),
                }),
              }),
            }),
          ),
          ...problemResponses,
        }),
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
          protocolParameters.DeviceProofHeader,
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
