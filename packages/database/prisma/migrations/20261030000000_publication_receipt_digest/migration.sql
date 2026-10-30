-- Bind a committed publication receipt to its normalized finalization request.
-- Nullable for operations committed before this release and non-publications.
ALTER TABLE "operations" ADD COLUMN "finalizationDigest" BYTEA;
ALTER TABLE "operations" ADD CONSTRAINT "operations_finalization_digest_length"
CHECK ("finalizationDigest" IS NULL OR octet_length("finalizationDigest") = 48);
