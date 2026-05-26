import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = source.match(/aiTile\.style\.display\s*=\s*\(([^?]+)\)\s*\?\s*''\s*:\s*'none'/);

assert.ok(match, 'Could not find AI Assistant tile visibility condition');

const shouldShowAiTile = new Function(
  'isAdmin',
  'curView',
  `return Boolean(${match[1]});`
);

assert.equal(shouldShowAiTile(true, 'admin'), true, 'admin view shows AI Assistant');
assert.equal(shouldShowAiTile(true, 'corporate'), false, 'corporate view hides AI Assistant');
assert.equal(shouldShowAiTile(true, 'branch'), false, 'Head Office view hides AI Assistant');
assert.equal(shouldShowAiTile(false, 'admin'), false, 'non-admin sessions hide AI Assistant');
