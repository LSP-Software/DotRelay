-- Human-readable Device display metadata. Cleartext, user-visible labels:
-- not covered by the signed Device certificate, renamable by the owning
-- Device. Nullable so existing rows need no backfill; clients refresh on
-- their next session.

CREATE TYPE "DeviceClientKind" AS ENUM ('CLI', 'BROWSER');

ALTER TABLE "devices"
  ADD COLUMN "displayName" VARCHAR(64),
  ADD COLUMN "nameOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "clientKind" "DeviceClientKind",
  ADD COLUMN "osName" VARCHAR(32),
  ADD COLUMN "clientSummary" VARCHAR(64);
