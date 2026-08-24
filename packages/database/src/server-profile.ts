import type { PrismaClient } from "./generated/prisma/client";

const isUniqueConstraintError = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "P2002";

export type EnsureServerProfileInput = Readonly<{
  readonly id: string;
  readonly origin: string;
  readonly allowRebind: boolean;
}>;

export const ensureServerProfile = async (
  database: PrismaClient,
  input: EnsureServerProfileInput,
): Promise<void> => {
  const validateExisting = async (existing: { origin: string }) => {
    if (existing.origin !== input.origin && !input.allowRebind) {
      throw new Error(
        "SERVER_PROFILE_ORIGIN differs from the persisted profile; set SERVER_PROFILE_REBIND=true for an explicit rebind",
      );
    }
    if (existing.origin !== input.origin && input.allowRebind) {
      try {
        await database.serverProfile.update({
          where: { id: input.id },
          data: { origin: input.origin },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        throw new Error(
          "SERVER_PROFILE_ORIGIN is already assigned to another server profile",
          { cause: error },
        );
      }
    }
  };

  const existing = await database.serverProfile.findUnique({
    where: { id: input.id },
  });
  if (existing) {
    await validateExisting(existing);
    return;
  }
  try {
    await database.serverProfile.create({
      data: { id: input.id, origin: input.origin },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await database.serverProfile.findUnique({
      where: { id: input.id },
    });
    if (concurrent) {
      await validateExisting(concurrent);
      return;
    }
    throw new Error(
      "SERVER_PROFILE_ORIGIN is already assigned to another server profile",
      { cause: error },
    );
  }
};
