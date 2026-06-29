import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../mailrecord.html', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

assert.match(
  packageSource,
  /mailrecord-history-pagination\.test\.mjs/,
  'Mail Record history pagination regression test must be included in npm test'
);

const loadRecordsMatch = source.match(/async function loadRecords\(type\) \{([\s\S]*?)\n    \}/);
const sbGetAllMatch = source.match(/async function sbGetAll\(t, p = '', pageSize = 1000\) \{([\s\S]*?)\n    \}/);

assert.ok(loadRecordsMatch, 'Could not find Mail Record loadRecords');
assert.ok(sbGetAllMatch, 'Could not find Mail Record sbGetAll');

const loadRecordsSource = loadRecordsMatch[0];
const sbGetAllSource = sbGetAllMatch[0];

assert.match(
  sbGetAllSource,
  /const MAX_PAGES = \d+;/,
  'sbGetAll must have a page ceiling before it is used for branch history'
);

assert.match(
  sbGetAllSource,
  /firstPageSignature/,
  'sbGetAll must detect a repeated first page in case the proxy ignores Range headers'
);

assert.match(
  loadRecordsSource,
  /const allRecs = await sbGetAll\('mail_records', `select=\*&mail_type=eq\.\$\{type\}&location=eq\.\$\{encodeURIComponent\(selectedLocation\)\}&date=gte\.\$\{fy\.start\}&date=lte\.\$\{fy\.end\}&order=created_at\.asc`\)/,
  'Branch Outward/Inward FY history must use paginated sbGetAll so new rows beyond the first PostgREST page appear in history and search'
);

assert.doesNotMatch(
  loadRecordsSource,
  /await sbGet\('mail_records'/,
  'Branch Outward/Inward FY history must not use one-page sbGet'
);

assert.match(
  loadRecordsSource,
  /allRecs\.forEach\(\(r, i\) => \{ r\.seq = i \+ 1;/,
  'Sequence numbers must still be assigned from ascending created_at order after pagination'
);
