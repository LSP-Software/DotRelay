"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // A generic primitive receives its association through caller-provided htmlFor.
    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- association is supplied by component consumers
    <label
      data-slot="label"
      className={cn(
        "flex min-w-0 items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
