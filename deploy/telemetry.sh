#!/usr/bin/env bash
# Store the telemetry IDs (the same s10 / Sentry / PostHog / GA4 / Clarity / Meta / Plausible
# projects as jdetle.com) in SSM, where deploy/fargate.sh picks them up as build args.
# Every value here is public (it ships in jdetle.com's JavaScript); SSM only keeps forks of
# this public repo from reporting into those projects.
#   bash deploy/telemetry.sh KEY=VALUE [KEY=VALUE ...]
# Keys: S10_INGEST_KEY S10_INGEST_URL NEXT_PUBLIC_SENTRY_DSN NEXT_PUBLIC_POSTHOG_KEY NEXT_PUBLIC_POSTHOG_HOST
#       NEXT_PUBLIC_GA4_ID NEXT_PUBLIC_CLARITY_ID NEXT_PUBLIC_META_PIXEL_ID NEXT_PUBLIC_PLAUSIBLE_SCRIPT_ID
set -euo pipefail
if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]; then export AWS_PROFILE="${AWS_PROFILE:-agentcore-bootstrap-source}"; fi
export AWS_REGION="${AWS_REGION:-us-east-1}"
PARAM="${TELEMETRY_PARAM:-/oauth-mcp-cards/telemetry}"
[[ $# -gt 0 ]] || { sed -n '2,9p' "$0"; exit 1; }
for kv in "$@"; do [[ "$kv" =~ ^(NEXT_PUBLIC_[A-Z0-9_]+|S10_INGEST_KEY|S10_INGEST_URL)=[^[:space:]]+$ ]] || { echo "bad setting: ${kv%%=*}"; exit 1; }; done
aws ssm put-parameter --name "$PARAM" --type String --overwrite --value "$(printf '%s\n' "$@")" >/dev/null
echo "stored $# telemetry settings in $PARAM"
