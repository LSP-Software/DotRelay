import { issueDeviceProof } from "./device-proof";

/**
 * Test support: a Device proof for a stubbed session, minted the way the
 * exchange route mints one but without a signed challenge.
 */
export const testDeviceProof = async (
  profile: Readonly<{ readonly id: string; readonly authSecret: string }>,
  input: Readonly<{
    readonly sessionId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly issuedAtMs?: number;
  }>,
): Promise<string> =>
  (
    await issueDeviceProof(profile, {
      challenge: {
        nonce: crypto.getRandomValues(new Uint8Array(16)),
        issuedAtMs: input.issuedAtMs ?? Date.now(),
      },
      sessionId: input.sessionId,
      userId: input.userId,
      deviceId: input.deviceId,
    })
  ).token;
