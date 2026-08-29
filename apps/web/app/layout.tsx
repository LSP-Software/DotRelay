import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: {
    default: "DotRelay — client-encrypted configuration",
    template: "%s · DotRelay",
  },
  description: "Client-encrypted collaboration context",
};

const RootLayout = ({ children }: Readonly<{ children: ReactNode }>) => {
  return (
    <html
      lang="en"
      className={cn("dark font-sans", geist.variable, geistMono.variable)}
      data-scroll-behavior="smooth"
    >
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
};

export default RootLayout;
