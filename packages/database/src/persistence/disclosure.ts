import { decideLaneDisclosure, decideTeamAction } from "../administration";
import { type PersistenceClient, requireActiveDevice } from "./repository-core";
export type EnvironmentMetadata = Readonly<{
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly lifecycle: "ACTIVE" | "ARCHIVED";
  readonly currentHeadId: string | null;
}>;

type EnvironmentAccessInput = Readonly<{
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly environmentId: string;
}>;

/**
 * Read-side authorization keeps protected rows outside the result set. In
 * particular, owner/admin roles do not broaden User-defined Value ownership.
 */
export class AdministrationDisclosureRepository {
  private async requireEnvironmentAccess(
    database: PersistenceClient,
    input: EnvironmentAccessInput,
  ) {
    await requireActiveDevice(database, input.actorUserId, input.actorDeviceId);
    const environment = await database.environment.findFirst({
      where: {
        id: input.environmentId,
        project: {
          team: {
            memberships: {
              some: { userId: input.actorUserId, lifecycle: "ACTIVE" },
            },
          },
        },
      },
      include: { project: { select: { teamId: true, lifecycle: true } } },
    });
    if (!environment) throw new Error("Environment not found");
    const membership = await database.membership.findUnique({
      where: {
        teamId_userId: {
          teamId: environment.project.teamId,
          userId: input.actorUserId,
        },
      },
      select: { lifecycle: true, role: true },
    });
    const decision = decideTeamAction(membership, "VIEW");
    if (!decision.allowed)
      throw new Error(`Environment is not disclosed: ${decision.reason}`);
    return { environment, membership };
  }

  async getEnvironmentMetadata(
    database: PersistenceClient,
    input: EnvironmentAccessInput,
  ): Promise<EnvironmentMetadata> {
    const { environment } = await this.requireEnvironmentAccess(
      database,
      input,
    );
    return {
      id: environment.id,
      projectId: environment.projectId,
      label: environment.label,
      lifecycle: environment.lifecycle,
      currentHeadId: environment.currentHeadId,
    };
  }

  async listEnvironmentLanes(
    database: PersistenceClient,
    input: EnvironmentAccessInput,
  ) {
    const { environment, membership } = await this.requireEnvironmentAccess(
      database,
      input,
    );
    const resourceLifecycle =
      environment.lifecycle === "ACTIVE" &&
      environment.project.lifecycle === "ACTIVE"
        ? "ACTIVE"
        : "ARCHIVED";
    const resourceDecision = decideLaneDisclosure(
      membership,
      resourceLifecycle,
      { scope: "SHARED_VALUE" },
      input.actorUserId,
    );
    if (!resourceDecision.allowed)
      throw new Error(
        `Environment lanes are not disclosed: ${resourceDecision.reason}`,
      );
    return database.laneObject.findMany({
      where: {
        environmentId: input.environmentId,
        OR: [
          { scope: { not: "USER_DEFINED_VALUE" } },
          { scope: "USER_DEFINED_VALUE", ownerUserId: input.actorUserId },
        ],
      },
      include: { protocolObject: true },
      orderBy: { id: "asc" },
    });
  }
}
