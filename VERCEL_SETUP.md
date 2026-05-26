# Vercel deploy setup — AI Assistant

## One-time env vars (Vercel dashboard → Project → Settings → Environment Variables)

Set these for **Production + Preview + Development**:

| Key | Value source |
|---|---|
| `OPENAI_API_KEY` | `~/Desktop/Coll_Db/server/.env` line 2 |
| `DEEPSEEK_KEY` | `~/Desktop/Coll_Db/server/.env` line 11 |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` (or `deepseek-chat` for V3.2) |
| `SUPABASE_URL` | `https://zovnmmdfthpbubrorsgh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → service_role key |

## DB migration (run once)

```sql
-- paste contents of ai_chat_log.sql into Supabase SQL editor
```

## After env vars set

Vercel auto-deploys on push. After deploy:
- `https://mail-record.vercel.app/api/ai-chat` — POST endpoint
- `https://mail-record.vercel.app/api/ai-stt` — POST endpoint
- `https://mail-record.vercel.app/ai_assistant.html` — UI

Same origin = no CORS issues.

## Token model

Browser computes `sha256(admin_otp + "YYYY-MM-DD")` after global admin login. Server fetches `admin_otp` from `app_config` table at request time and validates. Token rotates daily automatically.
