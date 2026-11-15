import {
  createProblem,
  DEVICE_ID_HEADER,
  DEVICE_PROOF_HEADER,
  type ProblemCode,
} from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import { resolveDotRelayUser } from "@dotrelay/database";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "../auth";
import { verifyDeviceProof } from "../device-proof";
import type { ServerProfileConfig } from "../profile";
import { requestSession } from "../session";

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

const problem = (context: Context, code: ProblemCode) => {
  const body = createProblem(code);
  return context.json(body, body.status as ContentfulStatusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  });
};

/** The Better Auth session row id, which Device proofs are bound to. */
export const sessionIdOf = (session: unknown): string | null => {
  const id = (session as { session?: { id?: unknown } } | null)?.session?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/**
 * The User and Device a request acts as. The session names the User; the
 * Device must be proven with a Device proof (ADR 0018) issued to this same
 * session. `X-DotRelay-Device-Id` is only a claim: when present it must name
 * the proven Device. Every check runs on every request, so signing out,
 * session expiry and Device revocation take effect on the next request.
 */
export const requireProtocolActor = async (
  context: Context,
  database: DatabaseClient,
  profile: ServerProfileConfig,
  auth: DotRelayAuth,
): Promise<ProtocolActor | Response> => {
  const cached = context.get("protocolActor" as never) as
    ProtocolActor | undefined;
  if (cached) return cached;
  try {
    const session = await requestSession(context, auth);
    const sessionId = sessionIdOf(session);
    if (!session || !sessionId)
      return problem(context, "authentication_required");
    const user = await resolveDotRelayUser(database, {
      serverProfileId: profile.id,
      authSubject: session.user.id,
      serverProfileOrigin: profile.origin,
      allowRebind: profile.allowRebind,
    });
    if (!user) return problem(context, "service_unavailable");
    const proof = context.req.header(DEVICE_PROOF_HEADER);
    if (!proof) return problem(context, "device_proof_required");
    const deviceId = await verifyDeviceProof(profile, proof, {
      sessionId,
      userId: user.id,
      nowMs: Date.now(),
    });
    if (!deviceId) return problem(context, "device_proof_required");
    const claimed = context.req.header(DEVICE_ID_HEADER);
    if (claimed !== undefined && claimed.toLowerCase() !== deviceId)
      return problem(context, "invalid_request");
    const device = await database.device.findFirst({
      where: { id: deviceId, userId: user.id, lifecycle: "ACTIVE" },
      select: { id: true },
    });
    if (!device) return problem(context, "device_not_active");
    const actor = Object.freeze({
      userId: user.id,
      deviceId: device.id,
      authSubject: session.user.id,
    });
    context.set("protocolActor" as never, actor as never);
    return actor;
  } catch {
    return problem(context, "service_unavailable");
  }
};

/**
 * For routes that also serve a session without a Device: null when the
 * request carries no Device proof, otherwise what requireProtocolActor
 * returns. A request that presents a proof never falls back to the session
 * view, so a client cannot mistake an expired proof for a missing Device.
 */
export const optionalProtocolActor = async (
  context: Context,
  database: DatabaseClient,
  profile: ServerProfileConfig,
  auth: DotRelayAuth,
): Promise<ProtocolActor | Response | null> =>
  context.req.header(DEVICE_PROOF_HEADER) === undefined
    ? null
    : requireProtocolActor(context, database, profile, auth);

export const requireWebActor = async (
  context: Context,
  database: DatabaseClient,
  profile: ServerProfileConfig,
  auth: DotRelayAuth,
): Promise<WebActor | Response> => {
  try {
    const session = await requestSession(context, auth);
    if (!session) return problem(context, "authentication_required");
    const user = await resolveDotRelayUser(database, {
      serverProfileId: profile.id,
      authSubject: session.user.id,
      serverProfileOrigin: profile.origin,
      allowRebind: profile.allowRebind,
    });
    if (!user) return problem(context, "service_unavailable");
    return Object.freeze({
      userId: user.id,
      authSubject: session.user.id,
    });
  } catch {
    return problem(context, "service_unavailable");
  }
};
