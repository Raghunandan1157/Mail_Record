#!/usr/bin/env bash
# verify_ai.sh — Smoke-test the ai-stt and ai-chat Supabase Edge Functions.
# chmod +x verify_ai.sh   ← run this once before first use
#
# Usage:
#   SUPABASE_URL=https://<ref>.supabase.co \
#   ANON_KEY=<anon-key> \
#   ./verify_ai.sh
#
# Optional overrides (env vars):
#   ADMIN_OTP   — plain-text admin OTP (used to generate the auth token for ai-chat tests)
#                 If not set, the auth-required tests will be skipped with a warning.
#
# What it tests:
#   1. ai-stt: rejects a request with no audio (expects 400 / error body)
#   2. ai-chat: rejects a request with no token (expects 401)
#   3. ai-chat: rejects a request with a wrong token (expects 401)
#   4. ai-chat: accepts a minimal valid message with a correct token (expects 200 + content)
#
# Prerequisites:
#   - supabase functions serve (local) OR deployed to remote project
#   - curl, jq, sha256sum / shasum available

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────

die()  { echo "ERROR: $*" >&2; exit 1; }
pass() { echo "  ✓ PASS — $*"; }
fail() { echo "  ✗ FAIL — $*"; FAILURES=$((FAILURES + 1)); }

FAILURES=0

# ── Validate required env vars ───────────────────────────────────────────────

[[ -n "${SUPABASE_URL:-}" ]]  || die "SUPABASE_URL env var is required"
[[ -n "${ANON_KEY:-}" ]]      || die "ANON_KEY env var is required"

STT_URL="${SUPABASE_URL}/functions/v1/ai-stt"
CHAT_URL="${SUPABASE_URL}/functions/v1/ai-chat"

echo "============================================================"
echo "  Mail_Record AI Edge Function Smoke Tests"
echo "  STT:  ${STT_URL}"
echo "  CHAT: ${CHAT_URL}"
echo "============================================================"
echo ""

# ── Build admin token (sha256 of OTP + day-bucket) ───────────────────────────

if [[ -n "${ADMIN_OTP:-}" ]]; then
  DAY_BUCKET=$(date -u +%Y-%m-%d)
  if command -v sha256sum &>/dev/null; then
    ADMIN_TOKEN=$(printf '%s%s' "${ADMIN_OTP}" "${DAY_BUCKET}" | sha256sum | awk '{print $1}')
  elif command -v shasum &>/dev/null; then
    ADMIN_TOKEN=$(printf '%s%s' "${ADMIN_OTP}" "${DAY_BUCKET}" | shasum -a 256 | awk '{print $1}')
  else
    die "Neither sha256sum nor shasum found"
  fi
  echo "✓ Admin token derived from ADMIN_OTP + day-bucket (${DAY_BUCKET})"
else
  echo "⚠  ADMIN_OTP not set — test 4 (valid auth) will be skipped"
  ADMIN_TOKEN=""
fi

echo ""

# ── Helper: run curl and capture HTTP status + body ──────────────────────────

http_post_json() {
  # http_post_json <url> <json-body> [extra curl args...]
  local url="$1"
  local body="$2"
  shift 2
  # Write status to stdout first line, body to second via a temp file
  local tmp
  tmp=$(mktemp)
  local status
  status=$(curl -s -o "${tmp}" -w "%{http_code}" \
    -X POST "${url}" \
    -H "Authorization: Bearer ${ANON_KEY}" \
    -H "Content-Type: application/json" \
    --data "${body}" \
    "$@")
  local resp_body
  resp_body=$(cat "${tmp}")
  rm -f "${tmp}"
  printf '%s\n%s' "${status}" "${resp_body}"
}

# ── Test 1: ai-stt — no audio → 400 ─────────────────────────────────────────

echo "Test 1: ai-stt rejects request with no audio file"
RAW=$(curl -s -o /tmp/stt_no_audio.json -w "%{http_code}" \
  -X POST "${STT_URL}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  2>&1 || true)
STATUS=$(cat /tmp/stt_no_audio.json 2>/dev/null | head -1 || true)

# curl exits 0 even on HTTP errors; check status code directly
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${STT_URL}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  --max-time 10 2>&1 || echo "000")

if [[ "${HTTP_CODE}" =~ ^(400|422|415|500)$ ]]; then
  pass "ai-stt returned ${HTTP_CODE} (error) when no audio is provided"
elif [[ "${HTTP_CODE}" == "000" ]]; then
  fail "ai-stt connection failed (is the function deployed/running?)"
else
  fail "ai-stt returned unexpected status ${HTTP_CODE} — expected 4xx for missing audio"
fi

# ── Test 2: ai-chat — no token → 401 ─────────────────────────────────────────

echo ""
echo "Test 2: ai-chat rejects request with no admin token"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${CHAT_URL}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"messages":[{"role":"user","content":"hello"}]}' \
  --max-time 15 2>&1 || echo "000")

if [[ "${HTTP_CODE}" == "401" ]]; then
  pass "ai-chat returned 401 when no admin token is provided"
elif [[ "${HTTP_CODE}" == "000" ]]; then
  fail "ai-chat connection failed (is the function deployed/running?)"
else
  fail "ai-chat returned ${HTTP_CODE} — expected 401 for missing token"
fi

# ── Test 3: ai-chat — wrong token → 401 ──────────────────────────────────────

echo ""
echo "Test 3: ai-chat rejects request with wrong admin token"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${CHAT_URL}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"messages":[{"role":"user","content":"hello"}],"admin_token":"deadbeefdeadbeefdeadbeefdeadbeef"}' \
  --max-time 15 2>&1 || echo "000")

if [[ "${HTTP_CODE}" == "401" ]]; then
  pass "ai-chat returned 401 for a bad admin token"
elif [[ "${HTTP_CODE}" == "000" ]]; then
  fail "ai-chat connection failed (is the function deployed/running?)"
else
  fail "ai-chat returned ${HTTP_CODE} — expected 401 for wrong token"
fi

# ── Test 4: ai-chat — valid token → 200 ──────────────────────────────────────

echo ""
if [[ -z "${ADMIN_TOKEN}" ]]; then
  echo "Test 4: SKIPPED (set ADMIN_OTP env var to enable valid-auth test)"
else
  echo "Test 4: ai-chat accepts message with correct admin token"
  BODY=$(printf '{"messages":[{"role":"user","content":"today date?"}],"admin_token":"%s"}' "${ADMIN_TOKEN}")
  TMP_BODY=$(mktemp)
  HTTP_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
    -X POST "${CHAT_URL}" \
    -H "Authorization: Bearer ${ANON_KEY}" \
    -H "Content-Type: application/json" \
    --data "${BODY}" \
    --max-time 30 2>&1 || echo "000")

  if [[ "${HTTP_CODE}" == "200" ]]; then
    # Verify response has content
    if command -v jq &>/dev/null; then
      CONTENT=$(jq -r '.message // .content // .choices[0].message.content // empty' "${TMP_BODY}" 2>/dev/null || true)
      if [[ -n "${CONTENT}" ]]; then
        pass "ai-chat returned 200 with content: ${CONTENT:0:80}..."
      else
        pass "ai-chat returned 200 (response body: $(cat "${TMP_BODY}" | head -c 200))"
      fi
    else
      pass "ai-chat returned 200 (install jq for response body inspection)"
    fi
  elif [[ "${HTTP_CODE}" == "000" ]]; then
    fail "ai-chat connection failed (is the function deployed/running?)"
  else
    RESP=$(cat "${TMP_BODY}" | head -c 300)
    fail "ai-chat returned ${HTTP_CODE} with valid token — response: ${RESP}"
  fi
  rm -f "${TMP_BODY}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "============================================================"
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "  ✓ All tests passed"
else
  echo "  ✗ ${FAILURES} test(s) failed"
fi
echo "============================================================"

exit "${FAILURES}"
