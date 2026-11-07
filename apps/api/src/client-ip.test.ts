import { describe, expect, test } from "bun:test";
import { createClientIpResolver } from "./client-ip";

const headers = (forwardedFor?: string) =>
  new Headers(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {});

describe("Security Request Log client IP", () => {
  test("uses the socket peer and ignores forwarded headers without proxy trust", () => {
    const resolve = createClientIpResolver({
      trustProxy: false,
      trustedProxies: [],
    });
    expect(resolve("203.0.113.9", headers("198.51.100.1"))).toBe("203.0.113.9");
    expect(resolve("::ffff:203.0.113.9", headers())).toBe("203.0.113.9");
    expect(resolve(null, headers("198.51.100.1"))).toBeNull();
  });

  test("walks the forwarded chain from the right past trusted proxies", () => {
    const resolve = createClientIpResolver({
      trustProxy: true,
      trustedProxies: ["10.0.0.0/8", "2001:db8::1"],
    });
    expect(resolve("10.0.0.2", headers("198.51.100.7"))).toBe("198.51.100.7");
    // A spoofed leftmost value is ignored: the first untrusted hop wins.
    expect(
      resolve("10.0.0.2", headers("192.0.2.66, 198.51.100.7, 10.1.1.1")),
    ).toBe("198.51.100.7");
    expect(resolve("2001:db8::1", headers("2001:DB8::99"))).toBe(
      "2001:db8::99",
    );
  });

  test("does not trust forwarded headers from an untrusted peer", () => {
    const resolve = createClientIpResolver({
      trustProxy: true,
      trustedProxies: ["10.0.0.0/8"],
    });
    expect(resolve("203.0.113.9", headers("198.51.100.7"))).toBe("203.0.113.9");
  });

  test("returns no address for a malformed or fully trusted chain", () => {
    const resolve = createClientIpResolver({
      trustProxy: true,
      trustedProxies: ["10.0.0.0/8"],
    });
    expect(resolve("10.0.0.2", headers("not-an-ip"))).toBeNull();
    expect(resolve("10.0.0.2", headers("10.0.0.3"))).toBeNull();
  });

  test("accepts only a single-value header when no proxy list is configured", () => {
    const resolve = createClientIpResolver({
      trustProxy: true,
      trustedProxies: [],
    });
    expect(resolve("127.0.0.1", headers("198.51.100.7"))).toBe("198.51.100.7");
    expect(resolve("127.0.0.1", headers("192.0.2.1, 198.51.100.7"))).toBe(
      "127.0.0.1",
    );
  });
});
