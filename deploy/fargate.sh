#!/usr/bin/env bash
# Deploy to ECS Fargate: build the image in CodeBuild (no local Docker), push to ECR, roll the service.
#   AWS_PROFILE=agentcore-bootstrap-source bash deploy/fargate.sh
# Re-run to ship a new version. Open games are lost on each deploy (state is in memory).
set -euo pipefail
cd "$(dirname "$0")/.."

# Use access keys from the environment if present; otherwise a named profile.
if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]; then export AWS_PROFILE="${AWS_PROFILE:-agentcore-bootstrap-source}"; fi
export AWS_REGION="${AWS_REGION:-us-east-1}"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-800002328643}"
BUILD_STACK="${BUILD_STACK:-oauth-mcp-cards-build}"
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

echo "==> Building image in CodeBuild"
BUILD_ID="$(aws codebuild start-build --project-name "$PROJECT" --environment-variables-override "name=IMAGE_TAG,value=$TAG" --query build.id --output text)"
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
echo "==> App stack ($APP_STACK) with $REPO:$TAG"
aws cloudformation deploy --stack-name "$APP_STACK" --template-file deploy/app.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides "ImageUri=$REPO:$TAG" "CloudFrontPrefixList=$PL" --no-fail-on-empty-changeset

URL="$(out "$APP_STACK" Url)"
echo "==> Waiting for $URL/api/health"
for _ in $(seq 1 60); do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then echo; echo "Live: $URL"; exit 0; fi
  sleep 10
done
echo "Deployed, but $URL isn't answering yet (CloudFront can take a few minutes). Check: aws logs tail $(out "$APP_STACK" LogGroup) --follow"
