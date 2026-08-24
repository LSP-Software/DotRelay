import type { PrismaClient } from "./generated/prisma/client";

export type EnsureServerProfileInput = Readonly<{
  readonly id: string;
  readonly origin: string;
  readonly allowRebind: boolean;
}>;

export const ensureServerProfile = async (
  database: PrismaClient,
  input: EnsureServerProfileInput,
): Promise<void> => {
  const existing = await database.serverProfile.findUnique({
    where: { id: input.id },
  });
  if (existing) {
    if (existing.origin !== input.origin && !input.allowRebind) {
      throw new Error(
        "SERVER_PROFILE_ORIGIN differs from the persisted profile; set SERVER_PROFILE_REBIND=true for an explicit rebind",
      );
    }
    if (existing.origin !== input.origin && input.allowRebind) {
      await database.serverProfile.update({
        where: { id: input.id },
        data: { origin: input.origin },
      });
    }
    return;
  }
  await database.serverProfile.create({
    data: { id: input.id, origin: input.origin },
  });
};
