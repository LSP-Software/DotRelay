import { BlockList, isIP } from "node:net";

type ProxyTrust = Readonly<{
  readonly trustProxy: boolean;
  readonly trustedProxies: readonly string[];
}>;

const IPV4_MAPPED_PREFIX = "::ffff:";

const normalizeAddress = (address: string): string | null => {
  const trimmed = address.trim();
  const version = isIP(trimmed);
  if (version === 0) return null;
  if (version === 6 && trimmed.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    const mapped = trimmed.slice(IPV4_MAPPED_PREFIX.length);
    if (isIP(mapped) === 4) return mapped;
  }
  return version === 6 ? trimmed.toLowerCase() : trimmed;
};

const buildTrustedProxyList = (entries: readonly string[]): BlockList => {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix] = entry.split("/");
    const version = isIP(address);
    if (version === 0) continue;
    const family = version === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
};

const isTrusted = (list: BlockList, address: string) =>
  list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");

/**
 * Creates the Security Request Log client-IP resolver.
 *
 * Without proxy trust the socket peer is the client. With proxy trust it
 * follows the same rule Better Auth applies to `X-Forwarded-For` with
 * `trustedProxies`: walk the chain (ending in the socket peer) from the right,
 * skip trusted proxies, and take the first untrusted hop. The leftmost entry is
 * client-supplied and never trusted on its own. When proxy trust is enabled
 * without a trusted-proxy list (development only), a single-value header is
 * accepted, as Better Auth does.
 */
export const createClientIpResolver = (profile: ProxyTrust) => {
  const trustedProxies = buildTrustedProxyList(profile.trustedProxies);
  const hasTrustedProxies = profile.trustedProxies.length > 0;
  return (peerAddress: string | null, headers: Headers): string | null => {
    const peer = peerAddress === null ? null : normalizeAddress(peerAddress);
    if (!profile.trustProxy) return peer;
    const forwarded = (headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (!hasTrustedProxies) {
      if (forwarded.length !== 1) return peer;
      return normalizeAddress(forwarded[0] ?? "") ?? peer;
    }
    const chain = peer === null ? forwarded : [...forwarded, peer];
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const address = normalizeAddress(chain[index] ?? "");
      // A malformed hop means the chain cannot be trusted past this point.
      if (address === null) return null;
      if (!isTrusted(trustedProxies, address)) return address;
    }
    return null;
  };
};
