"use client";

import { Check, Clipboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const copyValue = async (value: string, codeEl: HTMLElement | null) => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    if (!codeEl) return false;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(codeEl);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return false;
  }
};

type CopyableCommandProps = Readonly<{
  readonly value: string;
  readonly className?: string;
  readonly "data-testid"?: string;
}>;

export const CopyableCommand = ({
  value,
  className,
  "data-testid": testId,
}: CopyableCommandProps) => {
  const codeRef = useRef<HTMLElement>(null);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const copied = copiedAt !== null;

  useEffect(() => {
    if (copiedAt === null) return;
    const timeout = window.setTimeout(() => setCopiedAt(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [copiedAt]);

  const copy = async () => {
    const ok = await copyValue(value, codeRef.current);
    if (ok) setCopiedAt(Date.now());
  };

  return (
    <div
      className={cn(
        "group/command flex items-start gap-2.5 rounded-lg border border-primary/20 bg-background px-3 py-2.5 ring-1 ring-foreground/5 transition-all duration-300",
        "hover:border-primary/40",
        copied && "border-primary/45 ring-primary/25",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="select-none font-mono text-xs leading-5 text-primary"
      >
        $
      </span>
      <code
        className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-foreground select-all"
        data-testid={testId}
        ref={codeRef}
      >
        {value}
      </code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={copied ? "Copied" : "Copy command"}
              className="-mr-1 shrink-0 cursor-pointer"
              onClick={() => void copy()}
              size="icon-xs"
              type="button"
              variant="ghost"
            />
          }
        >
          <span className="relative grid size-4 place-items-center">
            <Clipboard
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-all duration-200",
                copied
                  ? "scale-0 opacity-0"
                  : "text-muted-foreground group-hover/command:scale-110 group-hover/command:text-foreground",
              )}
            />
            {copied ? (
              <Check
                aria-hidden="true"
                className="absolute size-3.5 animate-in fade-in zoom-in-50 duration-200 text-primary"
                key={copiedAt}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {copied ? "Copied" : "Click to copy"}
        </TooltipContent>
      </Tooltip>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
};
