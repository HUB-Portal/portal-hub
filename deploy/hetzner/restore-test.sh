#!/usr/bin/env bash
# Monthly restore test: proves that a backup can really be restored and that the audit chain is intact.
#
# It takes the newest encrypted dump (from the Storage Box, or a file you name), decrypts it with the OFFLINE age identity,
# restores it into a throw away PostgreSQL container that has no network, runs sanity checks and throws everything away.
# Only counts are printed, never names or other patient data.
#
# Usage:
#   AGE_IDENTITY=/path/to/age-identity.txt  ./restore-test.sh                   # newest dump from the Storage Box
#   AGE_IDENTITY=/path/to/age-identity.txt  ./restore-test.sh /path/to/kph-db-....dump.age
#
# The identity (private key) should not live on the server. Copy it to a tmpfs (/dev/shm) for the test and delete it afterwards,
# or run this script on your own computer after pulling a dump with rclone.
#
# Settings: RCLONE_REMOTE (default kphbox:kph-backups), WORK_DIR (default /dev/shm), PG_IMAGE (default postgres:16-alpine),
#           EXPECTED_MIGRATIONS (default: number of files in server/migrations next to this script, if found),
#           MAX_AGE_HOURS (how old the newest dump may be before a warning, default 30).
set -Eeuo pipefail
umask 077

: "${AGE_IDENTITY:?Set AGE_IDENTITY to the path of the age identity (private key) file}"
RCLONE_REMOTE="${RCLONE_REMOTE:-kphbox:kph-backups}"
WORK_DIR="${WORK_DIR:-/dev/shm}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-30}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${EXPECTED_MIGRATIONS:-}" ] && [ -d "$HERE/../../server/migrations" ]; then
  EXPECTED_MIGRATIONS="$(find "$HERE/../../server/migrations" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
fi

log() { printf '%s restore-test: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*" >&2; exit 1; }

CONTAINER="kph-restore-test-$$"
TMP="$(mktemp -d "$WORK_DIR/kph-restore.XXXXXX")"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

command -v age >/dev/null || fail "age is not installed"
command -v docker >/dev/null || fail "docker is not installed"
[ -r "$AGE_IDENTITY" ] || fail "cannot read the identity file $AGE_IDENTITY"

if [ $# -ge 1 ]; then
  FILE="$1"
  [ -r "$FILE" ] || fail "cannot read $FILE"
else
  command -v rclone >/dev/null || fail "rclone is not installed"
  NAME="$(rclone lsf "$RCLONE_REMOTE/db" --include 'kph-db-*.dump.age' | sort | tail -n 1)"
  [ -n "$NAME" ] || fail "no dump found in $RCLONE_REMOTE/db"
  log "newest dump on the Storage Box: $NAME"
  rclone copy "$RCLONE_REMOTE/db" "$TMP" --include "$NAME" --include "$NAME.sha256"
  FILE="$TMP/$NAME"
  if [ -f "$FILE.sha256" ]; then
    ( cd "$TMP" && sha256sum -c "$NAME.sha256" >/dev/null ) || fail "the downloaded dump does not match its checksum"
  fi
fi

# How old is it? The name holds the time: kph-db-YYYYMMDDTHHMMSSZ.dump.age
STAMP="$(basename "$FILE" | sed -n 's/^kph-db-\([0-9]\{8\}T[0-9]\{6\}Z\)\.dump\.age$/\1/p')"
if [ -n "$STAMP" ]; then
  THEN="$(date -u -d "${STAMP:0:4}-${STAMP:4:2}-${STAMP:6:2} ${STAMP:9:2}:${STAMP:11:2}:${STAMP:13:2}" +%s 2>/dev/null || echo 0)"
  AGE_H=$(( ( $(date -u +%s) - THEN ) / 3600 ))
  log "the dump is about $AGE_H hour(s) old"
  if [ "$THEN" -le 0 ] || [ "$AGE_H" -gt "$MAX_AGE_HOURS" ]; then
    log "WARNING: the dump is older than $MAX_AGE_HOURS hours. Check that the nightly backup is running."
  fi
fi

log "decrypting"
age --decrypt --identity "$AGE_IDENTITY" --output "$TMP/db.dump" "$FILE"

log "starting a throw away database without network"
PW="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name "$CONTAINER" --network none -e POSTGRES_USER=kph_owner -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=kph "$PG_IMAGE" >/dev/null
# The image starts a temporary server to initialise, stops it, then starts the real one: wait for the real one.
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" sh -c 'pg_isready -q -U kph_owner -d kph && [ -f /var/lib/postgresql/data/postmaster.pid ]' 2>/dev/null \
     && docker logs "$CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete'; then
    break
  fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -q -U kph_owner -d kph || fail "the test database did not start"

docker cp "$TMP/db.dump" "$CONTAINER:/tmp/db.dump"
log "restoring"
docker exec -e PGPASSWORD="$PW" "$CONTAINER" pg_restore -h localhost -U kph_owner -d kph --no-owner --no-acl --exit-on-error /tmp/db.dump

q() { docker exec -e PGPASSWORD="$PW" "$CONTAINER" psql -h localhost -U kph_owner -d kph -At -c "$1"; }

TABLES="$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
MIGRATIONS="$(q "SELECT count(*) FROM schema_migrations")"
ORGS="$(q "SELECT count(*) FROM organizations")"
USERS="$(q "SELECT count(*) FROM users")"
CASES="$(q "SELECT count(*) FROM cases")"
FILES="$(q "SELECT count(*) FROM files WHERE state <> 'purged'")"
AUDIT="$(q "SELECT ok || ' ' || checked FROM kph_audit_verify()")"
LAST="$(q "SELECT COALESCE(to_char(max(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), 'none') FROM audit_log")"

log "tables: $TABLES, migrations: $MIGRATIONS, organisations: $ORGS, users: $USERS, cases: $CASES, files: $FILES"
log "audit chain (ok, entries checked): $AUDIT, newest entry: $LAST UTC"

[ "$TABLES" -ge 25 ] || fail "too few tables ($TABLES)"
[ "$ORGS" -ge 1 ] || fail "no organisations in the restored database"
case "$AUDIT" in
  "true "*) ;;
  *) fail "the audit chain does not verify: $AUDIT" ;;
esac
if [ -n "${EXPECTED_MIGRATIONS:-}" ] && [ "$MIGRATIONS" -ne "$EXPECTED_MIGRATIONS" ]; then
  log "WARNING: the backup has $MIGRATIONS migrations but this checkout has $EXPECTED_MIGRATIONS (normal right after an upgrade; run the migrate command after a real restore)"
fi
log "OK: the backup can be restored. Delete the identity file from this machine if you copied it here."
