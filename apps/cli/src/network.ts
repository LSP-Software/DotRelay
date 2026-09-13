import { CliError } from "./errors";
import type { FetchFunction } from "./profile";

/**
 * Bounding policy for one CLI network operation. Every fetch attempt gets a
 * cancellable deadline so a stalled request can never wait indefinitely, and
 * safe operations get a bounded number of attempts so short outages do not
 * force the operator to start over.
 */
export type NetworkPolicy = Readonly<{
  /** A fetch that has not settled after this long is treated as stalled. */
  readonly requestDeadlineMs: number;
  /** Total attempts for one logical operation, including the first. */
  readonly maxAttempts: number;
  /** Delay before the first retry; doubles per further attempt. */
  readonly retryBaseDelayMs: number;
  /** Upper bound for the delay between attempts. */
  readonly retryMaxDelayMs: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}>;

const realSleep = (milliseconds: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const defaultNetworkPolicy: NetworkPolicy = Object.freeze({
  requestDeadlineMs: 30_000,
  maxAttempts: 3,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 10_000,
  sleep: realSleep,
  now: Date.now,
});

// A snappier policy for read-only probes (status, capability lookups) where
// the operator wants a fast answer instead of full retry patience.
export const probeNetworkPolicy: NetworkPolicy = Object.freeze({
  requestDeadlineMs: 10_000,
  maxAttempts: 2,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 2_000,
  sleep: realSleep,
  now: Date.now,
});

export type NetworkFailure =
  | Readonly<{ readonly kind: "stalled"; readonly deadlineMs: number }>
  | Readonly<{ readonly kind: "offline" }>;

/**
 * Thrown when a single fetch attempt cannot complete: the request stalled
 * past its deadline, or the endpoint could not be reached at all.
 */
export class NetworkAttemptError extends Error {
  readonly failure: NetworkFailure;
  /** Set when a whole budget of attempts is exhausted. */
  readonly attempts?: number;
  readonly elapsedMs?: number;

  constructor(
    failure: NetworkFailure,
    stats?: Readonly<{ readonly attempts: number; readonly elapsedMs: number }>,
  ) {
    super(
      failure.kind === "stalled"
        ? `the request stalled after ${failure.deadlineMs} ms`
        : "the request could not be completed",
    );
    this.name = "NetworkAttemptError";
    this.failure = failure;
    if (stats) {
      this.attempts = stats.attempts;
      this.elapsedMs = stats.elapsedMs;
    }
  }
}

/**
 * Classifies a server response for a bounded operation: `final` means the
 * operation is done (success or a definitive error); `retry` means the
 * server asked to be retried, optionally with an explicit wait.
 */
export type RetryDecision =
  | Readonly<{ readonly kind: "final" }>
  | Readonly<{ readonly kind: "retry"; readonly retryAfterMs?: number }>;

export type RetryReason = "offline" | "stalled" | "server";

export type RetryListener = (
  event: Readonly<{
    /** One-based number of the attempt that just finished. */
    readonly attempt: number;
    readonly reason: RetryReason;
    readonly nextDelayMs: number;
  }>,
) => void;

export type FetchBudget = Readonly<{
  readonly policy: NetworkPolicy;
  /**
   * Retries for safe operations. Omit for deadline-only operations that
   * must never be repeated, such as a mutation carrying a fresh operation
   * id: the attempt still gets a cancellable deadline, but a failed attempt
   * is surfaced to the caller instead of being retried.
   */
  readonly retry?: Readonly<{
    readonly verdict?: (response: Response) => RetryDecision;
    readonly onRetry?: RetryListener;
  }>;
}>;

export type BoundedFetchResult = Readonly<{
  readonly response: Response;
  readonly attempts: number;
  readonly elapsedMs: number;
}>;

export const retryDelay = (
  attempt: number,
  policy: Pick<NetworkPolicy, "retryBaseDelayMs" | "retryMaxDelayMs">,
): number =>
  Math.min(
    policy.retryMaxDelayMs,
    policy.retryBaseDelayMs * 2 ** (attempt - 1),
  );

const MAX_RETRY_AFTER_MS = 10 * 60_000;

/**
 * Reads the server's retry guidance from a response: the Retry-After (or the
 * service's X-Retry-After) header as seconds or an HTTP date.
 */
export const retryAfterMsFromResponse = (
  response: Response,
  now: () => number,
): number | undefined => {
  const header =
    response.headers.get("Retry-After") ??
    response.headers.get("X-Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date))
    return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, date - now()));
  return undefined;
};

/**
 * Standard verdict for safe operations: a rate limit or a 5xx answer is a
 * transient server condition worth retrying, optionally waiting the server's
 * Retry-After guidance first; every other answer is final.
 */
export const transientResponseVerdict = (
  response: Response,
  now: () => number,
): RetryDecision => {
  if (response.status === 429 || response.status >= 500) {
    const retryAfterMs = retryAfterMsFromResponse(response, now);
    return {
      kind: "retry",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  return { kind: "final" };
};

/**
 * Runs one fetch attempt under a cancellable deadline. The deadline aborts
 * the attempt and settles it as a stalled failure, so a fetch that never
 * settles can never hang the CLI.
 */
export const fetchWithDeadline = async (
  fetcher: FetchFunction,
  input: string,
  init: RequestInit,
  policy: NetworkPolicy,
): Promise<Response> => {
  const controller = new AbortController();
  const callerSignal = init.signal ?? null;
  if (callerSignal?.aborted) controller.abort();
  else
    callerSignal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  // The deadline races the attempt itself, so a fetch that never settles
  // (even one that ignores the abort signal) still terminates bounded.
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      controller.abort();
      reject(
        new NetworkAttemptError({
          kind: "stalled",
          deadlineMs: policy.requestDeadlineMs,
        }),
      );
    }, policy.requestDeadlineMs);
  });
  let attempt: Promise<Response>;
  try {
    attempt = fetcher(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    // A synchronously throwing fetcher never races the deadline, so the
    // timer must be disarmed: an armed timer would reject the unwatched
    // deadline promise requestDeadlineMs later as an unhandled rejection.
    if (timer !== undefined) clearTimeout(timer);
    // A fetch the caller already aborted is the caller's outcome, not an
    // unreachable service.
    if (callerSignal?.aborted) throw error;
    throw new NetworkAttemptError({ kind: "offline" });
  }
  // A late failure of an attempt the deadline already beat must not surface
  // as an unhandled rejection.
  attempt.catch(() => undefined);
  try {
    const response = await Promise.race([attempt, deadline]);
    settled = true;
    return response;
  } catch (error) {
    settled = true;
    if (error instanceof NetworkAttemptError) throw error;
    if (callerSignal?.aborted) throw error;
    throw new NetworkAttemptError({ kind: "offline" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Runs a safe operation under the policy's budget: each attempt gets a
 * cancellable deadline, transient network failures and server retry
 * guidance (rate limits, 5xx answers) are retried with backoff or the
 * server's Retry-After wait, and the total is bounded by maxAttempts. A
 * response the verdict marks final is returned as-is, including one that
 * exhausts the budget, so the caller keeps its own error classification.
 */
export const fetchWithinBudget = async (
  fetcher: FetchFunction,
  input: string,
  init: RequestInit,
  budget: FetchBudget,
): Promise<BoundedFetchResult> => {
  const { policy } = budget;
  const retry = budget.retry;
  if (!retry) {
    // A deadline-only operation surfaces its failed attempt as-is.
    const started = policy.now();
    const response = await fetchWithDeadline(fetcher, input, init, policy);
    return { response, attempts: 1, elapsedMs: policy.now() - started };
  }
  const { verdict, onRetry } = retry;
  const started = policy.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let response: Response;
    try {
      response = await fetchWithDeadline(fetcher, input, init, policy);
    } catch (error) {
      if (!(error instanceof NetworkAttemptError)) throw error;
      if (attempts >= policy.maxAttempts)
        throw new NetworkAttemptError(error.failure, {
          attempts,
          elapsedMs: policy.now() - started,
        });
      const nextDelayMs = retryDelay(attempts, policy);
      onRetry?.({
        attempt: attempts,
        reason: error.failure.kind,
        nextDelayMs,
      });
      await policy.sleep(nextDelayMs);
      continue;
    }
    const decision = verdict ? verdict(response) : { kind: "final" as const };
    if (decision.kind === "final" || attempts >= policy.maxAttempts)
      return { response, attempts, elapsedMs: policy.now() - started };
    const nextDelayMs = decision.retryAfterMs ?? retryDelay(attempts, policy);
    onRetry?.({
      attempt: attempts,
      reason: "server",
      nextDelayMs,
    });
    await policy.sleep(nextDelayMs);
  }
};

/**
 * Names a failed network attempt for an operator: a stall means the service
 * was reached but stopped answering, while offline means it could not be
 * reached at all.
 */
export const describeNetworkFailure = (
  failure: NetworkFailure,
  subject: string,
  attempts?: number,
): string => {
  const tail =
    attempts === undefined
      ? ""
      : ` after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  return failure.kind === "stalled"
    ? `${subject} stopped responding${tail}`
    : `could not reach ${subject}${tail}`;
};

/**
 * Classifies an exhausted network budget as a retryable CLI failure, naming
 * the failed subject for the operator.
 */
export const networkFailureCliError = (
  error: NetworkAttemptError,
  subject: string,
  code: string,
): CliError =>
  new CliError(
    "transient",
    describeNetworkFailure(error.failure, subject, error.attempts),
    {},
    code,
  );
