#!/usr/bin/env bash
# Create + start the "momo" OpenWA session, then print the QR as a PNG file.
# Usage: OPENWA_URL=http://localhost:2785 ./scripts/create-session.sh
# (API key is read from OPENWA_API_KEY or ./data/.api-key)
set -euo pipefail

OPENWA_URL="${OPENWA_URL:-http://localhost:2785}"
SESSION_NAME="${OPENWA_SESSION_NAME:-momo}"
API_KEY="${OPENWA_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f data/.api-key ]; then
  API_KEY="$(tr -d '\r\n' < data/.api-key)"
fi
if [ -z "$API_KEY" ]; then
  echo "ERROR: set OPENWA_API_KEY or run from a dir containing data/.api-key" >&2
  exit 1
fi

AUTH=(-H "X-API-Key: $API_KEY" -H "Content-Type: application/json")

echo "== creating session '$SESSION_NAME' =="
curl -sS -X POST "$OPENWA_URL/api/sessions" "${AUTH[@]}" -d "{\"name\":\"$SESSION_NAME\",\"config\":{\"autoReconnect\":true}}" || true

echo "== starting session =="
curl -sS -X POST "$OPENWA_URL/api/sessions/$SESSION_NAME/start" "${AUTH[@]}" || true
echo

for i in $(seq 1 15); do
  sleep 2
  STATUS="$(curl -sS "$OPENWA_URL/api/sessions/$SESSION_NAME" "${AUTH[@]}" || true)"
  echo "status: $(echo "$STATUS" | grep -o '"status":"[^"]*"' || echo unknown)"
  if echo "$STATUS" | grep -q '"status":"qr_ready"'; then
    break
  fi
done

echo "== fetching QR =="
curl -sS "$OPENWA_URL/api/sessions/$SESSION_NAME/qr" "${AUTH[@]}" \
  | python3 -c "
import json, base64, sys
d = json.load(sys.stdin)
png = d['qrCode'].split(',', 1)[1]
open('qr.png', 'wb').write(base64.b64decode(png))
print('QR saved to qr.png - scan it with WhatsApp > Linked Devices')
"
echo "Also available at: $OPENWA_URL (dashboard)"