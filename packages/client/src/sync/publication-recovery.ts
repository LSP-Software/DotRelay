import type { FinalizeInput, ProtocolTransport } from "./transport";
import { ProtocolTransportError } from "./transport";

export class PublicationUncertainError extends Error {
  constructor(readonly operationId: string) {
    super(
      "Publication outcome is unknown. Reconcile the original operation before publishing again.",
    );
    this.name = "PublicationUncertainError";
  }
}

// Retrying the same operation and exact revision is safe. Never cancel a
// finalize whose commit outcome is unknown and never invent a new operation.
export const finalizePublication = async (
  transport: ProtocolTransport,
  input: FinalizeInput,
  uncertain = false,
) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transport.finalize(input);
    } catch (error) {
      if (
        error instanceof ProtocolTransportError &&
        error.problem.status < 500 &&
        ![408, 429].includes(error.problem.status)
      ) {
        if (uncertain) throw new PublicationUncertainError(input.operationId);
        throw error;
      }
      uncertain = true;
      if (transport.operation) {
        try {
          const receipt = await transport.operation(input);
          if (receipt.status === "COMMITTED") {
            if (!receipt.revisionIds.includes(input.request.revision.id))
              throw new Error("Operation receipt mismatch");
            return { revisionId: input.request.revision.id, idempotent: true };
          }
          if (["CANCELLED", "EXPIRED"].includes(receipt.status)) throw error;
        } catch {
          /* Offline or uncertain: retain the exact input for retry. */
        }
      }
    }
  }
  throw new PublicationUncertainError(input.operationId);
};
