-- ============================================
-- MAIL RECORD - Supabase Database Schema
-- ============================================

-- 1. Employees table (for BOE login profiles)
CREATE TABLE employees (
  id BIGSERIAL PRIMARY KEY,
  emp_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'Admin Executive',
  mobile TEXT,
  location TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. App config (stores admin OTP and settings)
CREATE TABLE app_config (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Mail records (inward + outward)
CREATE TABLE mail_records (
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

-- 4. Edit log (tracks changes to mail records)
CREATE TABLE edit_log (
  id BIGSERIAL PRIMARY KEY,
  record_id BIGINT REFERENCES mail_records(id),
  mail_type TEXT NOT NULL,
  field_changed TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  edited_by TEXT NOT NULL,
  edited_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX idx_employees_location ON employees(location);
CREATE INDEX idx_mail_records_type ON mail_records(mail_type);
CREATE INDEX idx_mail_records_location ON mail_records(location);
CREATE INDEX idx_mail_records_date ON mail_records(date DESC);
CREATE INDEX idx_edit_log_record ON edit_log(record_id);

-- ============================================
-- SEED DATA
-- ============================================

-- Set admin OTP (same as Stationary Management)
INSERT INTO app_config (key, value) VALUES ('admin_otp', '1234');

-- Sample employee (optional - remove in production)
-- INSERT INTO employees (emp_id, name, role, mobile, location)
-- VALUES ('BOE-001', 'Sample User', 'Admin Executive', '9999999999', 'Honnavar');

-- ============================================
-- ROW LEVEL SECURITY (Enable after setup)
-- ============================================
-- ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE mail_records ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE edit_log ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "Allow anon read employees" ON employees FOR SELECT USING (true);
-- CREATE POLICY "Allow anon read config" ON app_config FOR SELECT USING (true);
-- CREATE POLICY "Allow anon all mail_records" ON mail_records FOR ALL USING (true);
-- CREATE POLICY "Allow anon all edit_log" ON edit_log FOR ALL USING (true);


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
