-- Finished active periods of a Membership (ADR 0017). A removed Membership
-- that is invited back keeps its row; its previous period moves here so
-- Revisions signed during it stay verifiable.
CREATE TABLE "membership_periods" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "activatedAt" TIMESTAMPTZ(3) NOT NULL,
    "removedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "membership_periods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "membership_periods_window_check"
      CHECK ("removedAt" >= "activatedAt")
);

CREATE UNIQUE INDEX "membership_periods_membershipId_activatedAt_key" ON "membership_periods"("membershipId", "activatedAt");

ALTER TABLE "membership_periods" ADD CONSTRAINT "membership_periods_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER membership_periods_append_only
BEFORE UPDATE OR DELETE ON "membership_periods"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();

-- Backfill periods already lost to a revival. Every acceptance of a REMOVED
-- Membership closed the period ended by the removal before it, when that
-- removal ended an ACTIVE Membership. The period began at the last
-- activation from PENDING_KEY_GRANT before the removal, or at the
-- Membership's creation for a Team's founding owner. Audit receipt times
-- stand in for the overwritten row timestamps.
INSERT INTO "membership_periods" ("id", "membershipId", "activatedAt", "removedAt")
SELECT gen_random_uuid(), periods."membershipId", periods."activatedAt", periods."removedAt"
FROM (
  SELECT
    membership."id" AS "membershipId",
    COALESCE(
      (
        SELECT max(activation."receiptAt")
        FROM "audit_events" activation
        WHERE activation."entityKind" = 'MEMBERSHIP'
          AND activation."entityId" = membership."id"
          AND activation."kind" = 'MEMBERSHIP_ACTIVATED'
          AND activation."priorLifecycle" = 'PENDING_KEY_GRANT'
          AND activation."receiptAt" <= removal."receiptAt"
      ),
      membership."createdAt"
    ) AS "activatedAt",
    removal."receiptAt" AS "removedAt"
  FROM "audit_events" acceptance
  JOIN "memberships" membership ON membership."id" = acceptance."entityId"
  JOIN LATERAL (
    SELECT candidate."receiptAt", candidate."priorLifecycle"
    FROM "audit_events" candidate
    WHERE candidate."entityKind" = 'MEMBERSHIP'
      AND candidate."entityId" = membership."id"
      AND candidate."kind" = 'MEMBERSHIP_REMOVED'
      AND candidate."receiptAt" <= acceptance."receiptAt"
    ORDER BY candidate."receiptAt" DESC, candidate."id" DESC
    LIMIT 1
  ) removal ON removal."priorLifecycle" = 'ACTIVE'
  WHERE acceptance."entityKind" = 'MEMBERSHIP'
    AND acceptance."kind" = 'MEMBERSHIP_ACCEPTED'
    AND acceptance."priorLifecycle" = 'REMOVED'
) periods
WHERE periods."activatedAt" <= periods."removedAt"
ON CONFLICT ("membershipId", "activatedAt") DO NOTHING;
