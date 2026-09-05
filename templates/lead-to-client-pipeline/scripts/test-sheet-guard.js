#!/usr/bin/env node
// Self-check for WF-E's `Resolve Sheet ID` guard.
//
// That guard decides which Google Spreadsheet the mirror writes every prospect's name,
// email and phone number into. It is the only thing standing between the pipeline and
// an attacker-supplied document, so it gets a real test rather than a smoke test.
//
//   node templates/lead-to-client-pipeline/scripts/test-sheet-guard.js
//
// It runs the jsCode straight out of the committed workflow JSON, so it cannot drift
// from what ships. Each mutation below MUST make a specific case stop failing -- if a
// mutation changes nothing, this file is testing nothing and should be rewritten.
//
// SECURITY NOTE on `new Function` below. This executes code read from a file in the
// repo. That is deliberate -- reimplementing the guard here would let this test pass
// while the real node is broken. But the earlier justification ("anyone able to edit
// that can already run code in n8n") was wrong on two counts, and is corrected here:
//
//   1. Editing the workflow JSON in a FORK PR grants no n8n access. It grants code
//      execution on whoever runs this script -- a reviewer, on their own machine.
//      This repo is public, so a fork PR is a plausible delivery path.
//   2. This test would not notice. `process.mainModule.require` is reachable from
//      inside the Function body, and a payload can still return a well-formed result,
//      so the script would print "all checks passed" while running arbitrary commands.
//
// Consequence: DO NOT add this script to a CI job triggered by `pull_request`. The
// repo's only workflow runs on `self-hosted`, so doing so would turn a fork PR into
// remote code execution on the homelab runner. Run it locally, on branches you trust.

const fs = require('fs');
const path = require('path');

const WF = path.join(__dirname, '..', 'workflows', 'wf-e-sheet-sync.json');
const src = JSON.parse(fs.readFileSync(WF, 'utf8'))
  .nodes.find((n) => n.name === 'Resolve Sheet ID').parameters.jsCode;

const OWNER = 'owner@example.test';
const run = (items, env = { lead_sheet_owner: OWNER }, code = src) =>
  new Function('$input', '$env', code)({ all: () => items }, env);

const file = (id, owner) => ({ json: { id, name: 'Prudentia Leads Mirror',
  owners: owner ? [{ emailAddress: owner }] : [] } });

const OURS = file('OURS', OWNER);
const THEIRS = file('THEIRS', 'attacker@example.test');
const NONE = [{ json: {} }];            // what Find Sheet's alwaysOutputData emits

let failed = 0;
const check = (label, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const threw = (items, env, code) => { try { run(items, env, code); return false; } catch { return true; } };

console.log('--- shipped guard ---');
check('owner not configured -> throws', threw([OURS], {}));
check('no results -> throws', threw(NONE));
check('only an attacker-owned file -> throws (does NOT write PII to it)', threw([THEIRS]));
check('two owned files -> throws (ambiguous, refuses to guess)', threw([OURS, file('OURS2', OWNER)]));
check('ours alone -> returns it', run([OURS])[0].json.sheet_id === 'OURS');
check('ours alongside an attacker file -> still picks ours',
  run([THEIRS, OURS])[0].json.sheet_id === 'OURS');

// MUTATION 1: drop the ownership filter. The attacker-owned cases must stop failing.
console.log('--- mutant: ownership filter removed ---');
const m1 = src.replace(
  /const owned = \$input\.all\(\)\.filter\([\s\S]*?\}\);/,
  'const owned = $input.all().filter((i) => i.json && i.json.id);');
check('mutation applied', m1 !== src);
check('mutant ACCEPTS an attacker-owned file -> the filter is what blocks it',
  !threw([THEIRS], { lead_sheet_owner: OWNER }, m1));

// MUTATION 2: remove the explicit unset-owner check.
// It still throws -- an empty owner matches no file, so the ownership filter already
// fails closed. That is defence in depth, and worth asserting: the two mechanisms are
// independent. What the explicit check actually buys is a USABLE error message, so
// that is what gets tested. (An earlier version of this file asserted the mutant would
// stop throwing; it does not, and the mutation is what caught that.)
console.log('--- mutant: explicit unset-owner check removed ---');
const m2 = src.replace(/if \(!owner\) \{[\s\S]*?\n\}\n/, '');
check('mutation applied', m2 !== src);
check('mutant STILL fails closed on an unset owner -> two independent mechanisms',
  threw([OURS], {}, m2));
const msg = (items, env, code) => { try { run(items, env, code); return ''; } catch (e) { return e.message; } };
check('shipped guard names the missing setting', /lead_sheet_owner is not set/.test(msg([OURS], {})));
check('mutant loses that message -> the explicit check is what makes it diagnosable',
  !/lead_sheet_owner is not set/.test(msg([OURS], {}, m2)));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
