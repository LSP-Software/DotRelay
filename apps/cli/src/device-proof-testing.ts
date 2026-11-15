import {
  createProblem,
  DEVICE_PROOF_CHALLENGE_BYTES,
  DEVICE_PROOF_TOKEN_BYTES,
  encodeDeviceProofValue,
  parseUuid,
  uuidToBytes,
} from "@dotrelay/contracts";

/**
 * Test support: answers the Device proof routes (ADR 0018) the way a Server
 * Profile does, for fake servers in CLI tests. Returns null for any other
 * request. The token names the Device; the fake does not check signatures.
 */
export const answerDeviceProofRoute = async (
  request: Request,
  options: Readonly<{
    readonly isActive?: (deviceId: string) => boolean;
  }> = {},
): Promise<Response | null> => {
  if (request.method !== "POST") return null;
  const { pathname } = new URL(request.url);
  if (pathname === "/api/v1/devices/proofs/challenges")
    return Response.json(
      {
        challenge: encodeDeviceProofValue(
          crypto.getRandomValues(new Uint8Array(DEVICE_PROOF_CHALLENGE_BYTES)),
        ),
        expiresIn: 120,
      },
      { status: 201 },
    );
  if (pathname !== "/api/v1/devices/proofs") return null;
  const body = (await request.json()) as { deviceId?: unknown };
  const deviceId = parseUuid(body.deviceId, "deviceId");
  if (options.isActive && !options.isActive(deviceId)) {
    const problem = createProblem("device_not_active");
    return Response.json(problem, { status: problem.status });
  }
  const token = new Uint8Array(DEVICE_PROOF_TOKEN_BYTES);
  token[0] = 1;
  token.set(uuidToBytes(deviceId), 1);
  return Response.json(
    { token: encodeDeviceProofValue(token), deviceId, expiresIn: 300 },
    { status: 201 },
  );
};
