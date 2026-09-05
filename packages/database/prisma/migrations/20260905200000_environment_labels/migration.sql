ALTER TABLE "environments"
  ADD COLUMN "label" VARCHAR(64) NOT NULL DEFAULT 'default';

WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "projectId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS n
  FROM "environments"
)
UPDATE "environments" AS environment
SET "label" = CASE
  WHEN ranked.n = 1 THEN 'default'
  ELSE 'env-' || ranked.n::text
END
FROM ranked
WHERE environment."id" = ranked."id";

CREATE INDEX "environments_projectId_label_idx"
  ON "environments" ("projectId", "label");

CREATE UNIQUE INDEX "environments_active_project_label_key"
  ON "environments" ("projectId", "label")
  WHERE "lifecycle" = 'ACTIVE';
