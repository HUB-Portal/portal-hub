#!/usr/bin/env bash
# Runs once when the Codespace is created: installs, creates the demo database and builds the app.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci
npm run -w server init-dev

# Links in the app (emails, invites) must point at the forwarded address of this Codespace.
if [ -n "${CODESPACE_NAME:-}" ]; then
  url="https://${CODESPACE_NAME}-4000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=${url}|" server/.env
fi

npm run db:up
for _ in $(seq 1 60); do
  docker compose -f deploy/docker-compose.dev.yml exec -T db pg_isready -U kph_owner -d kph >/dev/null 2>&1 && break
  sleep 2
done

npm run migrate
npm run seed
npm run build
