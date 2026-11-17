"use client";

import { type ComponentProps, useLayoutEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// What a masked, non-empty Value shows while nobody is editing it. A
// password input draws one dot per character, which would give away the
// Value's length, so a fixed run of dots covers it instead.
const FIXED_MASK = "••••••••••••";

// A Value input that never puts the Value into the document. React mirrors a
// controlled input's `value` into the HTML attribute, where page capture,
// "save page" and CSS attribute selectors can read a masked secret before
// anyone reveals it. This input is uncontrolled as far as React's markup is
// concerned: the Value is assigned to the live element's `value` property
// after mount and whenever it changes, and typing still reports through
// onChange. A `masked` input hides its own text behind a fixed-length mask
// until it is focused for editing.
export const SecretValueInput = ({
  value,
  masked,
  className,
  onFocus,
  onBlur,
  ...props
}: Omit<ComponentProps<typeof Input>, "value" | "defaultValue"> & {
  readonly value: string;
  readonly masked?: boolean;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    const input = ref.current;
    if (input && input.value !== value) input.value = value;
  }, [value]);
  const covered = masked === true && !focused && value.length > 0;
  const input = (
    <Input
      ref={ref}
      className={cn(className, covered && "text-transparent")}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      {...props}
    />
  );
  // An input that can be masked keeps one wrapper whether or not it is
  // masked right now, so revealing never remounts it and loses its value.
  if (masked === undefined) return input;
  return (
    <span className="relative flex min-w-0 flex-1">
      {input}
      {covered ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-[13px] tracking-wider text-foreground"
        >
          {FIXED_MASK}
        </span>
      ) : null}
    </span>
  );
};
