import type { NextConfig } from "next";

// Static export: the front end is plain files (S3 + CloudFront); all game logic runs on PartyKit.
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default config;
