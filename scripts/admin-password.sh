#!/usr/bin/env bash
# Set the admin password. You type it here (hidden); only a scrypt hash is kept:
#   - locally in .env.admin (gitignored), read by `bun run start`
#   - in AWS SSM Parameter Store as a SecureString, read by the Fargate task on the next deploy
# The password itself is never written anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=server/target/release/oauth-mcp-server
[[ -x "$BIN" ]] || (cd server && cargo build --release -q)

read -r -s -p "New admin password (12+ characters): " P1; echo
read -r -s -p "Type it again: " P2; echo
if [[ "$P1" != "$P2" ]]; then echo "They don't match. Nothing changed."; exit 1; fi
HASH="$(printf '%s\n' "$P1" | "$BIN" hash-password)"
unset P1 P2

umask 077
printf 'ADMIN_PASSWORD_HASH=%s\n' "$HASH" > .env.admin
echo "Saved the hash to .env.admin (local runs)."

# AWS: use keys already in the environment, else the ones in ~/.env, else the default profile
if [[ -z "${AWS_ACCESS_KEY_ID:-}" && -f "$HOME/.env" ]] && grep -q 'AWS_ACCESS_KEY_ID' "$HOME/.env"; then
  set -a; source "$HOME/.env" >/dev/null 2>&1; set +a; unset OPENAI_API_KEY
fi
export AWS_REGION="${AWS_REGION:-us-east-1}"
PARAM="${ADMIN_HASH_PARAM:-/oauth-mcp-cards/admin-password-hash}"
if command -v aws >/dev/null && aws sts get-caller-identity >/dev/null 2>&1; then
  aws ssm put-parameter --name "$PARAM" --type SecureString --value "$HASH" --overwrite >/dev/null
  echo "Saved the hash to AWS SSM ($PARAM, $AWS_REGION). It takes effect on the next deploy: bun run deploy"
else
  echo "No working AWS credentials found, so the deployed site was not updated."
fi
