type TextEncoderLike = Readonly<{
  encode(value: string): Uint8Array;
}>;

type TextDecoderLike = Readonly<{
  decode(value: Uint8Array): string;
}>;

type RuntimeTextGlobals = Readonly<{
  TextEncoder: new () => TextEncoderLike;
  TextDecoder: new (
    label?: string,
    options?: Readonly<{ fatal?: boolean }>,
  ) => TextDecoderLike;
}>;

const runtimeText = globalThis as typeof globalThis & RuntimeTextGlobals;

export const utf8Encode = (value: string): Uint8Array =>
  new runtimeText.TextEncoder().encode(value);

export const utf8Decode = (
  value: Uint8Array,
  label?: string,
  options?: Readonly<{ fatal?: boolean }>,
): string => new runtimeText.TextDecoder(label, options).decode(value);
