import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const match = source.match(/isHeadOffice\s*=\s*isAdminUser\s*&&\s*\(([^;]+)\);/);
const locationMatch = source.match(/const savedViewMode = getStoredViewMode\(savedLoc, adminFlag\);\s*selectedLocation\s*=\s*([\s\S]*?);\n\s*isAdminUser\s*=/);

assert.ok(match, 'Could not find stationary admin-mode restore expression');
assert.ok(locationMatch, 'Could not find stationary selected-location restore expression');

const restoredAdminMode = new Function(
  'isAdminUser',
  'savedViewMode',
  `return isAdminUser && (${match[1]});`
);

const restoredSelectedLocation = new Function(
  'savedLoc',
  'savedViewMode',
  `return ${locationMatch[1]};`
);

assert.equal(restoredAdminMode(true, undefined), true, 'admin user defaults to corporate/admin UI');
assert.equal(restoredAdminMode(true, 'corporate'), true, 'corporate view uses admin UI');
assert.equal(restoredAdminMode(true, 'admin'), true, 'admin view uses admin UI');
assert.equal(restoredAdminMode(true, 'branch'), false, 'head office view uses regular branch UI');
assert.equal(restoredAdminMode(false, 'corporate'), false, 'branch users never get admin UI');

assert.equal(
  restoredSelectedLocation('Airoli Branch', 'branch'),
  'Airoli Branch',
  'ordinary branch sessions restore their saved branch location'
);
assert.equal(
  restoredSelectedLocation('Head Office', 'branch'),
  'Head Office',
  'Head Office branch view restores Head Office'
);
assert.equal(
  restoredSelectedLocation('Head Office', 'corporate'),
  'Corporate Office',
  'corporate view uses Corporate Office context'
);

assert.match(
  source,
  /function loginConfirm\(\)[\s\S]*?sessionStorage\.removeItem\('sr_headoffice'\)[\s\S]*?localStorage\.removeItem\('sr_headoffice'\)/,
  'ordinary branch login clears any stale Head Office admin flag'
);
