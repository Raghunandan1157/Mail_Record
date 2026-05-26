#!/usr/bin/env bash
# setup_ai_secrets.sh — Bootstrap Supabase secrets for the AI Assistant module.
# chmod +x setup_ai_secrets.sh   ← run this once before first use
#
# Usage:
#   ./setup_ai_secrets.sh
#
# What it does:
#   1. Reads OPENAI_API_KEY and DEEPSEEK_KEY from ~/Desktop/Coll_Db/server/.env
#   2. Prompts you for the current ADMIN_OTP value (4-digit PIN from app_config)
#   3. SHA-256 hashes the OTP and stores it as ADMIN_OTP_HASH
#   4. Calls `supabase secrets set` to push all secrets to the linked project
#
# Prerequisites:
#   - supabase CLI installed and authenticated (`supabase login`)
#   - Project linked (`supabase link --project-ref <ref>`)

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

# ── Locate .env file ─────────────────────────────────────────────────────────

ENV_FILE="${HOME}/Desktop/Coll_Db/server/.env"
[[ -f "${ENV_FILE}" ]] || die ".env file not found at ${ENV_FILE}"

# ── Parse keys from .env (handles KEY=value and KEY="value") ─────────────────

parse_env_key() {
  local key="$1"
  local value
  value=$(grep -E "^${key}=" "${ENV_FILE}" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [[ -n "${value}" ]] || die "Key '${key}' not found or empty in ${ENV_FILE}"
  printf '%s' "${value}"
}

OPENAI_API_KEY=$(parse_env_key "OPENAI_API_KEY")
DEEPSEEK_KEY=$(parse_env_key "DEEPSEEK_KEY")

echo "✓ Read OPENAI_API_KEY from ${ENV_FILE}"
echo "✓ Read DEEPSEEK_KEY    from ${ENV_FILE}"

# ── Prompt for ADMIN_OTP and hash it ─────────────────────────────────────────

echo ""
echo "Enter the current ADMIN_OTP value (the admin PIN stored in app_config.admin_otp)."
echo "It will be SHA-256 hashed and stored as ADMIN_OTP_HASH — never stored in plain text."
read -rsp "ADMIN_OTP: " ADMIN_OTP_RAW
echo ""
[[ -n "${ADMIN_OTP_RAW}" ]] || die "ADMIN_OTP cannot be empty"

# sha256sum is available on Linux; shasum -a 256 on macOS
if command -v sha256sum &>/dev/null; then
  ADMIN_OTP_HASH=$(printf '%s' "${ADMIN_OTP_RAW}" | sha256sum | awk '{print $1}')
elif command -v shasum &>/dev/null; then
  ADMIN_OTP_HASH=$(printf '%s' "${ADMIN_OTP_RAW}" | shasum -a 256 | awk '{print $1}')
else
  die "Neither sha256sum nor shasum found — cannot hash the OTP"
fi

echo "✓ ADMIN_OTP hashed (SHA-256): ${ADMIN_OTP_HASH}"

# ── Push secrets to Supabase ─────────────────────────────────────────────────

echo ""
echo "Pushing secrets to Supabase (requires CLI login + linked project)..."

supabase secrets set \
  "OPENAI_API_KEY=${OPENAI_API_KEY}" \
  "DEEPSEEK_KEY=${DEEPSEEK_KEY}" \
  "DEEPSEEK_MODEL=deepseek-v4-pro" \
  "ADMIN_OTP_HASH=${ADMIN_OTP_HASH}"

echo ""
echo "✓ All secrets set successfully."
echo ""
echo "Secrets configured:"
echo "  OPENAI_API_KEY   — OpenAI STT key (gpt-4o-mini-transcribe)"
echo "  DEEPSEEK_KEY     — DeepSeek chat key (deepseek-v4-pro)"
echo "  DEEPSEEK_MODEL   — deepseek-v4-pro"
echo "  ADMIN_OTP_HASH   — SHA-256 of admin OTP (used by ai-chat edge fn for auth)"
echo ""
echo "Note: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically"
echo "      by the Supabase runtime — no manual set needed."
