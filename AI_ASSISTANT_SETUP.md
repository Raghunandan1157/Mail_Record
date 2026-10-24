# AI Assistant — Setup

Minimal DeepSeek-only text chat for global admin. Read-only data snapshot Q&A.

## Required env vars

The site runs on Vercel as project `navachetana-mailrecord` (team raghu-45b8): Settings → Environment
Variables, **Production**. A standby copy runs on the AWS server as `mail-record` with the same settings
in `/opt/sites/mail-record/shared/.env` (`~/Desktop/AWS-Hosting/local/push-env.sh mail-record <file>`):

| Key | Value |
|---|---|
| `DEEPSEEK_KEY` | Your DeepSeek API key (`sk-...`) |
| `DEEPSEEK_MODEL` | `deepseek-chat` (V3.2) or `deepseek-reasoner` (R1) — anything else is rejected and falls back to `deepseek-chat` |
| `SUPABASE_URL` | `https://zovnmmdfthpbubrorsgh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → `service_role` key |
| `SESSION_SECRET` | random string that signs login tokens (`openssl rand -hex 32`) |

Deploy: `vercel deploy --prod` from a clean copy of the repo (the AWS standby: `~/Desktop/AWS-Hosting/local/deploy-mail-record.sh`).

## Verify env is loaded

Hit `https://navachetana-mailrecord.vercel.app/api/health` in the browser. Returns:

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
