import {
  accountFingerprint,
  createAccountDeviceRoster,
  deriveAccountSigningKey,
} from "@dotrelay/client";
import type { Page, Route } from "@playwright/test";
import { E2E_REVISION_SIGNING_RAW_KEY } from "../lib/workspace-boundary";

// What an honest Server Profile serves for the signed-in account after
// ADR 0015 and ADR 0022: the account's Device roster, signed by the key the
// account's Account Master Key derives. A browser trusts its account's other
// Devices, including the one that signs the fixture's synthetic history, only
// once it holds that key and the roster lists them. The fixture serves the
// teammate's roster itself (apps/web/lib/workspace-boundary.ts).

export const E2E_SERVER_PROFILE_ID = "00000000-0000-4000-8000-000000000062";
export const E2E_USER_ID = "00000000-0000-4000-8000-000000000061";
export const E2E_TEAMMATE_USER_ID = "00000000-0000-4000-8000-000000000071";
// The account's other Device, whose key signs the fixture's history.
export const E2E_HISTORY_DEVICE_ID = "00000000-0000-4000-8000-000000000040";
const E2E_HISTORY_SIGNING_KEY = E2E_REVISION_SIGNING_RAW_KEY;

export type BrowserDeviceKeys = Readonly<{
  readonly id: string;
  /** Hex X25519 public key, as the browser enrolled it. */
  readonly encryptionPublicKey: string;
  /** Hex Ed25519 public key, as the browser enrolled it. */
  readonly signingPublicKey: string;
}>;

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** This account's roster: this browser and the Device that signs history. */
export const ownAccountRosterB64 = async (
  accountMasterKey: Uint8Array,
  browser: BrowserDeviceKeys,
  version = 1,
): Promise<string> =>
  Buffer.from(
    (
      await createAccountDeviceRoster({
        serverProfileId: E2E_SERVER_PROFILE_ID,
        userId: E2E_USER_ID,
        version,
        devices: [
          {
            deviceId: browser.id,
            encryptionPublicKey: bytes(browser.encryptionPublicKey),
            signingPublicKey: bytes(browser.signingPublicKey),
            addedAtMs: 0,
          },
          {
            deviceId: E2E_HISTORY_DEVICE_ID,
            encryptionPublicKey: bytes("66".repeat(32)),
            signingPublicKey: bytes(E2E_HISTORY_SIGNING_KEY),
            addedAtMs: 0,
          },
        ],
        signingKey: await deriveAccountSigningKey(accountMasterKey, {
          serverProfileId: E2E_SERVER_PROFILE_ID,
          userId: E2E_USER_ID,
        }),
      })
    ).canonicalBytes,
  ).toString("base64");

/** The account fingerprint a transfer code for this account ends with. */
export const ownAccountFingerprint = async (
  accountMasterKey: Uint8Array,
): Promise<string> =>
  accountFingerprint(
    (
      await deriveAccountSigningKey(accountMasterKey, {
        serverProfileId: E2E_SERVER_PROFILE_ID,
        userId: E2E_USER_ID,
      })
    ).identity,
  );

/**
 * Serves this account's roster on the boundary once the browser holds the
 * Account Master Key, and accepts the versions the browser publishes,
 * serving the latest afterwards like the service does.
 */
export const createOwnAccountRoster = (
  input: Readonly<{
    readonly accountMasterKey: () => Uint8Array | null;
    readonly deviceKeys: () => BrowserDeviceKeys | null;
  }>,
) => {
  let published: string | null = null;
  let built: Readonly<{ key: string; roster: string }> | null = null;
  const current = async (): Promise<string | null> => {
    if (published) return published;
    const accountMasterKey = input.accountMasterKey();
    const device = input.deviceKeys();
    if (!accountMasterKey || !device) return null;
    const key = `${Buffer.from(accountMasterKey).toString("hex")}:${device.id}`;
    if (built?.key !== key)
      built = {
        key,
        roster: await ownAccountRosterB64(accountMasterKey, device),
      };
    return built.roster;
  };
  return {
    /** Adds this account's roster to a boundary body the spec serves. */
    inject: async (body: Record<string, unknown>): Promise<void> => {
      const roster = await current();
      if (!roster) return;
      body.accountRosters = {
        ...((body.accountRosters as Record<string, string | null>) ?? {}),
        [E2E_USER_ID]: roster,
      };
    },
    /** Accepts a roster the browser publishes; later boundaries serve it. */
    install: async (page: Page): Promise<void> => {
      await page.route(
        "**/api/v1/account-keys/rosters",
        async (route: Route) => {
          const body = (route.request().postDataJSON() ?? {}) as {
            readonly object?: string;
            readonly objectId?: string;
          };
          if (typeof body.object === "string") published = body.object;
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            json: { objectId: body.objectId ?? "", idempotent: false },
          });
        },
      );
    },
    published: (): string | null => published,
  };
};
