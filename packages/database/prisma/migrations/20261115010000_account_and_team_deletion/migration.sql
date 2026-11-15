-- Account deletion (ADR 0018) and Team deletion (ADR 0019).
ALTER TYPE "OperationKind" ADD VALUE 'ACCOUNT_DELETION' AFTER 'EPOCH_KEY_LINK';
ALTER TYPE "AuditEventKind" ADD VALUE 'TEAM_DELETED' AFTER 'INVITATION_DECLINED';
ALTER TYPE "AuditEventKind" ADD VALUE 'ACCOUNT_DELETED' AFTER 'TEAM_DELETED';

-- A deleted User keeps its row for history; its auth and GitHub subjects are
-- replaced by a tombstone so no sign-in maps to it again.
ALTER TABLE "users" ADD COLUMN "deletedAt" TIMESTAMPTZ(3);

-- A deleted Team is ARCHIVED with deletedAt set until retention purges it.
ALTER TABLE "teams" ADD COLUMN "deletedAt" TIMESTAMPTZ(3);
ALTER TABLE "teams"
  ADD CONSTRAINT "teams_deleted_lifecycle_check"
  CHECK ("deletedAt" IS NULL OR "lifecycle" = 'ARCHIVED');
CREATE INDEX "teams_deletedAt_idx" ON "teams"("deletedAt");

-- Append-only rows stay immutable, except inside a transaction that sets
-- dotrelay.purge: Team purge and Account deletion remove history that no
-- client can read any more.
CREATE OR REPLACE FUNCTION dotrelay_reject_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('dotrelay.purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'immutable DotRelay row: %.%', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Owner invariants apply to active Teams only; a deleted Team has none.
CREATE OR REPLACE FUNCTION dotrelay_enforce_last_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  team_uuid UUID;
  owner_count INTEGER;
BEGIN
  team_uuid := COALESCE(NEW."teamId", OLD."teamId");
  IF NOT EXISTS (
    SELECT 1 FROM "teams" WHERE "id" = team_uuid AND "lifecycle" = 'ACTIVE'
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT count(*) INTO owner_count
  FROM "memberships"
  WHERE "teamId" = team_uuid
    AND "lifecycle" = 'ACTIVE'
    AND "role" = 'OWNER'
    AND (TG_OP <> 'DELETE' OR "id" <> OLD."id");
  IF owner_count = 0 THEN
    RAISE EXCEPTION 'a Team must retain one active owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION dotrelay_enforce_team_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_count INTEGER;
BEGIN
  IF NEW."lifecycle" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO owner_count
  FROM "memberships"
  WHERE "teamId" = NEW."id"
    AND "lifecycle" = 'ACTIVE'
    AND "role" = 'OWNER';
  IF owner_count = 0 THEN
    RAISE EXCEPTION 'a Team must have an active owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
