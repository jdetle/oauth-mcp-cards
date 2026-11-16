#!/usr/bin/env bash
# Deploy the multiplayer server to PartyKit (needs `bunx partykit login` once).
# Generates the INTERNAL_SECRET the lobby and game rooms share, unless you pass one.
set -euo pipefail
cd "$(dirname "$0")/.."
bun run scenarios
SECRET="${INTERNAL_SECRET:-$(openssl rand -hex 24)}"
bunx partykit deploy --var "INTERNAL_SECRET=${SECRET}"
