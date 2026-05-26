-- Run in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- Schema for AI Assistant module — ai_chat_sessions audit table
-- Part of Task #3: SQL migration + RLS for AI chat logging

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id           BIGSERIAL PRIMARY KEY,
  admin_id     TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  transcript   JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_calls   INT  NOT NULL DEFAULT 0,
  model        TEXT NOT NULL DEFAULT 'deepseek-v4-pro',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  ai_chat_sessions               IS 'Audit log of every AI assistant conversation (global admin only)';
COMMENT ON COLUMN ai_chat_sessions.transcript    IS 'Full message array — [{role, content}] — for audit replay';
COMMENT ON COLUMN ai_chat_sessions.tool_calls    IS 'Number of tool calls made during the session (cost indicator)';

-- Indexes for dashboard queries: latest sessions per admin, date-range lookups
CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_admin
  ON ai_chat_sessions(admin_id);

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_started_at
  ON ai_chat_sessions(started_at DESC);

-- RLS: enable but allow only service-role writes + reads.
-- The edge function uses the service-role key; the browser never touches this table directly.
ALTER TABLE ai_chat_sessions ENABLE ROW LEVEL SECURITY;

-- Service-role key bypasses RLS by default in Supabase (auth.role() = 'service_role').
-- Deny everything from the anon / authenticated roles so the table is never exposed
-- via the public API, while the edge function (service-role) can INSERT and SELECT freely.
CREATE POLICY "Deny anon access to ai_chat_sessions"
  ON ai_chat_sessions
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny authenticated access to ai_chat_sessions"
  ON ai_chat_sessions
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
