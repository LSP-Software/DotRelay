export const bytesFromHex = (value: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error("invalid vector hex");
  return Uint8Array.from(
    value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
};

export const hexFromBytes = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
