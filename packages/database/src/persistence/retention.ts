import {
  type ExpiryBatchOptions,
  inShortTransaction,
  runExpiryBatches,
  type TransactionDatabase,
} from "./transaction";

/**
 * Batched deletion of short-lived rows that no history depends on, mirroring
 * StagedObjectRepository.expire: one short transaction per batch, rows
 * locked with SKIP LOCKED so concurrent requests are never blocked.
 *
 * Deliberately out of scope: Operations (their ids are idempotency guards,
 * and append-only Audit Facts reference them), PENDING Device rows (their
 * enrollment Operation and Audit Fact reference them), protocol objects,
 * Revisions, Memberships, and Membership periods, which history and
 * signature verification need.
 */
export class RetentionRepository {
  /**
   * Better Auth sessions past their sliding expiry, or older than the
   * absolute session lifetime when one is given.
   */
  async expireAuthSessions(
    database: TransactionDatabase,
    now: Date,
    options?: ExpiryBatchOptions & {
      readonly maxSessionAgeMs?: number;
    },
  ) {
    const createdBefore =
      options?.maxSessionAgeMs === undefined
        ? null
        : new Date(now.getTime() - options.maxSessionAgeMs);
    const count = await runExpiryBatches(async (batchSize) => {
      const deleted = await inShortTransaction(
        database,
        (transaction) => transaction.$executeRaw`
          DELETE FROM "auth_sessions"
          WHERE "id" IN (
            SELECT "id" FROM "auth_sessions"
            WHERE "expiresAt" <= ${now}
              OR (${createdBefore}::timestamptz IS NOT NULL
                AND "createdAt" <= ${createdBefore}::timestamptz)
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          )`,
      );
      return { scanned: deleted, affected: deleted };
    }, options);
    return { count };
  }

  async expireAuthDeviceCodes(
    database: TransactionDatabase,
    now: Date,
    options?: ExpiryBatchOptions,
  ) {
    const count = await runExpiryBatches(async (batchSize) => {
      const deleted = await inShortTransaction(
        database,
        (transaction) => transaction.$executeRaw`
          DELETE FROM "auth_device_codes"
          WHERE "id" IN (
            SELECT "id" FROM "auth_device_codes"
            WHERE "expiresAt" <= ${now}
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          )`,
      );
      return { scanned: deleted, affected: deleted };
    }, options);
    return { count };
  }

  async expireAuthVerifications(
    database: TransactionDatabase,
    now: Date,
    options?: ExpiryBatchOptions,
  ) {
    const count = await runExpiryBatches(async (batchSize) => {
      const deleted = await inShortTransaction(
        database,
        (transaction) => transaction.$executeRaw`
          DELETE FROM "auth_verifications"
          WHERE "id" IN (
            SELECT "id" FROM "auth_verifications"
            WHERE "expiresAt" <= ${now}
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          )`,
      );
      return { scanned: deleted, affected: deleted };
    }, options);
    return { count };
  }

  /**
   * Expired enrollments nobody approved. An approved or completed enrollment
   * is history (its approval and enrollment objects are append-only and
   * reference it), so it stays.
   */
  async expireDeviceEnrollments(
    database: TransactionDatabase,
    now: Date,
    options?: ExpiryBatchOptions,
  ) {
    const count = await runExpiryBatches(async (batchSize) => {
      const deleted = await inShortTransaction(
        database,
        (transaction) => transaction.$executeRaw`
          DELETE FROM "device_enrollments"
          WHERE "id" IN (
            SELECT enrollment."id" FROM "device_enrollments" enrollment
            WHERE enrollment."expiresAt" <= ${now}
              AND enrollment."completedAt" IS NULL
              AND enrollment."approverDeviceId" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM "enrollment_objects" object
                WHERE object."enrollmentId" = enrollment."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "enrollment_approval_objects" approval
                WHERE approval."enrollmentId" = enrollment."id"
              )
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          )`,
      );
      return { scanned: deleted, affected: deleted };
    }, options);
    return { count };
  }

  /**
   * Unaccepted invitations past their expiry, including revoked and declined
   * ones. An accepted invitation is referenced by its Membership and stays.
   */
  async expireInvitations(
    database: TransactionDatabase,
    now: Date,
    options?: ExpiryBatchOptions,
  ) {
    const count = await runExpiryBatches(async (batchSize) => {
      const deleted = await inShortTransaction(
        database,
        (transaction) => transaction.$executeRaw`
          DELETE FROM "membership_invitations"
          WHERE "id" IN (
            SELECT invitation."id" FROM "membership_invitations" invitation
            WHERE invitation."expiresAt" <= ${now}
              AND invitation."acceptedAt" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM "memberships" membership
                WHERE membership."invitationId" = invitation."id"
              )
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          )`,
      );
      return { scanned: deleted, affected: deleted };
    }, options);
    return { count };
  }
}
