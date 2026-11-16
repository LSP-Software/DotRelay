// Kept free of runtime imports so production config checks can load it.
export type MetricsConfig = Readonly<{
  readonly enabled: boolean;
  readonly port: number;
  /** The interface the listener binds; loopback unless set. */
  readonly hostname: string;
  readonly token?: string;
}>;

export const DEFAULT_METRICS_PORT = 9464;
/**
 * Loopback by default: the metrics listener is private, and an operator
 * whose scraper runs elsewhere names the private interface it reaches.
 */
export const DEFAULT_METRICS_HOSTNAME = "127.0.0.1";
// A host name or an IPv4 or IPv6 address, nothing else.
const HOSTNAME =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|[0-9A-Fa-f:.]+)$/;
const MIN_METRICS_TOKEN_LENGTH = 32;

/**
 * Reads METRICS_ENABLED, METRICS_PORT, METRICS_HOSTNAME and METRICS_TOKEN.
 * Metrics are off unless METRICS_ENABLED=true, and listen on loopback unless
 * METRICS_HOSTNAME names another interface. Production requires a token.
 * Errors never contain the token.
 */
export const loadMetricsConfig = (
  environment: NodeJS.ProcessEnv,
  isProduction: boolean,
): MetricsConfig => {
  const enabled = environment.METRICS_ENABLED?.trim();
  if (enabled !== undefined && !["", "true", "false"].includes(enabled))
    throw new Error("METRICS_ENABLED must be true or false");
  if (enabled !== "true")
    return Object.freeze({
      enabled: false,
      port: DEFAULT_METRICS_PORT,
      hostname: DEFAULT_METRICS_HOSTNAME,
    });
  const rawPort = environment.METRICS_PORT?.trim();
  const port =
    rawPort === undefined || rawPort === ""
      ? DEFAULT_METRICS_PORT
      : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("METRICS_PORT must be a TCP port");
  if (port === Number(environment.PORT ?? 3001))
    throw new Error("METRICS_PORT must differ from the API PORT");
  const hostname =
    environment.METRICS_HOSTNAME?.trim() || DEFAULT_METRICS_HOSTNAME;
  if (hostname.length > 253 || !HOSTNAME.test(hostname))
    throw new Error("METRICS_HOSTNAME must be a host name or an IP address");
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
    hostname,
    ...(token === undefined ? {} : { token }),
  });
};
