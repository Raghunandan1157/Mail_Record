# AI Assistant — Setup

Minimal DeepSeek-only text chat for global admin. Read-only data snapshot Q&A.

## Required Vercel env vars

Vercel dashboard → mail-record → Settings → Environment Variables → add for **Production + Preview + Development**:

| Key | Value |
|---|---|
| `DEEPSEEK_KEY` | Your DeepSeek API key (`sk-...`) |
| `DEEPSEEK_MODEL` | `deepseek-chat` (V3.2) or `deepseek-reasoner` (R1) — anything else is rejected and falls back to `deepseek-chat` |
| `SUPABASE_URL` | `https://zovnmmdfthpbubrorsgh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → `service_role` key |

After setting → Deployments → latest → ⋯ → Redeploy.

## Verify env is loaded

Hit `https://mail-record.vercel.app/api/health` in the browser. Returns:

```json
{
  "ok": true,
  "env": {
    "DEEPSEEK_KEY": true,
    "DEEPSEEK_MODEL": "deepseek-chat",
    "SUPABASE_URL": true,
    "SUPABASE_SERVICE_ROLE_KEY": true
  }
}
```

`ok: false` means at least one env var missing.

## DB migration

Already applied via Supabase MCP. To re-run manually: paste `ai_chat_log.sql` into Supabase SQL Editor.

## Auth flow

- Browser admin login → OTP entered → stored in `sessionStorage.ai_otp` + `localStorage.ai_otp` (plain).
- Chat POST sends `{otp, messages}` → edge fn looks up `app_config.value` where `key='admin_otp'` → string equality.
- No hashing, no daily rotation, no session tokens.
