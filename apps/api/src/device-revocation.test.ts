import { expect, test } from "bun:test";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const signCommand = async (
  key: CryptoKey,
  targetId: string,
  operationId: string,
): Promise<string> =>
  toBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        new TextEncoder().encode(
          JSON.stringify({
            action: "device.revoke",
            deviceId: targetId,
            operationId,
          }),
        ),
      ),
    ),
  );

const fixture = async () => {
  const profile = loadServerProfileConfig({});
  const actor = crypto.randomUUID();
  const actorDevice = crypto.randomUUID();
  const target = {
    id: crypto.randomUUID(),
    userId: actor,
    lifecycle: "ACTIVE" as "ACTIVE" | "REVOKED",
  };
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const actorDeviceKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const sessions = new Set(["current-token", "copied-token"]);
  const operations = new Map<string, Record<string, unknown>>();
  const deletedUsers: string[] = [];
  const actorState: { lifecycle: "ACTIVE" | "REVOKED" } = {
    lifecycle: "ACTIVE",
  };
  const transaction = {
    $executeRaw: async () => 0,
    user: {
      upsert: async () => ({ id: actor }),
      findUniqueOrThrow: async () => ({ authSubject: "auth-user" }),
    },
    authAccount: { findFirst: async () => ({ accountId: "1001" }) },
    authSession: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        deletedUsers.push(where.userId);
        sessions.clear();
        return { count: 2 };
      },
    },
    authDeviceCode: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        expect(where.userId).toBe("auth-user");
        return { count: 1 };
      },
    },
    device: {
      // Honor the where clause so the lifecycle filter (and actor id/user)
      // actually decide which row — and thus which public key — verifies the
      // signature.
      findFirst: async ({
        where,
      }: {
        where: {
          id?: string;
          userId?: string;
          lifecycle?: "ACTIVE" | "REVOKED";
        };
      }) => {
        if (
          where.id !== actorDevice ||
          where.userId !== actor ||
          (where.lifecycle !== undefined &&
            where.lifecycle !== actorState.lifecycle)
        )
          return null;
        return {
          id: actorDevice,
          userId: actor,
          lifecycle: actorState.lifecycle,
          ed25519PublicKey: actorDeviceKey,
        };
      },
      findUnique: async () => ({ ...target }),
      update: async () => {
        target.lifecycle = "REVOKED";
        return { ...target };
      },
    },
    operation: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        // Mirrors skipDuplicates: replayed operation ids keep their
        // committed outcome.
        for (const entry of data)
          if (!operations.has(String(entry.id)))
            operations.set(String(entry.id), { ...entry, status: "STAGED" });
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        operations.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => Object.assign(operations.get(where.id) ?? {}, data),
    },
    auditEvent: { create: async () => ({}) },
  };
  const database = {
    ...transaction,
    $transaction: async (
      callback: (tx: typeof transaction) => Promise<unknown>,
    ) => callback(transaction),
  };
  const app = createApi({
    profile,
    database: database as never,
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          sessions.has(
            headers.get("Authorization")?.replace("Bearer ", "") ?? "",
          )
            ? { user: { id: "auth-user" } }
            : null,
      },
    } as never,
  });
  const revoke = (
    operationId = crypto.randomUUID(),
    signingKey: CryptoKey = keyPair.privateKey,
    token = "current-token",
  ) =>
    signCommand(signingKey, target.id, operationId).then((signature) =>
      app.request(`${profile.origin}/api/v1/devices/${target.id}/revoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-DotRelay-Device-Id": actorDevice,
          "Idempotency-Key": operationId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ signature }),
      }),
    );
  return {
    profile,
    app,
    target,
    sessions,
    operations,
    deletedUsers,
    keyPair,
    actorState,
    revoke,
  };
};

test("revocation invalidates copied sessions before they can bootstrap replacements", async () => {
  const setup = await fixture();
  expect((await setup.revoke()).status).toBe(200);
  expect(setup.target.lifecycle).toBe("REVOKED");
  expect(setup.deletedUsers).toEqual(["auth-user"]);
  expect(setup.sessions.size).toBe(0);
  const response = await setup.app.request(
    `${setup.profile.origin}/api/v1/devices/bootstrap`,
    {
      method: "POST",
      headers: { Authorization: "Bearer copied-token" },
    },
  );
  expect(response.status).toBe(401);
});

test("a User cannot revoke another User's Device or sessions", async () => {
  const setup = await fixture();
  setup.target.userId = crypto.randomUUID();
  expect((await setup.revoke()).status).toBe(404);
  expect(setup.target.lifecycle).toBe("ACTIVE");
  expect(setup.sessions.size).toBe(2);
  expect(setup.deletedUsers).toHaveLength(0);
  expect(setup.operations.size).toBe(0);
});

test("a copied session cannot revoke without the actor Device's signing key", async () => {
  const setup = await fixture();
  const impostor = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign"],
  )) as unknown as CryptoKeyPair;
  expect(
    (await setup.revoke(crypto.randomUUID(), impostor.privateKey)).status,
  ).toBe(400);
  expect(setup.target.lifecycle).toBe("ACTIVE");
  expect(setup.sessions.size).toBe(2);
  expect(setup.deletedUsers).toHaveLength(0);
  expect(setup.operations.size).toBe(0);
});

test("replaying the original operation id does not sign the User out again", async () => {
  const setup = await fixture();
  const operationId = crypto.randomUUID();
  expect((await setup.revoke(operationId)).status).toBe(200);
  // The User signs back in on a trusted Device.
  setup.sessions.add("trusted-token");
  expect(
    (await setup.revoke(operationId, undefined, "trusted-token")).status,
  ).toBe(200);
  expect(setup.target.lifecycle).toBe("REVOKED");
  expect(setup.sessions.size).toBe(1);
  expect(setup.deletedUsers).toEqual(["auth-user"]);
});

test("a retry under a new operation id is refused once the Device is revoked", async () => {
  const setup = await fixture();
  expect((await setup.revoke()).status).toBe(200);
  setup.sessions.add("trusted-token");
  expect(
    (await setup.revoke(undefined, undefined, "trusted-token")).status,
  ).toBe(403);
  expect(setup.target.lifecycle).toBe("REVOKED");
  expect(setup.sessions.size).toBe(1);
});

test("a revoked actor Device cannot revoke even with a valid signature", async () => {
  const setup = await fixture();
  // The actor Device the session claims is no longer active, so the
  // lifecycle filter in the actor lookup must refuse it even though the
  // signature is valid for that Device's stored key.
  setup.actorState.lifecycle = "REVOKED";
  expect((await setup.revoke()).status).toBe(403);
  expect(setup.target.lifecycle).toBe("ACTIVE");
  expect(setup.sessions.size).toBe(2);
  expect(setup.deletedUsers).toHaveLength(0);
  expect(setup.operations.size).toBe(0);
});
