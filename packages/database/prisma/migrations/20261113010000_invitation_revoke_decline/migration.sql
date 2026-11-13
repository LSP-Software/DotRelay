-- Membership Invitations can be revoked by an owner or admin, or declined by
-- the addressed User. Either ends the invitation; neither combines with
-- acceptance.
ALTER TYPE "AuditEventKind" ADD VALUE 'INVITATION_REVOKED' AFTER 'OPERATION_EXPIRED';
ALTER TYPE "AuditEventKind" ADD VALUE 'INVITATION_DECLINED' AFTER 'INVITATION_REVOKED';

ALTER TABLE "membership_invitations" ADD COLUMN "declinedAt" TIMESTAMPTZ(3),
ADD COLUMN "revokedAt" TIMESTAMPTZ(3);

ALTER TABLE "membership_invitations"
  ADD CONSTRAINT "membership_invitations_single_outcome_check"
  CHECK (
    num_nonnulls("acceptedAt", "revokedAt", "declinedAt") <= 1
  );
