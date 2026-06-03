-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- Mail records table
CREATE TABLE IF NOT EXISTS mail_records (
  id BIGSERIAL PRIMARY KEY,
  mail_type TEXT NOT NULL CHECK (mail_type IN ('inward', 'outward')),
  date DATE NOT NULL,
  employee_id TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT NOT NULL,
  documents TEXT NOT NULL,
  courier_status TEXT DEFAULT '',
  particular TEXT NOT NULL,
  details TEXT DEFAULT '',
  location TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Edit log table
CREATE TABLE IF NOT EXISTS mail_edit_log (
  id BIGSERIAL PRIMARY KEY,
  record_id BIGINT REFERENCES mail_records(id),
  mail_type TEXT NOT NULL,
  field_changed TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  edited_by TEXT NOT NULL,
  edited_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mail_records_type ON mail_records(mail_type);
CREATE INDEX IF NOT EXISTS idx_mail_records_location ON mail_records(location);
CREATE INDEX IF NOT EXISTS idx_mail_records_date ON mail_records(date DESC);
CREATE INDEX IF NOT EXISTS idx_mail_edit_log_record ON mail_edit_log(record_id);

-- Enable RLS but allow all access via anon key
ALTER TABLE mail_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_edit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on mail_records" ON mail_records FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on mail_edit_log" ON mail_edit_log FOR ALL USING (true) WITH CHECK (true);


-- Branch credentials (added for username/password auth)
CREATE TABLE IF NOT EXISTS branch_credentials (
  id BIGSERIAL PRIMARY KEY,
  branch TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  is_auditor BOOLEAN DEFAULT FALSE,
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_branch_credentials_username ON branch_credentials(username);
ALTER TABLE branch_credentials ADD COLUMN IF NOT EXISTS is_auditor BOOLEAN DEFAULT FALSE;
ALTER TABLE branch_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on branch_credentials" ON branch_credentials;
CREATE POLICY "Allow all on branch_credentials" ON branch_credentials FOR ALL USING (true) WITH CHECK (true);

INSERT INTO branch_credentials (branch, username, password, is_admin, is_auditor)
VALUES ('Internal Audit', 'INTERNALAUDITOR', 'Auditor@123', FALSE, TRUE)
ON CONFLICT (username) DO UPDATE SET
  password = EXCLUDED.password,
  is_admin = FALSE,
  is_auditor = TRUE;

CREATE TABLE IF NOT EXISTS audit_branch_months (
  id BIGSERIAL PRIMARY KEY,
  audit_month DATE NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  started_by TEXT,
  completed_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (audit_month, branch)
);
CREATE INDEX IF NOT EXISTS idx_audit_branch_months_month ON audit_branch_months(audit_month);
CREATE INDEX IF NOT EXISTS idx_audit_branch_months_branch ON audit_branch_months(branch);
CREATE INDEX IF NOT EXISTS idx_audit_branch_months_status ON audit_branch_months(status);
ALTER TABLE audit_branch_months ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on audit_branch_months" ON audit_branch_months;
CREATE POLICY "Allow all on audit_branch_months" ON audit_branch_months FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audit_branch_months TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.audit_branch_months_id_seq TO anon, authenticated;


-- Shipments (Head Office → Branch stock distribution)
CREATE TABLE IF NOT EXISTS shipments (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL,
  from_branch TEXT NOT NULL DEFAULT 'Head Office',
  to_branch TEXT NOT NULL,
  item_name TEXT NOT NULL,
  hsn_code TEXT,
  category TEXT,
  quantity INTEGER NOT NULL,
  received_quantity INTEGER,
  unit TEXT,
  rate NUMERIC,
  gst NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','shipped','received','dismissed')),
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  received_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shipments_to_branch ON shipments(to_branch);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_batch ON shipments(batch_id);
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on shipments" ON shipments;
CREATE POLICY "Allow all on shipments" ON shipments FOR ALL USING (true) WITH CHECK (true);
