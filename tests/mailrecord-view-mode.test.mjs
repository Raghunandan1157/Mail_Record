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
