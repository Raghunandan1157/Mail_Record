import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const match = source.match(/isHeadOffice\s*=\s*isAdminUser\s*&&\s*\(([^;]+)\);/);

assert.ok(match, 'Could not find stationary admin-mode restore expression');

const restoredAdminMode = new Function(
  'isAdminUser',
  'savedViewMode',
  `return isAdminUser && (${match[1]});`
);

assert.equal(restoredAdminMode(true, undefined), true, 'admin user defaults to corporate/admin UI');
assert.equal(restoredAdminMode(true, 'corporate'), true, 'corporate view uses admin UI');
assert.equal(restoredAdminMode(true, 'admin'), true, 'admin view uses admin UI');
assert.equal(restoredAdminMode(true, 'branch'), false, 'head office view uses regular branch UI');
assert.equal(restoredAdminMode(false, 'corporate'), false, 'branch users never get admin UI');
