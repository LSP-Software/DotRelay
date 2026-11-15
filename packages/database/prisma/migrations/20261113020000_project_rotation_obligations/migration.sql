-- Project Epoch rotations owed after a removed active Member or a revoked
-- active Device. Rotation clears them; they never block publication.
CREATE TYPE "RotationObligationReason" AS ENUM ('MEMBERSHIP_REMOVED', 'DEVICE_REVOKED');

CREATE TABLE "project_rotation_obligations" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "reason" "RotationObligationReason" NOT NULL,
    "membershipId" UUID,
    "deviceId" UUID,
    "projectEpoch" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMPTZ(3),
    "clearedByEpoch" BIGINT,

    CONSTRAINT "project_rotation_obligations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_rotation_obligations_subject_check" CHECK (
      ("reason" = 'MEMBERSHIP_REMOVED' AND "membershipId" IS NOT NULL AND "deviceId" IS NULL)
      OR ("reason" = 'DEVICE_REVOKED' AND "deviceId" IS NOT NULL AND "membershipId" IS NULL)
    ),
    CONSTRAINT "project_rotation_obligations_epoch_check" CHECK ("projectEpoch" >= 1),
    CONSTRAINT "project_rotation_obligations_cleared_check" CHECK (
      ("clearedAt" IS NULL AND "clearedByEpoch" IS NULL)
      OR ("clearedAt" IS NOT NULL AND "clearedByEpoch" > "projectEpoch")
    )
);

CREATE INDEX "project_rotation_obligations_projectId_clearedAt_idx" ON "project_rotation_obligations"("projectId", "clearedAt");

ALTER TABLE "project_rotation_obligations" ADD CONSTRAINT "project_rotation_obligations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "project_rotation_obligations" ADD CONSTRAINT "project_rotation_obligations_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "project_rotation_obligations" ADD CONSTRAINT "project_rotation_obligations_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
