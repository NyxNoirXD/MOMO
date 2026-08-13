#!/usr/bin/env bash
# Register the bot webhook on the OpenWA session.
# Usage:
#   OPENWA_URL=http://localhost:2785 \
#   OPENWA_PUBLIC_URL=https://momo-anime-bot.onrender.com \
#   WEBHOOK_SECRET=mysecret ./scripts/register-webhook.sh
set -euo pipefail

OPENWA_URL="${OPENWA_URL:-http://localhost:2785}"
SESSION_NAME="${OPENWA_SESSION_NAME:-momo}"
PUBLIC_URL="${OPENWA_PUBLIC_URL:?set OPENWA_PUBLIC_URL (your public bot URL)}"
SECRET="${WEBHOOK_SECRET:?set WEBHOOK_SECRET}"
API_KEY="${OPENWA_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f data/.api-key ]; then
  API_KEY="$(tr -d '\r\n' < data/.api-key)"
fi
if [ -z "$API_KEY" ]; then
  echo "ERROR: set OPENWA_API_KEY or run from a dir containing data/.api-key" >&2
  exit 1
fi

WEBHOOK_URL="${PUBLIC_URL%/}/webhook"
echo "== registering webhook $WEBHOOK_URL =="
curl -sS -X POST "$OPENWA_URL/api/sessions/$SESSION_NAME/webhooks" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"url\":\"$WEBHOOK_URL\",\"events\":[\"message.received\"],\"secret\":\"$SECRET\",\"retryCount\":3}"
echo