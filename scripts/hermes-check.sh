#!/usr/bin/env bash
# Run this INSIDE WSL, on the machine where Hermes lives, with the server running on Windows.
# It checks the same things Hermes needs and prints the config.yaml entry to use.
#
#   scripts/hermes-check.sh                 # finds the Windows host itself, default port
#   scripts/hermes-check.sh 172.28.176.1    # explicit host
#   scripts/hermes-check.sh 172.28.176.1 8789 mcpt
#
# Exit code 0 = every check passed. Nothing here changes anything.
set -u

PORT="${2:-8789}"
KEY="${3:-mcpt}"

if [ -n "${1:-}" ]; then
  HOST="$1"
else
  # WSL2 in NAT mode: the default gateway is the Windows side of the vEthernet (WSL) adapter.
  HOST="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
  if [ -z "${HOST:-}" ]; then
    echo "Could not detect the Windows host. Pass it as the first argument." >&2
    echo "(In WSL mirrored-networking mode, 127.0.0.1 reaches Windows services.)" >&2
    exit 2
  fi
fi

URL="http://${HOST}:${PORT}/mcp"
FAILED=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=$((FAILED + 1)); }

echo "checking ${URL}"
echo

# 1. Is anything answering on that address at all? (Firewall, wrong host, server not running.)
if curl -sS -m 5 -o /dev/null "http://${HOST}:${PORT}/api/state" 2>/dev/null; then
  pass "the server answers at ${HOST}:${PORT}"
else
  fail "no answer from ${HOST}:${PORT} — is it running on Windows, and does the firewall rule allow this WSL subnet?"
fi

# 2. A bare GET on /mcp must be the MCP transport's 406 JSON, never the dashboard HTML.
BARE_CODE="$(curl -sS -m 5 -o /tmp/mcp-bare.$$ -w '%{http_code}' "$URL" 2>/dev/null || true)"
BARE_CODE="${BARE_CODE:-000}"
if [ "$BARE_CODE" = "406" ] && grep -q "Not Acceptable" /tmp/mcp-bare.$$ 2>/dev/null; then
  pass "bare GET /mcp answers MCP's 406 (not the dashboard)"
else
  fail "bare GET /mcp answered HTTP ${BARE_CODE}, expected 406 Not Acceptable"
fi

# 3. A real handshake: initialize must return a session id.
INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hermes-check","version":"0.0.0"}}}'
HEADERS="$(curl -sS -m 10 -D - -o /tmp/mcp-init.$$ -X POST "$URL" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' -d "$INIT_BODY" 2>/dev/null || true)"
SESSION="$(printf '%s' "$HEADERS" | awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub(/\r/,""); print $2; exit}')"
if [ -n "$SESSION" ]; then
  pass "initialize returned a session id (${SESSION:0:8}…)"
else
  fail "initialize returned no mcp-session-id"
fi

# 4. The session must list tools.
if [ -n "$SESSION" ]; then
  curl -sS -m 5 -o /dev/null -X POST "$URL" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-06-18' \
    -H "mcp-session-id: ${SESSION}" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' 2>/dev/null
  TOOLS="$(curl -sS -m 5 -X POST "$URL" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-06-18' \
    -H "mcp-session-id: ${SESSION}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' 2>/dev/null)"
  COUNT="$(printf '%s' "$TOOLS" | grep -o '"name":"[a-z_]*"' | wc -l | tr -d ' ')"
  if [ "${COUNT:-0}" -gt 0 ]; then
    pass "tools/list returned ${COUNT} tool(s)"
  else
    fail "tools/list returned no tools"
  fi
  curl -sS -m 5 -o /dev/null -X DELETE "$URL" -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: ${SESSION}" -H 'MCP-Protocol-Version: 2025-06-18' 2>/dev/null
fi

rm -f /tmp/mcp-bare.$$ /tmp/mcp-init.$$

echo
if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed. Put this in ~/.hermes/config.yaml:"
  echo
  echo "  mcp_servers:"
  echo "    ${KEY}:"
  echo "      url: ${URL}"
  echo "      enabled: true"
  echo
  echo "Then in Hermes: manage_connections install, and after every server restart manage_connections enable."
  echo "Tools appear as mcp__${KEY}__<tool>."
  exit 0
fi
echo "${FAILED} check(s) failed — see docs/HERMES-CONTRACT.md, section \"When it does not work\"."
exit 1
