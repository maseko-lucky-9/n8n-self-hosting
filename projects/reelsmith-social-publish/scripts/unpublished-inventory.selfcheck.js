#!/usr/bin/env node
'use strict';
// Falsifiable checks for unpublished-inventory.js: dispatcher claims and the
// tiktok_status column count as published (a released outcome such as
// refused_retry does not), needs_you/failed claims are listed,
// quoted newlines in manifests create no phantom clips.
//   node unpublished-inventory.selfcheck.js   -> exit 0 on pass, 1 on any failure.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const h = require('./selfcheck-harness');

const s = h.suite('unpublished-inventory');

function inventory(root) {
  return execFileSync(process.execPath, [path.join(__dirname, 'unpublished-inventory.js')], {
    encoding: 'utf8', env: { ...process.env, ROOT: h.inboxOf(root) },
  });
}
const count = (out, label) => Number(out.match(new RegExp(`^${label}\\s*: (\\d+)$`, 'm'))[1]);

s.check('claims, tiktok_status (also as a 9th cell under the old header) and the old live columns are all read', () => {
  const root = h.makeRoot();
  const nfc = 'Alizé.mp4'.normalize('NFC');
  const { jobDir } = h.addJob(root, 'jobA', {
    rows: ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4', 'f.mp4', 'g.mp4', nfc.normalize('NFD')]
      .map((filename) => ({ filename, description: 'multi\nline.mp4\ndescription' })),
  });
  const claims = path.join(jobDir, '.claims');
  fs.mkdirSync(claims);
  const claim = (f, data) => fs.writeFileSync(path.join(claims, f + '.json'), JSON.stringify(data));
  claim('a.mp4', { status: 'posted' });
  claim('b.mp4', { status: 'posted_elsewhere' });
  claim('c.mp4', { status: 'needs_you', code: 'auth_invalid' });
  claim('d.mp4', { status: 'failed', code: 'timeout' });
  claim('e.mp4', { status: 'claimed' });
  claim(nfc, { status: 'posted' });
  fs.writeFileSync(path.join(jobDir, 'results.log.csv'),
    'timestamp,filename,title,tiktok_post_id,tiktok_post_url,youtube_video_id,youtube_status,error,tiktok_status\n'
    + '2026-10-17T12:00:05.000+02:00,f.mp4,t,,,,,,posted\n'
    + '2026-10-17T12:01:05.000+02:00,e.mp4,t,,,,,dry_run,dry_run\n'
    + '2026-10-17T15:00:05.000+02:00,g.mp4,t,,,,,publish_rejected e1,refused_retry\n'); // released: not published
  const { jobDir: oldDir } = h.addJob(root, 'jobOld', { rows: [{ filename: 'x.mp4' }, { filename: 'y.mp4' }, { filename: 'z.mp4' }] });
  fs.writeFileSync(path.join(oldDir, 'results.log.csv'),
    'timestamp,filename,title,tiktok_post_id,tiktok_post_url,youtube_video_id,youtube_status,error\n'
    + '2026-06-01T00:00:00Z,x.mp4,t,,https://www.tiktok.com/@a/video/1,,unknown,\n'
    + '2026-10-17T15:00:05.000+02:00,z.mp4,t,,,,,,posted\n'); // 9 cells under the old 8-column header

  const out = inventory(root);
  assert.equal(count(out, 'catalog clips'), 11, 'phantom rows from quoted newlines?\n' + out);
  assert.equal(count(out, 'published \\(TT or YT\\)'), 6);
  assert.equal(count(out, 'NEVER republished'), 5);
  assert.equal(count(out, 'needs you \\(claim\\)'), 2);
  assert.match(out, /jobA\/c\.mp4 \(needs_you: auth_invalid\)/);
  assert.match(out, /jobA\/d\.mp4 \(failed: timeout\)/);
  assert.match(out, /\[4\] jobA: c\.mp4, d\.mp4, e\.mp4, g\.mp4/);
  assert.match(out, /\[1\] jobOld: y\.mp4/);
});

s.run();
