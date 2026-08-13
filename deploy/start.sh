#!/usr/bin/env bash
# Single-container orchestrator: restore -> OpenWA + bot + router + backup cron.
# Runs as PID 1's child via the official image's dumb-init/gosu entrypoint.
set -euo pipefail

export OPENWA_PORT="${OPENWA_PORT:-2790}"
export BOT_PORT="${BOT_PORT:-3001}"
export ROUTER_PORT="${PORT:-2785}"
export OPENWA_DATA_DIR="${OPENWA_DATA_DIR:-/app/data}"

log() { echo "[start] $(date -Iseconds) $*"; }

# 1. Restore persisted state (WhatsApp session creds, DB, API keys) from object store.
if command -v /usr/local/bin/restore-download.sh >/dev/null 2>&1; then
  /usr/local/bin/restore-download.sh || log "restore failed (continuing)"
fi

PIDS=""
cleanup() {
  # Try to persist state one last time before the platform kills us.
  if [ -n "${BACKUP_REMOTE:-}" ] && command -v /usr/local/bin/backup-upload.sh >/dev/null 2>&1; then
    /usr/local/bin/backup-upload.sh || log "final backup failed"
  fi
  kill $PIDS 2>/dev/null || true
}
trap cleanup TERM INT

# 2. Backup cron: first run 3 min after boot (captures QR-scan creds), then every 15 min.
if [ -n "${BACKUP_REMOTE:-}" ] && command -v /usr/local/bin/backup-upload.sh >/dev/null 2>&1; then
  (
    sleep 180
    while true; do
      /usr/local/bin/backup-upload.sh || log "backup failed"
      sleep "${BACKUP_INTERVAL_SECONDS:-900}"
    done
  ) &
  PIDS="$PIDS $!"
  log "backup cron enabled -> $BACKUP_REMOTE"
fi

# 3. OpenWA gateway (Baileys engine). Heap-capped for 512 MB free-tier hosts.
NODE_ENV=production \
  PORT="$OPENWA_PORT" \
  BIND_HOST=0.0.0.0 \
  WEBHOOK_SHUTDOWN_DRAIN_MS=10000 \
  NODE_OPTIONS="${OPENWA_NODE_OPTIONS:---max-old-space-size=256}" \
  node dist/main &
PIDS="$PIDS $!"
log "openwa starting on :$OPENWA_PORT"

# 4. Bot (webhook receiver + download-link logic).
NODE_ENV=production BOT_PORT="$BOT_PORT" node /bot/dist/index.js &
PIDS="$PIDS $!"
log "bot starting on :$BOT_PORT"

# 5. Router: public port -> /webhook + /health to bot, everything else to OpenWA.
PORT="$ROUTER_PORT" BOT_PORT="$BOT_PORT" OPENWA_PORT="$OPENWA_PORT" node /usr/local/bin/momo-router.js &
PIDS="$PIDS $!"
log "router starting on :$ROUTER_PORT"

wait