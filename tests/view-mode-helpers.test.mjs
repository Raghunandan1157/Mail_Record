import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');

const canSwitchMatch = source.match(/function canSwitchOfficeViews\([^)]*\) \{\s*return ([^;]+);/);
const defaultModeMatch = source.match(/function defaultViewModeFor\([^)]*\) \{([\s\S]*?)\n\}/);

assert.ok(canSwitchMatch, 'Could not find canSwitchOfficeViews helper');
assert.ok(defaultModeMatch, 'Could not find defaultViewModeFor helper');

const canSwitchOfficeViews = new Function(
  'location',
  'adminFlag',
  `return Boolean(${canSwitchMatch[1]});`
);

const defaultViewModeFor = new Function(
  'location',
  'adminFlag',
  `${defaultModeMatch[1]}`
);

assert.equal(canSwitchOfficeViews('Head Office', false), true, 'Head Office can switch views');
assert.equal(canSwitchOfficeViews('Corporate Office', false), true, 'Corporate Office can switch views');
assert.equal(canSwitchOfficeViews('Branch A', true), true, 'admin credentials can switch views');
assert.equal(canSwitchOfficeViews('Branch A', false), false, 'ordinary branches cannot switch views');

assert.equal(defaultViewModeFor('Head Office', false), 'branch', 'Head Office defaults to branch operations');
assert.equal(defaultViewModeFor('Corporate Office', false), 'corporate', 'Corporate Office defaults to corporate view');
assert.equal(defaultViewModeFor('Head Office', true), 'admin', 'admin credentials default to Admin view');
