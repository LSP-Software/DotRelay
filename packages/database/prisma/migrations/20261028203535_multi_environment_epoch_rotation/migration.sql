-- DropIndex
DROP INDEX "revisions_operationId_key";

-- CreateIndex
CREATE INDEX "revisions_operationId_idx" ON "revisions"("operationId");
