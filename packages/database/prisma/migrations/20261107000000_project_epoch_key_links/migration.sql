-- Project Epoch Key Links (ADR 0014): the previous Project Epoch Key sealed
-- under the next one, published with each rotation or backfilled later.
ALTER TYPE "OperationKind" ADD VALUE 'EPOCH_KEY_LINK';
ALTER TYPE "AuditEventKind" ADD VALUE 'EPOCH_KEY_LINK_PUBLISHED' AFTER 'EPOCH_ROTATED';

-- The hand-written kind range now admits the key link object kind.
ALTER TABLE "protocol_objects" DROP CONSTRAINT "protocol_objects_kind_check";
ALTER TABLE "protocol_objects"
  ADD CONSTRAINT "protocol_objects_kind_check"
  CHECK ("kind" BETWEEN 1 AND 23);

-- CreateTable
CREATE TABLE "project_epoch_key_links" (
    "protocolObjectId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "fromEpoch" BIGINT NOT NULL,
    "toEpoch" BIGINT NOT NULL,
    "signingDeviceId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_epoch_key_links_pkey" PRIMARY KEY ("protocolObjectId"),
    CONSTRAINT "project_epoch_key_links_contiguous_check"
      CHECK ("fromEpoch" >= 1 AND "toEpoch" = "fromEpoch" + 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "project_epoch_key_links_projectId_toEpoch_key" ON "project_epoch_key_links"("projectId", "toEpoch");

-- AddForeignKey
ALTER TABLE "project_epoch_key_links" ADD CONSTRAINT "project_epoch_key_links_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_epoch_key_links" ADD CONSTRAINT "project_epoch_key_links_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
