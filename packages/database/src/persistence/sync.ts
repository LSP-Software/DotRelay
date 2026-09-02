import { decideLaneDisclosure } from "../administration";
import type { MutationKind } from "../generated/prisma/client";
import {
  AdministrationDisclosureRepository,
  type PersistenceClient,
} from "./repositories";
import { copyBytes } from "./validation";

export class SyncIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncIntegrityError";
  }
}

export type SyncInput = Readonly<{
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly environmentId: string;
  readonly trustedRevisionId: string;
  readonly trustedRevisionHash: Uint8Array;
  readonly cursorRevisionId?: string;
  readonly cursorRevisionHash?: Uint8Array;
  readonly limit: number;
}>;

export type SyncObject = Readonly<{
  readonly objectId: string;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
}>;

export type SyncRevision = Readonly<{
  readonly id: string;
  readonly digest: Uint8Array;
  readonly parentId: string | null;
  readonly parentHash: Uint8Array | null;
  readonly mutation: MutationKind;
  readonly projectEpoch: bigint;
  readonly authoredAtMs: bigint;
  readonly rollbackTargetId: string | null;
  readonly objects: readonly SyncObject[];
}>;

export type SyncPage = Readonly<{
  readonly environmentId: string;
  readonly trustedRevisionId: string;
  readonly trustedRevisionHash: Uint8Array;
  readonly currentHeadId: string | null;
  readonly currentHeadHash: Uint8Array | null;
  readonly projectEpoch: bigint;
  readonly revisions: readonly SyncRevision[];
  readonly nextCursor: Readonly<{
    revisionId: string;
    revisionHash: Uint8Array;
  }> | null;
}>;

const mutationWireValues: Readonly<Record<MutationKind, number>> = {
  GENESIS: 1,
  MANIFEST_UPDATE: 2,
  ROLLBACK: 3,
  EPOCH_TRANSITION: 4,
  USER_KEY_ROTATION: 5,
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const verifyRevisionDigest = (
  digest: Uint8Array,
  expected: Uint8Array,
  label: string,
) => {
  if (!sameBytes(digest, expected))
    throw new SyncIntegrityError(`${label} digest does not match`);
};

export class SyncRepository {
  private readonly disclosure = new AdministrationDisclosureRepository();

  async synchronize(
    database: PersistenceClient,
    input: SyncInput,
  ): Promise<SyncPage> {
    await this.disclosure.getEnvironmentMetadata(database, {
      actorUserId: input.actorUserId,
      actorDeviceId: input.actorDeviceId,
      environmentId: input.environmentId,
    });
    const environment = await database.environment.findUnique({
      where: { id: input.environmentId },
      include: {
        project: {
          select: { currentEpoch: true, lifecycle: true, teamId: true },
        },
        currentHead: {
          include: { protocolObject: { select: { digest: true } } },
        },
      },
    });
    if (!environment) throw new Error("Environment not found");
    const membership = await database.membership.findFirst({
      where: {
        teamId: environment.project.teamId,
        userId: input.actorUserId,
        lifecycle: "ACTIVE",
      },
      select: { role: true, lifecycle: true },
    });
    if (!membership) throw new Error("Membership is not active");
    const isEnvironmentGenesis =
      input.trustedRevisionId === input.environmentId &&
      sameBytes(input.trustedRevisionHash, new Uint8Array(48));
    const trusted = isEnvironmentGenesis
      ? null
      : await database.revision.findUnique({
          where: { id: input.trustedRevisionId },
          include: { protocolObject: true },
        });
    if (
      (!isEnvironmentGenesis && !trusted) ||
      (trusted &&
        (trusted.environmentId !== input.environmentId ||
          !sameBytes(trusted.protocolObject.digest, input.trustedRevisionHash)))
    )
      throw new SyncIntegrityError(
        "trusted revision is unknown or incompatible",
      );
    if (
      trusted &&
      !(await this.isAncestor(database, trusted.id, environment.currentHeadId))
    )
      throw new SyncIntegrityError(
        "trusted revision is not an ancestor of the head",
      );
    let afterRevision = trusted;
    if (input.cursorRevisionId !== undefined) {
      if (input.cursorRevisionHash === undefined)
        throw new SyncIntegrityError("cursor revision hash is required");
      const cursor = await database.revision.findUnique({
        where: { id: input.cursorRevisionId },
        include: { protocolObject: true },
      });
      if (
        !cursor ||
        cursor.environmentId !== input.environmentId ||
        !sameBytes(cursor.protocolObject.digest, input.cursorRevisionHash)
      )
        throw new SyncIntegrityError(
          "cursor revision is unknown or incompatible",
        );
      if (trusted && !(await this.isAncestor(database, trusted.id, cursor.id)))
        throw new SyncIntegrityError(
          "cursor revision is not after the trusted revision",
        );
      afterRevision = cursor;
    }
    const revisions = await database.revision.findMany({
      where: {
        environmentId: input.environmentId,
        ...(afterRevision
          ? {
              OR: [
                { acceptedAt: { gt: afterRevision.acceptedAt } },
                {
                  acceptedAt: afterRevision.acceptedAt,
                  id: { gt: afterRevision.id },
                },
              ],
            }
          : {}),
      },
      include: {
        protocolObject: true,
        manifestDescriptor: {
          include: { protocolObject: true },
        },
        commitments: {
          include: {
            laneObject: {
              include: { protocolObject: true },
            },
          },
          orderBy: { ordinal: "asc" },
        },
      },
      orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
      take: input.limit + 1,
    });
    const pageRevisions = revisions.slice(0, input.limit);
    const resourceLifecycle =
      environment.lifecycle === "ACTIVE" &&
      environment.project.lifecycle === "ACTIVE"
        ? "ACTIVE"
        : "ARCHIVED";
    const mapped = await Promise.all(
      pageRevisions.map(async (revision) => {
        const objects: SyncObject[] = [
          {
            objectId: revision.protocolObjectId,
            canonicalBytes: copyBytes(
              revision.protocolObject.canonicalBytes,
              "revision canonical bytes",
            ),
            digest: copyBytes(
              revision.protocolObject.digest,
              "revision digest",
            ),
          },
        ];
        if (revision.manifestDescriptor) {
          objects.push({
            objectId: revision.manifestDescriptor.protocolObjectId,
            canonicalBytes: copyBytes(
              revision.manifestDescriptor.protocolObject.canonicalBytes,
              "descriptor canonical bytes",
            ),
            digest: copyBytes(
              revision.manifestDescriptor.protocolObject.digest,
              "descriptor digest",
            ),
          });
        }
        for (const commitment of revision.commitments) {
          const lane = commitment.laneObject;
          const decision = decideLaneDisclosure(
            membership,
            resourceLifecycle,
            { scope: lane.scope, ownerUserId: lane.ownerUserId },
            input.actorUserId,
          );
          if (!decision.allowed) continue;
          verifyRevisionDigest(
            commitment.objectHash,
            lane.protocolObject.digest,
            "lane commitment",
          );
          objects.push({
            objectId: lane.protocolObjectId,
            canonicalBytes: copyBytes(
              lane.protocolObject.canonicalBytes,
              "lane canonical bytes",
            ),
            digest: copyBytes(lane.protocolObject.digest, "lane digest"),
          });
        }
        return Object.freeze({
          id: revision.id,
          digest: copyBytes(revision.protocolObject.digest, "revision digest"),
          parentId: revision.parentId,
          parentHash: revision.parentHash
            ? copyBytes(revision.parentHash, "parent hash")
            : null,
          mutation: revision.mutation,
          projectEpoch: revision.projectEpoch,
          authoredAtMs: revision.authoredAtMs,
          rollbackTargetId: revision.rollbackTargetId,
          objects: Object.freeze(objects),
        });
      }),
    );
    const lastRevision = pageRevisions.at(-1);
    const nextCursor =
      revisions.length > input.limit && lastRevision !== undefined
        ? Object.freeze({
            revisionId: lastRevision.id,
            revisionHash: copyBytes(
              lastRevision.protocolObject.digest,
              "next cursor revision hash",
            ),
          })
        : null;
    return Object.freeze({
      environmentId: input.environmentId,
      trustedRevisionId: input.trustedRevisionId,
      trustedRevisionHash: copyBytes(
        input.trustedRevisionHash,
        "trusted revision hash",
      ),
      currentHeadId: environment.currentHeadId,
      currentHeadHash: environment.currentHead
        ? copyBytes(
            environment.currentHead.protocolObject.digest,
            "current head hash",
          )
        : null,
      projectEpoch: environment.project.currentEpoch,
      revisions: Object.freeze(mapped),
      nextCursor,
    });
  }

  private async isAncestor(
    database: PersistenceClient,
    ancestorId: string,
    descendantId: string | null,
  ): Promise<boolean> {
    if (descendantId === null) return false;
    let currentId: string | null = descendantId;
    while (currentId !== null) {
      if (currentId === ancestorId) return true;
      const link: { parentId: string | null } | null =
        await database.revision.findUnique({
          where: { id: currentId },
          select: { parentId: true },
        });
      currentId = link?.parentId ?? null;
    }
    return false;
  }
}

export const mutationToWire = (mutation: MutationKind): number =>
  mutationWireValues[mutation];
