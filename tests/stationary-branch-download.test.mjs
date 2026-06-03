import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stationarySource = readFileSync(new URL('../stationary.html', import.meta.url), 'utf8');
const scriptSource = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

assert.match(
  packageSource,
  /stationary-branch-download\.test\.mjs/,
  'stationary branch download test must be included in npm test'
);

assert.match(
  stationarySource,
  /<!-- Module Switch \+ Download -->[\s\S]*id="bd-modbtn-stationary"[\s\S]*id="bd-modbtn-mailrecord"[\s\S]*id="bd-download-btn"[\s\S]*onclick="downloadStationaryBranchReport\(\)"/,
  'Stationary branch detail must place the download button beside the Stationary/Mail Record switch'
);

assert.match(
  stationarySource,
  /<!-- Module Switch \+ Download -->[\s\S]*justify-between[\s\S]*flex-wrap/,
  'Stationary branch module switch and download action must wrap like Mail Record branch detail'
);

assert.match(
  stationarySource,
  /Download Branch Report/,
  'Stationary branch detail download button must use the same visible label as Mail Record branch view'
);

assert.match(
  scriptSource,
  /function downloadStationaryBranchReport\(\)/,
  'Stationary branch detail must implement downloadStationaryBranchReport'
);

assert.match(
  scriptSource,
  /XLSX\.utils\.book_append_sheet\(wb, wsSummary, 'Summary'\)/,
  'Stationary branch report must include a Summary sheet'
);

assert.match(
  scriptSource,
  /XLSX\.utils\.book_append_sheet\(wb, wsInventory, 'Stationary Items'\)/,
  'Stationary branch report must include a Stationary Items sheet'
);

assert.match(
  scriptSource,
  /XLSX\.utils\.book_append_sheet\(wb, wsMailOutward, 'Mail Outward'\)/,
  'Stationary branch report must include a Mail Outward sheet'
);

assert.match(
  scriptSource,
  /XLSX\.utils\.book_append_sheet\(wb, wsMailInward, 'Mail Inward'\)/,
  'Stationary branch report must include a Mail Inward sheet'
);

assert.match(
  scriptSource,
  /XLSX\.utils\.book_append_sheet\(wb, wsTransactions, 'Transactions'\)/,
  'Stationary branch report must include a Transactions sheet'
);

assert.match(
  scriptSource,
  /XLSX\.utils\.book_append_sheet\(wb, wsTeam, 'Team Members'\)/,
  'Stationary branch report must include a Team Members sheet'
);

assert.match(
  scriptSource,
  /selectedBranch/,
  'Stationary branch report must export the currently selected branch'
);
