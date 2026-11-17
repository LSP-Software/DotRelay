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
 * The Device a CLI client acts as (ADR 0020). Its signing key is read from
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
          "The keys for this device are missing from this machine. Run dotrelay login to enroll it again.",
          {},
          "device_bundle_missing",
        );
      }
      try {
        return await deviceProofSignerFromBundle(bundle);
      } catch {
        throw new CliError(
          "crypto",
          "This device's saved keys are damaged, so DotRelay can't sign requests with them.",
          {},
          "device_bundle_invalid",
        );
      }
    },
  });
