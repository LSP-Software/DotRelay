-- CreateEnum
CREATE TYPE "WrapperType" AS ENUM ('PASSKEY_PRF', 'PASSWORD', 'RECOVERY_CODE');

-- CreateEnum
CREATE TYPE "KeyEnvelopeType" AS ENUM ('PROJECT_EPOCH_KEY', 'USER_VALUE_KEY');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'CONSUMED', 'EXPIRED');

-- DropForeignKey
ALTER TABLE "recovery_attempts" DROP CONSTRAINT "recovery_attempts_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_attempts" DROP CONSTRAINT "recovery_attempts_envelopeId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_attempts" DROP CONSTRAINT "recovery_attempts_userId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_challenge_objects" DROP CONSTRAINT "recovery_challenge_objects_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_challenge_objects" DROP CONSTRAINT "recovery_challenge_objects_protocolObjectId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_challenge_objects" DROP CONSTRAINT "recovery_challenge_objects_userId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_envelopes" DROP CONSTRAINT "recovery_envelopes_protocolObjectId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_envelopes" DROP CONSTRAINT "recovery_envelopes_userId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_grant_objects" DROP CONSTRAINT "recovery_grant_objects_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_grant_objects" DROP CONSTRAINT "recovery_grant_objects_projectId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_grant_objects" DROP CONSTRAINT "recovery_grant_objects_protocolObjectId_fkey";

-- DropForeignKey
ALTER TABLE "recovery_grant_objects" DROP CONSTRAINT "recovery_grant_objects_recoveryEnvelopeId_fkey";

-- DropTable
DROP TABLE "recovery_attempts";

-- DropTable
DROP TABLE "recovery_challenge_objects";

-- DropTable
DROP TABLE "recovery_envelopes";

-- DropTable
DROP TABLE "recovery_grant_objects";

-- AlterEnum
BEGIN;
CREATE TYPE "AuditEntityKind_new" AS ENUM ('SERVER_PROFILE', 'USER', 'DEVICE', 'TEAM', 'MEMBERSHIP', 'INVITATION', 'PROJECT', 'ENVIRONMENT', 'OPERATION', 'PROTOCOL_OBJECT', 'REVISION', 'ACCOUNT_KEY_WRAPPER', 'ACCOUNT_KEY_ENVELOPE', 'ACCOUNT_KEY_TRANSFER');
ALTER TABLE "audit_events" ALTER COLUMN "entityKind" TYPE "AuditEntityKind_new" USING ("entityKind"::text::"AuditEntityKind_new");
ALTER TYPE "AuditEntityKind" RENAME TO "AuditEntityKind_old";
ALTER TYPE "AuditEntityKind_new" RENAME TO "AuditEntityKind";
DROP TYPE "public"."AuditEntityKind_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "AuditEventKind_new" AS ENUM ('TEAM_CREATED', 'MEMBERSHIP_INVITED', 'MEMBERSHIP_ACCEPTED', 'MEMBERSHIP_ACTIVATED', 'MEMBERSHIP_ROLE_CHANGED', 'MEMBERSHIP_REMOVED', 'DEVICE_ENROLLED', 'DEVICE_REVOKED', 'ACCOUNT_KEY_WRAPPER_ADDED', 'ACCOUNT_KEY_WRAPPER_REVOKED', 'ACCOUNT_KEY_ENVELOPE_PUBLISHED', 'ACCOUNT_KEY_TRANSFER_CREATED', 'PROJECT_CREATED', 'PROJECT_ARCHIVED', 'PROJECT_RESTORED', 'ENVIRONMENT_CREATED', 'ENVIRONMENT_ARCHIVED', 'ENVIRONMENT_RESTORED', 'REVISION_PUBLISHED', 'ROLLBACK_PUBLISHED', 'EPOCH_ROTATED', 'GRANT_CREATED', 'DEVICE_ENROLLMENT_STARTED', 'DEVICE_ENROLLMENT_APPROVED', 'OPERATION_CANCELLED', 'OPERATION_EXPIRED');
ALTER TABLE "audit_events" ALTER COLUMN "kind" TYPE "AuditEventKind_new" USING ("kind"::text::"AuditEventKind_new");
ALTER TYPE "AuditEventKind" RENAME TO "AuditEventKind_old";
ALTER TYPE "AuditEventKind_new" RENAME TO "AuditEventKind";
DROP TYPE "public"."AuditEventKind_old";
COMMIT;

-- AlterEnum
-- The hand-written generation check still named the removed recovery grant
-- kinds, so it is re-created against the new enum members.
ALTER TABLE "grant_objects" DROP CONSTRAINT "grant_objects_generation_check";
BEGIN;
CREATE TYPE "GrantKind_new" AS ENUM ('CURRENT_PROJECT_EPOCH', 'HISTORICAL_PROJECT_EPOCH', 'CURRENT_USER_VALUE_GENERATION', 'HISTORICAL_USER_VALUE_GENERATION', 'DEVICE_TRUST_PROVISIONING');
ALTER TABLE "grant_objects" ALTER COLUMN "grantKind" TYPE "GrantKind_new" USING ("grantKind"::text::"GrantKind_new");
ALTER TYPE "GrantKind" RENAME TO "GrantKind_old";
ALTER TYPE "GrantKind_new" RENAME TO "GrantKind";
DROP TYPE "public"."GrantKind_old";
COMMIT;
ALTER TABLE "grant_objects"
  ADD CONSTRAINT "grant_objects_generation_check"
  CHECK (
    ("grantKind" IN ('CURRENT_PROJECT_EPOCH', 'HISTORICAL_PROJECT_EPOCH') AND "projectEpoch" IS NOT NULL)
    OR ("grantKind" IN ('CURRENT_USER_VALUE_GENERATION', 'HISTORICAL_USER_VALUE_GENERATION') AND "valueGeneration" IS NOT NULL)
    OR "grantKind" IN ('DEVICE_TRUST_PROVISIONING')
  );

-- AlterEnum
BEGIN;
CREATE TYPE "OperationKind_new" AS ENUM ('ADMINISTRATION', 'INVITATION', 'MEMBERSHIP_CHANGE', 'DEVICE_ENROLLMENT', 'DEVICE_REVOCATION', 'ACCOUNT_KEY', 'ENVIRONMENT_GENESIS', 'REVISION_PUBLICATION', 'ROLLBACK', 'EPOCH_ROTATION');
ALTER TABLE "operations" ALTER COLUMN "kind" TYPE "OperationKind_new" USING ("kind"::text::"OperationKind_new");
ALTER TYPE "OperationKind" RENAME TO "OperationKind_old";
ALTER TYPE "OperationKind_new" RENAME TO "OperationKind";
DROP TYPE "public"."OperationKind_old";
COMMIT;

-- The hand-written kind range now admits the account key object kinds.
ALTER TABLE "protocol_objects" DROP CONSTRAINT "protocol_objects_kind_check";
ALTER TABLE "protocol_objects"
  ADD CONSTRAINT "protocol_objects_kind_check"
  CHECK ("kind" BETWEEN 1 AND 22);

-- The recovery envelope generation counter is obsolete; wrapper lifecycle
-- now lives on the wrapper objects.
ALTER TABLE "users" DROP CONSTRAINT "users_generations_positive_check";
ALTER TABLE "users" DROP COLUMN "recoveryGeneration";
ALTER TABLE "users"
  ADD CONSTRAINT "users_generations_positive_check"
  CHECK ("identityGeneration" > 0);

-- CreateTable
CREATE TABLE "account_key_wrapper_objects" (
    "protocolObjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "identityGeneration" BIGINT NOT NULL,
    "wrapperType" "WrapperType" NOT NULL,
    "wrapperId" BYTEA NOT NULL,
    "wrapperGeneration" BIGINT NOT NULL DEFAULT 1,
    "credentialId" BYTEA,
    "kdfName" INTEGER,
    "kdfMemoryKib" BIGINT,
    "kdfIterations" BIGINT,
    "kdfParallelism" INTEGER,
    "ciphertextHash" BYTEA NOT NULL,
    "ciphertextLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "account_key_wrapper_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "account_key_envelope_objects" (
    "protocolObjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "envelopeType" "KeyEnvelopeType" NOT NULL,
    "projectId" UUID,
    "projectEpoch" BIGINT,
    "ownerUserId" UUID,
    "valueGeneration" BIGINT,
    "ciphertextHash" BYTEA NOT NULL,
    "ciphertextLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "account_key_envelope_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "account_key_transfer_objects" (
    "protocolObjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "recipientDeviceId" UUID NOT NULL,
    "transferId" BYTEA NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_key_transfer_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateIndex
CREATE INDEX "account_key_wrapper_objects_userId_wrapperType_retiredAt_idx" ON "account_key_wrapper_objects"("userId", "wrapperType", "retiredAt");

-- CreateIndex
CREATE INDEX "account_key_wrapper_objects_userId_wrapperId_idx" ON "account_key_wrapper_objects"("userId", "wrapperId");

-- CreateIndex
CREATE INDEX "account_key_envelope_objects_userId_envelopeType_projectId__idx" ON "account_key_envelope_objects"("userId", "envelopeType", "projectId", "projectEpoch");

-- CreateIndex
CREATE INDEX "account_key_envelope_objects_userId_ownerUserId_valueGenera_idx" ON "account_key_envelope_objects"("userId", "ownerUserId", "valueGeneration");

-- CreateIndex
CREATE INDEX "account_key_transfer_objects_userId_status_expiresAt_idx" ON "account_key_transfer_objects"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "account_key_transfer_objects_recipientDeviceId_status_idx" ON "account_key_transfer_objects"("recipientDeviceId", "status");

-- AddForeignKey
ALTER TABLE "account_key_wrapper_objects" ADD CONSTRAINT "account_key_wrapper_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_key_wrapper_objects" ADD CONSTRAINT "account_key_wrapper_objects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_key_envelope_objects" ADD CONSTRAINT "account_key_envelope_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_key_envelope_objects" ADD CONSTRAINT "account_key_envelope_objects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_key_envelope_objects" ADD CONSTRAINT "account_key_envelope_objects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_key_envelope_objects" ADD CONSTRAINT "account_key_envelope_objects_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_key_transfer_objects" ADD CONSTRAINT "account_key_transfer_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_key_transfer_objects" ADD CONSTRAINT "account_key_transfer_objects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_key_transfer_objects" ADD CONSTRAINT "account_key_transfer_objects_recipientDeviceId_fkey" FOREIGN KEY ("recipientDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
