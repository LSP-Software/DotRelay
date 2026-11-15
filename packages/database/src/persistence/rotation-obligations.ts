import type { PersistenceClient } from "./repository-core";

export type OutstandingRotation = Readonly<{
  /** When the oldest uncleared obligation was recorded. */
  readonly since: Date;
  /** The Project epoch that was current when it was recorded. */
  readonly sinceEpoch: bigint;
  /** Removed active Members whose access is not yet rotated away. */
  readonly membershipRemovals: number;
  /** Revoked active Devices whose access is not yet rotated away. */
  readonly deviceRevocations: number;
}>;

/**
 * Records and clears the Project Epoch rotations owed after someone who may
 * hold the current Project Epoch Key loses access. An obligation is advice
 * for owners and admins: nothing here blocks publication, and rotating the
 * Project clears every obligation recorded before the rotation committed.
 */
export class ProjectRotationObligationRepository {
  // A removed active Member held every Project key of the Team.
  async recordMembershipRemoval(
    transaction: PersistenceClient,
    input: Readonly<{
      readonly teamId: string;
      readonly membershipId: string;
      readonly now: Date;
    }>,
  ) {
    const projects = await transaction.project.findMany({
      where: { teamId: input.teamId },
      select: { id: true, currentEpoch: true },
    });
    if (projects.length === 0) return;
    await transaction.projectRotationObligation.createMany({
      data: projects.map((project) => ({
        id: crypto.randomUUID(),
        projectId: project.id,
        reason: "MEMBERSHIP_REMOVED" as const,
        membershipId: input.membershipId,
        projectEpoch: project.currentEpoch,
        createdAt: input.now,
      })),
    });
  }

  // A revoked active Device could hold the key of every Project its User
  // can read: every Project of each Team the User is an active Member of.
  async recordDeviceRevocation(
    transaction: PersistenceClient,
    input: Readonly<{
      readonly userId: string;
      readonly deviceId: string;
      readonly now: Date;
    }>,
  ) {
    const projects = await transaction.project.findMany({
      where: {
        team: {
          memberships: {
            some: { userId: input.userId, lifecycle: "ACTIVE" },
          },
        },
      },
      select: { id: true, currentEpoch: true },
    });
    if (projects.length === 0) return;
    await transaction.projectRotationObligation.createMany({
      data: projects.map((project) => ({
        id: crypto.randomUUID(),
        projectId: project.id,
        reason: "DEVICE_REVOKED" as const,
        deviceId: input.deviceId,
        projectEpoch: project.currentEpoch,
        createdAt: input.now,
      })),
    });
  }

  // Called inside the rotation transaction, with the Project row locked.
  async clearForRotation(
    transaction: PersistenceClient,
    input: Readonly<{
      readonly projectId: string;
      readonly newEpoch: bigint;
      readonly now: Date;
    }>,
  ) {
    await transaction.projectRotationObligation.updateMany({
      where: {
        projectId: input.projectId,
        clearedAt: null,
        projectEpoch: { lt: input.newEpoch },
      },
      data: { clearedAt: input.now, clearedByEpoch: input.newEpoch },
    });
  }

  async outstanding(
    database: PersistenceClient,
    projectId: string,
  ): Promise<OutstandingRotation | null> {
    const obligations = await database.projectRotationObligation.findMany({
      where: { projectId, clearedAt: null },
      select: {
        reason: true,
        membershipId: true,
        deviceId: true,
        projectEpoch: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1_000,
    });
    const first = obligations[0];
    if (!first) return null;
    return Object.freeze({
      since: first.createdAt,
      sinceEpoch: first.projectEpoch,
      membershipRemovals: new Set(
        obligations.flatMap((obligation) =>
          obligation.reason === "MEMBERSHIP_REMOVED" && obligation.membershipId
            ? [obligation.membershipId]
            : [],
        ),
      ).size,
      deviceRevocations: new Set(
        obligations.flatMap((obligation) =>
          obligation.reason === "DEVICE_REVOKED" && obligation.deviceId
            ? [obligation.deviceId]
            : [],
        ),
      ).size,
    });
  }
}
