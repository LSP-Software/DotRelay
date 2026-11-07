-- Account Device rosters (ADR 0015): each User's Devices, signed by the
-- account signing key derived from the Account Master Key.
ALTER TYPE "AuditEventKind" ADD VALUE 'ACCOUNT_DEVICE_ROSTER_PUBLISHED' AFTER 'EPOCH_KEY_LINK_PUBLISHED';

ALTER TABLE "protocol_objects" DROP CONSTRAINT "protocol_objects_kind_check";
ALTER TABLE "protocol_objects"
  ADD CONSTRAINT "protocol_objects_kind_check"
  CHECK ("kind" BETWEEN 1 AND 24);

-- CreateTable
CREATE TABLE "account_device_rosters" (
    "protocolObjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "accountIdentity" BYTEA NOT NULL,
    "operationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_device_rosters_pkey" PRIMARY KEY ("protocolObjectId"),
    CONSTRAINT "account_device_rosters_version_check" CHECK ("version" >= 1),
    CONSTRAINT "account_device_rosters_identity_check"
      CHECK (octet_length("accountIdentity") = 32)
);

-- CreateIndex
CREATE UNIQUE INDEX "account_device_rosters_userId_version_key" ON "account_device_rosters"("userId", "version");

-- AddForeignKey
ALTER TABLE "account_device_rosters" ADD CONSTRAINT "account_device_rosters_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_device_rosters" ADD CONSTRAINT "account_device_rosters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
