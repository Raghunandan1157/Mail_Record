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

-- Department config (admin-managed via Manage Departments UI)
CREATE TABLE IF NOT EXISTS complaint_dept_config (
  id BIGSERIAL PRIMARY KEY,
  dept_key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  problems JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaint_dept_config_active ON complaint_dept_config(active);
CREATE INDEX IF NOT EXISTS idx_complaint_dept_config_sort ON complaint_dept_config(sort_order);

ALTER TABLE complaint_dept_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on complaint_dept_config" ON complaint_dept_config FOR ALL USING (true) WITH CHECK (true);

INSERT INTO complaint_dept_config (dept_key, name, icon, sort_order, problems) VALUES
  ('admin', 'Administration Department', 'Admin', 1,
   '["Stationary Requirements","Asset Requirements","Change of premises","Electricity issues","Internet payment issues","Essential Items","House Keeping Items","Asset Repair"]'::jsonb),
  ('it', 'IT Hardware', 'IT', 2,
   '["Desktop","Printer","Close Circuit Camera","DVR","UPS and Batteries","TABs"]'::jsonb)
ON CONFLICT (dept_key) DO NOTHING;

-- Drop hardcoded check on complaint_records.department_id so admin can add new depts
ALTER TABLE complaint_records DROP CONSTRAINT IF EXISTS complaint_records_department_id_check;

-- Per-department 4-digit access code (used as alternate admin login scoped to one dept)
ALTER TABLE complaint_dept_config
  ADD COLUMN IF NOT EXISTS dept_code TEXT;

ALTER TABLE complaint_dept_config
  DROP CONSTRAINT IF EXISTS complaint_dept_config_dept_code_format_chk;
ALTER TABLE complaint_dept_config
  ADD CONSTRAINT complaint_dept_config_dept_code_format_chk
  CHECK (dept_code IS NULL OR dept_code ~ '^[0-9]{4}$');

CREATE UNIQUE INDEX IF NOT EXISTS complaint_dept_config_dept_code_uniq
  ON complaint_dept_config(dept_code)
  WHERE dept_code IS NOT NULL;
