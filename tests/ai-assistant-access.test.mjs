import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../ai_assistant.html', import.meta.url), 'utf8');

assert.match(
  source,
  /else if \(viewMode !== 'admin'\)/,
  'AI Assistant direct access must be blocked outside Admin view'
);
assert.doesNotMatch(
  source,
  /viewMode === 'branch'/,
  'AI Assistant access must not allow Corporate Office by only blocking Head Office view'
);
