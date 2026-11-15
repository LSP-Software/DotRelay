-- Device revocation is terminal (ADR 0021). Clients judge every Revision a
-- Device signed by its activation and revocation times, so those are written
-- once, a revoked Device never changes lifecycle again, and a Device's owner
-- and keys never change. Display metadata (ADR 0012) stays writable.
CREATE OR REPLACE FUNCTION dotrelay_enforce_device_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."lifecycle" = 'REVOKED' AND NEW."lifecycle" <> 'REVOKED' THEN
    RAISE EXCEPTION 'a revoked Device cannot change lifecycle'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."lifecycle" <> 'PENDING' AND NEW."lifecycle" = 'PENDING' THEN
    RAISE EXCEPTION 'a Device cannot return to PENDING'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."activatedAt" IS NOT NULL
     AND NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" THEN
    RAISE EXCEPTION 'a Device activation time is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL
     AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'a Device revocation time is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."lifecycle" = 'REVOKED' AND NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" THEN
    RAISE EXCEPTION 'a revoked Device activation time is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."identityGeneration" IS DISTINCT FROM OLD."identityGeneration"
     OR NEW."keyId" IS DISTINCT FROM OLD."keyId"
     OR NEW."x25519PublicKey" IS DISTINCT FROM OLD."x25519PublicKey"
     OR NEW."ed25519PublicKey" IS DISTINCT FROM OLD."ed25519PublicKey" THEN
    RAISE EXCEPTION 'a Device owner and keys are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER devices_lifecycle_guard
BEFORE UPDATE ON "devices"
FOR EACH ROW EXECUTE FUNCTION dotrelay_enforce_device_lifecycle();
