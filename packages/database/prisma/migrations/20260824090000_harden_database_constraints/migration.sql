CREATE INDEX "auth_sessions_expiresAt_idx"
  ON "auth_sessions" ("expiresAt");
CREATE INDEX "auth_verifications_expiresAt_idx"
  ON "auth_verifications" ("expiresAt");
CREATE INDEX "auth_device_codes_expiresAt_idx"
  ON "auth_device_codes" ("expiresAt");
CREATE INDEX "auth_device_codes_userId_idx"
  ON "auth_device_codes" ("userId");

ALTER TABLE "auth_device_codes"
  ADD CONSTRAINT "auth_device_codes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "auth_users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION dotrelay_enforce_last_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  team_uuid UUID;
  owner_count INTEGER;
BEGIN
  team_uuid := COALESCE(NEW."teamId", OLD."teamId");
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

CREATE OR REPLACE FUNCTION dotrelay_validate_revision_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  environment_uuid UUID;
BEGIN
  SELECT "id" INTO environment_uuid
  FROM "environments"
  WHERE "currentHeadId" = NEW."id";
  IF environment_uuid IS NOT NULL AND environment_uuid <> NEW."environmentId" THEN
    RAISE EXCEPTION 'Environment current head must belong to the Revision Environment'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
