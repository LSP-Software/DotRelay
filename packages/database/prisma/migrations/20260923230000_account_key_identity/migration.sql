-- Diagnose duplicate active account-key envelopes, then enforce one active
-- Project Epoch Key per (user, project, epoch) and one active User Value Key
-- per (user, owner, generation). This migration reports protocol object ids
-- and stops. It does not delete, merge, or rewrite existing rows.
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(format('%s [%s]', identity, ids), E'\n' ORDER BY identity)
  INTO duplicates
  FROM (
    SELECT
      format(
        'PROJECT_EPOCH_KEY user=%s project=%s epoch=%s',
        "userId",
        "projectId",
        "projectEpoch"
      ) AS identity,
      string_agg("protocolObjectId"::text, ', ' ORDER BY "createdAt") AS ids
    FROM "account_key_envelope_objects"
    WHERE "retiredAt" IS NULL AND "envelopeType" = 'PROJECT_EPOCH_KEY'
    GROUP BY "userId", "projectId", "projectEpoch"
    HAVING count(*) > 1
    UNION ALL
    SELECT
      format(
        'USER_VALUE_KEY user=%s owner=%s generation=%s',
        "userId",
        "ownerUserId",
        "valueGeneration"
      ),
      string_agg("protocolObjectId"::text, ', ' ORDER BY "createdAt")
    FROM "account_key_envelope_objects"
    WHERE "retiredAt" IS NULL AND "envelopeType" = 'USER_VALUE_KEY'
    GROUP BY "userId", "ownerUserId", "valueGeneration"
    HAVING count(*) > 1
  ) found;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION
      'duplicate active account key envelopes must be resolved before the unique index is created: %',
      duplicates
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

-- Prisma cannot express a filtered unique index, so these are SQL-only,
-- matching account_key_wrapper_objects_userId_wrapperId_active_key.
CREATE UNIQUE INDEX "account_key_envelope_objects_active_project_epoch_key"
  ON "account_key_envelope_objects"("userId", "projectId", "projectEpoch")
  WHERE "retiredAt" IS NULL AND "envelopeType" = 'PROJECT_EPOCH_KEY';

CREATE UNIQUE INDEX "account_key_envelope_objects_active_user_value_key"
  ON "account_key_envelope_objects"("userId", "ownerUserId", "valueGeneration")
  WHERE "retiredAt" IS NULL AND "envelopeType" = 'USER_VALUE_KEY';

-- Appended so the enum order matches Prisma. DELIVERED is not consumption:
-- the recipient can retry until acknowledgement or expiry.
ALTER TYPE "TransferStatus" ADD VALUE 'DELIVERED';
