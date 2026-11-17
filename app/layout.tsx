import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WakingBanner } from "../src/ui/Waking.tsx";
import { TelemetryStart } from "../src/ui/TelemetryStart.tsx";

export const metadata: Metadata = {
  title: "OAuth for MCP",
  description: "A multiplayer card game that teaches the auth flows an MCP server can rely on.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WakingBanner />
        {children}
        <TelemetryStart />
      </body>
    </html>
  );
}
