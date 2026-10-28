import { expect, test } from "bun:test";
import { createMembershipProvisioning } from "@dotrelay/client";
import {
  canonicalEncode,
  encodeProtocolObject,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  protocolObjectFromFields,
  signProtocolObject,
} from "@dotrelay/contracts";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const fixture = async () => {
  const profile = loadServerProfileConfig({});
  const owner = crypto.randomUUID();
  const invitee = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const signing = await generateSigningKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const member = {
    id: crypto.randomUUID(),
    userId: invitee,
    teamId: crypto.randomUUID(),
    role: "MEMBER",
    lifecycle: "PENDING_KEY_GRANT",
  };
  const plan = {
    teamId: member.teamId,
    membershipId: member.id,
    userId: invitee,
    role: "MEMBER" as const,
    projects: [
      { id: crypto.randomUUID(), epoch: 1, environmentId: crypto.randomUUID() },
    ],
    devices: [
      {
        id: crypto.randomUUID(),
        encryptionPublicKey: Buffer.from(
          await crypto.subtle.exportKey("raw", encryption.publicKey),
        ).toString("hex"),
      },
    ],
  };
  const operations = new Map<string, Record<string, unknown>>();
  const staged = new Map<string, Record<string, unknown>>();
  const grants: Record<string, unknown>[] = [];
  const objects: Record<string, unknown>[] = [];
  let role = "OWNER";
  const transaction = {
    $executeRaw: async () => 0,
    $queryRaw: async (parts: TemplateStringsArray) =>
      parts.join("").includes("COUNT(*)") ? [{ count: 0n, bytes: 0n }] : [],
    user: { upsert: async () => ({ id: owner }) },
    authAccount: { findFirst: async () => ({ accountId: "1001" }) },
    team: {
      findFirst: async () => ({ id: member.teamId, lifecycle: "ACTIVE" }),
    },
    membership: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.userId === owner ? { role, lifecycle: "ACTIVE" } : { ...member },
      findUnique: async () => ({ ...member }),
      update: async ({ data }: { data: { lifecycle: string } }) => {
        member.lifecycle = data.lifecycle;
        return { ...member };
      },
    },
    project: {
      findMany: async () =>
        plan.projects.map((project) => ({
          id: project.id,
          currentEpoch: BigInt(project.epoch),
          environments: [{ id: project.environmentId }],
        })),
      findUnique: async () => ({
        id: plan.projects[0]?.id,
        teamId: member.teamId,
        lifecycle: "ACTIVE",
        currentEpoch: 1n,
      }),
    },
    device: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        userId: where.id === deviceId ? owner : invitee,
        lifecycle: "ACTIVE",
        ed25519PublicKey: new Uint8Array(
          await crypto.subtle.exportKey("raw", signing.publicKey),
        ),
      }),
      findMany: async () =>
        plan.devices.map((device) => ({
          id: device.id,
          x25519PublicKey: Uint8Array.from(
            Buffer.from(device.encryptionPublicKey, "hex"),
          ),
        })),
    },
    operation: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        operations.get(where.id) ?? null,
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const entry of data)
          if (!operations.has(String(entry.id)))
            operations.set(String(entry.id), { ...entry, status: "STAGED" });
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const entry = operations.get(where.id);
        if (!entry) throw new Error("missing operation");
        Object.assign(entry, data);
        return entry;
      },
    },
    stagedObject: {
      findUnique: async ({
        where,
      }: {
        where: {
          operationId_objectId: { operationId: string; objectId: string };
        };
      }) => {
        const value = where.operationId_objectId;
        return staged.get(`${value.operationId}/${value.objectId}`) ?? null;
      },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const entry of data)
          staged.set(`${entry.operationId}/${entry.objectId}`, {
            committedAt: null,
            ...entry,
          });
      },
      update: async ({
        where,
        data,
      }: {
        where: {
          operationId_objectId: { operationId: string; objectId: string };
        };
        data: Record<string, unknown>;
      }) => {
        const value = where.operationId_objectId;
        const entry = staged.get(`${value.operationId}/${value.objectId}`);
        if (!entry) throw new Error("missing stage");
        Object.assign(entry, data);
        return entry;
      },
    },
    protocolObject: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        objects.push(data);
        return data;
      },
    },
    grantObject: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        grants.push(data);
        return data;
      },
      count: async () => grants.length,
    },
    membershipActivationObject: { create: async () => ({}) },
    auditEvent: { create: async () => ({}) },
  };
  const database = {
    ...transaction,
    $transaction: async (
      callback: (tx: typeof transaction) => Promise<unknown>,
    ) => {
      const previous = {
        operations: structuredClone(operations),
        staged: structuredClone(staged),
        grants: grants.length,
        objects: objects.length,
        lifecycle: member.lifecycle,
      };
      try {
        return await callback(transaction);
      } catch (error) {
        operations.clear();
        staged.clear();
        for (const [key, entry] of previous.operations)
          operations.set(key, entry);
        for (const [key, entry] of previous.staged) staged.set(key, entry);
        grants.splice(previous.grants);
        objects.splice(previous.objects);
        member.lifecycle = previous.lifecycle;
        throw error;
      }
    },
  };
  const app = createApi({
    profile,
    database: database as never,
    auth: {
      api: { getSession: async () => ({ user: { id: "auth-owner" } }) },
    } as never,
  });
  const key = crypto.getRandomValues(new Uint8Array(32));
  const request = await createMembershipProvisioning({
    serverProfileId: profile.id,
    deviceId,
    signingPrivateKey: signing.privateKey,
    plan,
    projectKeys: new Map([[plan.projects[0]?.id ?? "", key]]),
  });
  const send = (body: unknown = request) =>
    app.request(
      `${profile.origin}/api/v1/teams/${member.teamId}/memberships/${member.id}/provision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DotRelay-Device-Id": deviceId,
          "Idempotency-Key": request.operationId,
        },
        body: JSON.stringify(body),
      },
    );
  return {
    app,
    profile,
    request,
    member,
    plan,
    operations,
    grants,
    objects,
    signing,
    send,
    setRole: (next: string) => {
      role = next;
    },
  };
};

test("provisioning commits grants and activation together and retries the same operation", async () => {
  const setup = await fixture();
  const response = await setup.send();
  expect(await response.clone().text()).toContain("ACTIVE");
  expect(response.status).toBe(200);
  expect(setup.member.lifecycle).toBe("ACTIVE");
  expect(setup.grants).toHaveLength(1);
  expect(setup.objects).toHaveLength(2);
  expect((await setup.send()).status).toBe(200);
  expect(setup.grants).toHaveLength(1);
});

test("missing grants and swapped ciphertext never activate or partially persist", async () => {
  for (const mutation of ["missing", "swapped"] as const) {
    const setup = await fixture();
    const request = structuredClone(setup.request);
    if (mutation === "missing") request.grants = [];
    else if (request.grants[0])
      request.grants[0].object = request.activation.object;
    expect((await setup.send(request)).status).toBeGreaterThanOrEqual(400);
    expect(setup.member.lifecycle).toBe("PENDING_KEY_GRANT");
    expect(setup.grants).toHaveLength(0);
    expect(setup.objects).toHaveLength(0);
    expect(setup.operations.size).toBe(0);
  }
});

test("plain members cannot provision access", async () => {
  const setup = await fixture();
  setup.setRole("MEMBER");
  expect((await setup.send()).status).toBe(403);
  expect(setup.member.lifecycle).toBe("PENDING_KEY_GRANT");
  expect(setup.operations.size).toBe(0);
});

test("signed activation references are checked after grant creation and failure rolls everything back", async () => {
  const setup = await fixture();
  const request = structuredClone(setup.request);
  const object = parseProtocolObject(
    Uint8Array.from(Buffer.from(request.activation.object, "base64")),
  );
  const fields = new Map([...object.entries()].filter(([field]) => field > 5));
  fields.set(56, []);
  fields.set(3, canonicalEncode(protocolObjectFromFields(6, fields)));
  fields.set(4, new Uint8Array(64));
  fields.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(6, fields),
      setup.signing.privateKey,
    ),
  );
  request.activation.object = Buffer.from(
    encodeProtocolObject(protocolObjectFromFields(6, fields)),
  ).toString("base64");
  expect((await setup.send(request)).status).toBe(400);
  expect(setup.member.lifecycle).toBe("PENDING_KEY_GRANT");
  expect(setup.grants).toHaveLength(0);
  expect(setup.objects).toHaveLength(0);
  expect(setup.operations.size).toBe(0);
});

test("active Members can receive new Project or Device grants without another activation record", async () => {
  const setup = await fixture();
  setup.member.lifecycle = "ACTIVE";
  expect((await setup.send()).status).toBe(200);
  expect(setup.member.lifecycle).toBe("ACTIVE");
  expect(setup.grants).toHaveLength(1);
});
