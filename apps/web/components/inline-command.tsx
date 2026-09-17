"use client";

import { Check, Copy } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const copyValue = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

type InlineCommandProps = Readonly<{
  readonly value: string;
  readonly className?: string;
}>;

export const InlineCommand = ({ value, className }: InlineCommandProps) => {
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const copied = copiedAt !== null;

  useEffect(() => {
    if (copiedAt === null) return;
    const timeout = window.setTimeout(() => setCopiedAt(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [copiedAt]);

  const copy = async () => {
    if (await copyValue(value)) setCopiedAt(Date.now());
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={copied ? "Copied" : `Copy ${value}`}
            onClick={() => void copy()}
            className={cn(
              "group/chip inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 font-mono text-[0.85em] leading-5 text-foreground transition-all duration-200",
              "hover:border-primary/40 hover:bg-primary/10 hover:text-primary",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              copied && "border-primary/40 bg-primary/10 text-primary",
              className,
            )}
            type="button"
          />
        }
      >
        {value}
        <span
          aria-hidden="true"
          className="relative grid size-3 place-items-center"
        >
          <Copy
            className={cn(
              "size-3 transition-all duration-200",
              copied
                ? "scale-0 opacity-0"
                : "text-muted-foreground opacity-0 group-hover/chip:opacity-100 group-hover/chip:text-current",
            )}
          />
          {copied ? (
            <Check
              className="absolute size-3 animate-in fade-in zoom-in-50 duration-200 text-primary"
              key={copiedAt}
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {copied ? "Copied" : "Click to copy"}
      </TooltipContent>
    </Tooltip>
  );
};

type CommandTextProps = Readonly<{
  readonly text: string;
}>;

type CommandTextSegment = Readonly<{
  readonly key: string;
  readonly value: string;
  readonly command: boolean;
}>;

const parseCommandText = (text: string): CommandTextSegment[] => {
  const segments: CommandTextSegment[] = [];
  let commandCount = 0;
  let textCount = 0;
  text.split("`").forEach((part, index) => {
    if (index % 2 === 1) {
      segments.push({
        command: true,
        key: `command-${commandCount++}`,
        value: part,
      });
    } else {
      segments.push({
        command: false,
        key: `text-${textCount++}`,
        value: part,
      });
    }
  });
  return segments;
};

const CommandText = ({ text }: CommandTextProps) => {
  return (
    <>
      {parseCommandText(text).map((segment) =>
        segment.command ? (
          <InlineCommand key={segment.key} value={segment.value} />
        ) : (
          <Fragment key={segment.key}>{segment.value}</Fragment>
        ),
      )}
    </>
  );
};

export { CommandText };
