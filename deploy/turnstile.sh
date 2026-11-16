#!/usr/bin/env bash
# Store the Cloudflare Turnstile keys for the deployed site (takes effect on the next deploy).
#   bash deploy/turnstile.sh <site-key>
# The site key is public. The secret key is prompted for (hidden) and goes only to
# AWS SSM Parameter Store as a SecureString. Find it in the Cloudflare dashboard:
# Turnstile → your widget → Settings → Secret key.
set -euo pipefail
SITE_KEY="${1:?usage: bash deploy/turnstile.sh <site-key>}"
if [[ -z "${AWS_ACCESS_KEY_ID:-}" && -f "$HOME/.env" ]] && grep -q 'AWS_ACCESS_KEY_ID' "$HOME/.env"; then
  set -a; source "$HOME/.env" >/dev/null 2>&1; set +a; unset OPENAI_API_KEY
fi
export AWS_REGION="${AWS_REGION:-us-east-1}"
aws sts get-caller-identity >/dev/null
read -r -s -p "Turnstile secret key (hidden): " SECRET; echo
[[ ${#SECRET} -ge 20 ]] || { echo "That doesn't look like a Turnstile secret. Nothing changed."; exit 1; }
aws ssm put-parameter --name /oauth-mcp-cards/turnstile-site-key --type String --value "$SITE_KEY" --overwrite >/dev/null
aws ssm put-parameter --name /oauth-mcp-cards/turnstile-secret --type SecureString --value "$SECRET" --overwrite >/dev/null
unset SECRET
echo "Saved. The bot check turns on with the next deploy: bun run deploy"
