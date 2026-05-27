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

assert.match(
  source,
  /async function ensureAiToken\(\)/,
  'index hub must refresh the AI token from Supabase'
);
assert.doesNotMatch(
  source,
  /makeAiToken\(p\)/,
  'AI Assistant must not use the branch login password as the backend OTP'
);
assert.match(
  source,
  /await ensureAiToken\(\);[\s\S]*window\.location\.href = 'ai_assistant\.html'/,
  'AI Assistant must refresh the backend OTP before navigating'
);
assert.match(
  source,
  /function saveSession\(\)[\s\S]*?if \(isAdmin\)[\s\S]*?else[\s\S]*?sessionStorage\.removeItem\('sr_headoffice'\)[\s\S]*?localStorage\.removeItem\('sr_headoffice'\)/,
  'branch login through the hub clears any stale Head Office admin flag'
);
