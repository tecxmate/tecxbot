#!/bin/bash
# Trigger the archive-media cron job from a machine that is on 24/7.
#
# Vercel Cron on the Hobby plan runs at most once a day, which leaves a long
# window where LINE media can expire before it is archived to R2. This script
# is the frequent driver; the daily Vercel Cron in vercel.json stays as a
# backstop for when this machine is down.
#
# Setup (on the always-on machine):
#   mkdir -p ~/.tecxbot
#   printf 'CRON_SECRET=%s\n' '<the value from Vercel>' > ~/.tecxbot/cron.env
#   chmod 600 ~/.tecxbot/cron.env
#
# Then install the launchd agent — see scripts/com.tecxmate.archive-media.plist.

set -uo pipefail

BASE_URL="${TECXBOT_BASE_URL:-https://bot.tecxmate.com}"
ENV_FILE="${TECXBOT_ENV_FILE:-$HOME/.tecxbot/cron.env}"

if [ ! -r "$ENV_FILE" ]; then
  echo "$(date -u +%FT%TZ) fatal: cannot read $ENV_FILE" >&2
  exit 78 # EX_CONFIG
fi

# shellcheck source=/dev/null
set -a; . "$ENV_FILE"; set +a

if [ -z "${CRON_SECRET:-}" ]; then
  echo "$(date -u +%FT%TZ) fatal: CRON_SECRET is not set in $ENV_FILE" >&2
  exit 78
fi

# The secret goes in the Authorization header, not the query string, so it does
# not land in access logs or `ps` output.
response=$(curl -fsS --max-time 120 --retry 3 --retry-delay 5 --retry-connrefused \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${BASE_URL}/api/archive-media" 2>&1)
status=$?

if [ $status -ne 0 ]; then
  echo "$(date -u +%FT%TZ) archive-media FAILED (curl exit $status): ${response}" >&2
  exit $status
fi

echo "$(date -u +%FT%TZ) archive-media ok: ${response}"
