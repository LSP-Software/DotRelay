import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The Geist fonts resolve from the checked-in `geist` package instead of a
// remote font service, so the web build is deterministic in restricted and
// self-hosted environments with no general outbound access.

export const metadata: Metadata = {
  title: {
    default: "DotRelay — shared .env files for your team",
    template: "%s · DotRelay",
  },
  description:
    "DotRelay shares your project's .env files with your team and your other machines. Values are encrypted on your device before they leave it, so only your team can read them.",
};

const RootLayout = ({ children }: Readonly<{ children: ReactNode }>) => {
  return (
    <html
      lang="en"
      className={cn("dark font-sans", GeistSans.variable, GeistMono.variable)}
      data-scroll-behavior="smooth"
    >
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
};

export default RootLayout;
