#!/usr/bin/env bash
# Downloads the most recent backup from the object store and restores it into
# OPENWA_DATA_DIR. No-op (exit 0) when BACKUP_REMOTE is unset or empty, so the
# image also boots fine for local/dev use without object storage.
#   BACKUP_REMOTE   e.g. "b2:momo-backup" or "r2:momo-backup"
#   OPENWA_DATA_DIR data dir to restore into (default /app/data)
set -euo pipefail

REMOTE="${BACKUP_REMOTE:-}"
DATA_DIR="${OPENWA_DATA_DIR:-/app/data}"
WORK_DIR="${BACKUP_WORK_DIR:-/tmp/momo-backups}"

if [ -z "$REMOTE" ]; then
  echo "[restore] BACKUP_REMOTE unset, skipping restore"
  exit 0
fi

LATEST="$(rclone lsf "$REMOTE" | sort | tail -1 || true)"
if [ -z "$LATEST" ]; then
  echo "[restore] no backups found in $REMOTE, first boot"
  exit 0
fi

mkdir -p "$WORK_DIR" "$DATA_DIR"
rclone copyto "$REMOTE/$LATEST" "$WORK_DIR/restore.tar.gz"
rm -rf "$DATA_DIR"/* "$DATA_DIR"/.[!.]* 2>/dev/null || true
tar -xzf "$WORK_DIR/restore.tar.gz" -C "$DATA_DIR"
rm -f "$WORK_DIR/restore.tar.gz"
echo "[restore] restored $LATEST into $DATA_DIR"