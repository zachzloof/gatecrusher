import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { SystemStatusBanner } from "@/components/system-status-banner";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Gatecrusher",
    template: "%s — Gatecrusher",
  },
  description: "Classify a SoundCloud playlist and work through its free-download gates.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <div className="flex min-h-dvh flex-col sm:flex-row">
          <Nav />
          {/* Bottom padding keeps content clear of the mobile bottom bar. */}
          <div className="flex min-w-0 flex-1 flex-col pb-14 sm:pb-0">
            <SystemStatusBanner />
            <main className="mx-auto w-full max-w-content flex-1 px-4 py-6 lg:px-6">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
