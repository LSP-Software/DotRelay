import type { DatabaseClient } from "@dotrelay/database";
import type { Context, Next } from "hono";
import type { DotRelayAuth } from "./auth";

/**
 * The absolute lifetime of any Better Auth session, browser or CLI bearer.
 * Sessions slide (auth.ts refreshes them daily for 30 days), so without this
 * cap a session used at least monthly would never expire.
 */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

type RequestSession = Awaited<ReturnType<DotRelayAuth["api"]["getSession"]>>;

const SESSION_KEY = "dotrelayRequestSession";

/**
 * The Better Auth session for this request, looked up at most once per
 * request by the middlewares that need it before the route runs.
 */
export const requestSession = (
  context: Context,
  auth: DotRelayAuth,
): Promise<RequestSession | null> => {
  const cached = context.get(SESSION_KEY as never) as
    Promise<RequestSession | null> | undefined;
  if (cached) return cached;
  const lookup = auth.api
    .getSession({ headers: context.req.raw.headers })
    .then((session) => session ?? null);
  context.set(SESSION_KEY as never, lookup as never);
  return lookup;
};

/**
 * Whether a signed-in session made this request, as the middlewares that
 * looked it up found. Every request with credentials passes the session
 * lifetime gate, which looks the session up, so a request without a lookup
 * carried no credentials and is anonymous.
 */
export const requestWasAuthenticated = async (
  context: Context,
): Promise<boolean> => {
  const cached = context.get(SESSION_KEY as never) as
    Promise<RequestSession | null> | undefined;
  if (!cached) return false;
  return (await cached.catch(() => null)) !== null;
};

const hasCredentials = (request: Request) =>
  request.headers.has("Cookie") || request.headers.has("Authorization");

export const sessionCreatedAt = (
  session: RequestSession | null,
): Date | null => {
  const createdAt = (session as { session?: { createdAt?: unknown } } | null)
    ?.session?.createdAt;
  if (createdAt instanceof Date) return createdAt;
  if (typeof createdAt === "string" || typeof createdAt === "number") {
    const parsed = new Date(createdAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

/**
 * Ends a session older than SESSION_MAX_AGE_MS before any route sees it:
 * the row is deleted, so Better Auth and every route treat the request as
 * signed out and the client signs in again.
 */
export const createSessionLifetimeGate =
  (
    database: DatabaseClient,
    auth: DotRelayAuth,
    now: () => Date = () => new Date(),
  ) =>
  async (context: Context, next: Next) => {
    if (!hasCredentials(context.req.raw)) {
      await next();
      return;
    }
    const session = await requestSession(context, auth).catch(() => null);
    const createdAt = sessionCreatedAt(session);
    const sessionId = (session as { session?: { id?: unknown } } | null)
      ?.session?.id;
    if (
      createdAt &&
      typeof sessionId === "string" &&
      now().getTime() - createdAt.getTime() > SESSION_MAX_AGE_MS
    ) {
      await database.authSession.deleteMany({ where: { id: sessionId } });
      context.set(SESSION_KEY as never, Promise.resolve(null) as never);
    }
    await next();
  };
