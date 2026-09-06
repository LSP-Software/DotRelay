"use client";

import { RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  authorInitials,
  type EnvironmentHistoryEntry,
  formatPublishSummary,
  formatRelativeTime,
  groupHistoryByDay,
  HISTORY_PAGE_SIZE,
  nextHistoryVisibleCount,
} from "@/lib/environment-history";

const HistoryDelta = ({
  entry,
}: {
  readonly entry: EnvironmentHistoryEntry;
}) => {
  const summary = formatPublishSummary(entry);
  return (
    <p
      className="truncate text-[11px] leading-4 text-muted-foreground"
      title={summary}
    >
      {summary}
    </p>
  );
};

export const EnvironmentHistoryPanel = ({
  entries,
  headRevision,
  onRollback,
}: {
  readonly entries: readonly EnvironmentHistoryEntry[];
  readonly headRevision: string;
  readonly onRollback: (revisionId: string) => void;
}) => {
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const visibleEntries = entries.slice(0, visibleCount);
  const groups = groupHistoryByDay(visibleEntries);
  const hasMore = visibleCount < entries.length;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const wideQuery = window.matchMedia("(min-width: 80rem)");
    const fitToViewport = () => {
      if (!wideQuery.matches) {
        frame.style.maxHeight = "";
        return;
      }
      const top = Math.max(0, frame.getBoundingClientRect().top);
      const bottomGap = 24;
      frame.style.maxHeight = `${Math.max(192, window.innerHeight - top - bottomGap)}px`;
    };
    fitToViewport();
    wideQuery.addEventListener("change", fitToViewport);
    window.addEventListener("resize", fitToViewport);
    window.addEventListener("scroll", fitToViewport, { passive: true });
    return () => {
      wideQuery.removeEventListener("change", fitToViewport);
      window.removeEventListener("resize", fitToViewport);
      window.removeEventListener("scroll", fitToViewport);
    };
  }, []);

  useEffect(() => {
    if (!hasMore) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const loadMore = () => {
      setVisibleCount((current) =>
        nextHistoryVisibleCount(current, entries.length),
      );
    };
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) loadMore();
      },
      { root, rootMargin: "160px" },
    );
    observer.observe(sentinel);
    const rootBox = root.getBoundingClientRect();
    if (sentinel.getBoundingClientRect().top < rootBox.bottom + 160) loadMore();
    return () => observer.disconnect();
  }, [entries.length, hasMore]);

  return (
    <Card
      className="flex min-h-0 min-w-0 flex-col gap-0 overflow-hidden xl:sticky xl:top-16"
      data-testid="environment-history"
      ref={frameRef}
      size="sm"
    >
      <CardHeader className="shrink-0 border-b pb-3">
        <CardTitle>
          <h2>History</h2>
        </CardTitle>
        <CardDescription>
          Who published, and which variables moved. Rollback writes a new
          Revision. It does not erase this one.
        </CardDescription>
      </CardHeader>
      <CardContent
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0"
        ref={scrollRef}
      >
        {entries.length === 0 ? (
          <p className="px-3 py-5 text-sm text-muted-foreground">
            Nothing published yet. The first publish starts this Environment.
          </p>
        ) : (
          <div>
            {groups.map((group) => (
              <section key={group.label}>
                <h3
                  className="sticky top-0 z-10 bg-card px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                  suppressHydrationWarning
                >
                  {group.label}
                </h3>
                <ul className="divide-y divide-border/70">
                  {group.entries.map((entry) => {
                    const current = entry.revisionId === headRevision;
                    return (
                      <li
                        className="flex items-start gap-2.5 px-3 py-2 hover:bg-muted/20"
                        key={entry.revisionId}
                      >
                        <Avatar className="mt-0.5" size="sm">
                          <AvatarFallback>
                            {authorInitials(entry.authorLabel)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <p className="truncate text-[13px] font-medium leading-5">
                              {entry.authorLabel}
                            </p>
                            <time
                              className="shrink-0 text-[11px] text-muted-foreground"
                              dateTime={new Date(
                                entry.authoredAtMs,
                              ).toISOString()}
                              suppressHydrationWarning
                              title={new Date(
                                entry.authoredAtMs,
                              ).toLocaleString("en-GB")}
                            >
                              {formatRelativeTime(entry.authoredAtMs)}
                            </time>
                          </div>
                          <HistoryDelta entry={entry} />
                        </div>
                        {current ? (
                          <span className="mt-0.5 shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-primary">
                            Live
                          </span>
                        ) : (
                          <Button
                            className="mt-0.5 shrink-0"
                            onClick={() => onRollback(entry.revisionId)}
                            size="xs"
                            variant="ghost"
                          >
                            <RotateCcw aria-hidden="true" /> Rollback
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {hasMore ? (
              <div
                className="h-8"
                data-testid="history-load-more"
                ref={sentinelRef}
              />
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
