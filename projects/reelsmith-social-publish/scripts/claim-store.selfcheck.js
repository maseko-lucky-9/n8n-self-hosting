#!/usr/bin/env node
'use strict';
// Falsifiable check of the claim-store gate logic (the same O_EXCL pattern the
// Assign Peak Window node uses). Proves: 1st pass claims all clips, a concurrent
// 2nd pass over the same clips claims ZERO (EEXIST -> skip). No n8n required.
//   node claim-store.selfcheck.js   ->  exits 0 on pass, 1 on fail.
const fs = require('fs');
const path = require('path');
const os = require('os');

function claimPass(items, root) {
  const out = [];
  for (const it of items) {
    const claimDir = path.join(root, it.jobDir, '.claims');
    fs.mkdirSync(claimDir, { recursive: true });
    const marker = path.join(claimDir, path.basename(it.filename) + '.json');
    try {
      fs.writeFileSync(marker, JSON.stringify({ clipIndex: it.clipIndex }), { flag: 'wx' });
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
    out.push(it);
  }
  return out;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claimtest-'));
const items = [
  { jobDir: 'job-a', filename: '00_clip.mp4', clipIndex: 0 },
  { jobDir: 'job-a', filename: '01_clip.mp4', clipIndex: 1 },
  { jobDir: 'job-b', filename: '00_clip.mp4', clipIndex: 0 } // same basename, different job -> distinct
];

const first = claimPass(items, root);
const second = claimPass(items, root); // simulates the 8h rescan over the same clips
fs.rmSync(root, { recursive: true, force: true });

const ok = first.length === 3 && second.length === 0;
console.log(`first=${first.length} (want 3)  second=${second.length} (want 0)  =>  ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
