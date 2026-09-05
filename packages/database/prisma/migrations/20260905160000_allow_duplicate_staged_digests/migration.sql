-- Publication begin stages the Revision command under a sentinel object id, then
-- stages the same Revision bytes again under the Revision protocol object id.
-- Both rows are required at finalize, so digests may repeat within one operation.
DROP INDEX IF EXISTS "staged_objects_operationId_digest_key";
