#!/usr/bin/env bash
# Deploys a branch on the server from git: pull, back up, build, restart, check.
#
# Run it on the server, from the checkout that holds docker-compose.yml and .env:
#   scripts/deploy.sh                 # main
#   scripts/deploy.sh my-branch       # try a branch before merging it into main
#
# What runs is always a pushed commit: the server pulls it from origin and builds
# it itself, never an image or files copied from somebody's working tree. The
# running container carries the commit as the `git.commit` label:
#   docker inspect -f '{{index .Config.Labels "git.commit"}}' web-games-web-games-1
#
# The build goes through the capped buildx builder (see "If you must build on the
# server anyway" in the README): an uncapped build has powered the box off.
# BUILDX_BUILDER overrides its name.
set -euo pipefail

BRANCH="${1:-main}"
BUILDER="${BUILDX_BUILDER:-limite}"

cd "$(dirname "$0")/.."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "tracked files are modified in $(pwd): commit them upstream instead" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "no buildx builder named '$BUILDER': refusing to build uncapped (see README)" >&2
  exit 1
fi

git fetch origin "$BRANCH"
git checkout -q "$BRANCH"
git pull -q --ff-only origin "$BRANCH"
COMMIT="$(git rev-parse --short HEAD)"
echo "deploying $BRANCH at $COMMIT: $(git log -1 --format=%s | cut -c1-100)"

# A snapshot before the new code touches the database (it may migrate it).
if docker compose ps --status running --services | grep -qx web-games; then
  docker compose exec -T web-games /app/scripts/backup-db.sh
else
  echo "container not running: no backup taken"
fi

GIT_COMMIT="$COMMIT" BUILDX_BUILDER="$BUILDER" docker compose build
docker compose up -d --no-build

for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)" = 200 ]; then
    echo "up: $COMMIT"
    exit 0
  fi
  sleep 2
done
echo "the app did not answer on :3000 within a minute: docker compose logs web-games" >&2
exit 1
