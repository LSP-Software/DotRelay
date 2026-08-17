-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DeviceLifecycle" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "MembershipLifecycle" AS ENUM ('PENDING_KEY_GRANT', 'ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "ResourceLifecycle" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('STAGED', 'COMMITTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OperationKind" AS ENUM ('ADMINISTRATION', 'INVITATION', 'MEMBERSHIP_CHANGE', 'DEVICE_ENROLLMENT', 'DEVICE_REVOCATION', 'RECOVERY', 'ENVIRONMENT_GENESIS', 'REVISION_PUBLICATION', 'ROLLBACK', 'EPOCH_ROTATION');

-- CreateEnum
CREATE TYPE "MutationKind" AS ENUM ('GENESIS', 'MANIFEST_UPDATE', 'ROLLBACK', 'EPOCH_TRANSITION', 'USER_KEY_ROTATION');

-- CreateEnum
CREATE TYPE "LaneScope" AS ENUM ('ENVIRONMENT_DEFINITION', 'VARIABLE_DEFINITION', 'SHARED_VALUE', 'USER_DEFINED_VALUE');

-- CreateEnum
CREATE TYPE "KeyKind" AS ENUM ('PROJECT_EPOCH', 'USER_DEFINED_VALUE', 'USER_TRUST_BUNDLE');

-- CreateEnum
CREATE TYPE "GrantKind" AS ENUM ('CURRENT_PROJECT_EPOCH', 'HISTORICAL_PROJECT_EPOCH', 'CURRENT_USER_VALUE_GENERATION', 'HISTORICAL_USER_VALUE_GENERATION', 'DEVICE_TRUST_PROVISIONING', 'RECOVERY_PROJECT_KEY', 'RECOVERY_USER_VALUE_KEY');

-- CreateEnum
CREATE TYPE "AuditEntityKind" AS ENUM ('SERVER_PROFILE', 'USER', 'DEVICE', 'TEAM', 'MEMBERSHIP', 'INVITATION', 'PROJECT', 'ENVIRONMENT', 'OPERATION', 'PROTOCOL_OBJECT', 'REVISION', 'RECOVERY_ENVELOPE');

-- CreateEnum
CREATE TYPE "AuditEventKind" AS ENUM ('TEAM_CREATED', 'MEMBERSHIP_INVITED', 'MEMBERSHIP_ACCEPTED', 'MEMBERSHIP_ACTIVATED', 'MEMBERSHIP_ROLE_CHANGED', 'MEMBERSHIP_REMOVED', 'DEVICE_ENROLLED', 'DEVICE_REVOKED', 'RECOVERY_COMPLETED', 'PROJECT_CREATED', 'PROJECT_ARCHIVED', 'PROJECT_RESTORED', 'ENVIRONMENT_CREATED', 'ENVIRONMENT_ARCHIVED', 'ENVIRONMENT_RESTORED', 'REVISION_PUBLISHED', 'ROLLBACK_PUBLISHED', 'EPOCH_ROTATED');

-- CreateTable
CREATE TABLE "server_profiles" (
    "id" UUID NOT NULL,
    "origin" VARCHAR(2048) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "serverProfileId" UUID NOT NULL,
    "authSubject" VARCHAR(255) NOT NULL,
    "githubSubject" VARCHAR(255) NOT NULL,
    "identityGeneration" BIGINT NOT NULL DEFAULT 1,
    "recoveryGeneration" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identity_generations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "generation" BIGINT NOT NULL,
    "x25519PublicKey" BYTEA NOT NULL,
    "ed25519PublicKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "user_identity_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lifecycle" "DeviceLifecycle" NOT NULL DEFAULT 'PENDING',
    "identityGeneration" BIGINT NOT NULL,
    "keyId" BYTEA NOT NULL,
    "x25519PublicKey" BYTEA NOT NULL,
    "ed25519PublicKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_enrollments" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "initiatorDeviceId" UUID NOT NULL,
    "approverDeviceId" UUID,
    "transcriptHash" BYTEA NOT NULL,
    "challengeHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "device_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_envelopes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "protocolObjectId" UUID NOT NULL,
    "identityGeneration" BIGINT NOT NULL,
    "recoveryGeneration" BIGINT NOT NULL,
    "ciphertextHash" BYTEA NOT NULL,
    "ciphertextLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "recovery_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_attempts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID,
    "envelopeId" UUID,
    "challengeHash" BYTEA NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "attemptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "serverProfileId" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "lifecycle" "ResourceLifecycle" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_invitations" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "providerSubject" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedByUserId" UUID,
    "acceptedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "invitationId" UUID,
    "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "lifecycle" "MembershipLifecycle" NOT NULL DEFAULT 'PENDING_KEY_GRANT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(3),
    "removedAt" TIMESTAMPTZ(3),

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "githubRepositoryId" BIGINT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "lifecycle" "ResourceLifecycle" NOT NULL DEFAULT 'ACTIVE',
    "currentEpoch" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "lifecycle" "ResourceLifecycle" NOT NULL DEFAULT 'ACTIVE',
    "currentHeadId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protocol_objects" (
    "id" UUID NOT NULL,
    "suite" VARCHAR(96) NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "kind" INTEGER NOT NULL,
    "canonicalBytes" BYTEA NOT NULL,
    "digest" BYTEA NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" UUID,
    "environmentId" UUID,

    CONSTRAINT "protocol_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_objects" (
    "protocolObjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "identityGeneration" BIGINT NOT NULL,
    "x25519PublicKey" BYTEA NOT NULL,
    "ed25519PublicKey" BYTEA NOT NULL,

    CONSTRAINT "identity_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "device_certificate_objects" (
    "protocolObjectId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "identityGeneration" BIGINT NOT NULL,
    "lifecycle" "DeviceLifecycle" NOT NULL,

    CONSTRAINT "device_certificate_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "enrollment_objects" (
    "protocolObjectId" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,

    CONSTRAINT "enrollment_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "membership_activation_objects" (
    "protocolObjectId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "teamId" UUID NOT NULL,

    CONSTRAINT "membership_activation_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "grant_objects" (
    "protocolObjectId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "membershipId" UUID,
    "senderDeviceId" UUID,
    "recipientDeviceId" UUID NOT NULL,
    "ownerUserId" UUID,
    "keyKind" "KeyKind" NOT NULL,
    "grantKind" "GrantKind" NOT NULL,
    "laneScope" "LaneScope",
    "projectEpoch" BIGINT,
    "valueGeneration" BIGINT,
    "plaintextLength" INTEGER NOT NULL,
    "ciphertextLength" INTEGER NOT NULL,
    "ciphertextHash" BYTEA NOT NULL,

    CONSTRAINT "grant_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "recovery_grant_objects" (
    "protocolObjectId" UUID NOT NULL,
    "recoveryEnvelopeId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantKind" "GrantKind" NOT NULL,
    "ownerUserId" UUID,

    CONSTRAINT "recovery_grant_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "epoch_transition_objects" (
    "protocolObjectId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "previousEpoch" BIGINT NOT NULL,
    "newEpoch" BIGINT NOT NULL,
    "expectedHeadId" UUID NOT NULL,
    "newHeadId" UUID NOT NULL,

    CONSTRAINT "epoch_transition_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "lane_objects" (
    "id" UUID NOT NULL,
    "protocolObjectId" UUID NOT NULL,
    "operationId" UUID,
    "projectId" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "scope" "LaneScope" NOT NULL,
    "ownerUserId" UUID,
    "originalProviderUserId" UUID,
    "projectEpoch" BIGINT NOT NULL,
    "valueGeneration" BIGINT,
    "plaintextLength" INTEGER NOT NULL,
    "ciphertextLength" INTEGER NOT NULL,
    "ciphertextHash" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lane_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lane_commitment_objects" (
    "protocolObjectId" UUID NOT NULL,
    "laneObjectId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "scope" "LaneScope" NOT NULL,
    "projectEpoch" BIGINT NOT NULL,
    "valueGeneration" BIGINT,
    "ciphertextHash" BYTEA NOT NULL,
    "ciphertextLength" INTEGER NOT NULL,

    CONSTRAINT "lane_commitment_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "manifest_descriptors" (
    "protocolObjectId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "descriptorHash" BYTEA NOT NULL,
    "laneCount" INTEGER NOT NULL,

    CONSTRAINT "manifest_descriptors_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "revisions" (
    "id" UUID NOT NULL,
    "protocolObjectId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "parentId" UUID,
    "parentHash" BYTEA,
    "authorUserId" UUID NOT NULL,
    "signingDeviceId" UUID NOT NULL,
    "projectEpoch" BIGINT NOT NULL,
    "mutation" "MutationKind" NOT NULL,
    "authoredAtMs" BIGINT NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rollbackTargetId" UUID,

    CONSTRAINT "revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revision_lane_commitments" (
    "revisionId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "laneObjectId" UUID NOT NULL,
    "objectHash" BYTEA NOT NULL,
    "projectEpoch" BIGINT NOT NULL,
    "valueGeneration" BIGINT,
    "scope" "LaneScope" NOT NULL,
    "ownerUserId" UUID,
    "originalProviderUserId" UUID,
    "ciphertextLength" INTEGER NOT NULL,

    CONSTRAINT "revision_lane_commitments_pkey" PRIMARY KEY ("revisionId","ordinal")
);

-- CreateTable
CREATE TABLE "recovery_challenge_objects" (
    "protocolObjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "recoveryGeneration" BIGINT NOT NULL,
    "challengeHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recovery_challenge_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

-- CreateTable
CREATE TABLE "operations" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "actorDeviceId" UUID,
    "kind" "OperationKind" NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'STAGED',
    "commandDigest" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),

    CONSTRAINT "operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staged_objects" (
    "operationId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "actorDeviceId" UUID NOT NULL,
    "canonicalBytes" BYTEA NOT NULL,
    "digest" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "committedAt" TIMESTAMPTZ(3),

    CONSTRAINT "staged_objects_pkey" PRIMARY KEY ("operationId","objectId")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "kind" "AuditEventKind" NOT NULL,
    "actorUserId" UUID,
    "actorDeviceId" UUID,
    "entityKind" "AuditEntityKind" NOT NULL,
    "entityId" UUID NOT NULL,
    "priorLifecycle" VARCHAR(64),
    "newLifecycle" VARCHAR(64),
    "outcomeObjectId" UUID,
    "outcomeRevisionId" UUID,
    "receiptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_request_logs" (
    "id" UUID NOT NULL,
    "ipAddress" INET NOT NULL,
    "endpointTemplate" VARCHAR(255) NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "transferBytes" BIGINT NOT NULL DEFAULT 0,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "security_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "server_profiles_origin_key" ON "server_profiles"("origin");

-- CreateIndex
CREATE INDEX "users_serverProfileId_idx" ON "users"("serverProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "users_serverProfileId_authSubject_key" ON "users"("serverProfileId", "authSubject");

-- CreateIndex
CREATE UNIQUE INDEX "users_serverProfileId_githubSubject_key" ON "users"("serverProfileId", "githubSubject");

-- CreateIndex
CREATE UNIQUE INDEX "user_identity_generations_userId_generation_key" ON "user_identity_generations"("userId", "generation");

-- CreateIndex
CREATE INDEX "devices_userId_lifecycle_idx" ON "devices"("userId", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "devices_userId_id_key" ON "devices"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_keyId_key" ON "devices"("keyId");

-- CreateIndex
CREATE UNIQUE INDEX "device_enrollments_operationId_key" ON "device_enrollments"("operationId");

-- CreateIndex
CREATE INDEX "device_enrollments_userId_expiresAt_idx" ON "device_enrollments"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_envelopes_protocolObjectId_key" ON "recovery_envelopes"("protocolObjectId");

-- CreateIndex
CREATE INDEX "recovery_envelopes_userId_recoveryGeneration_idx" ON "recovery_envelopes"("userId", "recoveryGeneration");

-- CreateIndex
CREATE INDEX "recovery_attempts_userId_attemptedAt_idx" ON "recovery_attempts"("userId", "attemptedAt");

-- CreateIndex
CREATE INDEX "teams_serverProfileId_lifecycle_idx" ON "teams"("serverProfileId", "lifecycle");

-- CreateIndex
CREATE INDEX "membership_invitations_teamId_expiresAt_idx" ON "membership_invitations"("teamId", "expiresAt");

-- CreateIndex
CREATE INDEX "membership_invitations_providerSubject_expiresAt_idx" ON "membership_invitations"("providerSubject", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_invitationId_key" ON "memberships"("invitationId");

-- CreateIndex
CREATE INDEX "memberships_teamId_lifecycle_role_idx" ON "memberships"("teamId", "lifecycle", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_teamId_userId_key" ON "memberships"("teamId", "userId");

-- CreateIndex
CREATE INDEX "projects_teamId_lifecycle_idx" ON "projects"("teamId", "lifecycle");

-- CreateIndex
CREATE INDEX "projects_githubRepositoryId_idx" ON "projects"("githubRepositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "environments_currentHeadId_key" ON "environments"("currentHeadId");

-- CreateIndex
CREATE INDEX "environments_projectId_lifecycle_idx" ON "environments"("projectId", "lifecycle");

-- CreateIndex
CREATE INDEX "protocol_objects_kind_acceptedAt_idx" ON "protocol_objects"("kind", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "protocol_objects_digest_key" ON "protocol_objects"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "identity_objects_userId_identityGeneration_key" ON "identity_objects"("userId", "identityGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "device_certificate_objects_deviceId_key" ON "device_certificate_objects"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_objects_enrollmentId_key" ON "enrollment_objects"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_activation_objects_membershipId_key" ON "membership_activation_objects"("membershipId");

-- CreateIndex
CREATE INDEX "grant_objects_projectId_grantKind_projectEpoch_valueGenerat_idx" ON "grant_objects"("projectId", "grantKind", "projectEpoch", "valueGeneration");

-- CreateIndex
CREATE INDEX "grant_objects_recipientDeviceId_grantKind_idx" ON "grant_objects"("recipientDeviceId", "grantKind");

-- CreateIndex
CREATE UNIQUE INDEX "lane_objects_protocolObjectId_key" ON "lane_objects"("protocolObjectId");

-- CreateIndex
CREATE INDEX "lane_objects_environmentId_scope_idx" ON "lane_objects"("environmentId", "scope");

-- CreateIndex
CREATE INDEX "lane_objects_projectId_projectEpoch_valueGeneration_idx" ON "lane_objects"("projectId", "projectEpoch", "valueGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "lane_commitment_objects_laneObjectId_key" ON "lane_commitment_objects"("laneObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "manifest_descriptors_revisionId_key" ON "manifest_descriptors"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "revisions_protocolObjectId_key" ON "revisions"("protocolObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "revisions_operationId_key" ON "revisions"("operationId");

-- CreateIndex
CREATE INDEX "revisions_environmentId_acceptedAt_idx" ON "revisions"("environmentId", "acceptedAt");

-- CreateIndex
CREATE INDEX "revisions_parentId_idx" ON "revisions"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "revision_lane_commitments_revisionId_laneObjectId_key" ON "revision_lane_commitments"("revisionId", "laneObjectId");

-- CreateIndex
CREATE INDEX "operations_status_expiresAt_idx" ON "operations"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "operations_actorUserId_commandDigest_key" ON "operations"("actorUserId", "commandDigest");

-- CreateIndex
CREATE INDEX "staged_objects_expiresAt_idx" ON "staged_objects"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "staged_objects_operationId_digest_key" ON "staged_objects"("operationId", "digest");

-- CreateIndex
CREATE INDEX "audit_events_entityKind_entityId_receiptAt_idx" ON "audit_events"("entityKind", "entityId", "receiptAt");

-- CreateIndex
CREATE INDEX "audit_events_receiptAt_idx" ON "audit_events"("receiptAt");

-- CreateIndex
CREATE INDEX "security_request_logs_expiresAt_idx" ON "security_request_logs"("expiresAt");

-- CreateIndex
CREATE INDEX "security_request_logs_requestedAt_idx" ON "security_request_logs"("requestedAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_serverProfileId_fkey" FOREIGN KEY ("serverProfileId") REFERENCES "server_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_identity_generations" ADD CONSTRAINT "user_identity_generations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_enrollments" ADD CONSTRAINT "device_enrollments_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_enrollments" ADD CONSTRAINT "device_enrollments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_enrollments" ADD CONSTRAINT "device_enrollments_initiatorDeviceId_fkey" FOREIGN KEY ("initiatorDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_enrollments" ADD CONSTRAINT "device_enrollments_approverDeviceId_fkey" FOREIGN KEY ("approverDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_envelopes" ADD CONSTRAINT "recovery_envelopes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_envelopes" ADD CONSTRAINT "recovery_envelopes_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "recovery_envelopes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_serverProfileId_fkey" FOREIGN KEY ("serverProfileId") REFERENCES "server_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "membership_invitations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_currentHeadId_fkey" FOREIGN KEY ("currentHeadId") REFERENCES "revisions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "protocol_objects" ADD CONSTRAINT "protocol_objects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "protocol_objects" ADD CONSTRAINT "protocol_objects_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity_objects" ADD CONSTRAINT "identity_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity_objects" ADD CONSTRAINT "identity_objects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_certificate_objects" ADD CONSTRAINT "device_certificate_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_certificate_objects" ADD CONSTRAINT "device_certificate_objects_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "enrollment_objects" ADD CONSTRAINT "enrollment_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "enrollment_objects" ADD CONSTRAINT "enrollment_objects_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "device_enrollments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_activation_objects" ADD CONSTRAINT "membership_activation_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_activation_objects" ADD CONSTRAINT "membership_activation_objects_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_objects" ADD CONSTRAINT "grant_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_objects" ADD CONSTRAINT "grant_objects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_objects" ADD CONSTRAINT "grant_objects_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_objects" ADD CONSTRAINT "grant_objects_senderDeviceId_fkey" FOREIGN KEY ("senderDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_objects" ADD CONSTRAINT "grant_objects_recipientDeviceId_fkey" FOREIGN KEY ("recipientDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "grant_objects" ADD CONSTRAINT "grant_objects_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_grant_objects" ADD CONSTRAINT "recovery_grant_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_grant_objects" ADD CONSTRAINT "recovery_grant_objects_recoveryEnvelopeId_fkey" FOREIGN KEY ("recoveryEnvelopeId") REFERENCES "recovery_envelopes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_grant_objects" ADD CONSTRAINT "recovery_grant_objects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_grant_objects" ADD CONSTRAINT "recovery_grant_objects_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "epoch_transition_objects" ADD CONSTRAINT "epoch_transition_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "epoch_transition_objects" ADD CONSTRAINT "epoch_transition_objects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lane_objects" ADD CONSTRAINT "lane_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lane_objects" ADD CONSTRAINT "lane_objects_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lane_objects" ADD CONSTRAINT "lane_objects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lane_objects" ADD CONSTRAINT "lane_objects_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lane_objects" ADD CONSTRAINT "lane_objects_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lane_objects" ADD CONSTRAINT "lane_objects_originalProviderUserId_fkey" FOREIGN KEY ("originalProviderUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lane_commitment_objects" ADD CONSTRAINT "lane_commitment_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lane_commitment_objects" ADD CONSTRAINT "lane_commitment_objects_laneObjectId_fkey" FOREIGN KEY ("laneObjectId") REFERENCES "lane_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "manifest_descriptors" ADD CONSTRAINT "manifest_descriptors_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "manifest_descriptors" ADD CONSTRAINT "manifest_descriptors_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "revisions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "manifest_descriptors" ADD CONSTRAINT "manifest_descriptors_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "manifest_descriptors" ADD CONSTRAINT "manifest_descriptors_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "revisions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_signingDeviceId_fkey" FOREIGN KEY ("signingDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_rollbackTargetId_fkey" FOREIGN KEY ("rollbackTargetId") REFERENCES "revisions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revision_lane_commitments" ADD CONSTRAINT "revision_lane_commitments_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "revisions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "revision_lane_commitments" ADD CONSTRAINT "revision_lane_commitments_laneObjectId_fkey" FOREIGN KEY ("laneObjectId") REFERENCES "lane_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_challenge_objects" ADD CONSTRAINT "recovery_challenge_objects_protocolObjectId_fkey" FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_challenge_objects" ADD CONSTRAINT "recovery_challenge_objects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_challenge_objects" ADD CONSTRAINT "recovery_challenge_objects_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_actorDeviceId_fkey" FOREIGN KEY ("actorDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staged_objects" ADD CONSTRAINT "staged_objects_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staged_objects" ADD CONSTRAINT "staged_objects_actorDeviceId_fkey" FOREIGN KEY ("actorDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorDeviceId_fkey" FOREIGN KEY ("actorDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- Prisma cannot express the integrity boundary below. Keep these checks in the
-- forward-only SQL migration so db push and generated clients cannot weaken it.
ALTER TABLE "server_profiles"
  ADD CONSTRAINT "server_profiles_origin_check"
  CHECK (origin ~ '^https?://[^[:space:]]+$');

ALTER TABLE "users"
  ADD CONSTRAINT "users_generations_positive_check"
  CHECK ("identityGeneration" > 0 AND "recoveryGeneration" > 0);

ALTER TABLE "user_identity_generations"
  ADD CONSTRAINT "user_identity_generations_generation_positive_check"
  CHECK (generation > 0),
  ADD CONSTRAINT "user_identity_generations_x25519_length_check"
  CHECK (octet_length("x25519PublicKey") = 32),
  ADD CONSTRAINT "user_identity_generations_ed25519_length_check"
  CHECK (octet_length("ed25519PublicKey") = 32);

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_identity_generation_positive_check"
  CHECK ("identityGeneration" > 0),
  ADD CONSTRAINT "devices_key_id_length_check"
  CHECK (octet_length("keyId") = 48),
  ADD CONSTRAINT "devices_x25519_length_check"
  CHECK (octet_length("x25519PublicKey") = 32),
  ADD CONSTRAINT "devices_ed25519_length_check"
  CHECK (octet_length("ed25519PublicKey") = 32),
  ADD CONSTRAINT "devices_lifecycle_timestamps_check"
  CHECK (
    ("lifecycle" = 'PENDING' AND "activatedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("lifecycle" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("lifecycle" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  );

ALTER TABLE "device_enrollments"
  ADD CONSTRAINT "device_enrollments_hash_lengths_check"
  CHECK (octet_length("transcriptHash") = 48 AND octet_length("challengeHash") = 48),
  ADD CONSTRAINT "device_enrollments_expiry_check"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "recovery_envelopes"
  ADD CONSTRAINT "recovery_envelopes_generations_positive_check"
  CHECK ("identityGeneration" > 0 AND "recoveryGeneration" > 0),
  ADD CONSTRAINT "recovery_envelopes_hash_length_check"
  CHECK (octet_length("ciphertextHash") = 48),
  ADD CONSTRAINT "recovery_envelopes_ciphertext_length_check"
  CHECK ("ciphertextLength" > 16 AND "ciphertextLength" <= 67108864);

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_lifecycle_timestamps_check"
  CHECK (
    ("lifecycle" = 'ACTIVE' AND "archivedAt" IS NULL)
    OR ("lifecycle" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
  );

ALTER TABLE "membership_invitations"
  ADD CONSTRAINT "membership_invitations_acceptance_check"
  CHECK (
    ("acceptedAt" IS NULL AND "acceptedByUserId" IS NULL)
    OR ("acceptedAt" IS NOT NULL AND "acceptedByUserId" IS NOT NULL)
  ),
  ADD CONSTRAINT "membership_invitations_expiry_check"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_lifecycle_timestamps_check"
  CHECK (
    ("lifecycle" = 'PENDING_KEY_GRANT' AND "activatedAt" IS NULL AND "removedAt" IS NULL)
    OR ("lifecycle" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "removedAt" IS NULL)
    OR ("lifecycle" = 'REMOVED' AND "removedAt" IS NOT NULL)
  );

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_epoch_positive_check"
  CHECK ("currentEpoch" > 0),
  ADD CONSTRAINT "projects_lifecycle_timestamps_check"
  CHECK (
    ("lifecycle" = 'ACTIVE' AND "archivedAt" IS NULL)
    OR ("lifecycle" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
  );

ALTER TABLE "environments"
  ADD CONSTRAINT "environments_lifecycle_timestamps_check"
  CHECK (
    ("lifecycle" = 'ACTIVE' AND "archivedAt" IS NULL)
    OR ("lifecycle" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
  );

ALTER TABLE "protocol_objects"
  ADD CONSTRAINT "protocol_objects_suite_check"
  CHECK ("suite" = 'dotrelay-e2ee-v3-classical-webcrypto'),
  ADD CONSTRAINT "protocol_objects_format_check"
  CHECK ("formatVersion" = 3),
  ADD CONSTRAINT "protocol_objects_kind_check"
  CHECK ("kind" BETWEEN 1 AND 19),
  ADD CONSTRAINT "protocol_objects_bytes_limit_check"
  CHECK (octet_length("canonicalBytes") BETWEEN 1 AND 67108864),
  ADD CONSTRAINT "protocol_objects_digest_length_check"
  CHECK (octet_length("digest") = 48);

ALTER TABLE "identity_objects"
  ADD CONSTRAINT "identity_objects_generation_positive_check"
  CHECK ("identityGeneration" > 0),
  ADD CONSTRAINT "identity_objects_key_lengths_check"
  CHECK (octet_length("x25519PublicKey") = 32 AND octet_length("ed25519PublicKey") = 32);

ALTER TABLE "device_certificate_objects"
  ADD CONSTRAINT "device_certificate_objects_generation_positive_check"
  CHECK ("identityGeneration" > 0);

ALTER TABLE "grant_objects"
  ADD CONSTRAINT "grant_objects_hash_length_check"
  CHECK (octet_length("ciphertextHash") = 48),
  ADD CONSTRAINT "grant_objects_lengths_check"
  CHECK ("plaintextLength" BETWEEN 0 AND 4096 AND "ciphertextLength" > 16 AND "ciphertextLength" <= 67108864),
  ADD CONSTRAINT "grant_objects_generation_check"
  CHECK (
    ("grantKind" IN ('CURRENT_PROJECT_EPOCH', 'HISTORICAL_PROJECT_EPOCH', 'RECOVERY_PROJECT_KEY') AND "projectEpoch" IS NOT NULL)
    OR ("grantKind" IN ('CURRENT_USER_VALUE_GENERATION', 'HISTORICAL_USER_VALUE_GENERATION', 'RECOVERY_USER_VALUE_KEY') AND "valueGeneration" IS NOT NULL)
    OR "grantKind" IN ('DEVICE_TRUST_PROVISIONING')
  );

ALTER TABLE "recovery_grant_objects"
  ADD CONSTRAINT "recovery_grant_objects_owner_check"
  CHECK (
    ("grantKind" = 'RECOVERY_USER_VALUE_KEY' AND "ownerUserId" IS NOT NULL)
    OR ("grantKind" <> 'RECOVERY_USER_VALUE_KEY')
  );

ALTER TABLE "epoch_transition_objects"
  ADD CONSTRAINT "epoch_transition_objects_epoch_check"
  CHECK ("previousEpoch" > 0 AND "newEpoch" = "previousEpoch" + 1);

ALTER TABLE "lane_objects"
  ADD CONSTRAINT "lane_objects_hash_length_check"
  CHECK (octet_length("ciphertextHash") = 48),
  ADD CONSTRAINT "lane_objects_length_check"
  CHECK ("plaintextLength" >= 0 AND "ciphertextLength" > 16 AND "ciphertextLength" <= 67108864),
  ADD CONSTRAINT "lane_objects_epoch_check"
  CHECK ("projectEpoch" > 0),
  ADD CONSTRAINT "lane_objects_scope_owner_check"
  CHECK (
    ("scope" = 'USER_DEFINED_VALUE' AND "ownerUserId" IS NOT NULL AND "originalProviderUserId" IS NULL)
    OR ("scope" = 'SHARED_VALUE' AND "originalProviderUserId" IS NOT NULL AND "ownerUserId" IS NULL)
    OR ("scope" IN ('ENVIRONMENT_DEFINITION', 'VARIABLE_DEFINITION') AND "ownerUserId" IS NULL AND "originalProviderUserId" IS NULL)
  );

ALTER TABLE "lane_commitment_objects"
  ADD CONSTRAINT "lane_commitment_objects_hash_length_check"
  CHECK (octet_length("ciphertextHash") = 48),
  ADD CONSTRAINT "lane_commitment_objects_length_check"
  CHECK ("ciphertextLength" > 16 AND "ciphertextLength" <= 67108864),
  ADD CONSTRAINT "lane_commitment_objects_epoch_check"
  CHECK ("projectEpoch" > 0);

ALTER TABLE "manifest_descriptors"
  ADD CONSTRAINT "manifest_descriptors_hash_length_check"
  CHECK (octet_length("descriptorHash") = 48),
  ADD CONSTRAINT "manifest_descriptors_counts_check"
  CHECK ("schemaVersion" > 0 AND "laneCount" BETWEEN 0 AND 100000);

ALTER TABLE "revisions"
  ADD CONSTRAINT "revisions_epoch_and_time_check"
  CHECK ("projectEpoch" > 0 AND "authoredAtMs" >= 0),
  ADD CONSTRAINT "revisions_parent_shape_check"
  CHECK (
    ("mutation" = 'GENESIS' AND "parentId" IS NULL AND "parentHash" IS NULL)
    OR ("mutation" <> 'GENESIS' AND "parentId" IS NOT NULL AND "parentHash" IS NOT NULL AND octet_length("parentHash") = 48)
  ),
  ADD CONSTRAINT "revisions_rollback_shape_check"
  CHECK (
    ("mutation" = 'ROLLBACK' AND "rollbackTargetId" IS NOT NULL)
    OR ("mutation" <> 'ROLLBACK' AND "rollbackTargetId" IS NULL)
  );

ALTER TABLE "revision_lane_commitments"
  ADD CONSTRAINT "revision_lane_commitments_hash_length_check"
  CHECK (octet_length("objectHash") = 48),
  ADD CONSTRAINT "revision_lane_commitments_ordinal_check"
  CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "revision_lane_commitments_epoch_check"
  CHECK ("projectEpoch" > 0),
  ADD CONSTRAINT "revision_lane_commitments_length_check"
  CHECK ("ciphertextLength" > 16 AND "ciphertextLength" <= 67108864),
  ADD CONSTRAINT "revision_lane_commitments_scope_owner_check"
  CHECK (
    ("scope" = 'USER_DEFINED_VALUE' AND "ownerUserId" IS NOT NULL AND "originalProviderUserId" IS NULL)
    OR ("scope" = 'SHARED_VALUE' AND "originalProviderUserId" IS NOT NULL AND "ownerUserId" IS NULL)
    OR ("scope" IN ('ENVIRONMENT_DEFINITION', 'VARIABLE_DEFINITION') AND "ownerUserId" IS NULL AND "originalProviderUserId" IS NULL)
  );

ALTER TABLE "recovery_challenge_objects"
  ADD CONSTRAINT "recovery_challenge_objects_generation_check"
  CHECK ("recoveryGeneration" > 0),
  ADD CONSTRAINT "recovery_challenge_objects_hash_length_check"
  CHECK (octet_length("challengeHash") = 48);

ALTER TABLE "operations"
  ADD CONSTRAINT "operations_digest_length_check"
  CHECK (octet_length("commandDigest") = 48),
  ADD CONSTRAINT "operations_status_time_check"
  CHECK (
    ("status" = 'STAGED' AND "committedAt" IS NULL)
    OR ("status" = 'COMMITTED' AND "committedAt" IS NOT NULL)
    OR "status" IN ('CANCELLED', 'EXPIRED')
  );

ALTER TABLE "staged_objects"
  ADD CONSTRAINT "staged_objects_digest_length_check"
  CHECK (octet_length("digest") = 48),
  ADD CONSTRAINT "staged_objects_bytes_limit_check"
  CHECK (octet_length("canonicalBytes") BETWEEN 1 AND 67108864),
  ADD CONSTRAINT "staged_objects_expiry_check"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_lifecycle_check"
  CHECK ("priorLifecycle" IS NULL OR length("priorLifecycle") > 0),
  ADD CONSTRAINT "audit_events_entity_id_check"
  CHECK ("entityId" IS NOT NULL);

ALTER TABLE "security_request_logs"
  ADD CONSTRAINT "security_request_logs_status_check"
  CHECK ("httpStatus" BETWEEN 100 AND 599),
  ADD CONSTRAINT "security_request_logs_bytes_check"
  CHECK ("transferBytes" >= 0),
  ADD CONSTRAINT "security_request_logs_expiry_check"
  CHECK ("expiresAt" > "requestedAt");

CREATE UNIQUE INDEX "projects_active_team_repository_key"
  ON "projects" ("teamId", "githubRepositoryId")
  WHERE "lifecycle" = 'ACTIVE';

ALTER TABLE "grant_objects"
  ADD CONSTRAINT "grant_objects_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION dotrelay_reject_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'immutable DotRelay row: %.%', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dotrelay_reject_committed_staged_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."committedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'committed staged object is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' AND OLD."committedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'committed staged object cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER protocol_objects_append_only
BEFORE UPDATE OR DELETE ON "protocol_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER revisions_append_only
BEFORE UPDATE OR DELETE ON "revisions"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER revision_lane_commitments_append_only
BEFORE UPDATE OR DELETE ON "revision_lane_commitments"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER grant_objects_append_only
BEFORE UPDATE OR DELETE ON "grant_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER identity_objects_append_only
BEFORE UPDATE OR DELETE ON "identity_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER device_certificate_objects_append_only
BEFORE UPDATE OR DELETE ON "device_certificate_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER enrollment_objects_append_only
BEFORE UPDATE OR DELETE ON "enrollment_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER membership_activation_objects_append_only
BEFORE UPDATE OR DELETE ON "membership_activation_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER recovery_grant_objects_append_only
BEFORE UPDATE OR DELETE ON "recovery_grant_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER epoch_transition_objects_append_only
BEFORE UPDATE OR DELETE ON "epoch_transition_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER lane_objects_append_only
BEFORE UPDATE OR DELETE ON "lane_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER lane_commitment_objects_append_only
BEFORE UPDATE OR DELETE ON "lane_commitment_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER manifest_descriptors_append_only
BEFORE UPDATE OR DELETE ON "manifest_descriptors"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER recovery_challenge_objects_append_only
BEFORE UPDATE OR DELETE ON "recovery_challenge_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER staged_objects_committed_immutable
BEFORE UPDATE OR DELETE ON "staged_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_committed_staged_row();

CREATE OR REPLACE FUNCTION dotrelay_enforce_last_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  team_uuid UUID;
  owner_count INTEGER;
BEGIN
  team_uuid := COALESCE(NEW."teamId", OLD."teamId");
  SELECT count(*) INTO owner_count
  FROM "memberships"
  WHERE "teamId" = team_uuid
    AND "lifecycle" = 'ACTIVE'
    AND "role" = 'OWNER'
    AND ("id" <> COALESCE(OLD."id", '00000000-0000-0000-0000-000000000000'::uuid));
  IF owner_count = 0 THEN
    RAISE EXCEPTION 'a Team must retain one active owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE CONSTRAINT TRIGGER memberships_last_owner
AFTER UPDATE OF "role", "lifecycle" OR DELETE ON "memberships"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION dotrelay_enforce_last_owner();

CREATE OR REPLACE FUNCTION dotrelay_enforce_team_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_count INTEGER;
BEGIN
  SELECT count(*) INTO owner_count
  FROM "memberships"
  WHERE "teamId" = NEW."id"
    AND "lifecycle" = 'ACTIVE'
    AND "role" = 'OWNER';
  IF owner_count = 0 THEN
    RAISE EXCEPTION 'a Team must have an active owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER teams_require_owner
AFTER INSERT OR UPDATE ON "teams"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION dotrelay_enforce_team_owner();

CREATE OR REPLACE FUNCTION dotrelay_validate_current_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  environment_uuid UUID;
BEGIN
  IF NEW."currentHeadId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "environmentId" INTO environment_uuid
  FROM "revisions"
  WHERE "id" = NEW."currentHeadId";
  IF environment_uuid IS NULL OR environment_uuid <> NEW."id" THEN
    RAISE EXCEPTION 'Environment current head must belong to the Environment'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER environments_current_head_owner
AFTER INSERT OR UPDATE OF "currentHeadId" ON "environments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION dotrelay_validate_current_head();

CREATE OR REPLACE FUNCTION dotrelay_validate_revision_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  environment_uuid UUID;
BEGIN
  SELECT "environmentId" INTO environment_uuid
  FROM "environments"
  WHERE "currentHeadId" = NEW."id";
  IF environment_uuid IS NOT NULL AND environment_uuid <> NEW."environmentId" THEN
    RAISE EXCEPTION 'Environment current head must belong to the Revision Environment'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER revisions_current_head_owner
AFTER INSERT ON "revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION dotrelay_validate_revision_head();

CREATE UNIQUE INDEX "revisions_one_genesis_per_environment_key"
  ON "revisions" ("environmentId")
  WHERE "parentId" IS NULL;

-- Keep the old foundation migration as history; this migration is the first
-- product persistence projection and is intentionally forward-only.

-- These two projections keep the server-visible enrollment and identity
-- rollover object kinds typed instead of folding them into generic metadata.
CREATE TABLE "identity_rollover_objects" (
    "protocolObjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "predecessorGeneration" BIGINT NOT NULL,
    "successorGeneration" BIGINT NOT NULL,
    "predecessorHash" BYTEA NOT NULL,
    "successorHash" BYTEA NOT NULL,
    CONSTRAINT "identity_rollover_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

CREATE TABLE "enrollment_approval_objects" (
    "protocolObjectId" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "approvalDeviceId" UUID NOT NULL,
    CONSTRAINT "enrollment_approval_objects_pkey" PRIMARY KEY ("protocolObjectId")
);

CREATE INDEX "enrollment_approval_objects_enrollmentId_idx"
  ON "enrollment_approval_objects" ("enrollmentId");

ALTER TABLE "identity_rollover_objects"
  ADD CONSTRAINT "identity_rollover_objects_protocolObjectId_fkey"
  FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "identity_rollover_objects_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "identity_rollover_objects_generation_check"
  CHECK ("predecessorGeneration" > 0 AND "successorGeneration" = "predecessorGeneration" + 1),
  ADD CONSTRAINT "identity_rollover_objects_hash_lengths_check"
  CHECK (octet_length("predecessorHash") = 48 AND octet_length("successorHash") = 48);

ALTER TABLE "enrollment_approval_objects"
  ADD CONSTRAINT "enrollment_approval_objects_protocolObjectId_fkey"
  FOREIGN KEY ("protocolObjectId") REFERENCES "protocol_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "enrollment_approval_objects_enrollmentId_fkey"
  FOREIGN KEY ("enrollmentId") REFERENCES "device_enrollments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "enrollment_approval_objects_approvalDeviceId_fkey"
  FOREIGN KEY ("approvalDeviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER identity_rollover_objects_append_only
BEFORE UPDATE OR DELETE ON "identity_rollover_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
CREATE TRIGGER enrollment_approval_objects_append_only
BEFORE UPDATE OR DELETE ON "enrollment_approval_objects"
FOR EACH ROW EXECUTE FUNCTION dotrelay_reject_immutable_row();
