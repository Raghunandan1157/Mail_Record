import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scriptSource = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const mailrecordSource = readFileSync(new URL('../mailrecord.html', import.meta.url), 'utf8');
const auditSource = readFileSync(new URL('../audit.html', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

assert.match(
  packageSource,
  /branch-mail-involvement\.test\.mjs/,
  'branch mail involvement test must be included in npm test'
);

assert.match(
  scriptSource,
  /function buildBranchMailRecordsQuery\(branch\)[\s\S]*or=\(location\.eq\.\$\{encodedBranch\},name\.ilike\.\*\$\{encodedBranch\}\*\)/,
  'Stationary branch detail must load mail records where the branch is either the recording location or the mail party name'
);

assert.match(
  scriptSource,
  /loadBranchMailRecords\(branch\)[\s\S]*supabaseFetch\('mail_records', buildBranchMailRecordsQuery\(branch\)\)/,
  'Stationary Mail Record tab must use the branch involvement query'
);

assert.match(
  scriptSource,
  /downloadStationaryBranchReport\(\)[\s\S]*supabaseFetch\('mail_records', buildBranchMailRecordsQuery\(selectedBranch\)\)/,
  'Stationary branch report download must include the same branch-involved mail records'
);

assert.match(
  mailrecordSource,
  /function mrBranchMailQuery\(branch\)[\s\S]*or=\(location\.eq\.\$\{encodedBranch\},name\.ilike\.\*\$\{encodedBranch\}\*\)/,
  'Mail Record branch detail must share the same branch involvement query'
);

assert.match(
  mailrecordSource,
  /loadMrMail\(branch\)[\s\S]*sbGet\('mail_records', mrBranchMailQuery\(branch\)\)/,
  'Mail Record branch detail tab must use the branch involvement query'
);

assert.match(
  mailrecordSource,
  /downloadMrBranch\(\)[\s\S]*sbGet\('mail_records', mrBranchMailQuery\(branch\)\)/,
  'Mail Record branch report download must use the branch involvement query'
);

assert.match(
  auditSource,
  /function auditBranchMailQuery\(branch, type, range\)[\s\S]*or=\(location\.eq\.\$\{encodedBranch\},name\.ilike\.\*\$\{encodedBranch\}\*\)/,
  'Auditor monthly branch counts must use the same branch involvement query'
);

assert.match(
  auditSource,
  /loadBranchCounts\(\)[\s\S]*sbGet\('mail_records', auditBranchMailQuery\(selectedBranch, 'inward', range\)\)/,
  'Auditor inward count must use the branch involvement query'
);

assert.match(
  auditSource,
  /loadBranchCounts\(\)[\s\S]*sbGet\('mail_records', auditBranchMailQuery\(selectedBranch, 'outward', range\)\)/,
  'Auditor outward count must use the branch involvement query'
);
