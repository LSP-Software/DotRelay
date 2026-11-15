import { describe, expect, test } from "bun:test";
import {
  createResendTransport,
  DEFAULT_EMAIL_FROM,
  DEFAULT_EMAIL_SUPPORT_ADDRESS,
  EmailSendError,
  loadEmailConfig,
} from "./email";

// Assembled at runtime so the secret scanner does not read a fixture as a key.
const testKey = ["re", "fixtureOnlyKey123"].join("_");

const message = {
  to: "member@example.com",
  subject: "Subject",
  text: "Body",
  html: "<p>Body</p>",
  idempotencyKey: "invitation/1/2",
};

describe("email configuration", () => {
  test("is off without RESEND_API_KEY and uses the DotRelay defaults", () => {
    expect(loadEmailConfig({})).toEqual({
      apiKey: null,
      from: DEFAULT_EMAIL_FROM,
      supportAddress: DEFAULT_EMAIL_SUPPORT_ADDRESS,
    });
    expect(loadEmailConfig({ RESEND_API_KEY: "  " }).apiKey).toBeNull();
    expect(DEFAULT_EMAIL_FROM).toBe("DotRelay <noreply@dotrelay.dev>");
    expect(DEFAULT_EMAIL_SUPPORT_ADDRESS).toBe("support@dotrelay.dev");
  });

  test("accepts well-formed values", () => {
    expect(
      loadEmailConfig({
        RESEND_API_KEY: testKey,
        EMAIL_FROM: "Relay Ops <ops@relay.example>",
        EMAIL_SUPPORT_ADDRESS: "help@relay.example",
      }),
    ).toEqual({
      apiKey: testKey,
      from: "Relay Ops <ops@relay.example>",
      supportAddress: "help@relay.example",
    });
    expect(loadEmailConfig({ EMAIL_FROM: "ops@relay.example" }).from).toBe(
      "ops@relay.example",
    );
  });

  test("rejects malformed values without echoing them", () => {
    for (const [environment, name] of [
      [{ RESEND_API_KEY: "sk_live_do-not-print" }, "RESEND_API_KEY"],
      [{ EMAIL_FROM: "do-not-print" }, "EMAIL_FROM"],
      [{ EMAIL_FROM: "Name <do-not-print>" }, "EMAIL_FROM"],
      [{ EMAIL_FROM: "A\r\nBcc: x <a@b.example>" }, "EMAIL_FROM"],
      [{ EMAIL_SUPPORT_ADDRESS: "do-not-print" }, "EMAIL_SUPPORT_ADDRESS"],
    ] as const) {
      let error = "";
      try {
        loadEmailConfig(environment);
      } catch (caught) {
        error = String(caught);
      }
      expect(error).toContain(name);
      expect(error).not.toContain("do-not-print");
    }
  });
});

describe("Resend transport", () => {
  test("posts one recipient with an idempotency key and a timeout", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = createResendTransport({
      apiKey: testKey,
      from: DEFAULT_EMAIL_FROM,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ id: "email-id" });
      }) as unknown as typeof fetch,
    });
    await transport.send(message);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${testKey}`);
    expect(headers["Idempotency-Key"]).toBe("invitation/1/2");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: DEFAULT_EMAIL_FROM,
      to: ["member@example.com"],
      subject: "Subject",
      text: "Body",
      html: "<p>Body</p>",
    });
  });

  test("maps failures to bounded reasons without the provider's message", async () => {
    const failing = (respond: () => Promise<Response>) =>
      createResendTransport({
        apiKey: testKey,
        from: DEFAULT_EMAIL_FROM,
        timeoutMs: 20,
        fetch: respond as unknown as typeof fetch,
      });
    const reasonFor = async (respond: () => Promise<Response>) => {
      const error = await failing(respond)
        .send(message)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EmailSendError);
      expect(String(error)).not.toContain("member@example.com");
      return (error as EmailSendError).reason;
    };
    const body = () =>
      Response.json(
        { message: "member@example.com is invalid" },
        { status: 422 },
      );
    expect(await reasonFor(async () => body())).toBe("rejected");
    expect(
      await reasonFor(async () => new Response(null, { status: 429 })),
    ).toBe("rate_limited");
    expect(
      await reasonFor(async () => new Response(null, { status: 503 })),
    ).toBe("server_error");
    expect(
      await reasonFor(async () => {
        throw new TypeError("connect ECONNREFUSED");
      }),
    ).toBe("network");
    expect(
      await reasonFor(
        () =>
          new Promise<Response>((_resolve, reject) =>
            setTimeout(
              () => reject(new DOMException("timed out", "TimeoutError")),
              50,
            ),
          ),
      ),
    ).toBe("timeout");
  });

  test("a hung request is cut off by the timeout", async () => {
    const transport = createResendTransport({
      apiKey: testKey,
      from: DEFAULT_EMAIL_FROM,
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        })) as unknown as typeof fetch,
    });
    const error = await transport.send(message).catch((caught) => caught);
    expect((error as EmailSendError).reason).toBe("timeout");
  });
});
