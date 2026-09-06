"use client";

import { ChevronUp, LogOut, Settings } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type UserSessionCardProps = Readonly<{
  readonly displayName?: string;
  readonly sessionActive: boolean;
  readonly onOpenSettings: () => void;
  readonly onSignIn: () => void;
  readonly onSignOut: () => void;
}>;

const initialsFor = (name: string): string => name.slice(0, 2).toUpperCase();

export const UserSessionCard = ({
  displayName,
  sessionActive,
  onOpenSettings,
  onSignIn,
  onSignOut,
}: UserSessionCardProps) => {
  const label = displayName ?? "Signed out";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="Open user menu"
            className={cn(
              "flex w-full items-center gap-3 rounded-lg p-1 text-left outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
            )}
            type="button"
          />
        }
      >
        <Avatar size="sm">
          <AvatarFallback>{initialsFor(label)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {sessionActive ? "Signed in" : "Sign in required"}
          </p>
        </div>
        <ChevronUp
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" side="top">
        {sessionActive ? (
          <>
            <DropdownMenuItem onClick={onOpenSettings}>
              <Settings aria-hidden="true" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut} variant="destructive">
              <LogOut aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onClick={onSignIn}>Sign in</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
