-- Run in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- Schema for Raise Complaint module — applied via Supabase MCP

CREATE TABLE IF NOT EXISTS complaint_records (
  id BIGSERIAL PRIMARY KEY,
  branch TEXT NOT NULL,
  date DATE NOT NULL,
  department_id TEXT NOT NULL CHECK (department_id IN ('admin','it')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  raised_by TEXT NOT NULL,
  phone TEXT NOT NULL,
  emp_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','resolved','escalated','rejected')),
  resolution_note TEXT,
  resolved_by TEXT,
  raised_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS complaint_log (
  id BIGSERIAL PRIMARY KEY,
  complaint_id BIGINT REFERENCES complaint_records(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  by_user TEXT NOT NULL,
  at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaint_records_branch ON complaint_records(branch);
CREATE INDEX IF NOT EXISTS idx_complaint_records_status ON complaint_records(status);
CREATE INDEX IF NOT EXISTS idx_complaint_records_raised_at ON complaint_records(raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaint_records_dept ON complaint_records(department_id);
CREATE INDEX IF NOT EXISTS idx_complaint_log_cid ON complaint_log(complaint_id);

ALTER TABLE complaint_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on complaint_records" ON complaint_records FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on complaint_log" ON complaint_log FOR ALL USING (true) WITH CHECK (true);
