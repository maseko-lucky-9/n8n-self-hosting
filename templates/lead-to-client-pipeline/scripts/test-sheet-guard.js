#!/usr/bin/env node
// Self-check for WF-E's `Resolve Sheet ID` guard.
//
// That guard is the only non-trivial logic in the sheet mirror, and it is the thing
// standing between a renamed/ambiguous spreadsheet and lead PII being written into the
// wrong document. It runs the jsCode straight out of the committed workflow JSON, so
// this cannot drift from what actually ships.
//
//   node templates/lead-to-client-pipeline/scripts/test-sheet-guard.js
//
// Ends with a mutation check: relaxing `!== 1` to `< 1` MUST make the two-match case
// stop failing. If it does not, this file is testing nothing and should be rewritten.

const fs = require('fs');
const path = require('path');

const WF = path.join(__dirname, '..', 'workflows', 'wf-e-sheet-sync.json');
const src = JSON.parse(fs.readFileSync(WF, 'utf8'))
  .nodes.find((n) => n.name === 'Resolve Sheet ID').parameters.jsCode;

// `new Function` on file contents would be a code-injection hole if `code` were
// attacker-controlled. It is not: the only input is jsCode from a workflow JSON
// committed to this repo, and anyone able to edit that can already run arbitrary code
// inside n8n. Executing the shipped source is the entire point -- reimplementing the
// guard here would let the test pass while the real node is broken.
const run = (items, code = src) =>
  new Function('$input', '$env', code)({ all: () => items }, {});

const ONE = [{ json: { id: 'ABC123', name: 'Prudentia Leads Mirror' } }];
const TWO = [...ONE, { json: { id: 'DEF456', name: 'Prudentia Leads Mirror' } }];
const ZERO = [{ json: {} }]; // what Find Sheet's alwaysOutputData emits on no match

let failed = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
};
const threw = (items, code) => {
  try { run(items, code); return false; } catch { return true; }
};

check('0 matches throws (renamed, trashed, or not shared)', threw(ZERO));
check('2 matches throws (ambiguous name -- refuse, do not guess)', threw(TWO));
check('1 match returns its id', run(ONE)[0].json.sheet_id === 'ABC123');

const mutated = src.replace('hits.length !== 1', 'hits.length < 1');
check('mutation applied', mutated !== src);
check('mutant still rejects 0 matches', threw(ZERO, mutated));
check('mutant ACCEPTS 2 matches -- so the guard is what catches it', !threw(TWO, mutated));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
