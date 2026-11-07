import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryCredentialStore,
  createProjectEpochKeyLink,
} from "@dotrelay/client";
import {
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
} from "@dotrelay/contracts";
import { type Boundary, parseBoundary } from "./workflow-core";
import {
  pendingRotationPath,
  resolvePendingRotation,
  writePendingRotation,
} from "./workflow-pending-rotation";

const ids = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  team: "44444444-4444-4444-8444-444444444444",
  project: "55555555-5555-4555-8555-555555555555",
  device: "33333333-3333-4333-8333-333333333333",
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const scenario = async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "dotrelay-pending-"));
  directories.push(stateDirectory);
  const options = {
    profile: {
      name: "relay",
      origin: "https://relay.example",
      pin: {
        serverProfileId: ids.serverProfileId,
        origin: "https://relay.example",
      },
    },
    credentials: createMemoryCredentialStore(),
    stateDirectory,
    contextPath: "",
    noInput: true,
    force: false,
    stdoutIsTerminal: false,
  } as never;
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const previousKey = crypto.getRandomValues(new Uint8Array(32));
  const newKey = crypto.getRandomValues(new Uint8Array(32));
  const link = await createProjectEpochKeyLink({
    serverProfileId: ids.serverProfileId,
    teamId: ids.team,
    projectId: ids.project,
    fromEpoch: 1,
    fromKey: previousKey,
    toKey: newKey,
    signingDeviceId: ids.device,
    signingPrivateKey: signing.privateKey,
  });
  const boundaryAt = (projectEpoch: string, links: Uint8Array[]): Boundary =>
    parseBoundary({
      session: { active: true, userId: "22222222-2222-4222-8222-222222222222" },
      environment: {
        id: "66666666-6666-4666-8666-666666666666",
        projectId: ids.project,
        teamId: ids.team,
        headRevision: "empty-environment",
        headHash: null,
        projectEpoch,
      },
      device: { active: true, id: ids.device },
      epochKeyLinks: links.map((bytes) =>
        Buffer.from(bytes).toString("base64"),
      ),
    });
  await writePendingRotation(options, {
    operationId: crypto.randomUUID(),
    projectId: ids.project,
    newEpoch: 2,
    newEpochKey: newKey,
    encryptionPublicKey: encryption.publicKey,
  });
  return {
    options,
    encryption,
    trustedSigningKeys: [await exportSigningPublicKey(signing.publicKey)],
    newKey,
    link,
    boundaryAt,
  };
};

const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("an uncertain Project epoch rotation", () => {
  test("recovers the new key once the served link proves the rotation committed", async () => {
    const run = await scenario();
    const key = await resolvePendingRotation({
      options: run.options,
      boundary: run.boundaryAt("2", [run.link.canonicalBytes]),
      encryptionPrivateKey: run.encryption.privateKey,
      trustedSigningKeys: run.trustedSigningKeys,
    });
    expect(key).toEqual(run.newKey);
    // The caller clears the record after storing the key.
    expect(await exists(pendingRotationPath(run.options, ids.project))).toBe(
      true,
    );
  });

  test("discards the key when the Project never reached the new epoch", async () => {
    const run = await scenario();
    expect(
      await resolvePendingRotation({
        options: run.options,
        boundary: run.boundaryAt("1", []),
        encryptionPrivateKey: run.encryption.privateKey,
        trustedSigningKeys: run.trustedSigningKeys,
      }),
    ).toBeNull();
    expect(await exists(pendingRotationPath(run.options, ids.project))).toBe(
      false,
    );
  });

  test("discards the key when another rotation reached the epoch", async () => {
    const run = await scenario();
    const other = await createProjectEpochKeyLink({
      serverProfileId: ids.serverProfileId,
      teamId: ids.team,
      projectId: ids.project,
      fromEpoch: 1,
      fromKey: crypto.getRandomValues(new Uint8Array(32)),
      toKey: crypto.getRandomValues(new Uint8Array(32)),
      signingDeviceId: ids.device,
      signingPrivateKey: (await generateSigningKeyPair()).privateKey,
    });
    expect(
      await resolvePendingRotation({
        options: run.options,
        boundary: run.boundaryAt("2", [other.canonicalBytes]),
        encryptionPrivateKey: run.encryption.privateKey,
        trustedSigningKeys: run.trustedSigningKeys,
      }),
    ).toBeNull();
    expect(await exists(pendingRotationPath(run.options, ids.project))).toBe(
      false,
    );
  });

  test("only this Device can open the kept key", async () => {
    const run = await scenario();
    const stranger = await generateEncryptionKeyPair();
    expect(
      await resolvePendingRotation({
        options: run.options,
        boundary: run.boundaryAt("2", [run.link.canonicalBytes]),
        encryptionPrivateKey: stranger.privateKey,
        trustedSigningKeys: run.trustedSigningKeys,
      }),
    ).toBeNull();
  });
});
