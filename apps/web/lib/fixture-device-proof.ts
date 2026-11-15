import {
  DEVICE_PROOF_CHALLENGE_BYTES,
  DEVICE_PROOF_TOKEN_BYTES,
  encodeDeviceProofValue,
  parseUuid,
  uuidToBytes,
} from "@dotrelay/client";
import { isWorkspaceFixtureEnabled } from "@/lib/workspace-boundary";

// Device proof routes for the development workspace fixture only. With the
// fixture on, the browser's API origin is this web app, so the e2e suite's
// browser gets its proofs here; the fixture boundary ignores them. A live
// deployment answers 404: its proofs come from the Server Profile.

const notFound = () =>
  Response.json(
    { code: "resource_not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );

export const fixtureDeviceProofChallenge = (): Response => {
  if (!isWorkspaceFixtureEnabled()) return notFound();
  return Response.json(
    {
      challenge: encodeDeviceProofValue(
        globalThis.crypto.getRandomValues(
          new Uint8Array(DEVICE_PROOF_CHALLENGE_BYTES),
        ),
      ),
      expiresIn: 120,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
};

export const fixtureDeviceProof = async (
  request: Request,
): Promise<Response> => {
  if (!isWorkspaceFixtureEnabled()) return notFound();
  let deviceId: string;
  try {
    const body = (await request.json()) as { deviceId?: unknown };
    deviceId = parseUuid(body.deviceId, "deviceId");
  } catch {
    return Response.json(
      { code: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const token = new Uint8Array(DEVICE_PROOF_TOKEN_BYTES);
  token[0] = 1;
  token.set(uuidToBytes(deviceId), 1);
  return Response.json(
    { token: encodeDeviceProofValue(token), deviceId, expiresIn: 300 },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
};
