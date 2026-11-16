import type { NextConfig } from "next";

// Static export: the front end is plain files (S3 + CloudFront); all game logic runs on PartyKit.
// NEXT_PUBLIC_BASE_PATH=/mcp-oauth builds the site to live under that prefix (jdetle.com/mcp-oauth).
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const config: NextConfig = {
  output: "export",
  ...(basePath ? { basePath } : {}),
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default config;
