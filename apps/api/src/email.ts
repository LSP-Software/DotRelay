// Transactional email configuration and the Resend transport. Email is
// optional: without RESEND_API_KEY every notification is skipped.

export const DEFAULT_EMAIL_FROM = "DotRelay <noreply@dotrelay.dev>";
export const DEFAULT_EMAIL_SUPPORT_ADDRESS = "support@dotrelay.dev";
const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export type EmailConfig = Readonly<{
  /** Null disables sending. */
  readonly apiKey: string | null;
  readonly from: string;
  readonly supportAddress: string;
}>;

export type EmailMessage = Readonly<{
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Resend drops a repeat of the same key, so a retry never sends twice. */
  readonly idempotencyKey: string;
}>;

export type EmailFailureReason =
  "timeout" | "network" | "rejected" | "rate_limited" | "server_error";

/** Carries only a bounded reason: never an address, key or response body. */
export class EmailSendError extends Error {
  readonly reason: EmailFailureReason;
  constructor(reason: EmailFailureReason) {
    super(`email send failed: ${reason}`);
    this.name = "EmailSendError";
    this.reason = reason;
  }
}

export type EmailTransport = Readonly<{
  readonly send: (message: EmailMessage) => Promise<void>;
}>;

const ADDRESS_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const FROM_PATTERN = /^([^<>"\r\n]{1,64}) <([^<>\s]+)>$/;
const RESEND_KEY_PATTERN = /^re_[A-Za-z0-9_-]{8,128}$/;

export const isEmailAddress = (value: string): boolean =>
  value.length <= 254 && ADDRESS_PATTERN.test(value);

const isFromHeader = (value: string): boolean => {
  const match = FROM_PATTERN.exec(value);
  if (match) return isEmailAddress(match[2] ?? "");
  return isEmailAddress(value);
};

const optional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Parses the email settings. Errors name the variable, never its value. */
export const loadEmailConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): EmailConfig => {
  const apiKey = optional(environment.RESEND_API_KEY) ?? null;
  if (apiKey !== null && !RESEND_KEY_PATTERN.test(apiKey))
    throw new Error("RESEND_API_KEY must be a Resend API key (re_…)");
  const from = optional(environment.EMAIL_FROM) ?? DEFAULT_EMAIL_FROM;
  if (!isFromHeader(from))
    throw new Error(
      'EMAIL_FROM must be an address or "Name <address>", e.g. DotRelay <noreply@dotrelay.dev>',
    );
  const supportAddress =
    optional(environment.EMAIL_SUPPORT_ADDRESS) ??
    DEFAULT_EMAIL_SUPPORT_ADDRESS;
  if (!isEmailAddress(supportAddress))
    throw new Error("EMAIL_SUPPORT_ADDRESS must be an email address");
  return Object.freeze({ apiKey, from, supportAddress });
};

const failureForStatus = (status: number): EmailFailureReason =>
  status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "rejected";

/** Sends through Resend's HTTP API. Each attempt has its own timeout. */
export const createResendTransport = ({
  apiKey,
  from,
  fetch: fetchImpl = fetch,
  timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
}: Readonly<{
  readonly apiKey: string;
  readonly from: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}>): EmailTransport =>
  Object.freeze({
    send: async (message: EmailMessage) => {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_EMAILS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new EmailSendError(
          error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
            ? "timeout"
            : "network",
        );
      }
      // The body may echo the recipient; it is discarded unread.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok)
        throw new EmailSendError(failureForStatus(response.status));
    },
  });
