import type { PersistenceClient } from "./repository-core";

export type MembershipWindow = Readonly<{
  /** When the period began. */
  readonly activatedAt: Date;
  /** When it ended; null while it is the current, still active period. */
  readonly removedAt: Date | null;
}>;

export type TeamMembershipWindows = Readonly<{
  /** The current period from the Membership row (null bounds as stored). */
  readonly current: Readonly<{
    readonly activatedAt: Date | null;
    readonly removedAt: Date | null;
  }>;
  /** Every active period, archived and current, oldest first. */
  readonly periods: readonly MembershipWindow[];
}>;

/**
 * Archives a removed Membership's finished period before an invitation
 * revives the row (ADR 0016). The row then describes only the new period;
 * the archive keeps the old one so Revisions signed in it stay verifiable.
 */
export const archiveMembershipPeriod = async (
  transaction: PersistenceClient,
  membership: Readonly<{
    readonly id: string;
    readonly activatedAt: Date | null;
    readonly removedAt: Date | null;
  }>,
) => {
  if (!membership.activatedAt || !membership.removedAt) return;
  await transaction.membershipPeriod.createMany({
    data: [
      {
        id: crypto.randomUUID(),
        membershipId: membership.id,
        activatedAt: membership.activatedAt,
        removedAt: membership.removedAt,
      },
    ],
    skipDuplicates: true,
  });
};

/**
 * Every Team Member's active periods, keyed by User id: the archived ones
 * and the current one from the Membership row.
 */
export const loadTeamMembershipWindows = async (
  database: PersistenceClient,
  teamId: string,
): Promise<ReadonlyMap<string, TeamMembershipWindows>> => {
  const memberships = await database.membership.findMany({
    where: { teamId },
    select: {
      userId: true,
      activatedAt: true,
      removedAt: true,
      periods: {
        select: { activatedAt: true, removedAt: true },
        orderBy: { activatedAt: "asc" },
      },
    },
  });
  return new Map(
    memberships.map((membership) => {
      const periods: MembershipWindow[] = membership.periods.map((period) => ({
        activatedAt: period.activatedAt,
        removedAt: period.removedAt,
      }));
      const current = membership.activatedAt;
      if (
        current &&
        !periods.some(
          (period) => period.activatedAt.getTime() === current.getTime(),
        )
      )
        periods.push({ activatedAt: current, removedAt: membership.removedAt });
      periods.sort(
        (left, right) =>
          left.activatedAt.getTime() - right.activatedAt.getTime(),
      );
      return [
        membership.userId,
        Object.freeze({
          current: {
            activatedAt: membership.activatedAt,
            removedAt: membership.removedAt,
          },
          periods: Object.freeze(periods),
        }),
      ];
    }),
  );
};
