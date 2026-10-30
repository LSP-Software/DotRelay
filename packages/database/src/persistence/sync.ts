import { decideLaneDisclosure } from "../administration";
import type { MutationKind } from "../generated/prisma/client";
import { AdministrationDisclosureRepository } from "./disclosure";
import {
  MembershipNotActiveError,
  type PersistenceClient,
} from "./repository-core";
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
    if (!membership) throw new MembershipNotActiveError();
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
    // Revisions are immutable. Walk only the chain ending at the head captured
    // above, so concurrent publications cannot leak beyond the advertised head.
    // Wall-clock timestamps (and random UUIDs) do not define ancestry.
    const reverseChain: string[] = [];
    const visited = new Set<string>();
    let currentId = environment.currentHeadId;
    while (currentId !== null && currentId !== trusted?.id) {
      if (visited.has(currentId))
        throw new SyncIntegrityError("revision history contains a cycle");
      visited.add(currentId);
      const link = await database.revision.findUnique({
        where: { id: currentId },
        select: { id: true, parentId: true, environmentId: true },
      });
      if (!link || link.environmentId !== input.environmentId)
        throw new SyncIntegrityError(
          "revision history is incomplete or incompatible",
        );
      reverseChain.push(link.id);
      currentId = link.parentId;
    }
    if (trusted && currentId !== trusted.id)
      throw new SyncIntegrityError(
        "trusted revision is not an ancestor of the head",
      );
    const chain = reverseChain.reverse();
    let afterIndex = -1;
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
      afterIndex = chain.indexOf(cursor.id);
      if (cursor.id !== trusted?.id && afterIndex === -1)
        throw new SyncIntegrityError(
          "cursor revision is not on the advertised head's chain",
        );
    }
    const remaining = chain.slice(afterIndex + 1);
    const pageIds = remaining.slice(0, input.limit);
    const revisions = await database.revision.findMany({
      where: { environmentId: input.environmentId, id: { in: pageIds } },
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
    });
    const byId = new Map(revisions.map((revision) => [revision.id, revision]));
    const pageRevisions = pageIds.map((id) => {
      const revision = byId.get(id);
      if (!revision)
        throw new SyncIntegrityError("revision history is incomplete");
      return revision;
    });
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
      remaining.length > input.limit && lastRevision !== undefined
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
}

export const mutationToWire = (mutation: MutationKind): number =>
  mutationWireValues[mutation];
