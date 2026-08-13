#!/usr/bin/env bash
# Uploads a tarball of OpenWA's data dir (session creds + DB + API keys) to a
# free object store via rclone. Configure with:
#   BACKUP_REMOTE   e.g. "b2:momo-backup" or "r2:momo-backup" (required)
#   RCLONE_CONFIG_* env vars for the remote (see README)
#   OPENWA_DATA_DIR data dir to archive (default /app/data)
set -euo pipefail

: "${BACKUP_REMOTE:?BACKUP_REMOTE is required (e.g. b2:momo-backup)}"
DATA_DIR="${OPENWA_DATA_DIR:-/app/data}"
WORK_DIR="${BACKUP_WORK_DIR:-/tmp/momo-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-3}"

[ -d "$DATA_DIR" ] || { echo "[backup] $DATA_DIR missing, skipping"; exit 0; }

mkdir -p "$WORK_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$WORK_DIR/momo-backup-$TIMESTAMP.tar.gz"

tar -czf "$ARCHIVE" -C "$DATA_DIR" .
rclone copyto "$ARCHIVE" "$BACKUP_REMOTE/$(basename "$ARCHIVE")"
rclone delete --min-age "${RETENTION_DAYS}d" "$BACKUP_REMOTE" || true

echo "[backup] uploaded $(basename "$ARCHIVE") to $BACKUP_REMOTE"
rm -f "$ARCHIVE"