import {
  type CliDeviceStorage,
  createCliDeviceStorage,
  deviceProofSignerFromBundle,
} from "@dotrelay/client";
import { type ServerProfilePin, uuidToBytes } from "@dotrelay/contracts";
import type { StrictJsonClientDevice } from "./admin";
import type { CredentialStore } from "./credentials";
import { createFileDeviceRecordStore } from "./device-storage";
import { CliError } from "./errors";

/**
 * The Device a CLI client acts as (ADR 0018). Its signing key is read from
 * the local bundle only when a request first needs a Device proof.
 */
export const cliDevice = (
  input: Readonly<{
    readonly pin: ServerProfilePin;
    readonly credentials: CredentialStore;
    readonly stateDirectory: string;
    readonly deviceId: string;
    readonly deviceStorage?: CliDeviceStorage;
  }>,
): StrictJsonClientDevice =>
  Object.freeze({
    id: input.deviceId,
    signer: async () => {
      const storage =
        input.deviceStorage ??
        createCliDeviceStorage(input.pin, input.credentials, {
          recordStore: createFileDeviceRecordStore(input.stateDirectory),
        });
      let bundle: Awaited<ReturnType<CliDeviceStorage["load"]>>;
      try {
        bundle = await storage.load({
          pin: input.pin,
          deviceId: uuidToBytes(input.deviceId),
        });
      } catch {
        throw new CliError(
          "authentication",
          "the active Device bundle is not available locally",
          {},
          "device_bundle_missing",
        );
      }
      try {
        return await deviceProofSignerFromBundle(bundle);
      } catch {
        throw new CliError(
          "crypto",
          "the active Device bundle is invalid",
          {},
          "device_bundle_invalid",
        );
      }
    },
  });
