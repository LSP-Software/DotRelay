"use client";

import { type ComponentProps, useLayoutEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

// A Value input that never puts the Value into the document. React mirrors a
// controlled input's `value` into the HTML attribute, where page capture,
// "save page" and CSS attribute selectors can read a masked secret before
// anyone reveals it. This input is uncontrolled as far as React's markup is
// concerned: the Value is assigned to the live element's `value` property
// after mount and whenever it changes, and typing still reports through
// onChange.
export const SecretValueInput = ({
  value,
  ...props
}: Omit<ComponentProps<typeof Input>, "value" | "defaultValue"> & {
  readonly value: string;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (input && input.value !== value) input.value = value;
  }, [value]);
  return <Input ref={ref} {...props} />;
};
