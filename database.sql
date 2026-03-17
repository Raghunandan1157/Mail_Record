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
