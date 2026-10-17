#!/usr/bin/env node
'use strict';
// Falsifiable checks for the Pick Due Clip node (scripts/pick-due-clip.jsCode.js),
// run the way n8n runs it, against temp copies of the inbox PVC.
//   node pick-due-clip.selfcheck.js   -> exit 0 on pass, 1 on any failure.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./selfcheck-harness');

const PICK = 'pick-due-clip.jsCode.js';
const LEGACY_JOB = '1979f8a4a33643b5a43d8f0fb4337d3e';
const LEGACY_JOB_2 = '32508a2a96a14ce38cd087bfb1fdeb22';
const s = h.suite('pick-due-clip');

async function pick(root, sast, { live = true, fsImpl, execId } = {}) {
  h.setNow(sast);
  return h.runNode(h.loadNode(PICK, { root, live }), { fsImpl, execId });
}

// A youtube job with n clips 00.mp4..; mtime decides newest-first.
function job(root, name, n, mtime = '2026-10-15T10:00:00') {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ filename: `${String(i).padStart(2, '0')}_clip.mp4` });
  return h.addJob(root, name, { rows, mtime });
}

// Stand-in for the Log Results outcome "posted": the claim records it.
function markPosted(item) {
  fs.writeFileSync(item.claimPath, JSON.stringify({ status: 'posted', claimedAt: item.claimedAt }));
}

s.check('gate: nothing before 12:00, slot 0 at 12:00, then wait for 15:00', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 5);
  assert.deepEqual(await pick(root, '2026-10-17T11:59:00'), []);
  const [first] = await pick(root, '2026-10-17T12:00:00');
  assert.equal(first.json.clip_key, 'jobA/00_clip.mp4');
  markPosted(first.json);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
  for (const t of ['12:15', '13:00', '14:45', '14:50', '14:59']) assert.deepEqual(await pick(root, `2026-10-17T${t}:00`), [], t);
  const [second] = await pick(root, '2026-10-17T15:00:00');
  assert.equal(second.json.clip_key, 'jobA/01_clip.mp4');
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json', '2026-10-17-1.json']);
});

s.check('gate: 170-minute gap after the newest slot marker', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 5);
  const [late] = await pick(root, '2026-10-17T13:00:00'); // outage: slot 0 taken late
  markPosted(late.json);
  assert.deepEqual(await pick(root, '2026-10-17T15:00:00'), [], '120 min after 13:00');
  assert.deepEqual(await pick(root, '2026-10-17T15:49:00'), [], '169 min');
  const [next] = await pick(root, '2026-10-17T15:50:00');
  assert.equal(next.json.clip_key, 'jobA/01_clip.mp4', '170 min');
});

s.check('gate: earliest unused passed slot, never more than 3 a day', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 6);
  const [a] = await pick(root, '2026-10-17T16:00:00'); // homelab back at 16:00
  markPosted(a.json);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json'], 'slot 0 caught up first');
  const [b] = await pick(root, '2026-10-17T18:50:00');
  markPosted(b.json);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json', '2026-10-17-1.json']);
  assert.deepEqual(await pick(root, '2026-10-17T20:45:00'), [], 'gap not met before 21:00');
});

s.check('gate: no catch-up at or after 21:00', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  assert.deepEqual(await pick(root, '2026-10-17T21:00:00'), []);
  assert.deepEqual(await pick(root, '2026-10-17T23:30:00'), []);
  assert.deepEqual(h.listSlots(root), []);
  assert.equal(h.listClaims(root).length, 0);
  const [late] = await pick(root, '2026-10-17T20:59:00');
  assert.equal(late.json.clip_key, 'jobA/00_clip.mp4');
});

s.check('gate: uses SAST, not the instance default zone', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  // 12:00 SAST is 06:00 in New York (the harness default zone)
  const [item] = await pick(root, '2026-10-17T12:00:00');
  assert.ok(item);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
});

s.check('DRY_RUN: no slot gate, no slot marker, flagged in the item', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  for (const t of ['2026-10-17T09:00:00', '2026-10-17T22:30:00']) {
    const [item] = await pick(root, t, { live: false });
    assert.equal(item.json.dryRun, true);
    assert.equal(item.json.slotMarker, null);
    fs.rmSync(item.json.claimPath); // Log Results releases a dry-run claim
  }
  assert.equal(h.exists(path.join(root, '.slots')), false);
  assert.match(fs.readFileSync(path.join(__dirname, PICK), 'utf8'), /^const DRY_RUN = true;/m);
});

s.check('stale-claim sweep releases unresolved claims older than 30 min only', async () => {
  const root = h.makeRoot();
  const { jobDir } = job(root, 'jobA', 4);
  const claims = path.join(jobDir, '.claims');
  fs.mkdirSync(claims);
  const put = (f, data) => fs.writeFileSync(path.join(claims, f + '.json'), JSON.stringify(data));
  put('00_clip.mp4', { status: 'claimed', claimedAt: '2026-10-17T11:29:00.000+02:00' }); // 31 min
  put('01_clip.mp4', { status: 'claimed', claimedAt: '2026-10-17T11:31:00.000+02:00' }); // 29 min
  put('02_clip.mp4', { status: 'posted', claimedAt: '2026-10-01T12:00:00.000+02:00' });
  put('03_clip.mp4', { claimedAt: '2026-06-01T12:00:00.000Z', execId: '9', clipIndex: 3 }); // marker from the pre-2026-10 workflow
  const [item] = await pick(root, '2026-10-17T12:00:00');
  assert.equal(item.json.clip_key, 'jobA/00_clip.mp4', 'released stale clip is picked again');
  const left = h.listClaims(root).map((c) => c.file).sort();
  assert.deepEqual(left, ['00_clip.mp4.json', '01_clip.mp4.json', '02_clip.mp4.json', '03_clip.mp4.json']);
  assert.equal(h.readJson(path.join(claims, '00_clip.mp4.json')).execId, 'test-exec', 'fresh claim');
});

s.check('YouTube only: source column, legacy allowlist (also an empty cell), TikTok/unknown skipped', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'tiktokJob', { rows: [{ filename: 'a.mp4', source: 'tiktok' }], mtime: '2026-10-16T12:00:00' });
  h.addJob(root, 'blankSource', { rows: [{ filename: 'b.mp4', source: '' }], mtime: '2026-10-16T11:00:00' });
  h.addJob(root, 'uploadJob', { rows: [{ filename: 'c.mp4', source: 'upload' }], mtime: '2026-10-16T10:00:00' });
  h.addJob(root, 'ba634deeLegacy', { rows: [{ filename: 'd.mp4' }], legacy: true, mtime: '2026-10-16T09:00:00' });
  h.addJob(root, LEGACY_JOB, { rows: [{ filename: 'e.mp4' }], legacy: true, mtime: '2026-10-15T09:00:00' });
  h.addJob(root, 'ytJob', { rows: [{ filename: 'f.mp4', source: 'youtube' }], mtime: '2026-10-14T09:00:00' });
  // a legacy job re-exported with the new column: its DB source is NULL, so the cell is empty
  h.addJob(root, LEGACY_JOB_2, { rows: [{ filename: 'g.mp4', source: '' }, { filename: 'h.mp4', source: 'tiktok' }], mtime: '2026-10-13T09:00:00' });
  const got = [];
  for (const t of ['09:00', '09:05', '09:10', '09:15']) { // within 30 min: no stale release
    const items = await pick(root, `2026-10-17T${t}:00`, { live: false });
    if (items.length) got.push(items[0].json.clip_key);
  }
  assert.deepEqual(got, [`${LEGACY_JOB}/e.mp4`, 'ytJob/f.mp4', `${LEGACY_JOB_2}/g.mp4`]);
  assert.equal(h.exists(path.join(h.inboxOf(root), LEGACY_JOB_2, '.claims', 'h.mp4.json')), false, 'tiktok row in a legacy job picked');
  for (const skipped of ['tiktokJob', 'blankSource', 'uploadJob', 'ba634deeLegacy']) {
    assert.equal(h.exists(path.join(h.inboxOf(root), skipped, '.claims')), false, skipped + ' touched');
  }
});

s.check('RFC 4180: quoted newlines, commas and quotes stay inside one row', async () => {
  const root = h.makeRoot();
  const description = 'Line one, with a comma\nLine "two"\r\nLine three';
  h.addJob(root, 'jobA', {
    rows: [
      { filename: '00_first.mp4', size: null, description }, // missing: skipped, but parsed
      { filename: '01_second.mp4', description, hashtags: '["#a", "#b,c"]' },
    ],
    mtime: '2026-10-15T10:00:00',
  });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, 'jobA/01_second.mp4');
  assert.equal(item.json.caption, description.trim());
  assert.equal(item.json.hashtags, '["#a","#b,c"]');
  assert.equal(item.json.rowIndex, 1);
});

s.check('caption falls back to the title; hashtags pass through', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', {
    rows: [{ filename: '00.mp4', title: '  The Title ', description: '   ', hashtags: '#one #two' }],
    mtime: '2026-10-15T10:00:00',
  });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.caption, 'The Title');
  assert.equal(item.json.hashtags, '#one #two');
});

s.check('missing file waits; junk (empty name, not .mp4, <=1 KB, unsafe) is skipped', async () => {
  const root = h.makeRoot();
  h.addJob(root, LEGACY_JOB, {
    legacy: true,
    rows: [
      { filename: '' },
      { filename: '01_missing.mp4', size: null },
      { filename: '02_notes.txt' },
      { filename: '03_tiny.mp4', size: 1024 },
      { filename: '../escape.mp4', size: null },
      { filename: '.hidden.mp4' },
      { filename: '06_ok.mp4', size: 1025 },
    ],
    mtime: '2026-10-15T10:00:00',
  });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, `${LEGACY_JOB}/06_ok.mp4`);
  assert.deepEqual(h.listClaims(root).map((c) => c.file), ['06_ok.mp4.json']);
  // Syncthing delivers the missing clip: it is picked next (06 stays claimed)
  fs.writeFileSync(path.join(h.inboxOf(root), LEGACY_JOB, '01_missing.mp4'), Buffer.alloc(2048));
  const [next] = await pick(root, '2026-10-17T09:15:00', { live: false });
  assert.equal(next.json.clip_key, `${LEGACY_JOB}/01_missing.mp4`);
});

s.check('path guard: names with separators are refused before any lookup, even when the target exists', async () => {
  const root = h.makeRoot();
  const { jobDir } = h.addJob(root, 'jobA', {
    rows: [{ filename: 'sub/x.mp4', size: null }, { filename: 'a/../../other/x.mp4', size: null }, { filename: 'ok.mp4' }],
    mtime: '2026-10-15T10:00:00',
  });
  fs.mkdirSync(path.join(jobDir, 'sub'));
  fs.writeFileSync(path.join(jobDir, 'sub', 'x.mp4'), Buffer.alloc(4096));
  fs.mkdirSync(path.join(jobDir, 'a'));
  fs.mkdirSync(path.join(h.inboxOf(root), 'other'));
  fs.writeFileSync(path.join(h.inboxOf(root), 'other', 'x.mp4'), Buffer.alloc(4096));
  const looked = [];
  const fsShim = Object.create(fs);
  fsShim.lstatSync = (p, ...rest) => { looked.push(String(p)); return fs.lstatSync(p, ...rest); };
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false, fsImpl: fsShim });
  assert.equal(item.json.clip_key, 'jobA/ok.mp4');
  assert.deepEqual(item.json.manifestErrors, ['jobA row 1: unsafe filename', 'jobA row 2: unsafe filename']);
  assert.deepEqual(looked.filter((p) => p.endsWith('x.mp4')), [], 'looked up a path outside the job folder');
});

s.check('names: 200 bytes is fine; 201, 227, 253 (CJK) and 300 bytes are junk, reported, and never jam the run', async () => {
  const cjk = (ascii, han) => 'a'.repeat(ascii) + '字'.repeat(han) + '.mp4';
  const names = { 200: cjk(16, 60), 201: cjk(17, 60), 227: cjk(13, 70), 253: cjk(9, 80) };
  for (const [bytes, name] of Object.entries(names)) assert.equal(Buffer.byteLength(name), Number(bytes));
  const root = h.makeRoot();
  h.addJob(root, 'jobA', {
    rows: [
      { filename: 'b'.repeat(296) + '.mp4', size: null }, // cannot even exist on disk (ENAMETOOLONG)
      { filename: names[253] }, { filename: names[227] }, { filename: names[201] },
      { filename: "Don't stop.mp4" }, // the sidecar's FILENAME_RE refuses the apostrophe
      { filename: names[200] },
    ],
    mtime: '2026-10-15T10:00:00',
  });
  const [item] = await pick(root, '2026-10-17T12:00:00');
  assert.equal(item.json.clip_key, `jobA/${names[200]}`);
  assert.deepEqual(item.json.manifestErrors, [
    'jobA row 1: name over 200 bytes', 'jobA row 2: name over 200 bytes', 'jobA row 3: name over 200 bytes',
    'jobA row 4: name over 200 bytes', 'jobA row 5: name the sidecar refuses',
  ]);
  assert.equal(h.readJson(item.json.claimPath).status, 'claimed');
});

s.check('a row whose lookup throws is junk for that run; the next row is still posted', async () => {
  const root = h.makeRoot();
  const { jobDir } = job(root, 'jobA', 2);
  const fsShim = Object.create(fs);
  fsShim.lstatSync = (p, ...rest) => {
    if (String(p) === path.join(jobDir, '00_clip.mp4')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
    return fs.lstatSync(p, ...rest);
  };
  const [item] = await pick(root, '2026-10-17T12:00:00', { fsImpl: fsShim });
  assert.equal(item.json.clip_key, 'jobA/01_clip.mp4');
  assert.deepEqual(item.json.manifestErrors, ['jobA row 1: EACCES']);
  markPosted(item.json);
  await assert.rejects(pick(root, '2026-10-17T15:00:00', { fsImpl: fsShim }), /row\(s\): jobA row 1: EACCES/);
});

s.check('over 300 MiB is junk and reported (never sent); exactly 300 MiB is sent with 750 s', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', {
    rows: [{ filename: 'huge.mp4', size: 300 * 1048576 + 1 }, { filename: 'max.mp4', size: 300 * 1048576 }],
    mtime: '2026-10-15T10:00:00',
  });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, 'jobA/max.mp4');
  assert.equal(item.json.timeoutMs, 750000);
  assert.deepEqual(item.json.manifestErrors, ['jobA row 1: over 300 MiB']);
});

s.check('timeout cap: a clip whose timeout would pass 780 s fails the run before any claim', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', { rows: [{ filename: 'big.mp4', size: 350 * 1048576 }], mtime: '2026-10-15T10:00:00' });
  h.setNow('2026-10-17T12:00:00');
  let code = h.loadNode(PICK, { root, live: true });
  code = code.replace('const MAX_CLIP_MB = 300;', 'const MAX_CLIP_MB = 400;'); // a future bump
  await assert.rejects(h.runNode(code), /timeout 825000 ms exceeds 780000 ms/);
  assert.equal(h.listClaims(root).length, 0);
  assert.deepEqual(h.listSlots(root), []);
});

s.check('caption: cleaned like the sidecar; title fallback; nothing usable = junk, reported', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', {
    rows: [
      { filename: '00.mp4', title: '', description: 'https://x.example/a?b=@me @ ## \u{1F600}\u200d\ufe0f' },
      { filename: '01.mp4', title: '\u{1F600}', description: '  ' },
      { filename: '02.mp4', title: 'Real title', description: '#@ www.example.com/x' },
      { filename: '03.mp4', title: '', description: '\ufeff' }, // not whitespace to Python: kept
    ],
    mtime: '2026-10-15T10:00:00',
  });
  const [first] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(first.json.clip_key, 'jobA/02.mp4');
  assert.equal(first.json.caption, 'Real title');
  assert.deepEqual(first.json.manifestErrors, ['jobA row 1: no usable caption', 'jobA row 2: no usable caption']);
  const [second] = await pick(root, '2026-10-17T09:05:00', { live: false });
  assert.equal(second.json.clip_key, 'jobA/03.mp4');
});

s.check('hashtags that start like a JSON array but are not one are dropped, not sent', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', { rows: [{ filename: '00.mp4', hashtags: '["#a", "#b"' }], mtime: '2026-10-15T10:00:00' });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.hashtags, '[]');
});

s.check('a missing or replaced inbox fails the run instead of reporting nothing to post', async () => {
  const root = h.makeRoot();
  fs.rmSync(h.inboxOf(root), { recursive: true });
  await assert.rejects(pick(root, '2026-10-17T12:00:00'), /inbox missing/);
  await assert.rejects(pick(root, '2026-10-17T09:00:00', { live: false }), /inbox missing/);
  fs.writeFileSync(h.inboxOf(root), 'not a folder');
  await assert.rejects(pick(root, '2026-10-17T12:00:00'), /inbox missing or not a directory/);
});

s.check('a symlinked .slots is refused; nothing is written through it', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 2);
  const elsewhere = fs.mkdtempSync(path.join(require('os').tmpdir(), 'elsewhere-'));
  fs.symlinkSync(elsewhere, path.join(root, '.slots'));
  await assert.rejects(pick(root, '2026-10-17T12:00:00'), /not a real directory/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(h.listClaims(root).length, 0);
});

s.check('not a regular file (a folder or a symlink named .mp4) is junk', async () => {
  const root = h.makeRoot();
  const { jobDir } = h.addJob(root, 'jobA', {
    rows: [{ filename: '00_dir.mp4', size: null }, { filename: '01_link.mp4', size: null }, { filename: '02_ok.mp4' }],
    mtime: '2026-10-15T10:00:00',
  });
  fs.mkdirSync(path.join(jobDir, '00_dir.mp4'));
  fs.symlinkSync(path.join(jobDir, '02_ok.mp4'), path.join(jobDir, '01_link.mp4'));
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, 'jobA/02_ok.mp4');
  assert.deepEqual(item.json.manifestErrors, ['jobA row 1: not a regular file', 'jobA row 2: not a regular file']);
});

s.check('a missing clip whose NFD spelling is over 255 bytes waits: no lstat of it, no failed runs', async () => {
  const name = '01_' + '한'.repeat(60) + '.mp4';
  assert.equal(Buffer.byteLength(name), 187);
  assert.ok(Buffer.byteLength(name.normalize('NFD')) > 255);
  const root = h.makeRoot();
  h.addJob(root, 'jobA', { rows: [{ filename: name, size: null }], mtime: '2026-10-15T10:00:00' });
  const looked = [];
  const fsShim = Object.create(fs);
  fsShim.lstatSync = (p, ...rest) => { looked.push(String(p)); return fs.lstatSync(p, ...rest); };
  for (const t of ['12:00', '12:15', '15:00']) {
    assert.deepEqual(await pick(root, `2026-10-17T${t}:00`, { fsImpl: fsShim }), [], t);
  }
  assert.deepEqual(looked.filter((p) => Buffer.byteLength(path.basename(p)) > 255), [], 'lstat of a name longer than NAME_MAX');
  assert.equal(h.exists(path.join(root, '.state', 'notices.json')), false, 'a waiting clip is not a notice');
});

s.check('notices come from EVERY row, even after the picked one; idle runs fail once a SAST day', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', {
    rows: [{ filename: '00_good.mp4' }, { filename: '01_huge.mp4', size: 300 * 1048576 + 1 }, { filename: "02_bad'name.mp4" }],
    mtime: '2026-10-15T10:00:00',
  });
  const alerts = [];
  const first = await dispatchRun(root, '2026-10-17T12:00:00', posted, alerts);
  assert.equal(first.clip_key, 'jobA/00_good.mp4');
  assert.deepEqual(first.manifestErrors, ['jobA row 2: over 300 MiB', 'jobA row 3: name the sidecar refuses']);
  assert.deepEqual(alerts.map((a) => (a.match(/(\d+) manifest problem/) || [])[1]), ['2'], 'daily Telegram notice');
  assert.equal(h.exists(path.join(h.inboxOf(root), 'jobA', 'manifest.csv')), true, 'pinned manifest archived away');
  assert.deepEqual(h.readJson(path.join(root, '.state', 'notices.json')).notices, first.manifestErrors);
  // nothing left to post: the idle run fails ONCE that day, with a count only
  await assert.rejects(pick(root, '2026-10-17T15:00:00'), (e) => {
    assert.equal(e.message, 'Pick Due Clip: 2 clip(s) can never be posted as they are; see .state/notices.json (reported once a day)');
    return true;
  });
  assert.deepEqual(await pick(root, '2026-10-17T18:00:00'), [], 'failed twice in one day');
  await assert.rejects(pick(root, '2026-10-18T12:00:00'), /2 clip\(s\) can never be posted/);
  assert.deepEqual(await pick(root, '2026-10-18T12:15:00'), []);
  assert.equal(h.readJson(path.join(root, '.state', 'retryable-failures.json')).idleNoticeDay, '2026-10-18');
});

s.check('notices.json is cleared once the problem is gone', async () => {
  const root = h.makeRoot();
  const { jobDir } = h.addJob(root, 'jobA', {
    rows: [{ filename: 'huge.mp4', size: 300 * 1048576 + 1 }, { filename: 'ok.mp4' }], mtime: '2026-10-15T10:00:00',
  });
  const [a] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(h.readJson(path.join(root, '.state', 'notices.json')).notices.length, 1);
  fs.rmSync(a.json.claimPath);
  fs.truncateSync(path.join(jobDir, 'huge.mp4'), 2048); // re-exported smaller
  await pick(root, '2026-10-17T09:05:00', { live: false });
  assert.deepEqual(h.readJson(path.join(root, '.state', 'notices.json')).notices, []);
});

s.check('a URL cut at a Python-whitespace control char leaves a usable caption', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', { rows: [{ filename: '00.mp4', title: '', description: 'https://x\x1cHello' }], mtime: '2026-10-15T10:00:00' });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.ok(item, 'junked a caption the sidecar would post as "Hello"');
  assert.deepEqual(item.json.manifestErrors, []);
});

s.check('Unicode: NFC name in the manifest, NFD name on disk (and back)', async () => {
  const nfc = '13_Alizé Umbrella.mp4'.normalize('NFC');
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  for (const [inManifest, onDisk] of [[nfc, nfd], [nfd, nfc]]) {
    const root = h.makeRoot();
    h.addJob(root, 'jobA', { rows: [{ filename: inManifest, onDisk }], mtime: '2026-10-15T10:00:00' });
    const [item] = await pick(root, '2026-10-17T09:00:00', { live: false, fsImpl: h.byteExactFs() });
    assert.ok(item, `picked (${inManifest === nfc ? 'NFC->NFD' : 'NFD->NFC'})`);
    assert.equal(item.json.clip_path, `jobA/${nfc}`);
    assert.equal(item.json.clip_key, `jobA/${nfc}`);
    assert.equal(path.basename(item.json.claimPath), nfc + '.json');
  }
});

s.check('cutoff: manifests modified before 2026-10-11 SAST are ignored', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'old', { rows: [{ filename: 'old.mp4' }], mtime: '2026-10-10T23:59:59' });
  assert.deepEqual(await pick(root, '2026-10-17T09:00:00', { live: false }), []);
  h.addJob(root, 'edge', { rows: [{ filename: 'edge.mp4' }], mtime: '2026-10-11T00:00:00' });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, 'edge/edge.mp4');
});

s.check('ordering: newest manifest first, then row order', async () => {
  const root = h.makeRoot();
  job(root, 'older', 2, '2026-10-12T10:00:00');
  job(root, 'newest', 2, '2026-10-16T10:00:00');
  job(root, 'middle', 1, '2026-10-14T10:00:00');
  const order = [];
  for (let i = 0; i < 6; i++) {
    const items = await pick(root, '2026-10-17T09:00:00', { live: false });
    if (!items.length) break;
    order.push(items[0].json.clip_key);
    markPosted(items[0].json);
  }
  assert.deepEqual(order, ['newest/00_clip.mp4', 'newest/01_clip.mp4', 'middle/00_clip.mp4',
    'older/00_clip.mp4', 'older/01_clip.mp4']);
});

s.check('race: a clip already claimed by another run is skipped', async () => {
  const root = h.makeRoot();
  const { jobDir } = job(root, 'jobA', 2);
  fs.mkdirSync(path.join(jobDir, '.claims'));
  fs.writeFileSync(path.join(jobDir, '.claims', '00_clip.mp4.json'),
    JSON.stringify({ status: 'claimed', claimedAt: '2026-10-17T12:00:00.000+02:00' }));
  const [item] = await pick(root, '2026-10-17T12:00:00');
  assert.equal(item.json.clip_key, 'jobA/01_clip.mp4');
});

s.check('race: a clip claimed between the check and the write is skipped (EEXIST)', async () => {
  const root = h.makeRoot();
  const { jobDir } = job(root, 'jobA', 2);
  fs.mkdirSync(path.join(jobDir, '.claims'));
  const theirs = path.join(jobDir, '.claims', '00_clip.mp4.json');
  fs.writeFileSync(theirs, JSON.stringify({ status: 'claimed', claimedAt: '2026-10-17T12:00:00.000+02:00', execId: 'other' }));
  const fsShim = Object.create(fs);
  fsShim.lstatSync = (p, ...rest) => {
    if (p === theirs) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } // not there when we looked
    return fs.lstatSync(p, ...rest);
  };
  const [item] = await pick(root, '2026-10-17T12:00:00', { fsImpl: fsShim });
  assert.equal(item.json.clip_key, 'jobA/01_clip.mp4');
  assert.equal(h.readJson(theirs).execId, 'other', 'the other run\'s claim was overwritten');
});

s.check('race: slot taken between the gate and the marker -> stand down, clip released', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 2);
  const fsShim = Object.create(fs);
  fsShim.writeFileSync = (file, data, opts) => {
    if (String(file).endsWith('2026-10-17-0.json')) {
      fs.writeFileSync(file, JSON.stringify({ claimedAt: '2026-10-17T12:00:00.000+02:00', execId: 'other' }));
    }
    return fs.writeFileSync(file, data, opts);
  };
  assert.deepEqual(await pick(root, '2026-10-17T12:00:00', { fsImpl: fsShim }), []);
  assert.equal(h.listClaims(root).length, 0, 'clip claim released');
  assert.equal(h.readJson(path.join(root, '.slots', '2026-10-17-0.json')).execId, 'other');
});

s.check('race: 4 overlapping runs in separate processes post exactly one clip', async () => {
  for (let round = 0; round < 3; round++) {
    const root = h.makeRoot();
    job(root, 'jobA', 6);
    const results = await h.runPickInChildren({ root, sast: '2026-10-17T12:00:00', live: true, count: 4 });
    const items = results.flat();
    assert.equal(items.length, 1, `round ${round}: ${items.length} runs went ahead`);
    assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
    assert.deepEqual(h.listClaims(root).map((c) => c.data.clip_key), [items[0].json.clip_key]);
  }
});

s.check('timeoutMs = (240 + ceil(1.5 * MiB) + 60) * 1000', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', { rows: [{ filename: 'big.mp4', size: 248 * 1048576 + 1 }], mtime: '2026-10-15T10:00:00' });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.timeoutMs, (240 + Math.ceil(1.5 * (248 + 1 / 1048576)) + 60) * 1000);
  assert.equal(item.json.timeoutMs, 673000);
});

s.check('a broken manifest does not block the others; alone it fails the run', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'broken', { raw: 'filename,title\r\n"unterminated.mp4,x\r\n', mtime: '2026-10-16T10:00:00' });
  h.addJob(root, 'good', { rows: [{ filename: 'ok.mp4' }], mtime: '2026-10-15T10:00:00' });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, 'good/ok.mp4');
  assert.equal(item.json.manifestErrors.length, 1);
  markPosted(item.json);
  await assert.rejects(pick(root, '2026-10-17T09:15:00', { live: false }), /unreadable manifest/);
});

s.check('item carries every field the HTTP node and Log Results need', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 1);
  const [item] = await pick(root, '2026-10-17T12:00:00');
  for (const k of ['clip_path', 'clip_key', 'caption', 'hashtags', 'dryRun', 'timeoutMs', 'manifestPath',
    'jobDir', 'rowIndex', 'filename', 'title', 'claimPath', 'slotMarker', 'claimedAt']) {
    assert.ok(k in item.json, k);
  }
  assert.equal(item.json.dryRun, false);
  assert.equal(h.readJson(item.json.claimPath).status, 'claimed');
});

// ---- multi-day steady state through Pick -> sidecar -> Log Results -> Archive ----

async function dispatchRun(root, sast, sidecar, alerts = []) {
  h.setNow(sast);
  const execId = String(sast);
  const picked = await h.runNode(h.loadNode(PICK, { root, live: true }), { execId });
  if (!picked.length) return null;
  const response = sidecar(picked[0].json, sast);
  const nodes = { 'Pick Due Clip': picked };
  const logged = await h.runNode(h.loadNode('log-results.jsCode.js', { root }), {
    input: [{ json: response }], nodes, execId, env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' },
    helpers: { httpRequest: async (opts) => { alerts.push(opts.body.text); return { ok: true }; } },
  });
  await h.runNode(h.loadNode('archive-manifest.jsCode.js'), { input: logged, nodes, execId });
  return picked[0].json;
}

const posted = (item) => ({ statusCode: 200, body: { status: 'success', code: 'posted', clip_key: item.clip_key } });

s.check('multi-day: 3 posts per SAST day at 12:00/15:00/18:00, newest first, no duplicates', async () => {
  const root = h.makeRoot();
  job(root, 'jobOld', 4, '2026-10-12T10:00:00');
  job(root, 'jobNew', 6, '2026-10-16T10:00:00');
  const postedKeys = [];
  const perDay = {};
  let day = h.DateTime.fromISO('2026-10-17T00:00:00', { zone: h.TZ });
  for (let d = 0; d < 5; d++, day = day.plus({ days: 1 })) {
    for (let m = 12 * 60; m <= 20 * 60 + 45; m += 15) {
      const t = day.plus({ minutes: m });
      const item = await dispatchRun(root, t, posted);
      if (item) {
        postedKeys.push(item.clip_key);
        (perDay[day.toISODate()] ||= []).push(t.toFormat('HH:mm'));
      }
    }
  }
  assert.deepEqual(perDay, {
    '2026-10-17': ['12:00', '15:00', '18:00'],
    '2026-10-18': ['12:00', '15:00', '18:00'],
    '2026-10-19': ['12:00', '15:00', '18:00'],
    '2026-10-20': ['12:00'],
  });
  assert.equal(new Set(postedKeys).size, postedKeys.length, 'duplicate post');
  assert.deepEqual(postedKeys.slice(0, 7), ['jobNew/00_clip.mp4', 'jobNew/01_clip.mp4', 'jobNew/02_clip.mp4',
    'jobNew/03_clip.mp4', 'jobNew/04_clip.mp4', 'jobNew/05_clip.mp4', 'jobOld/00_clip.mp4']);
  for (const j of ['jobOld', 'jobNew']) {
    const dir = path.join(h.inboxOf(root), j);
    assert.equal(h.exists(path.join(dir, 'manifest.csv')), false, j + ' not archived');
    assert.equal(fs.readdirSync(path.join(dir, 'processed')).length, 1);
  }
});

s.check('multi-day: a retryable failure frees the slot and the clip for the next run', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  let calls = 0;
  const flaky = (item) => (++calls === 1
    ? { error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } }
    : posted(item));
  const first = await dispatchRun(root, '2026-10-17T12:00:00', flaky);
  assert.equal(first.clip_key, 'jobA/00_clip.mp4');
  assert.deepEqual(h.listSlots(root), [], 'slot released');
  const retry = await dispatchRun(root, '2026-10-17T12:15:00', flaky);
  assert.equal(retry.clip_key, 'jobA/00_clip.mp4', 'same clip retried');
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
});

s.check('multi-day: an expired cookie claims nothing, burns no slot and loses no clip', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 6);
  const fixedAt = h.DateTime.fromISO('2026-10-19T00:00:00', { zone: h.TZ }); // refresh-cookies on day 3
  const sidecarFn = (item, t) => (t < fixedAt
    ? { statusCode: 401, body: { status: 'error', code: 'auth_invalid', error_id: 'abc123' } }
    : posted(item));
  const alerts = [];
  const postedAt = [];
  let failedRuns = 0;
  let day = h.DateTime.fromISO('2026-10-17T00:00:00', { zone: h.TZ });
  for (let d = 0; d < 4; d++, day = day.plus({ days: 1 })) {
    for (let m = 12 * 60; m <= 20 * 60 + 45; m += 15) {
      const t = day.plus({ minutes: m });
      const item = await dispatchRun(root, t, sidecarFn, alerts);
      if (t < fixedAt) {
        assert.ok(item, `no attempt at ${t.toISO()}: the expired cookie stalled the dispatcher`);
        failedRuns += 1;
        assert.equal(h.listClaims(root).length, 0, `clip claimed at ${t.toISO()}`);
        assert.deepEqual(h.listSlots(root), [], `slot burned at ${t.toISO()}`);
      } else if (item) postedAt.push(`${t.toFormat('MM-dd HH:mm')} ${item.clip_key}`);
    }
  }
  assert.equal(failedRuns, 72, 'every 15-minute tick retried');
  assert.equal(alerts.length, 6, 'alerts at the 1st, 13th, 25th, 37th, 49th, 61st failure');
  for (const a of alerts) assert.match(a, /^🔑 [\s\S]*make refresh-cookies/);
  assert.deepEqual(postedAt, [
    '10-19 12:00 jobA/00_clip.mp4', '10-19 15:00 jobA/01_clip.mp4', '10-19 18:00 jobA/02_clip.mp4',
    '10-20 12:00 jobA/03_clip.mp4', '10-20 15:00 jobA/04_clip.mp4', '10-20 18:00 jobA/05_clip.mp4',
  ]);
});

s.check('a definite "not uploaded" (400) sets the clip aside and frees the slot for the next clip', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  const sidecarFn = (item) => (item.clip_key === 'jobA/00_clip.mp4'
    ? { statusCode: 400, body: { status: 'error', code: 'bad_input', error_id: 'abc123' } }
    : posted(item));
  const alerts = [];
  const first = await dispatchRun(root, '2026-10-17T12:00:00', sidecarFn, alerts);
  assert.equal(first.clip_key, 'jobA/00_clip.mp4');
  assert.equal(h.readJson(first.claimPath).status, 'needs_you');
  assert.deepEqual(h.listSlots(root), [], 'slot 0 still taken');
  assert.equal(alerts.length, 1);
  const next = await dispatchRun(root, '2026-10-17T12:15:00', sidecarFn, alerts);
  assert.equal(next.clip_key, 'jobA/01_clip.mp4', 'the next clip takes the same slot');
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
});

s.check('multi-day: a systematic 400 sets aside at most 5 clips a day, with at most 5 alerts', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 20);
  const refuse = () => ({ statusCode: 400, body: { status: 'error', code: 'bad_input', error_id: 'abc123' } });
  const perDay = {};
  let day = h.DateTime.fromISO('2026-10-17T00:00:00', { zone: h.TZ });
  for (let d = 0; d < 3; d++, day = day.plus({ days: 1 })) {
    const alerts = [];
    let setAside = 0;
    for (let m = 12 * 60; m <= 20 * 60 + 45; m += 15) {
      if (await dispatchRun(root, day.plus({ minutes: m }), refuse, alerts)) setAside += 1;
    }
    perDay[day.toISODate()] = { setAside, alerts: alerts.length, hinted: alerts.filter((a) => a.includes('check the sidecar contract')).length };
  }
  assert.deepEqual(perDay, {
    '2026-10-17': { setAside: 5, alerts: 5, hinted: 3 },
    '2026-10-18': { setAside: 5, alerts: 5, hinted: 3 },
    '2026-10-19': { setAside: 5, alerts: 5, hinted: 3 },
  });
  assert.equal(h.listClaims(root).filter((c) => c.data.status === 'needs_you').length, 15);
});

s.run();
