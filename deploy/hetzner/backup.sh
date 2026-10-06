#!/usr/bin/env bash
# Nightly backup of the Portal Hub.
#
#   1. pg_dump of the database (custom format), encrypted with age for an OFFLINE recipient key. The private key is never on this server.
#   2. Optional: a versioned copy of the encrypted file store (only when files are kept on local disk, STORAGE_DRIVER=fs).
#   3. rclone copy to the Hetzner Storage Box, then pruning of everything older than KEEP_DAYS (35 days by default).
#
# The master keys are NOT part of this backup and must never be stored next to it. Keep the offline copies described in the guide.
# Run from cron as root (see deploy/hetzner/README.md). A non zero exit code means the backup is not complete: cron mails the output.
#
# Settings (environment, all optional):
#   DB_CONTAINER         name of the database container                          (default kph-db-1)
#   BACKUP_DIR           local folder for recent dumps                           (default /srv/kph/backups)
#   AGE_RECIPIENT_FILE   file with the PUBLIC age recipient(s) only              (default /srv/kph/secrets/backup-recipient.txt)
#   RCLONE_REMOTE        rclone path on the Storage Box, for example kphbox:kph  (default kphbox:kph-backups)
#   KEEP_DAYS            how long dumps are kept, locally and remotely           (default 35)
#   INCLUDE_STORAGE      yes | no: also copy the file store                      (default no)
#   STORAGE_PATH         the file store on this server                           (default /srv/kph/data/storage)
#   MIN_DUMP_BYTES       refuse a dump smaller than this                         (default 20000)
set -Eeuo pipefail
umask 077

DB_CONTAINER="${DB_CONTAINER:-kph-db-1}"
BACKUP_DIR="${BACKUP_DIR:-/srv/kph/backups}"
AGE_RECIPIENT_FILE="${AGE_RECIPIENT_FILE:-/srv/kph/secrets/backup-recipient.txt}"
RCLONE_REMOTE="${RCLONE_REMOTE:-kphbox:kph-backups}"
KEEP_DAYS="${KEEP_DAYS:-35}"
INCLUDE_STORAGE="${INCLUDE_STORAGE:-no}"
STORAGE_PATH="${STORAGE_PATH:-/srv/kph/data/storage}"
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-20000}"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*" >&2; exit 1; }
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    log "FAILED (exit $rc)" >&2
    date -u +%FT%TZ > "$BACKUP_DIR/last-failure" 2>/dev/null || true
  fi
  rm -f "${TMP_OUT:-}" 2>/dev/null || true
}
trap on_exit EXIT

command -v age >/dev/null || fail "age is not installed (apt install age)"
command -v rclone >/dev/null || fail "rclone is not installed (apt install rclone)"
command -v docker >/dev/null || fail "docker is not installed"
[ -r "$AGE_RECIPIENT_FILE" ] || fail "recipient file $AGE_RECIPIENT_FILE not found"
# A private key next to the backups would defeat the encryption.
if grep -q 'AGE-SECRET-KEY' "$AGE_RECIPIENT_FILE"; then
  fail "$AGE_RECIPIENT_FILE contains a PRIVATE key. Keep only the public recipient (age1...) on this server."
fi
grep -q '^age1' "$AGE_RECIPIENT_FILE" || fail "$AGE_RECIPIENT_FILE holds no age recipient (a line starting with age1)"
docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true || fail "database container $DB_CONTAINER is not running"

mkdir -p "$BACKUP_DIR/db"
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || fail "another backup is still running"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="kph-db-$TS.dump.age"
TMP_OUT="$BACKUP_DIR/db/.$NAME.part"
OUT="$BACKUP_DIR/db/$NAME"

# 1. Database dump, encrypted on the fly. The password is read inside the container, never on the command line of the host.
log "dumping the database"
docker exec -i "$DB_CONTAINER" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner --no-acl' \
  | age --recipients-file "$AGE_RECIPIENT_FILE" --output "$TMP_OUT"
SIZE="$(stat -c %s "$TMP_OUT")"
[ "$SIZE" -ge "$MIN_DUMP_BYTES" ] || fail "the dump is only $SIZE bytes, which is too small to be right"
mv "$TMP_OUT" "$OUT"
( cd "$BACKUP_DIR/db" && sha256sum "$NAME" > "$NAME.sha256" )
log "dump written: $NAME ($SIZE bytes)"

# 2. Upload and verify (rclone compares size and checksum after the copy).
log "uploading to $RCLONE_REMOTE"
rclone copy "$BACKUP_DIR/db" "$RCLONE_REMOTE/db" --include "$NAME" --include "$NAME.sha256" --checksum --retries 3 --low-level-retries 5
rclone check "$BACKUP_DIR/db" "$RCLONE_REMOTE/db" --include "$NAME" --one-way --quiet || fail "the uploaded copy does not match the local dump"

# 3. File store (ciphertext only). Deleted or replaced files are kept in a dated folder for KEEP_DAYS, then removed.
if [ "$INCLUDE_STORAGE" = "yes" ]; then
  [ -d "$STORAGE_PATH" ] || fail "STORAGE_PATH $STORAGE_PATH does not exist"
  log "syncing the encrypted file store"
  rclone sync "$STORAGE_PATH" "$RCLONE_REMOTE/storage" --backup-dir "$RCLONE_REMOTE/storage-versions/$TS" --checksum --transfers 4 --retries 3
  rclone delete "$RCLONE_REMOTE/storage-versions" --min-age "${KEEP_DAYS}d" --rmdirs || true
fi

# 4. Retention: 35 days, locally and remotely. Purged patient data leaves the backups within that time.
log "removing dumps older than $KEEP_DAYS days"
find "$BACKUP_DIR/db" -maxdepth 1 -type f \( -name 'kph-db-*.dump.age' -o -name 'kph-db-*.dump.age.sha256' \) -mtime "+$KEEP_DAYS" -delete
rclone delete "$RCLONE_REMOTE/db" --min-age "${KEEP_DAYS}d" --include 'kph-db-*.dump.age' --include 'kph-db-*.dump.age.sha256'

printf '%s %s %s\n' "$TS" "$NAME" "$SIZE" > "$BACKUP_DIR/last-success"
rm -f "$BACKUP_DIR/last-failure"
log "done"
