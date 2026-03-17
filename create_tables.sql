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
