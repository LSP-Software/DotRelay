ALTER TABLE "membership_invitations"
  ADD CONSTRAINT "membership_invitations_seven_day_expiry_check"
  CHECK ("expiresAt" = "createdAt" + interval '7 days') NOT VALID;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_github_repository_id_positive_check"
  CHECK ("githubRepositoryId" > 0) NOT VALID;

CREATE OR REPLACE FUNCTION dotrelay_reject_project_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."teamId" IS DISTINCT FROM OLD."teamId"
     OR NEW."githubRepositoryId" IS DISTINCT FROM OLD."githubRepositoryId" THEN
    RAISE EXCEPTION 'Project Team and GitHub Repository identities are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_identity_immutable
BEFORE UPDATE OF "teamId", "githubRepositoryId" ON "projects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_project_identity_change();
