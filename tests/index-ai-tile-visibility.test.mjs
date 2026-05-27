import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = source.match(/aiTile\.style\.display\s*=\s*\(([^?]+)\)\s*\?\s*''\s*:\s*'none'/);

assert.ok(match, 'Could not find AI Assistant tile visibility condition');

const shouldShowAiTile = new Function(
  'isAdmin',
  'selectedLocation',
  'curView',
  `return Boolean(${match[1]});`
);

assert.equal(shouldShowAiTile(true, 'Head Office', 'admin'), true, 'admin view shows AI Assistant');
assert.equal(shouldShowAiTile(true, 'Head Office', 'corporate'), false, 'corporate view hides AI Assistant');
assert.equal(shouldShowAiTile(true, 'Head Office', 'branch'), false, 'Head Office view hides AI Assistant');
assert.equal(shouldShowAiTile(false, 'Branch A', 'admin'), false, 'branch sessions hide AI Assistant');
assert.equal(shouldShowAiTile(false, 'Head Office', 'admin'), true, 'Head Office can use Admin view');
assert.equal(shouldShowAiTile(false, 'Corporate Office', 'admin'), true, 'Corporate Office can use Admin view');
