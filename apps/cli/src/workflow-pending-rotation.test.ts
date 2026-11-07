import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
  assertNoPendingRotation,
  clearPendingRotation,
  PendingRotationExistsError,
  pendingRotationPath,
  RotationOutcomeUnknownError,
  resolvePendingRotation,
  submitRotation,
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
    const recovered = await resolvePendingRotation({
      options: run.options,
      boundary: run.boundaryAt("2", [run.link.canonicalBytes]),
      encryptionPrivateKey: run.encryption.privateKey,
      trustedSigningKeys: run.trustedSigningKeys,
      cancel: async () => true,
    });
    expect(recovered?.key).toEqual(run.newKey);
    // The caller clears the record after storing the key.
    expect(await exists(pendingRotationPath(run.options, ids.project))).toBe(
      true,
    );
  });

  test("keeps the key while the Project is behind and the operation cannot be cancelled", async () => {
    // The original request may still be in flight: the boundary was read
    // before it committed, so only a successful cancel may discard the key.
    const run = await scenario();
    const cancelled: string[] = [];
    expect(
      await resolvePendingRotation({
        options: run.options,
        boundary: run.boundaryAt("1", []),
        encryptionPrivateKey: run.encryption.privateKey,
        trustedSigningKeys: run.trustedSigningKeys,
        cancel: async (operationId) => {
          cancelled.push(operationId);
          return false;
        },
      }),
    ).toBeNull();
    expect(cancelled).toHaveLength(1);
    expect(await exists(pendingRotationPath(run.options, ids.project))).toBe(
      true,
    );
    // While the outcome is open, another rotation is refused and the
    // record stays byte-for-byte intact.
    const path = pendingRotationPath(run.options, ids.project);
    const before = await readFile(path, "utf8");
    await expect(
      assertNoPendingRotation(run.options, ids.project),
    ).rejects.toMatchObject({ code: "epoch_rotation_uncertain" });
    expect(await readFile(path, "utf8")).toBe(before);
    // Once it commits, the next session recovers the key.
    expect(
      (
        await resolvePendingRotation({
          options: run.options,
          boundary: run.boundaryAt("2", [run.link.canonicalBytes]),
          encryptionPrivateKey: run.encryption.privateKey,
          trustedSigningKeys: run.trustedSigningKeys,
          cancel: async () => false,
        })
      )?.key,
    ).toEqual(run.newKey);
  });

  test("a rotation may start once no earlier outcome is open", async () => {
    const run = await scenario();
    await rm(pendingRotationPath(run.options, ids.project));
    await assertNoPendingRotation(run.options, ids.project);
  });

  test("discards the key when the Project never reached the new epoch", async () => {
    const run = await scenario();
    expect(
      await resolvePendingRotation({
        options: run.options,
        boundary: run.boundaryAt("1", []),
        encryptionPrivateKey: run.encryption.privateKey,
        trustedSigningKeys: run.trustedSigningKeys,
        cancel: async () => true,
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
        cancel: async () => true,
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
        cancel: async () => true,
      }),
    ).toBeNull();
  });
});

describe("concurrent rotations of one Project", () => {
  test("the second rotation cannot reserve or discard the first one's key", async () => {
    // Both processes passed the guard; the first reserved the record.
    const run = await scenario();
    const path = pendingRotationPath(run.options, ids.project);
    const reserved = await readFile(path, "utf8");
    const second = crypto.randomUUID();
    await expect(
      writePendingRotation(run.options, {
        operationId: second,
        projectId: ids.project,
        newEpoch: 2,
        newEpochKey: crypto.getRandomValues(new Uint8Array(32)),
        encryptionPublicKey: run.encryption.publicKey,
      }),
    ).rejects.toBeInstanceOf(PendingRotationExistsError);
    // The second process fails and cleans up only its own operation.
    await clearPendingRotation(run.options, ids.project, second);
    expect(await readFile(path, "utf8")).toBe(reserved);
    // The first rotation's key is still recoverable once it commits.
    expect(
      (
        await resolvePendingRotation({
          options: run.options,
          boundary: run.boundaryAt("2", [run.link.canonicalBytes]),
          encryptionPrivateKey: run.encryption.privateKey,
          trustedSigningKeys: run.trustedSigningKeys,
          cancel: async () => false,
        })
      )?.key,
    ).toEqual(run.newKey);
  });
});

describe("submitting an epoch rotation", () => {
  const rateLimited = Object.assign(new Error("rate limited"), {
    status: 429,
  });

  test("a lost commit followed by a 429 keeps the key when cancel fails", async () => {
    let discarded = false;
    let attempts = 0;
    await expect(
      submitRotation({
        attempt: async () => {
          attempts += 1;
          // First: committed, but the answer was lost. Then: rate limited
          // before the service's idempotency check.
          throw attempts === 1 ? new TypeError("network") : rateLimited;
        },
        // The committed operation cannot be cancelled.
        cancel: async () => false,
        discardPending: async () => {
          discarded = true;
        },
      }),
    ).rejects.toBeInstanceOf(RotationOutcomeUnknownError);
    expect(attempts).toBe(2);
    expect(discarded).toBe(false);
  });

  test("discards the key only after a successful cancel", async () => {
    let discarded = false;
    const rejection = new Error("stale epoch");
    await expect(
      submitRotation({
        attempt: async () => {
          throw rejection;
        },
        cancel: async () => true,
        discardPending: async () => {
          discarded = true;
        },
      }),
    ).rejects.toBe(rejection);
    expect(discarded).toBe(true);
  });

  test("a replay that returns the committed outcome succeeds", async () => {
    let attempts = 0;
    expect(
      await submitRotation({
        attempt: async () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError("network");
          return { projectEpoch: "2", idempotent: true };
        },
        cancel: async () => {
          throw new Error("must not cancel");
        },
        discardPending: async () => {
          throw new Error("must not discard");
        },
      }),
    ).toEqual({ projectEpoch: "2", idempotent: true });
  });
});
