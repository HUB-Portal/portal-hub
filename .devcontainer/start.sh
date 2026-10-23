#!/usr/bin/env bash
# Runs every time the Codespace starts: brings the database up and serves the built app on port 4000.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run db:up
for _ in $(seq 1 60); do
  docker compose -f deploy/docker-compose.dev.yml exec -T db pg_isready -U kph_owner -d kph >/dev/null 2>&1 && break
  sleep 2
done

if ! curl -fs http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
  nohup npm start >hub.log 2>&1 &
  for _ in $(seq 1 30); do
    curl -fs http://127.0.0.1:4000/api/health >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo
echo "Portal Hub is running. Open the forwarded port 4000 (Ports tab) and sign in."
echo "The sign in page cannot list the demo accounts through the forwarded address, so use this:"
echo "  npm run -w server demo-accounts"
echo
npm run -s -w server demo-accounts || true
