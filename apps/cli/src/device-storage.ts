import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  DeviceRecordStore,
  DeviceStorageScope,
  EncryptedDeviceRecord,
} from "@dotrelay/client";
import type { ServerProfilePin } from "@dotrelay/contracts";
import { atomicWriteProtectedFile } from "./output";

const encode = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const decode = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("device record is invalid");
  return new Uint8Array(Buffer.from(value, "base64"));
};

const deviceKey = (deviceId: Uint8Array): string =>
  [...deviceId].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const samePin = (left: ServerProfilePin, right: ServerProfilePin): boolean =>
  left.origin === right.origin &&
  left.serverProfileId === right.serverProfileId;

export const createFileDeviceRecordStore = (
  directory: string,
): DeviceRecordStore => {
  const pathFor = (scope: DeviceStorageScope): string =>
    join(
      directory,
      `device-${scope.pin.serverProfileId}-${deviceKey(scope.deviceId)}.json`,
    );

  return Object.freeze({
    read: async (scope): Promise<EncryptedDeviceRecord | null> => {
      try {
        const value = JSON.parse(
          await readFile(pathFor(scope), "utf8"),
        ) as Record<string, unknown>;
        const storedScope = value.scope as Record<string, unknown> | undefined;
        const storedPin = storedScope?.pin as
          | Record<string, unknown>
          | undefined;
        const storedDeviceId = decode(storedScope?.deviceId);
        if (
          !storedPin ||
          typeof storedPin.origin !== "string" ||
          typeof storedPin.serverProfileId !== "string" ||
          !samePin(scope.pin, {
            origin: storedPin.origin,
            serverProfileId: storedPin.serverProfileId,
          }) ||
          deviceKey(storedDeviceId) !== deviceKey(scope.deviceId) ||
          value.version !== 1
        )
          throw new Error("device record scope mismatch");
        return Object.freeze({
          version: 1,
          scope,
          iv: decode(value.iv),
          ciphertext: decode(value.ciphertext),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write: async (record) => {
      await atomicWriteProtectedFile(
        pathFor(record.scope),
        `${JSON.stringify({
          version: 1,
          scope: {
            pin: record.scope.pin,
            deviceId: encode(record.scope.deviceId),
          },
          iv: encode(record.iv),
          ciphertext: encode(record.ciphertext),
        })}\n`,
      );
    },
    remove: async (scope) => {
      await unlink(pathFor(scope)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    },
  });
};

export const deviceMetadataPath = (
  directory: string,
  profile: ServerProfilePin,
): string => join(directory, `device-${profile.serverProfileId}.json`);

export const readDeviceId = async (path: string): Promise<string | null> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    return typeof value.deviceId === "string" ? value.deviceId : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const writeDeviceId = async (
  path: string,
  profile: ServerProfilePin,
  deviceId: string,
): Promise<void> => {
  await atomicWriteProtectedFile(
    path,
    `${JSON.stringify({
      version: 1,
      origin: profile.origin,
      serverProfileId: profile.serverProfileId,
      deviceId,
    })}\n`,
  );
};
