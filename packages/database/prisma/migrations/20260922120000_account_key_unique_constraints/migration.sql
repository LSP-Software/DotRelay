-- CreateIndex
-- A RECOVERY_CODE wrapper id is derived from the recovery code, so the same
-- id may reappear after the prior wrapper is retired. The uniqueness only
-- applies to ACTIVE wrappers, which Prisma cannot express as a filtered
-- @@unique, so it is declared here in SQL only (like
-- environments_active_project_label_key).
CREATE UNIQUE INDEX "account_key_wrapper_objects_userId_wrapperId_active_key"
  ON "account_key_wrapper_objects"("userId", "wrapperId")
  WHERE "retiredAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "account_key_transfer_objects_userId_transferId_key" ON "account_key_transfer_objects"("userId", "transferId");
