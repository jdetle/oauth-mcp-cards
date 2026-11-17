import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WakingBanner } from "../src/ui/Waking.tsx";
import { TelemetryStart } from "../src/ui/TelemetryStart.tsx";

// The site lives under a path on jdetle.com, so icons and the share image carry that prefix,
// and the share image is absolute (link previews fetch it from outside).
const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://jdetle.com").replace(/\/$/, "");
const TITLE = "Trust//Chain: card games about who to trust";
const DESCRIPTION = "Multiplayer card games that teach security by playing it: OAuth for MCP, agent security and more. Four seats, one chain: check before you trust.";

export const metadata: Metadata = {
  metadataBase: new URL(ORIGIN),
  title: { default: TITLE, template: "%s · Trust//Chain" },
  description: DESCRIPTION,
  icons: { icon: [{ url: `${BASE}/favicon.svg`, type: "image/svg+xml" }], apple: `${BASE}/apple-touch-icon.png` },
  openGraph: {
    type: "website",
    siteName: "Trust//Chain",
    title: TITLE,
    description: DESCRIPTION,
    url: `${ORIGIN}${BASE}/`,
    images: [{ url: `${ORIGIN}${BASE}/og.png`, width: 1200, height: 630, alt: "Trust//Chain: four seats joined in a chain, a slip passing between two of them" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [`${ORIGIN}${BASE}/og.png`] },
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
