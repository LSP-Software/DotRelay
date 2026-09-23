import {
  AuditFactRepository,
  type OperationInput,
  OperationRepository,
  type ProtocolObjectInput,
  ProtocolObjectRepository,
  StagedObjectRepository,
} from "./objects";
import { managedRoleAction, requireTeamAction } from "./repository-core";
import { inShortTransaction, type TransactionDatabase } from "./transaction";
export type MembershipActivationInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly teamId: string;
  readonly membershipId: string;
  readonly requiredGrantCount: number;
  readonly activationObject: ProtocolObjectInput;
  readonly now?: Date;
}>;

export class MembershipRepository {
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async activate(
    database: TransactionDatabase,
    input: MembershipActivationInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const membership = await transaction.membership.findUnique({
        where: { id: input.membershipId },
      });
      if (!membership || membership.teamId !== input.teamId)
        throw new Error("Membership not found");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        managedRoleAction(membership.role),
      );
      if (membership.lifecycle !== "PENDING_KEY_GRANT")
        throw new Error("Membership is not pending key grants");
      const grantCount = await transaction.grantObject.count({
        where: { membershipId: input.membershipId },
      });
      if (grantCount !== input.requiredGrantCount)
        throw new Error("required Membership grant set is incomplete");

      const now = input.now ?? new Date();
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.activationObject.id,
            canonicalBytes: input.activationObject.canonicalBytes,
            digest: input.activationObject.digest,
          },
        ],
      });
      const protocolObject = await new ProtocolObjectRepository().create(
        transaction,
        input.activationObject,
      );
      const activated = await transaction.membership.update({
        where: { id: input.membershipId },
        data: { lifecycle: "ACTIVE", activatedAt: now },
      });
      await transaction.membershipActivationObject.create({
        data: {
          protocolObjectId: protocolObject.id,
          membershipId: membership.id,
          teamId: input.teamId,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_ACTIVATED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "MEMBERSHIP",
        entityId: membership.id,
        priorLifecycle: "PENDING_KEY_GRANT",
        newLifecycle: "ACTIVE",
        outcomeObjectId: protocolObject.id,
      });
      return { operation: operation.operation, membership: activated };
    });
  }
}
