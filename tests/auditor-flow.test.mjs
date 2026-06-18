import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const databaseSource = readFileSync(new URL('../database.sql', import.meta.url), 'utf8');
const createTablesSource = readFileSync(new URL('../create_tables.sql', import.meta.url), 'utf8');
const scriptSource = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const mailSource = readFileSync(new URL('../mailrecord.html', import.meta.url), 'utf8');
const complaintSource = readFileSync(new URL('../complain.html', import.meta.url), 'utf8');
const aiSource = readFileSync(new URL('../ai_assistant.html', import.meta.url), 'utf8');

assert.match(
  packageSource,
  /auditor-flow\.test\.mjs/,
  'auditor flow test must be included in npm test'
);

assert.equal(
  existsSync(new URL('../audit.html', import.meta.url)),
  true,
  'audit.html must exist for auditor sessions'
);

const auditSource = existsSync(new URL('../audit.html', import.meta.url))
  ? readFileSync(new URL('../audit.html', import.meta.url), 'utf8')
  : '';

// The auditor flag is now resolved server-side by /api/login (which reads
// is_auditor from branch_credentials) and returned as isAuditor; the hub login
// consumes that instead of querying branch_credentials directly. The SQL-column
// assertion below still verifies the is_auditor column itself exists.
assert.match(indexSource, /isAuditor/, 'hub login must read the auditor flag (isAuditor) from the /api/login response');
assert.match(indexSource, /sr_auditor/, 'hub login must persist sr_auditor session flag');
assert.match(indexSource, /sr_auditor_name/, 'hub login must persist the real auditor name');
assert.match(indexSource, /openModule\('audit'\)/, 'hub must expose an Audit module route');
assert.match(indexSource, /audit\.html/, 'hub must navigate auditor users to audit.html');
assert.doesNotMatch(
  indexSource,
  /isAuditor[\s\S]{0,500}sr_headoffice','true'/,
  'auditor login must not grant Head Office/admin session flag'
);

for (const source of [databaseSource, createTablesSource]) {
  assert.match(source, /ADD COLUMN IF NOT EXISTS is_auditor/i, 'SQL setup must add is_auditor to branch_credentials');
  assert.match(source, /CREATE TABLE IF NOT EXISTS audit_branch_months/i, 'SQL setup must create audit_branch_months');
  assert.match(source, /CHECK \(status IN \('pending','in_progress','completed'\)\)/, 'SQL setup must lock exact audit status values');
  assert.match(source, /UNIQUE \(audit_month, branch\)/, 'SQL setup must enforce one audit row per branch per month');
  assert.match(source, /INTERNALAUDITOR/, 'SQL setup must seed the shared auditor username');
  assert.match(source, /Auditor@123/, 'SQL setup must seed the shared auditor password');
}

assert.match(auditSource, /type="month"/, 'audit dashboard must include a month picker');
assert.match(auditSource, /audit_branch_months/, 'audit dashboard must read/write audit_branch_months');
assert.match(auditSource, /pending[\s\S]*#111827/, 'pending status must map to black');
assert.match(auditSource, /in_progress[\s\S]*#16a34a/, 'in_progress status must map to green');
assert.match(auditSource, /completed[\s\S]*#2563eb/, 'completed status must map to blue');
assert.match(auditSource, /Mark Completed/, 'audit dashboard must provide a completed action');
assert.match(auditSource, /started_by[\s\S]*auditorName/, 'audit start must record the real auditor name');
assert.match(auditSource, /completed_by[\s\S]*auditorName/, 'audit completion must record the real auditor name');

for (const [name, source] of [
  ['stationary route', scriptSource],
  ['mail route', mailSource],
  ['complaint route', complaintSource],
  ['AI route', aiSource],
]) {
  assert.match(source, /sr_auditor/, `${name} must check sr_auditor`);
  assert.match(source, /audit\.html/, `${name} must redirect auditors to audit.html`);
}
