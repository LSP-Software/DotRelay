ALTER TYPE "AuditEventKind" ADD VALUE 'GRANT_CREATED';
ALTER TYPE "AuditEventKind" ADD VALUE 'DEVICE_ENROLLMENT_STARTED';
ALTER TYPE "AuditEventKind" ADD VALUE 'DEVICE_ENROLLMENT_APPROVED';
ALTER TYPE "AuditEventKind" ADD VALUE 'OPERATION_CANCELLED';
ALTER TYPE "AuditEventKind" ADD VALUE 'OPERATION_EXPIRED';

ALTER TABLE "security_request_logs"
  ADD CONSTRAINT "security_request_logs_endpoint_template_check"
  CHECK ("endpointTemplate" IN (
    '/health',
    '/api/v1/capabilities',
    '/api/v1/session',
    '/device',
    '/api/auth/*',
    '/api/v1/operations/:operationId/begin',
    '/api/v1/operations/:operationId/staging/:objectId',
    '/api/v1/operations/:operationId/finalize',
    '/api/v1/operations/:operationId',
    '/api/v1/environments/:environmentId/sync',
    '/api/v1/operations/:operationId/epoch-transitions'
  )),
  ADD CONSTRAINT "security_request_logs_retention_check"
  CHECK ("expiresAt" <= "requestedAt" + INTERVAL '30 days');

REVOKE ALL ON TABLE "security_request_logs" FROM PUBLIC;

DO $$
BEGIN
  CREATE ROLE dotrelay_security_response NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;
GRANT SELECT ON TABLE "security_request_logs" TO dotrelay_security_response;

ALTER TABLE "security_request_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_request_logs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "security_request_logs_append"
  ON "security_request_logs"
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "security_request_logs_expire"
  ON "security_request_logs"
  FOR DELETE
  USING (true);

CREATE POLICY "security_request_logs_security_response_read"
  ON "security_request_logs"
  FOR SELECT
  USING (
    pg_has_role(current_user, 'dotrelay_security_response', 'member')
    AND current_setting('dotrelay.security_request_log_access', true) = 'security-response'
  );
