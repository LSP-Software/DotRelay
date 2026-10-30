import type { Problem } from "@dotrelay/contracts";
export class ProtocolTransportError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail);
    this.name = "ProtocolTransportError";
    this.problem = problem;
  }
}
