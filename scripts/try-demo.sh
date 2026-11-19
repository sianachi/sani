#!/bin/sh
# Request the built-in demo ticket and wait until a person approves it.
# Requires SANI_AGENT_KEY. SANI_URL defaults to http://127.0.0.1:8765.
set -eu

url="${SANI_URL:-http://127.0.0.1:8765}"
url="${url%/}"
if [ -z "${SANI_AGENT_KEY:-}" ]; then
  printf 'Set SANI_AGENT_KEY to the agent token from the Sani console.\n' >&2
  exit 1
fi
command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; exit 1; }

mcp() {
  curl -sS --max-time 20 "$url/mcp" \
    -H "Authorization: Bearer $SANI_AGENT_KEY" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$1"
}

field() {
  # $1 JSON, $2 key. Uses the last unescaped occurrence, which is structuredContent.
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

request=$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"request_action","arguments":{"connection":"demo","tool":"lookup_ticket","args":{"id":"1001"}}}}')
printf '%s\n' "$request"
case "$request" in
  *'"isError":true'*) exit 1 ;;
esac

id=$(field "$request" id)
approval=$(field "$request" approvalUrl)
printf '%s\n' "$id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
  || { printf 'Could not read the request id.\n' >&2; exit 1; }
case "$approval" in
  "$url"/requests/*) ;;
  *) printf 'Could not read the approval URL.\n' >&2; exit 1 ;;
esac

printf 'Approve this request in your browser:\n%s\n' "$approval"
printf 'Waiting for a decision...\n'

i=0
while [ "$i" -lt 90 ]; do
  result=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_request\",\"arguments\":{\"id\":\"$id\"}}}")
  status=$(field "$result" status)
  if [ -n "$status" ] && [ "$status" != "pending" ]; then
    printf '%s\n' "$result"
    [ "$status" = "succeeded" ]
    exit
  fi
  i=$((i + 1))
  sleep 2
done
printf 'The request was still pending.\n' >&2
exit 1
