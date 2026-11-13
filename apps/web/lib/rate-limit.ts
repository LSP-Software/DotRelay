// The service answers a request over a per-User or per-IP limit with 429
// rate_limited. Its problem body carries retryAfterSeconds; the Retry-After
// header says the same but a cross-origin browser can only read it when the
// API exposes it (it exposes X-Retry-After for auth routes).

const asSeconds = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isSafeInteger(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? undefined
    : Math.max(0, Math.ceil((date - Date.now()) / 1000));
};

export const retryAfterSecondsFrom = (
  body: unknown,
  headers?: Pick<Headers, "get">,
): number | undefined =>
  asSeconds(
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as { readonly retryAfterSeconds?: unknown }).retryAfterSeconds
      : undefined,
  ) ??
  asSeconds(headers?.get("Retry-After")) ??
  asSeconds(headers?.get("X-Retry-After"));

export const rateLimitedMessage = (retryAfterSeconds?: number): string =>
  retryAfterSeconds === undefined || retryAfterSeconds === 0
    ? "The server is limiting requests right now. Wait a moment, then try again."
    : `The server is limiting requests right now. Try again in ${retryAfterSeconds} ${retryAfterSeconds === 1 ? "second" : "seconds"}.`;
