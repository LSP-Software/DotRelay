import { createProblem, DEVICE_ID_HEADER } from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import { resolveDotRelayUser } from "@dotrelay/database";
import type { Context } from "hono";
import type { DotRelayAuth } from "../auth";
import type { ServerProfileConfig } from "../profile";

export type ProtocolActor = Readonly<{
  readonly userId: string;
  readonly deviceId: string;
  /** The session user's ID in the better-auth ID space (authSubject). */
  readonly authSubject: string;
}>;

/**
 * A signed-in session without an active Device. Surfaces that disclose only
 * operator-visible metadata to the session's own User — the membership table
 * of a Team the User joins, the invitations addressed to that User — use this
 * gate; administrative mutations and protected data still require a Device.
 */
export type WebActor = Readonly<{
  readonly userId: string;
  readonly authSubject: string;
}>;

const serviceUnavailable = (context: Context) =>
  context.json(createProblem("service_unavailable"), 503, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  });

export const requireProtocolActor = async (
  context: Context,
  database: DatabaseClient,
  profile: ServerProfileConfig,
  auth: DotRelayAuth,
): Promise<ProtocolActor | Response> => {
  try {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session)
      return context.json(createProblem("authentication_required"), 401, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    const user = await resolveDotRelayUser(database, {
      serverProfileId: profile.id,
      authSubject: session.user.id,
    });
    if (!user) return serviceUnavailable(context);
    const deviceId = context.req.header(DEVICE_ID_HEADER);
    if (!deviceId)
      return context.json(createProblem("invalid_request"), 400, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    const device = await database.device.findFirst({
      where: { id: deviceId, userId: user.id, lifecycle: "ACTIVE" },
      select: { id: true },
    });
    if (!device)
      return context.json(createProblem("device_not_active"), 403, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    return Object.freeze({
      userId: user.id,
      deviceId: device.id,
      authSubject: session.user.id,
    });
  } catch {
    return serviceUnavailable(context);
  }
};

export const requireWebActor = async (
  context: Context,
  database: DatabaseClient,
  profile: ServerProfileConfig,
  auth: DotRelayAuth,
): Promise<WebActor | Response> => {
  try {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session)
      return context.json(createProblem("authentication_required"), 401, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    const user = await resolveDotRelayUser(database, {
      serverProfileId: profile.id,
      authSubject: session.user.id,
    });
    if (!user) return serviceUnavailable(context);
    return Object.freeze({
      userId: user.id,
      authSubject: session.user.id,
    });
  } catch {
    return serviceUnavailable(context);
  }
};
