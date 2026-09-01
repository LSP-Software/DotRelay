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
