#!/usr/bin/env bash
# Read-only Redmine probe for the dsh-superagent-redmine Source (docs/02-方案.md §16.3).
# It sends GET requests only and never writes an issue, note, or attachment.
# Usage:
#   export REDMINE_URL=http://redmine.example.com
#   export REDMINE_API_KEY=...
#   export REDMINE_PROJECT=my-project   # identifier or numeric id
#   ./scripts/probe-redmine.sh
set -euo pipefail

BASE=${REDMINE_URL:-http://redmine.example.com}
: "${REDMINE_API_KEY:?export REDMINE_API_KEY first}"
: "${REDMINE_PROJECT:?export REDMINE_PROJECT (identifier or numeric id)}"
BASE=${BASE%/}
H=(-H "X-Redmine-API-Key: $REDMINE_API_KEY" -H 'Accept: application/json')

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

echo "== me =="
curl -sS "${H[@]}" "$BASE/users/current.json" \
  | jq '.user | {id, login, name: ([.firstname, .lastname] | map(select(. != null)) | join(" "))}'

echo "== project =="
TMP_PROJECT=$(mktemp)
trap 'rm -f "$TMP_PROJECT" "$TMP_ISSUES"' EXIT
TMP_ISSUES=$(mktemp)
curl -sS "${H[@]}" "$BASE/projects/$REDMINE_PROJECT.json" | tee "$TMP_PROJECT" | jq '.project | {id, identifier, name}'
PID=$(jq -r '.project.id // empty' "$TMP_PROJECT")
[ -n "$PID" ] || { echo "project not visible; check the identifier and the account's role" >&2; exit 1; }

echo "== visible issues (total_count) =="
curl -sS "${H[@]}" "$BASE/issues.json?project_id=$PID&status_id=*&limit=1" | jq '{total_count, limit}'

echo "== updated_on timestamp filter (200 = supported, 422 = date-only) =="
curl -sS "${H[@]}" -o /dev/null -w '%{http_code}\n' \
  "$BASE/issues.json?status_id=*&limit=1&updated_on=%3E%3D$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== newest issue and its real timestamp shape =="
curl -sS "${H[@]}" "$BASE/issues.json?project_id=$PID&status_id=*&sort=updated_on:desc,id:desc&limit=1" \
  | tee "$TMP_ISSUES" | jq '.issues[0] | {id, updated_on, created_on}'
ID=$(jq -r '.issues[0].id // empty' "$TMP_ISSUES")

if [ -n "$ID" ]; then
  echo "== journals / attachments (shape only) =="
  curl -sS "${H[@]}" "$BASE/issues/$ID.json?include=journals,attachments" \
    | jq '.issue | {status, journal: (.journals[-1] // null | if . == null then null else {id, user, notes, created_on, private_notes, details} end),
                      attachment: (.attachments[0] // null)}'
  ATT=$(curl -sS "${H[@]}" "$BASE/issues/$ID.json?include=attachments" | jq -r '.issue.attachments[0].id // empty')
  if [ -n "$ATT" ]; then
    echo "== attachment metadata =="
    curl -sS "${H[@]}" "$BASE/attachments/$ATT.json" | jq '.attachment | {id, filename, content_type, filesize, content_url}'
  fi
fi

echo "== ?key= fallback (200 = the query-key mode works through the proxy) =="
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/users/current.json?key=$REDMINE_API_KEY"

echo "== done: paste the output into docs/02-方案.md §16.1 =="
