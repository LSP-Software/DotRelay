import { createProblem } from "@dotrelay/contracts";
import type { FinalizeInput, ProtocolTransport } from "./transport";
import { ProtocolTransportError } from "./transport-error";

export class PublicationJournalError extends Error {
  constructor() {
    super(
      "Publication recovery data could not be read. Publishing is blocked; restore the recovery record before retrying.",
    );
    this.name = "PublicationJournalError";
  }
}

export class PublicationUncertainError extends Error {
  constructor(readonly operationId: string) {
    super(
      "Publication outcome is unknown. Reconcile the original operation before publishing again.",
    );
    this.name = "PublicationUncertainError";
  }
}

export class PublicationTerminalError extends ProtocolTransportError {
  constructor() {
    super(createProblem("staging_expired"));
    this.name = "PublicationTerminalError";
  }
}

// Retry only the same operation and exact Revision. A 4xx cannot settle an
// earlier uncertain attempt: authorization may have changed after its commit.
export const finalizePublication = async (
  transport: ProtocolTransport,
  input: FinalizeInput,
  uncertain = false,
) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transport.finalize(input);
    } catch (error) {
      const definitive =
        error instanceof ProtocolTransportError &&
        error.problem.status < 500 &&
        ![408, 429].includes(error.problem.status);
      if (!definitive) uncertain = true;
      if (uncertain && transport.operation) {
        let receipt:
          | Awaited<ReturnType<NonNullable<ProtocolTransport["operation"]>>>
          | undefined;
        try {
          receipt = await transport.operation(input);
        } catch {
          /* Keep the journal when the receipt is inaccessible. */
        }
        if (
          receipt?.status === "COMMITTED" &&
          receipt.revisionIds.includes(input.request.revision.id)
        )
          return { revisionId: input.request.revision.id, idempotent: true };
        if (receipt && ["CANCELLED", "EXPIRED"].includes(receipt.status))
          throw new PublicationTerminalError();
      }
      if (definitive) {
        if (uncertain) throw new PublicationUncertainError(input.operationId);
        throw error;
      }
    }
  }
  throw new PublicationUncertainError(input.operationId);
};
