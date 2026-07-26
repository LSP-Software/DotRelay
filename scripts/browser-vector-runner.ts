import {
  canonicalDecode,
  canonicalEncode,
  parseProtocolObject,
} from "@dotrelay/contracts";
import { bytesFromHex, hexFromBytes } from "./vector-hex";

export type BrowserVectorEntry = Readonly<{
  readonly hex: string;
  readonly protocolObject?: boolean;
}>;

Object.assign(globalThis, {
  dotRelayCanonicalHexes: (entries: readonly BrowserVectorEntry[]): string[] =>
    entries.map(({ hex, protocolObject }) => {
      const bytes = bytesFromHex(hex);
      const value = protocolObject
        ? parseProtocolObject(bytes)
        : canonicalDecode(bytes);
      return hexFromBytes(canonicalEncode(value));
    }),
});
