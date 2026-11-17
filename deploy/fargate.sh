#!/usr/bin/env bash
# Deploy to ECS Fargate: build the image in CodeBuild (no local Docker), push to ECR, roll the service.
#   AWS_PROFILE=agentcore-bootstrap-source bash deploy/fargate.sh
# Re-run to ship a new version. Live games carry over: the old task saves them to DynamoDB and
# hands every browser to the new task (see "Games survive deploys" in the README).
set -euo pipefail
cd "$(dirname "$0")/.."

# Use access keys from the environment if present; otherwise a named profile.
if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]; then export AWS_PROFILE="${AWS_PROFILE:-agentcore-bootstrap-source}"; fi
export AWS_REGION="${AWS_REGION:-us-east-1}"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-800002328643}"
BUILD_STACK="${BUILD_STACK:-oauth-mcp-cards-build}"
# The site lives at jdetle.com/games (via a Cloudflare Worker), so it is built and served under that prefix.
# It used to live at /mcp-oauth; links there are redirected.
BASE_PATH="${BASE_PATH-/games}"
LEGACY_BASE_PATH="${LEGACY_BASE_PATH-/mcp-oauth}"
APP_STACK="${APP_STACK:-oauth-mcp-cards-app}"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ -n "$EXPECTED_ACCOUNT" && "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]]; then
  echo "Refusing: credentials are for account $ACCOUNT, expected $EXPECTED_ACCOUNT"; exit 1
fi
echo "Account $ACCOUNT, region $AWS_REGION, as $(aws sts get-caller-identity --query Arn --output text)"

out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

echo "==> Build pipeline stack ($BUILD_STACK)"
aws cloudformation deploy --stack-name "$BUILD_STACK" --template-file deploy/build.yaml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
REPO="$(out "$BUILD_STACK" RepositoryUri)"; BUCKET="$(out "$BUILD_STACK" SourceBucket)"; PROJECT="$(out "$BUILD_STACK" Project)"

TAG="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo local)"
echo "==> Uploading source (tag $TAG)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# tracked + new (not ignored) files only: no node_modules, targets or secrets
git ls-files -co --exclude-standard | grep -v '^deploy/' | zip -q "$TMP/source.zip" -@
aws s3 cp --only-show-errors "$TMP/source.zip" "s3://$BUCKET/source.zip"

# Telemetry IDs (the same projects as jdetle.com), kept in SSM so forks of this repo don't
# report into them. One KEY=VALUE per line; set with deploy/telemetry.sh. All are public values.
TELEMETRY_PARAM="${TELEMETRY_PARAM:-/oauth-mcp-cards/telemetry}"
OVERRIDES=("name=IMAGE_TAG,value=$TAG" "name=BASE_PATH,value=$BASE_PATH" "name=RELEASE,value=$TAG")
if TELEMETRY="$(aws ssm get-parameter --name "$TELEMETRY_PARAM" --query Parameter.Value --output text 2>/dev/null)"; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^(NEXT_PUBLIC_[A-Z0-9_]+|S10_INGEST_KEY|S10_INGEST_URL)$ && -n "$v" ]] && OVERRIDES+=("name=$k,value=$v")
  done <<< "$TELEMETRY"
  echo "    telemetry: $(( ${#OVERRIDES[@]} - 3 )) settings from $TELEMETRY_PARAM"
else
  echo "    telemetry: off (run deploy/telemetry.sh)"
fi

echo "==> Building image in CodeBuild"
BUILD_ID="$(aws codebuild start-build --project-name "$PROJECT" --environment-variables-override "${OVERRIDES[@]}" --query build.id --output text)"
while :; do
  STATUS="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text)"
  PHASE="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].currentPhase' --output text)"
  echo "    $STATUS / $PHASE"
  [[ "$STATUS" == "IN_PROGRESS" ]] || break
  sleep 20
done
if [[ "$STATUS" != "SUCCEEDED" ]]; then
  echo "Build $STATUS. Logs:"; aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].logs.deepLink' --output text; exit 1
fi

PL="$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)"
# Optional secrets, kept in SSM Parameter Store (set with `bun run admin:password` / deploy/turnstile.sh)
ADMIN_PARAM="${ADMIN_HASH_PARAM:-/oauth-mcp-cards/admin-password-hash}"
TS_SECRET_PARAM="${TURNSTILE_SECRET_PARAM:-/oauth-mcp-cards/turnstile-secret}"
TS_SITE_PARAM="${TURNSTILE_SITE_PARAM:-/oauth-mcp-cards/turnstile-site-key}"
has_param() { aws ssm get-parameter --name "$1" --query Parameter.Name --output text >/dev/null 2>&1; }
EXTRA=()
if has_param "$ADMIN_PARAM"; then EXTRA+=("AdminHashParam=$ADMIN_PARAM"); echo "    admin: enabled"; else EXTRA+=("AdminHashParam="); echo "    admin: disabled (run: bun run admin:password)"; fi
if has_param "$TS_SECRET_PARAM" && has_param "$TS_SITE_PARAM"; then
  EXTRA+=("TurnstileSiteKey=$(aws ssm get-parameter --name "$TS_SITE_PARAM" --query Parameter.Value --output text)" "TurnstileSecretParam=$TS_SECRET_PARAM"); echo "    bot check (Turnstile): enabled"
else
  EXTRA+=("TurnstileSiteKey=" "TurnstileSecretParam="); echo "    bot check (Turnstile): disabled"
fi

# Session cookies are signed with one secret shared by every task, so a deploy doesn't sign
# anyone out. Generated once, here, straight into SSM (never printed).
SESSION_PARAM="${SESSION_SECRET_PARAM:-/oauth-mcp-cards/session-secret}"
if ! has_param "$SESSION_PARAM"; then
  aws ssm put-parameter --name "$SESSION_PARAM" --type SecureString --value "$(openssl rand -hex 32)" >/dev/null
  echo "    session secret: created in $SESSION_PARAM"
fi
EXTRA+=("SessionSecretParam=$SESSION_PARAM")

EDGE_PARAM="${EDGE_KEY_PARAM:-/oauth-mcp-cards/edge-public-key}"
if has_param "$EDGE_PARAM"; then EXTRA+=("EdgePublicKey=$(aws ssm get-parameter --name "$EDGE_PARAM" --query Parameter.Value --output text)"); echo "    edge-signed visitor addresses: on"; else EXTRA+=("EdgePublicKey="); fi
EXTRA+=("BasePath=$BASE_PATH" "LegacyBasePath=$LEGACY_BASE_PATH")

echo "==> App stack ($APP_STACK) with $REPO:$TAG"
aws cloudformation deploy --stack-name "$APP_STACK" --template-file deploy/app.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides "ImageUri=$REPO:$TAG" "CloudFrontPrefixList=$PL" "${EXTRA[@]}" --no-fail-on-empty-changeset

URL="$(out "$APP_STACK" Url)"
echo "==> Waiting for $URL/api/health (site: $URL$BASE_PATH/)"
for _ in $(seq 1 60); do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then echo; echo "Live: $URL"; exit 0; fi
  sleep 10
done
echo "Deployed, but $URL isn't answering yet (CloudFront can take a few minutes). Check: aws logs tail $(out "$APP_STACK" LogGroup) --follow"
