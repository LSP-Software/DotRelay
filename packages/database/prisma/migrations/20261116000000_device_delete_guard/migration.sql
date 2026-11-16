-- Device revocation is terminal for every writer (ADR 0021), and so is the
-- Device row itself. Deleting one would let a later insert recreate its id
-- with any keys, lifecycle and times, so the windows clients judge its
-- Revisions by would no longer be the ones written once. No code path
-- deletes a Device; account deletion keeps every Device row (ADR 0018).
CREATE OR REPLACE FUNCTION dotrelay_reject_device_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'a Device row is never deleted'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER devices_delete_guard
BEFORE DELETE ON "devices"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_device_delete();
