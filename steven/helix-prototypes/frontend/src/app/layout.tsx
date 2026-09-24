import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
// v1 tokens + shared components (owned by UI step 0).
import "../styles/helix-v1.css";
// Lane-owned view styles, pre-wired so lanes never edit this layout.
import "../styles/views/upload.css";
import "../styles/views/agent.css";
import "../styles/views/traceability.css";
import "../styles/views/review.css";
// Legacy pre-v1 panels (removed as lanes replace them).
import "./globals.css";

export const metadata: Metadata = {
  title: "HELIX | Nonclinical report workbench",
  description: "Synthetic evidence-to-report workflow for nonclinical study pattern testing.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
