import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../mailrecord.html', import.meta.url), 'utf8');
const applyMatch = source.match(/function applyViewMode\(\) \{([\s\S]*?)\n    \}/);

assert.ok(applyMatch, 'Could not find Mail Record applyViewMode');

function runApplyViewMode({ storedViewMode, sessionLocation, sessionIsAdmin }) {
  const state = {
    selectedLocation: null,
    isAdmin: null,
  };
  const fn = new Function(
    'state',
    'storedViewMode',
    'sessionLocation',
    'sessionIsAdmin',
    `
      let selectedLocation = state.selectedLocation;
      let isAdmin = state.isAdmin;
      function getStoredViewMode() { return storedViewMode; }
      function canSwitchView() {
        return sessionIsAdmin || sessionLocation === 'Head Office' || sessionLocation === 'Corporate Office';
      }
      ${applyMatch[0]}
      applyViewMode();
      state.selectedLocation = selectedLocation;
      state.isAdmin = isAdmin;
    `
  );
  fn(state, storedViewMode, sessionLocation, sessionIsAdmin);
  return state;
}

assert.deepEqual(
  runApplyViewMode({ storedViewMode: 'branch', sessionLocation: 'Hiriyur', sessionIsAdmin: false }),
  { selectedLocation: 'Hiriyur', isAdmin: false },
  'ordinary branch users must keep their own branch location in Mail Record'
);

assert.deepEqual(
  runApplyViewMode({ storedViewMode: 'branch', sessionLocation: 'Head Office', sessionIsAdmin: false }),
  { selectedLocation: 'Head Office', isAdmin: false },
  'Head Office branch view should query Head Office data'
);

assert.deepEqual(
  runApplyViewMode({ storedViewMode: 'corporate', sessionLocation: 'Hiriyur', sessionIsAdmin: false }),
  { selectedLocation: 'Hiriyur', isAdmin: false },
  'ordinary branch users must ignore stale corporate view mode'
);

assert.deepEqual(
  runApplyViewMode({ storedViewMode: 'corporate', sessionLocation: 'Head Office', sessionIsAdmin: true }),
  { selectedLocation: 'Corporate Office', isAdmin: false },
  'admin-capable users can switch to Corporate Office context'
);

assert.deepEqual(
  runApplyViewMode({ storedViewMode: 'admin', sessionLocation: 'Head Office', sessionIsAdmin: true }),
  { selectedLocation: 'Head Office', isAdmin: true },
  'admin-capable users can switch to Admin view'
);

// Regression: a Corporate Office login (NOT a real admin) that switches to Admin view
// must reach the admin all-branches dashboard. This is the exact reported bug — guard it
// so the admin gate in applyViewMode() cannot silently ping-pong back to corporate again.
assert.deepEqual(
  runApplyViewMode({ storedViewMode: 'admin', sessionLocation: 'Corporate Office', sessionIsAdmin: false }),
  { selectedLocation: 'Corporate Office', isAdmin: true },
  'Corporate Office user switching to Admin view must get the admin dashboard'
);

// Suppress-half: the same account left in Corporate view must NOT show the admin dashboard.
assert.deepEqual(
  runApplyViewMode({ storedViewMode: 'corporate', sessionLocation: 'Corporate Office', sessionIsAdmin: false }),
  { selectedLocation: 'Corporate Office', isAdmin: false },
  'Corporate Office view must stay on the corporate dashboard, not admin'
);
