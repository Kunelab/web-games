#!/usr/bin/env bash
# Online backup of the SQLite database, safe to run while the app is up.
#
# Copying the file directly is not safe: the database runs in WAL mode, so a plain
# `cp` can catch a checkpoint halfway and produce a corrupt copy. `.backup` uses
# SQLite's own backup API, which takes a consistent snapshot under load.
#
# Usage:
#   scripts/backup-db.sh [database-file] [backup-directory]
#
# Defaults match the Docker layout (/data/kune.db -> /data/backups). For the bare
# install, pass the paths: scripts/backup-db.sh apps/back/kune.db /srv/backups
#
# Cron example (nightly at 04:10, keep the last 30):
#   10 4 * * * /srv/web-games/scripts/backup-db.sh /data/kune.db /data/backups
# Or through Docker:
#   10 4 * * * docker compose -f /srv/web-games/docker-compose.yml exec -T web-games \
#     /app/scripts/backup-db.sh
set -euo pipefail

DB_FILE="${1:-/data/kune.db}"
BACKUP_DIR="${2:-/data/backups}"
KEEP=30

if [ ! -f "$DB_FILE" ]; then
  echo "no database at $DB_FILE" >&2
  exit 1
fi

command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/kune-$STAMP.db"

sqlite3 "$DB_FILE" ".backup '$TARGET'"
gzip "$TARGET"

# Rotation: newest $KEEP stay, the rest go.
ls -1t "$BACKUP_DIR"/kune-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

echo "backed up $DB_FILE -> $TARGET.gz"
