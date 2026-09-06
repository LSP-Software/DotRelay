"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
        "flex items-center gap-2 rounded-lg border border-primary/20 bg-background px-3 py-2 ring-1 ring-foreground/5",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="select-none font-mono text-xs text-primary"
      >
        $
      </span>
      <code
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground select-all"
        data-testid={testId}
        ref={codeRef}
      >
        {value}
      </code>
      <Button
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() => void copy()}
        size="xs"
        type="button"
        variant="ghost"
      >
        {copied ? <Check className="text-primary" /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
};
