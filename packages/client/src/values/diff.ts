export type InlineValueHunk = Readonly<{
  readonly prefix: string;
  readonly removed: string;
  readonly added: string;
  readonly suffix: string;
}>;

export const splitInlineValueDiff = (
  from: string,
  to: string,
): InlineValueHunk => {
  let prefixLength = 0;
  const maxPrefix = Math.min(from.length, to.length);
  while (prefixLength < maxPrefix && from[prefixLength] === to[prefixLength])
    prefixLength += 1;
  let suffixLength = 0;
  const maxSuffix = Math.min(
    from.length - prefixLength,
    to.length - prefixLength,
  );
  while (
    suffixLength < maxSuffix &&
    from[from.length - 1 - suffixLength] === to[to.length - 1 - suffixLength]
  )
    suffixLength += 1;
  return Object.freeze({
    prefix: from.slice(0, prefixLength),
    removed: from.slice(prefixLength, from.length - suffixLength),
    added: to.slice(prefixLength, to.length - suffixLength),
    suffix: from.slice(from.length - suffixLength),
  });
};
