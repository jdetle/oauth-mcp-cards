#!/usr/bin/env bash
# Deploy the static front end to S3 + CloudFront. Idempotent: re-run to ship updates.
#   NEXT_PUBLIC_PARTYKIT_HOST=oauth-mcp-cards.<you>.partykit.dev bash deploy/aws-cloudfront.sh
# Needs: AWS CLI v2 with credentials (aws configure / aws sso login / AWS_PROFILE), bun.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NEXT_PUBLIC_PARTYKIT_HOST:?Set NEXT_PUBLIC_PARTYKIT_HOST to the deployed PartyKit host (run: bun run deploy:party)}"
STACK="${STACK:-oauth-mcp-cards-web}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

command -v aws >/dev/null || { echo "AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"; exit 1; }
echo "Deploying as: $(aws sts get-caller-identity --query Arn --output text)"

echo "Building static site against PartyKit host ${NEXT_PUBLIC_PARTYKIT_HOST}…"
NEXT_PUBLIC_PARTYKIT_HOST="$NEXT_PUBLIC_PARTYKIT_HOST" bun run build

echo "Deploying CloudFormation stack ${STACK} in ${REGION}…"
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file deploy/cloudfront.yaml \
  --parameter-overrides "PartyHost=${NEXT_PUBLIC_PARTYKIT_HOST}" \
  --no-fail-on-empty-changeset

out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET="$(out BucketName)"; DIST="$(out DistributionId)"; URL="$(out Url)"

echo "Uploading to s3://${BUCKET}…"
aws s3 sync out "s3://${BUCKET}" --delete --exclude "_next/static/*" --cache-control "public,max-age=0,must-revalidate"
aws s3 sync out/_next/static "s3://${BUCKET}/_next/static" --cache-control "public,max-age=31536000,immutable"

echo "Invalidating CloudFront cache…"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text

echo
echo "Done: ${URL}"
