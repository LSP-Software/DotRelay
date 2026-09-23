import { decideTeamAction, type TeamAction } from "../administration";
import type {
  MembershipRole,
  Prisma,
  PrismaClient,
} from "../generated/prisma/client";
import { inShortTransaction } from "./transaction";
export type PersistenceClient = PrismaClient | Prisma.TransactionClient;
type DatabaseBytes = Uint8Array<ArrayBuffer>;

export const databaseBytes = (value: Uint8Array): DatabaseBytes =>
  new Uint8Array(value) as DatabaseBytes;

export const inPersistenceTransaction = async <T>(
  database: PersistenceClient,
  callback: (transaction: PersistenceClient) => Promise<T>,
): Promise<T> => {
  if ("$transaction" in database) return inShortTransaction(database, callback);
  return callback(database);
};

export class OperationNotFoundError extends Error {
  constructor() {
    super("Operation not found");
    this.name = "OperationNotFoundError";
  }
}

export class OperationNotCancellableError extends Error {
  constructor() {
    super("Operation is not cancellable");
    this.name = "OperationNotCancellableError";
  }
}

export class OperationConflictError extends Error {
  constructor() {
    super(
      "operation id or idempotency digest was already used with different bytes",
    );
    this.name = "OperationConflictError";
  }
}

export const requireActiveDevice = async (
  database: PersistenceClient,
  actorUserId: string,
  actorDeviceId: string | undefined,
) => {
  if (!actorDeviceId) throw new Error("an active actor device is required");
  const device = await database.device.findFirst({
    where: { id: actorDeviceId, userId: actorUserId, lifecycle: "ACTIVE" },
  });
  if (!device) throw new Error("actor device is not active");
  return device;
};

export const requireTeamAction = async (
  database: PersistenceClient,
  actorUserId: string,
  actorDeviceId: string | undefined,
  teamId: string,
  action: TeamAction,
) => {
  await requireActiveDevice(database, actorUserId, actorDeviceId);
  const membership = await database.membership.findFirst({
    where: {
      teamId,
      userId: actorUserId,
    },
    select: { lifecycle: true, role: true },
  });
  const decision = decideTeamAction(membership, action);
  if (!decision.allowed)
    throw new Error(`actor is not authorized for the Team: ${decision.reason}`);
  return membership;
};

const managedRoleActions: Readonly<Record<MembershipRole, TeamAction>> = {
  OWNER: "MANAGE_OWNER",
  ADMIN: "MANAGE_ADMIN",
  MEMBER: "MANAGE_MEMBER",
};

export const managedRoleAction = (role: MembershipRole): TeamAction =>
  managedRoleActions[role];

export class StagedObjectConflictError extends Error {
  constructor() {
    super("staged object was uploaded with different bytes");
    this.name = "StagedObjectConflictError";
  }
}

export class StaleHeadError extends Error {
  readonly currentHeadId: string | null;

  constructor(currentHeadId: string | null) {
    super("the Environment head changed while the command was being prepared");
    this.name = "StaleHeadError";
    this.currentHeadId = currentHeadId;
  }
}

export class StaleEpochError extends Error {
  readonly currentEpoch: bigint;

  constructor(currentEpoch: bigint) {
    super("the Project epoch changed while the transition was being prepared");
    this.name = "StaleEpochError";
    this.currentEpoch = currentEpoch;
  }
}

export class GenesisExistsError extends Error {
  readonly currentHeadId: string;

  constructor(currentHeadId: string) {
    super("the Environment already has a genesis Revision");
    this.name = "GenesisExistsError";
    this.currentHeadId = currentHeadId;
  }
}

export const DEFAULT_ENVIRONMENT_LABEL = "default";

const environmentLabelPattern = /^[A-Za-z][A-Za-z0-9._-]{0,62}$/;

export const normalizeEnvironmentLabel = (value: unknown): string => {
  if (value === undefined || value === null || value === "")
    return DEFAULT_ENVIRONMENT_LABEL;
  if (typeof value !== "string")
    throw new Error("Environment label is invalid");
  const label = value.trim();
  if (!environmentLabelPattern.test(label))
    throw new Error("Environment label is invalid");
  return label;
};

export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
