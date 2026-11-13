-- Retention cleanup scans expired enrollments and invitations by expiry.
CREATE INDEX "device_enrollments_expiresAt_idx" ON "device_enrollments"("expiresAt");

CREATE INDEX "membership_invitations_expiresAt_idx" ON "membership_invitations"("expiresAt");
