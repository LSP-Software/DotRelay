import {
  ContractError,
  createProblem,
  DEVICE_PROOF_CHALLENGE_BYTES,
  decodeDeviceProofValue,
  deviceProofMessage,
  type ProblemCode,
  parseJsonObject,
  parseUuid,
} from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import { resolveDotRelayUser } from "@dotrelay/database";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DotRelayAuth } from "./auth";
import {
  DEVICE_PROOF_CHALLENGE_TTL_MS,
  deviceProofLifetimeSeconds,
  issueDeviceProof,
  issueDeviceProofChallenge,
  verifyDeviceProofChallenge,
} from "./device-proof";
import type { ServerProfileConfig } from "./profile";
import { sessionIdOf } from "./protocol/context";
import { requestSession } from "./session";

type Dependencies = Readonly<{
  readonly database: DatabaseClient;
  readonly profile: ServerProfileConfig;
  readonly auth: DotRelayAuth;
  readonly bodyLimit: MiddlewareHandler;
  readonly now?: () => number;
}>;

const problem = (context: Context, code: ProblemCode) => {
  const body = createProblem(code);
  return context.json(body, body.status as ContentfulStatusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  });
};

const decodeSignature = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || value.length !== 88)
    throw new ContractError("invalid_request");
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.length !== 64) throw new Error("length");
    return bytes;
  } catch {
    throw new ContractError("invalid_request");
  }
};

/**
 * Device proof of possession (ADR 0020). A session asks for a challenge,
 * its Device signs it, and the signature buys a short-lived proof bound to
 * that session and Device. Neither route accepts a proof: they are how a
 * client gets one.
 */
export const registerDeviceProofRoutes = (
  app: Hono,
  { database, profile, auth, bodyLimit, now = Date.now }: Dependencies,
) => {
  app.post("/api/v1/devices/proofs/challenges", bodyLimit, async (context) => {
    try {
      const session = await requestSession(context, auth);
      const sessionId = sessionIdOf(session);
      if (!session || !sessionId)
        return problem(context, "authentication_required");
      return context.json(
        {
          challenge: await issueDeviceProofChallenge(profile, sessionId, now()),
          expiresIn: DEVICE_PROOF_CHALLENGE_TTL_MS / 1000,
        },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch {
      return problem(context, "service_unavailable");
    }
  });

  app.post("/api/v1/devices/proofs", bodyLimit, async (context) => {
    let sessionId: string | null;
    let userId: string;
    try {
      const session = await requestSession(context, auth);
      sessionId = sessionIdOf(session);
      if (!session || !sessionId)
        return problem(context, "authentication_required");
      const user = await resolveDotRelayUser(database, {
        serverProfileId: profile.id,
        authSubject: session.user.id,
        serverProfileOrigin: profile.origin,
        allowRebind: profile.allowRebind,
      });
      if (!user) return problem(context, "service_unavailable");
      userId = user.id;
    } catch {
      return problem(context, "service_unavailable");
    }
    try {
      if (
        context.req.header("Content-Type")?.split(";", 1)[0]?.trim() !==
        "application/json"
      )
        return problem(context, "unsupported_media_type");
      let raw: unknown;
      try {
        raw = await context.req.json();
      } catch {
        return problem(context, "invalid_request");
      }
      const body = parseJsonObject<{
        deviceId?: unknown;
        challenge?: unknown;
        signature?: unknown;
      }>(raw, ["deviceId", "challenge", "signature"]);
      const deviceId = parseUuid(body.deviceId, "deviceId");
      const challenge = decodeDeviceProofValue(
        body.challenge,
        DEVICE_PROOF_CHALLENGE_BYTES,
      );
      const signature = decodeSignature(body.signature);
      const issuedAt = now();
      const verified = await verifyDeviceProofChallenge(
        profile,
        challenge,
        sessionId,
        issuedAt,
      );
      if (!verified) return problem(context, "device_proof_required");
      const device = await database.device.findFirst({
        where: { id: deviceId, userId, lifecycle: "ACTIVE" },
        select: { ed25519PublicKey: true },
      });
      if (!device) return problem(context, "device_not_active");
      const publicKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(device.ed25519PublicKey).slice(),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const message = deviceProofMessage({
        serverProfileId: profile.id,
        userId,
        deviceId,
        challenge,
      });
      if (
        !(await crypto.subtle.verify(
          "Ed25519",
          publicKey,
          signature.slice(),
          message,
        ))
      )
        return problem(context, "invalid_crypto_object");
      const proof = await issueDeviceProof(profile, {
        challenge: verified,
        sessionId,
        userId,
        deviceId,
      });
      return context.json(
        {
          token: proof.token,
          deviceId,
          expiresIn: deviceProofLifetimeSeconds(proof.expiresAtMs, issuedAt),
        },
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      if (error instanceof ContractError) return problem(context, error.code);
      return problem(context, "service_unavailable");
    }
  });
};
