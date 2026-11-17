-- A Project's first Environment is called "development", matching the
-- development / staging / production names the product describes. Existing
-- Environments keep their labels.
ALTER TABLE "environments" ALTER COLUMN "label" SET DEFAULT 'development';
