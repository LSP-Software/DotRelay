// Kept free of runtime imports so production config checks can load it.
export type MetricsConfig = Readonly<{
  readonly enabled: boolean;
  readonly port: number;
  readonly token?: string;
}>;

export const DEFAULT_METRICS_PORT = 9464;
const MIN_METRICS_TOKEN_LENGTH = 32;

/**
 * Reads METRICS_ENABLED, METRICS_PORT and METRICS_TOKEN. Metrics are off
 * unless METRICS_ENABLED=true. Production requires a token. Errors never
 * contain the token.
 */
export const loadMetricsConfig = (
  environment: NodeJS.ProcessEnv,
  isProduction: boolean,
): MetricsConfig => {
  const enabled = environment.METRICS_ENABLED?.trim();
  if (enabled !== undefined && !["", "true", "false"].includes(enabled))
    throw new Error("METRICS_ENABLED must be true or false");
  if (enabled !== "true")
    return Object.freeze({ enabled: false, port: DEFAULT_METRICS_PORT });
  const rawPort = environment.METRICS_PORT?.trim();
  const port =
    rawPort === undefined || rawPort === ""
      ? DEFAULT_METRICS_PORT
      : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("METRICS_PORT must be a TCP port");
  if (port === Number(environment.PORT ?? 3001))
    throw new Error("METRICS_PORT must differ from the API PORT");
  const token = environment.METRICS_TOKEN?.trim() || undefined;
  if (token === undefined && isProduction)
    throw new Error("METRICS_TOKEN is required when metrics are enabled");
  if (token !== undefined && token.length < MIN_METRICS_TOKEN_LENGTH)
    throw new Error(
      `METRICS_TOKEN must be at least ${MIN_METRICS_TOKEN_LENGTH} characters`,
    );
  return Object.freeze({
    enabled: true,
    port,
    ...(token === undefined ? {} : { token }),
  });
};
