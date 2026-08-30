import {
  type ProblemCode,
  sha384,
} from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import {
  OperationConflictError,
  StagedObjectConflictError,
  StaleEpochError,
  StaleHeadError,
  SyncIntegrityError,
} from "@dotrelay/database";

export const mapPersistenceError = (
  error: unknown,
): { readonly code: ProblemCode; readonly headId?: string; readonly headHash?: string } | null => {
  if (error instanceof StaleHeadError)
    return {
      code: "stale_head",
      ...(error.currentHeadId ? { headId: error.currentHeadId } : {}),
    };
  if (error instanceof StaleEpochError) return { code: "stale_epoch" };
  if (error instanceof OperationConflictError)
    return { code: "operation_conflict" };
  if (error instanceof StagedObjectConflictError)
    return { code: "state_conflict" };
  if (error instanceof SyncIntegrityError) return { code: "state_conflict" };
  if (!(error instanceof Error)) return null;
  const message = error.message;
  if (message.includes("not active")) return { code: "device_not_active" };
  if (message.includes("not authorized") || message.includes("not disclosed"))
    return { code: "forbidden" };
  if (message.includes("not found")) return { code: "resource_not_found" };
  if (message.includes("archived")) return { code: "archived_resource" };
  if (message.includes("not staged")) return { code: "staged_object_missing" };
  if (message.includes("expired")) return { code: "staging_expired" };
  if (message.includes("not cancellable")) return { code: "state_conflict" };
  return null;
};

export const enrichStaleHead = async (
  database: DatabaseClient,
  headId: string | null | undefined,
): Promise<{ headId?: string; headHash?: string }> => {
  if (!headId) return {};
  const revision = await database.revision.findUnique({
    where: { id: headId },
    include: { protocolObject: { select: { digest: true } } },
  });
  if (!revision) return { headId };
  const digest = new Uint8Array(revision.protocolObject.digest);
  const headHash = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { headId, headHash };
};

export const digestRequestBody = async (body: Uint8Array): Promise<Uint8Array> =>
  sha384(body);
