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

// A youtube job with n clips 01_clip.mp4.. (00_ is the intro); mtime only breaks rotation ties.
function job(root, name, n, mtime = '2026-10-15T10:00:00') {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ filename: `${String(i).padStart(2, '0')}_clip.mp4` }); // 00_ is the intro: never posted
  return h.addJob(root, name, { rows, mtime });
}

// Stand-in for the Log Results outcome "posted": the claim records it.
function markPosted(item) {
  fs.writeFileSync(item.claimPath, JSON.stringify({ status: 'posted', claimedAt: item.claimedAt }));
}

s.check('gate: nothing before 09:00, slot 0 at 09:00, then wait for 12:00', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 5);
  for (const t of ['00:00', '08:45', '08:59']) assert.deepEqual(await pick(root, `2026-10-17T${t}:00`), [], t);
  const [first] = await pick(root, '2026-10-17T09:00:00');
  assert.equal(first.json.clip_key, 'jobA/01_clip.mp4');
  markPosted(first.json);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
  for (const t of ['09:15', '10:00', '11:45', '11:50', '11:59']) assert.deepEqual(await pick(root, `2026-10-17T${t}:00`), [], t);
  const [second] = await pick(root, '2026-10-17T12:00:00');
  assert.equal(second.json.clip_key, 'jobA/02_clip.mp4');
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json', '2026-10-17-1.json']);
  const fresh = h.makeRoot(); // homelab back at 11:59: the 09:00 slot is still owed
  job(fresh, 'jobA', 5);
  const [late] = await pick(fresh, '2026-10-17T11:59:00');
  assert.equal(late.json.clip_key, 'jobA/01_clip.mp4');
  assert.deepEqual(h.listSlots(fresh), ['2026-10-17-0.json']);
});

s.check('gate: 160-minute gap after the newest slot marker', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 5);
  const [late] = await pick(root, '2026-10-17T12:00:00'); // outage: slot 0 taken late
  markPosted(late.json);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
  assert.deepEqual(await pick(root, '2026-10-17T14:00:00'), [], '120 min after 12:00');
  assert.deepEqual(await pick(root, '2026-10-17T14:39:00'), [], '159 min');
  const [next] = await pick(root, '2026-10-17T14:40:00');
  assert.equal(next.json.clip_key, 'jobA/02_clip.mp4', '160 min');
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json', '2026-10-17-1.json']);
});

s.check('gate: earliest unused passed slot, never more than 5 a day', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 8);
  const [a] = await pick(root, '2026-10-17T16:00:00'); // homelab back at 16:00
  markPosted(a.json);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json'], 'slot 0 caught up first');
  const [b] = await pick(root, '2026-10-17T18:40:00');
  markPosted(b.json);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json', '2026-10-17-1.json']);
  const [c] = await pick(root, '2026-10-17T21:20:00');
  markPosted(c.json);
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json', '2026-10-17-1.json', '2026-10-17-2.json']);
  assert.deepEqual(await pick(root, '2026-10-17T21:45:00'), [], 'gap not met before 22:00');
});

s.check('gate: no catch-up at or after 22:00', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  assert.deepEqual(await pick(root, '2026-10-17T22:00:00'), []);
  assert.deepEqual(await pick(root, '2026-10-17T23:30:00'), []);
  assert.deepEqual(h.listSlots(root), []);
  assert.equal(h.listClaims(root).length, 0);
  const [late] = await pick(root, '2026-10-17T21:59:00');
  assert.equal(late.json.clip_key, 'jobA/01_clip.mp4');
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
  put('01_clip.mp4', { status: 'claimed', claimedAt: '2026-10-17T11:29:00.000+02:00' }); // 31 min
  put('02_clip.mp4', { status: 'claimed', claimedAt: '2026-10-17T11:31:00.000+02:00' }); // 29 min
  put('03_clip.mp4', { status: 'posted', claimedAt: '2026-10-01T12:00:00.000+02:00' });
  put('04_clip.mp4', { claimedAt: '2026-06-01T12:00:00.000Z', execId: '9', clipIndex: 3 }); // marker from the pre-2026-10 workflow
  const [item] = await pick(root, '2026-10-17T12:00:00');
  assert.equal(item.json.clip_key, 'jobA/01_clip.mp4', 'released stale clip is picked again');
  const left = h.listClaims(root).map((c) => c.file).sort();
  assert.deepEqual(left, ['01_clip.mp4.json', '02_clip.mp4.json', '03_clip.mp4.json', '04_clip.mp4.json']);
  assert.equal(h.readJson(path.join(claims, '01_clip.mp4.json')).execId, 'test-exec', 'fresh claim');
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
      { filename: '01_first.mp4', size: null, description }, // missing: skipped, but parsed
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
      { filename: '07_ok.mp4', size: 1025 },
    ],
    mtime: '2026-10-15T10:00:00',
  });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, `${LEGACY_JOB}/07_ok.mp4`);
  assert.deepEqual(h.listClaims(root).map((c) => c.file), ['07_ok.mp4.json']);
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
    if (String(p) === path.join(jobDir, '01_clip.mp4')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
    return fs.lstatSync(p, ...rest);
  };
  const [item] = await pick(root, '2026-10-17T12:00:00', { fsImpl: fsShim });
  assert.equal(item.json.clip_key, 'jobA/02_clip.mp4');
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
    rows: [{ filename: '01_dir.mp4', size: null }, { filename: '02_link.mp4', size: null }, { filename: '03_ok.mp4' }],
    mtime: '2026-10-15T10:00:00',
  });
  fs.mkdirSync(path.join(jobDir, '01_dir.mp4'));
  fs.symlinkSync(path.join(jobDir, '03_ok.mp4'), path.join(jobDir, '02_link.mp4'));
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, 'jobA/03_ok.mp4');
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
    rows: [{ filename: '01_good.mp4' }, { filename: '02_huge.mp4', size: 300 * 1048576 + 1 }, { filename: "03_bad'name.mp4" }],
    mtime: '2026-10-15T10:00:00',
  });
  const alerts = [];
  const first = await dispatchRun(root, '2026-10-17T12:00:00', posted, alerts);
  assert.equal(first.clip_key, 'jobA/01_good.mp4');
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

// Dry-run picks (no slot gate), one per minute so every claim has its own time, each marked posted.
async function sequence(root, n, { start = '2026-10-17T09:00:00', after = markPosted } = {}) {
  const order = [];
  let t = h.DateTime.fromISO(start, { zone: h.TZ });
  for (let i = 0; i < n; i++, t = t.plus({ minutes: 1 })) {
    const items = await pick(root, t.toFormat("yyyy-MM-dd'T'HH:mm:ss"), { live: false });
    if (!items.length) break;
    order.push(items[0].json.clip_key);
    after(items[0].json);
  }
  return order;
}

function claimFile(root, jobName, file, data, mtime) {
  const dir = path.join(h.inboxOf(root), jobName, '.claims');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, file + '.json');
  fs.writeFileSync(f, JSON.stringify(data));
  if (mtime) {
    const t = h.DateTime.fromISO(mtime, { zone: h.TZ }).toJSDate();
    fs.utimesSync(f, t, t);
  }
}

s.check('rotation: videos take turns, never the same one twice; ties keep the newest manifest first', async () => {
  const root = h.makeRoot();
  job(root, 'older', 3, '2026-10-12T10:00:00');
  job(root, 'newest', 3, '2026-10-16T10:00:00');
  job(root, 'middle', 3, '2026-10-14T10:00:00');
  assert.deepEqual(await sequence(root, 9), [
    'newest/01_clip.mp4', 'middle/01_clip.mp4', 'older/01_clip.mp4',
    'newest/02_clip.mp4', 'middle/02_clip.mp4', 'older/02_clip.mp4',
    'newest/03_clip.mp4', 'middle/03_clip.mp4', 'older/03_clip.mp4']);
});

s.check('rotation: the video used least recently goes next, judged by its NEWEST claim (not oldest, not count)', async () => {
  const root = h.makeRoot();
  for (const [name, mtime] of [['A', '2026-10-12T10:00:00'], ['B', '2026-10-13T10:00:00'], ['C', '2026-10-14T10:00:00'], ['D', '2026-10-15T10:00:00']]) {
    job(root, name, 6, mtime);
  }
  const posted = (at) => ({ status: 'posted', claimedAt: at });
  claimFile(root, 'A', '01_clip.mp4', posted('2026-10-01T09:00:00.000+02:00')); // oldest of all
  claimFile(root, 'A', '02_clip.mp4', posted('2026-10-16T09:00:00.000+02:00')); // but A was used again recently
  claimFile(root, 'B', '01_clip.mp4', posted('2026-10-10T09:00:00.000+02:00'));
  for (let i = 1; i <= 5; i++) claimFile(root, 'C', `0${i}_clip.mp4`, posted(`2026-10-0${i + 1}T09:00:00.000+02:00`)); // many, all old
  claimFile(root, 'D', '01_clip.mp4', posted('2026-10-16T12:00:00.000+02:00')); // the video used last
  const order = await sequence(root, 3);
  assert.deepEqual(order.map((k) => k.split('/')[0]), ['C', 'B', 'A'], 'max claim time, not min and not count');
});

s.check('rotation: only claims that may have reached TikTok count; needs_you and posted_elsewhere do not', async () => {
  const at = (hhmm) => `2026-10-17T${hhmm}:00.000+02:00`;
  for (const [status, lastIsA] of [['needs_you', false], ['posted_elsewhere', false], ['failed', true], ['claimed', true], ['posted', true]]) {
    const root = h.makeRoot();
    job(root, 'A', 3, '2026-10-16T10:00:00');
    job(root, 'B', 3, '2026-10-15T10:00:00');
    claimFile(root, 'B', '01_clip.mp4', { status: 'posted', claimedAt: at('08:00') });
    claimFile(root, 'A', '01_clip.mp4', { status, claimedAt: at('08:30') });
    const [first] = await sequence(root, 1, { start: '2026-10-17T08:40:00' });
    // lastIsA: A was used last, so B goes. Otherwise A's refused claim is ignored, B is last, A goes (its next clip).
    assert.equal(first, lastIsA ? 'B/02_clip.mp4' : 'A/02_clip.mp4', status);
  }
});

s.check('rotation: a claim without status counts (time from the file mtime); a future-dated claim and a .tmp file do not', async () => {
  const root = h.makeRoot();
  job(root, 'A', 3, '2026-10-16T10:00:00');
  job(root, 'B', 3, '2026-10-15T10:00:00');
  claimFile(root, 'B', '01_clip.mp4', { status: 'posted', claimedAt: '2026-10-16T08:00:00.000+02:00' });
  claimFile(root, 'A', '01_clip.mp4', { execId: '9' }, '2026-10-17T07:00:00'); // legacy marker, newer by mtime
  fs.writeFileSync(path.join(h.inboxOf(root), 'B', '.claims', '.tmp-1-2'), '{"status":"posted","claimedAt":"2026-10-17T08:59:00.000+02:00"}');
  assert.equal((await sequence(root, 1))[0], 'B/02_clip.mp4', 'legacy marker makes A the video used last');
  const root2 = h.makeRoot();
  job(root2, 'A', 3, '2026-10-16T10:00:00');
  job(root2, 'B', 3, '2026-10-15T10:00:00');
  claimFile(root2, 'B', '01_clip.mp4', { status: 'posted', claimedAt: '2026-10-16T08:00:00.000+02:00' });
  claimFile(root2, 'A', '01_clip.mp4', { status: 'posted', claimedAt: '2026-10-18T09:00:00.000+02:00' }); // a day ahead: wrong clock
  assert.equal((await sequence(root2, 1))[0], 'A/02_clip.mp4', 'the future-dated claim is ignored, so B is last');
});

s.check('rotation: a video holding more than half of the ready clips goes every other post', async () => {
  const root = h.makeRoot();
  job(root, 'A', 8, '2026-10-12T10:00:00');
  job(root, 'B', 1, '2026-10-16T10:00:00');
  job(root, 'C', 1, '2026-10-14T10:00:00');
  const order = await sequence(root, 10);
  assert.deepEqual(order.slice(0, 4), ['A/01_clip.mp4', 'B/01_clip.mp4', 'A/02_clip.mp4', 'C/01_clip.mp4']);
  assert.equal(order.filter((k) => k.startsWith('A/')).length, 8);
});

s.check('rotation: with a single video left it is still posted, one after another', async () => {
  const root = h.makeRoot();
  job(root, 'only', 3);
  assert.deepEqual(await sequence(root, 4), ['only/01_clip.mp4', 'only/02_clip.mp4', 'only/03_clip.mp4']);
});

s.check('rotation: a refused clip (needs_you, posted_elsewhere) does not hand the next slot back to the previous video', async () => {
  for (const response of [
    { statusCode: 400, body: { status: 'error', code: 'bad_input', error_id: 'e1' } },
    { statusCode: 409, body: { status: 'error', code: 'duplicate', error_id: 'e2' } },
  ]) {
    const root = h.makeRoot();
    job(root, 'A', 3, '2026-10-16T10:00:00');
    job(root, 'B', 3, '2026-10-15T10:00:00');
    const first = await dispatchRun(root, '2026-10-17T12:00:00', posted);
    assert.equal(first.clip_key, 'A/01_clip.mp4');
    const refused = await dispatchRun(root, '2026-10-17T15:00:00', () => response);
    assert.equal(refused.clip_key, 'B/01_clip.mp4');
    const next = await dispatchRun(root, '2026-10-17T15:15:00', posted);
    assert.equal(next.clip_key, 'B/02_clip.mp4', 'B again: the refusal did not count, so A is still the video used last');
  }
});

s.check('rotation: a retryable failure retries the same clip of the same video', async () => {
  const root = h.makeRoot();
  job(root, 'A', 3, '2026-10-16T10:00:00');
  job(root, 'B', 3, '2026-10-15T10:00:00');
  const busy = () => ({ statusCode: 503, body: { status: 'error', code: 'busy', error_id: 'e3' } });
  const first = await dispatchRun(root, '2026-10-17T12:00:00', busy);
  const retry = await dispatchRun(root, '2026-10-17T12:15:00', posted);
  assert.equal(first.clip_key, 'A/01_clip.mp4');
  assert.equal(retry.clip_key, 'A/01_clip.mp4');
});

s.check('intro: a 00_ clip and a clip titled Intro are never posted, never reported, and never block the others', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'A', {
    mtime: '2026-10-16T10:00:00',
    rows: [
      { filename: '00_huge.mp4', size: 300 * 1048576 + 1 }, // would be a reported "over 300 MiB" notice if it were not the intro
      { filename: '00_Intro.mp4' },
      { filename: '01_a.mp4', title: ' INTRO ' },
      { filename: '02_b.mp4', title: 'Introducing the vest' },
      { filename: '03_c.mp4', title: 'intro to ropes' },
    ],
  });
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false });
  assert.equal(item.json.clip_key, 'A/02_b.mp4');
  assert.deepEqual(item.json.manifestErrors, []);
  markPosted(item.json);
  assert.equal((await sequence(root, 5, { start: '2026-10-17T09:05:00' })).join(), 'A/03_c.mp4');
});

s.check('intro: a video with only its intro left is skipped and the others keep posting', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'onlyIntro', { mtime: '2026-10-16T10:00:00', rows: [{ filename: '00_Intro.mp4' }] });
  job(root, 'B', 2, '2026-10-15T10:00:00');
  assert.deepEqual(await sequence(root, 4), ['B/01_clip.mp4', 'B/02_clip.mp4']);
});

s.check('rotation: parity with the planning simulation on the live backlog (intros excluded), first 10 posts', async () => {
  const root = h.makeRoot();
  // job letters: T = TILER (newest manifest, 11 clips already used), C, I, G, V.
  const jobs = [['T', 12 + 11, '2026-10-12T19:21:00'], ['C', 5, '2026-10-11T20:26:00'], ['I', 2, '2026-10-11T20:20:00'],
    ['G', 49, '2026-10-11T18:52:00'], ['V', 24, '2026-10-11T08:41:00']];
  for (const [name, n, mtime] of jobs) {
    const rows = [{ filename: '00_intro.mp4' }];
    for (let i = 1; i <= n; i++) rows.push({ filename: `${String(i).padStart(2, '0')}_clip.mp4` });
    h.addJob(root, name, { rows, mtime });
  }
  for (let i = 1; i <= 11; i++) {
    claimFile(root, 'T', `${String(i).padStart(2, '0')}_clip.mp4`, { status: 'failed', claimedAt: `2026-10-${17 + (i % 9)}T10:00:00.000+02:00` });
  }
  const order = await sequence(root, 10, { start: '2026-10-26T09:00:00' });
  assert.equal(order.map((k) => k.split('/')[0]).join(''), 'GCGIGVGTGC');
});

s.check('race: a clip already claimed by another run is skipped', async () => {
  const root = h.makeRoot();
  const { jobDir } = job(root, 'jobA', 2);
  fs.mkdirSync(path.join(jobDir, '.claims'));
  fs.writeFileSync(path.join(jobDir, '.claims', '01_clip.mp4.json'),
    JSON.stringify({ status: 'claimed', claimedAt: '2026-10-17T12:00:00.000+02:00' }));
  const [item] = await pick(root, '2026-10-17T12:00:00');
  assert.equal(item.json.clip_key, 'jobA/02_clip.mp4');
});

s.check('race: a clip claimed between the check and the write is skipped (EEXIST)', async () => {
  const root = h.makeRoot();
  const { jobDir } = job(root, 'jobA', 2);
  fs.mkdirSync(path.join(jobDir, '.claims'));
  const theirs = path.join(jobDir, '.claims', '01_clip.mp4.json');
  fs.writeFileSync(theirs, JSON.stringify({ status: 'claimed', claimedAt: '2026-10-17T12:00:00.000+02:00', execId: 'other' }));
  const fsShim = Object.create(fs);
  fsShim.lstatSync = (p, ...rest) => {
    if (p === theirs) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } // not there when we looked
    return fs.lstatSync(p, ...rest);
  };
  const [item] = await pick(root, '2026-10-17T12:00:00', { fsImpl: fsShim });
  assert.equal(item.json.clip_key, 'jobA/02_clip.mp4');
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
// The Schedule node's cron, */15 9-21: 52 runs a SAST day, 09:00 to 21:45.
const TICK_FIRST = 9 * 60;
const TICK_LAST = 21 * 60 + 45;

// Every run of one SAST day from `fromMin` on; returns the times that posted.
async function simulateDay(root, dayIso, sidecar, fromMin = TICK_FIRST) {
  const day = h.DateTime.fromISO(dayIso + 'T00:00:00', { zone: h.TZ });
  const at = [];
  for (let m = fromMin; m <= TICK_LAST; m += 15) {
    const t = day.plus({ minutes: m });
    if (await dispatchRun(root, t, sidecar)) at.push(t.toFormat('HH:mm'));
  }
  return at;
}

const minutesOf = (hhmm) => { const [hh, mm] = hhmm.split(':').map(Number); return hh * 60 + mm; };
function assertSpacing(times, label) {
  assert.ok(times.length <= 5, `${label}: ${times.length} posts in a day`);
  const sorted = times.map(minutesOf).sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 160, `${label}: ${times.join(' ')} has posts under 160 min apart`);
  }
}

s.check('multi-day: 5 posts per SAST day at 09:00/12:00/15:00/18:00/21:00, videos alternate, no duplicates', async () => {
  const root = h.makeRoot();
  job(root, 'jobOld', 5, '2026-10-12T10:00:00');
  job(root, 'jobNew', 6, '2026-10-16T10:00:00');
  const postedKeys = [];
  const perDay = {};
  let day = h.DateTime.fromISO('2026-10-17T00:00:00', { zone: h.TZ });
  for (let d = 0; d < 4; d++, day = day.plus({ days: 1 })) {
    for (let m = TICK_FIRST; m <= TICK_LAST; m += 15) {
      const t = day.plus({ minutes: m });
      const item = await dispatchRun(root, t, posted);
      if (item) {
        postedKeys.push(item.clip_key);
        (perDay[day.toISODate()] ||= []).push(t.toFormat('HH:mm'));
      }
    }
  }
  assert.deepEqual(perDay, {
    '2026-10-17': ['09:00', '12:00', '15:00', '18:00', '21:00'],
    '2026-10-18': ['09:00', '12:00', '15:00', '18:00', '21:00'],
    '2026-10-19': ['09:00'],
  });
  assert.equal(new Set(postedKeys).size, postedKeys.length, 'duplicate post');
  assert.deepEqual(postedKeys, ['jobNew/01_clip.mp4', 'jobOld/01_clip.mp4', 'jobNew/02_clip.mp4', 'jobOld/02_clip.mp4',
    'jobNew/03_clip.mp4', 'jobOld/03_clip.mp4', 'jobNew/04_clip.mp4', 'jobOld/04_clip.mp4', 'jobNew/05_clip.mp4', 'jobOld/05_clip.mp4',
    'jobNew/06_clip.mp4']);
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
  assert.equal(first.clip_key, 'jobA/01_clip.mp4');
  assert.deepEqual(h.listSlots(root), [], 'slot released');
  const retry = await dispatchRun(root, '2026-10-17T12:15:00', flaky);
  assert.equal(retry.clip_key, 'jobA/01_clip.mp4', 'same clip retried');
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
});

s.check('multi-day: an expired cookie claims nothing, burns no slot and loses no clip', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 10);
  const fixedAt = h.DateTime.fromISO('2026-10-19T00:00:00', { zone: h.TZ }); // refresh-cookies on day 3
  const sidecarFn = (item, t) => (t < fixedAt
    ? { statusCode: 401, body: { status: 'error', code: 'auth_invalid', error_id: 'abc123' } }
    : posted(item));
  const alerts = [];
  const postedAt = [];
  let failedRuns = 0;
  let day = h.DateTime.fromISO('2026-10-17T00:00:00', { zone: h.TZ });
  for (let d = 0; d < 4; d++, day = day.plus({ days: 1 })) {
    for (let m = TICK_FIRST; m <= TICK_LAST; m += 15) {
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
  assert.equal(failedRuns, 104, 'every 15-minute tick retried (52 a day)');
  const uploaded = alerts.filter((a) => a.startsWith('Reelsmith: uploaded as Only me'));
  const authAlerts = alerts.filter((a) => !uploaded.includes(a));
  assert.equal(uploaded.length, 10, 'one Only-me notice per upload');
  assert.equal(authAlerts.length, 9, 'alerts at the 1st, 13th, 25th, ..., 97th failure');
  for (const a of authAlerts) assert.match(a, /^🔑 [\s\S]*make refresh-cookies/);
  assert.deepEqual(postedAt, [
    '10-19 09:00 jobA/01_clip.mp4', '10-19 12:00 jobA/02_clip.mp4', '10-19 15:00 jobA/03_clip.mp4',
    '10-19 18:00 jobA/04_clip.mp4', '10-19 21:00 jobA/05_clip.mp4',
    '10-20 09:00 jobA/06_clip.mp4', '10-20 12:00 jobA/07_clip.mp4', '10-20 15:00 jobA/08_clip.mp4',
    '10-20 18:00 jobA/09_clip.mp4', '10-20 21:00 jobA/10_clip.mp4',
  ]);
});

s.check('a definite "not uploaded" (400) sets the clip aside and frees the slot for the next clip', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  const sidecarFn = (item) => (item.clip_key === 'jobA/01_clip.mp4'
    ? { statusCode: 400, body: { status: 'error', code: 'bad_input', error_id: 'abc123' } }
    : posted(item));
  const alerts = [];
  const first = await dispatchRun(root, '2026-10-17T12:00:00', sidecarFn, alerts);
  assert.equal(first.clip_key, 'jobA/01_clip.mp4');
  assert.equal(h.readJson(first.claimPath).status, 'needs_you');
  assert.deepEqual(h.listSlots(root), [], 'slot 0 still taken');
  assert.equal(alerts.length, 1);
  const next = await dispatchRun(root, '2026-10-17T12:15:00', sidecarFn, alerts);
  assert.equal(next.clip_key, 'jobA/02_clip.mp4', 'the next clip takes the same slot');
  assert.deepEqual(h.listSlots(root), ['2026-10-17-0.json']);
});

s.check('multi-day: a systematic 400 sets aside at most 7 clips a day (2 + the 5 slots), with at most 7 alerts', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 24); // more than 3 days' worth: the cap, not the backlog, stops each day
  const refuse = () => ({ statusCode: 400, body: { status: 'error', code: 'bad_input', error_id: 'abc123' } });
  const perDay = {};
  let day = h.DateTime.fromISO('2026-10-17T00:00:00', { zone: h.TZ });
  for (let d = 0; d < 3; d++, day = day.plus({ days: 1 })) {
    const alerts = [];
    let setAside = 0;
    for (let m = TICK_FIRST; m <= TICK_LAST; m += 15) {
      if (await dispatchRun(root, day.plus({ minutes: m }), refuse, alerts)) setAside += 1;
    }
    perDay[day.toISODate()] = { setAside, alerts: alerts.length, hinted: alerts.filter((a) => a.includes('check the sidecar contract')).length };
  }
  assert.deepEqual(perDay, {
    '2026-10-17': { setAside: 7, alerts: 7, hinted: 5 },
    '2026-10-18': { setAside: 7, alerts: 7, hinted: 5 },
    '2026-10-19': { setAside: 7, alerts: 7, hinted: 5 },
  });
  assert.equal(h.listClaims(root).filter((c) => c.data.status === 'needs_you').length, 21);
});

s.check('multi-day: TikTok refusing every clip (502 publish_rejected): one attempt per slot, each clip tried twice, then set aside', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 8);
  const refuse = () => ({ statusCode: 502, body: { status: 'error', code: 'publish_rejected', error_id: 'abc123', tiktok_status_code: 5 } });
  const tried = [];
  const day = h.DateTime.fromISO('2026-10-17T00:00:00', { zone: h.TZ });
  for (let m = TICK_FIRST; m <= TICK_LAST; m += 15) {
    const item = await dispatchRun(root, day.plus({ minutes: m }), refuse);
    if (item) tried.push(`${day.plus({ minutes: m }).toFormat('HH:mm')} ${item.filename}`);
  }
  // 09:00 01 refused (retryAfter 01); 12:00 02 goes first, refused (retryAfter 02); 15:00 01 is
  // retried, set aside (flag cleared); 18:00 02 retried, set aside; 21:00 03 refused once.
  assert.deepEqual(tried, ['09:00 01_clip.mp4', '12:00 02_clip.mp4', '15:00 01_clip.mp4', '18:00 02_clip.mp4', '21:00 03_clip.mp4']);
  assert.deepEqual(h.listClaims(root).filter((c) => c.data.status === 'needs_you').map((c) => c.data.clip_key).sort(),
    ['jobA/01_clip.mp4', 'jobA/02_clip.mp4']);
  const state = h.readJson(path.join(root, '.state', 'retryable-failures.json'));
  assert.deepEqual([state.refusals, state.retryAfter], [{ 'jobA/03_clip.mp4': 1 }, 'jobA/03_clip.mp4']);
});

// ---- a refused clip is retried after another clip of its video ----

const refusedOnce = () => {
  let n = 0;
  return (item) => (++n === 1
    ? { statusCode: 502, body: { status: 'error', code: 'publish_rejected', error_id: 'e1', tiktok_status_code: 5 } }
    : posted(item));
};
const stateOf = (root) => h.readJson(path.join(root, '.state', 'retryable-failures.json'));

s.check('refusal retry: another clip of the video goes first, then the refused one; a posted attempt clears the flag', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  const sidecar = refusedOnce();
  const a = await dispatchRun(root, '2026-10-17T09:00:00', sidecar);
  assert.equal(a.clip_key, 'jobA/01_clip.mp4');
  assert.equal(stateOf(root).retryAfter, 'jobA/01_clip.mp4');
  const b = await dispatchRun(root, '2026-10-17T12:00:00', sidecar);
  assert.equal(b.clip_key, 'jobA/02_clip.mp4', 'the refused clip went first again');
  assert.equal('retryAfter' in stateOf(root), false, 'a kept claim did not clear the flag');
  const c = await dispatchRun(root, '2026-10-17T15:00:00', sidecar);
  assert.equal(c.clip_key, 'jobA/01_clip.mp4', 'the refused clip was not retried next');
  assert.deepEqual(stateOf(root).refusals, {});
});

s.check('refusal retry: the only ready clip of its video is retried next', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 1);
  const sidecar = refusedOnce();
  assert.equal((await dispatchRun(root, '2026-10-17T09:00:00', sidecar)).clip_key, 'jobA/01_clip.mp4');
  assert.equal((await dispatchRun(root, '2026-10-17T12:00:00', sidecar)).clip_key, 'jobA/01_clip.mp4');
  assert.equal(h.readJson(path.join(h.inboxOf(root), 'jobA', '.claims', '01_clip.mp4.json')).status, 'posted');
});

s.check('refusal retry: the only ready clip of a video is retried next even when another video could go', async () => {
  const root = h.makeRoot();
  job(root, 'A', 1, '2026-10-16T10:00:00'); // newest manifest: first in the rotation
  job(root, 'B', 1, '2026-10-15T10:00:00');
  const sidecar = refusedOnce();
  assert.equal((await dispatchRun(root, '2026-10-17T09:00:00', sidecar)).clip_key, 'A/01_clip.mp4');
  assert.equal((await dispatchRun(root, '2026-10-17T12:00:00', sidecar)).clip_key, 'A/01_clip.mp4');
});

s.check('refusal retry: a released next attempt keeps the flag, so the refused clip still waits', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 3);
  const answers = [
    { statusCode: 502, body: { status: 'error', code: 'publish_rejected', error_id: 'e1' } },
    { statusCode: 503, body: { status: 'error', code: 'busy', error_id: 'e2' } },
  ];
  const sidecar = (item) => answers.shift() || posted(item);
  const got = [];
  for (const t of ['09:00', '12:00', '12:15', '15:00']) got.push(`${t} ${(await dispatchRun(root, `2026-10-17T${t}:00`, sidecar)).filename}`);
  assert.deepEqual(got, ['09:00 01_clip.mp4', '12:00 02_clip.mp4', '12:15 02_clip.mp4', '15:00 01_clip.mp4']);
});

s.check('refusal retry: Pick Due Clip only reads the flag; a junk or unknown flag is ignored', async () => {
  for (const [label, raw, want] of [
    ['valid', '{"retryAfter": "jobA/01_clip.mp4"}', 'jobA/02_clip.mp4'],
    ['number', '{"retryAfter": 5}', 'jobA/01_clip.mp4'],
    ['no slash', '{"retryAfter": "01_clip.mp4"}', 'jobA/01_clip.mp4'],
    ['unknown clip', '{"retryAfter": "jobA/zz.mp4"}', 'jobA/01_clip.mp4'],
    ['array', '{"retryAfter": ["jobA/01_clip.mp4"]}', 'jobA/01_clip.mp4'],
    ['state is an array', '[1]', 'jobA/01_clip.mp4'],
    ['state is null', 'null', 'jobA/01_clip.mp4'],
  ]) {
    const root = h.makeRoot();
    job(root, 'jobA', 3);
    fs.mkdirSync(path.join(root, '.state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.state', 'retryable-failures.json'), raw);
    const [item] = await pick(root, '2026-10-17T09:00:00');
    assert.equal(item.json.clip_key, want, label);
    assert.equal(fs.readFileSync(path.join(root, '.state', 'retryable-failures.json'), 'utf8'), raw, `${label}: the flag was rewritten`);
  }
});

s.check('Pick Due Clip\'s once-a-day state write keeps Log Results\' refusal counts', async () => {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', { rows: [{ filename: '01_huge.mp4', size: 300 * 1048576 + 1 }], mtime: '2026-10-15T10:00:00' });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const statePath = path.join(root, '.state', 'retryable-failures.json');
  fs.writeFileSync(statePath, JSON.stringify({ refusals: { 'jobB/x.mp4': 1 }, needsCount: 1 }));
  await assert.rejects(pick(root, '2026-10-17T12:00:00'), /can never be posted/);
  const state = h.readJson(statePath);
  assert.equal(state.idleNoticeDay, '2026-10-17');
  assert.deepEqual(state.refusals, { 'jobB/x.mp4': 1 });
  assert.equal(state.needsCount, 1);
});

s.check('late cascade: the 09:00 slot claimed at 10:00 still posts the 21:00 slot by 21:45', async () => {
  const root = h.makeRoot();
  job(root, 'jobA', 8);
  const at = await simulateDay(root, '2026-10-17', posted, 10 * 60);
  assert.deepEqual(at, ['10:00', '12:45', '15:30', '18:15', '21:00']);
  assertSpacing(at, 'late cascade');
});

s.check('deploy day: slot markers the 3-slot workflow wrote (12:00/15:00/18:00 as 0/1/2) never give more than 5 posts or a gap under 160 min', async () => {
  // [deploy time, old markers already written today (index -> HH:mm), the new workflow's posts that day]
  const cases = [
    ['08:00', {}, ['09:00', '12:00', '15:00', '18:00', '21:00']],
    ['13:00', { 0: '12:00' }, ['14:45', '17:30', '20:15']],
    ['19:00', { 0: '12:00', 1: '15:00', 2: '18:00' }, ['20:45']],
    ['21:10', { 0: '12:00', 1: '15:00', 2: '18:00' }, ['21:15']],
  ];
  for (const [deployAt, old, want] of cases) {
    const root = h.makeRoot();
    job(root, 'jobA', 8);
    fs.mkdirSync(path.join(root, '.slots'));
    for (const [i, hhmm] of Object.entries(old)) {
      fs.writeFileSync(path.join(root, '.slots', `2026-10-17-${i}.json`),
        JSON.stringify({ claimedAt: `2026-10-17T${hhmm}:00.000+02:00`, execId: 'old', clip_key: 'old/x.mp4' }));
    }
    const fromMin = Math.ceil(minutesOf(deployAt) / 15) * 15;
    const at = await simulateDay(root, '2026-10-17', posted, Math.max(TICK_FIRST, fromMin));
    assert.deepEqual(at, want, `deploy at ${deployAt}`);
    assertSpacing([...Object.values(old), ...at], `deploy at ${deployAt}`);
  }
});

s.check('rotation: exactly half of the ready clips is not a majority; a claim 4 min ahead counts, 6 min ahead does not', async () => {
  const root = h.makeRoot();
  job(root, 'A', 1, '2026-10-16T10:00:00');
  job(root, 'B', 2, '2026-10-15T10:00:00');
  job(root, 'C', 1, '2026-10-14T10:00:00');
  assert.equal((await sequence(root, 1))[0], 'A/01_clip.mp4', 'B holds 2 of 4: tie rules apply (newest manifest), no guard');
  for (const [minutes, lastIsA] of [[4, true], [6, false]]) {
    const r = h.makeRoot();
    job(r, 'A', 3, '2026-10-16T10:00:00');
    job(r, 'B', 3, '2026-10-15T10:00:00');
    claimFile(r, 'B', '01_clip.mp4', { status: 'posted', claimedAt: '2026-10-17T08:00:00.000+02:00' });
    claimFile(r, 'A', '01_clip.mp4', { status: 'posted', claimedAt: `2026-10-17T09:0${minutes}:00.000+02:00` });
    const [first] = await sequence(r, 1);
    assert.equal(first, lastIsA ? 'B/02_clip.mp4' : 'A/02_clip.mp4', `+${minutes} min`);
  }
});

s.check('rotation: a claim that vanishes between the listing and the read is skipped, not fatal', async () => {
  const root = h.makeRoot();
  job(root, 'A', 3, '2026-10-16T10:00:00');
  job(root, 'B', 3, '2026-10-15T10:00:00');
  claimFile(root, 'A', '01_clip.mp4', { status: 'posted' }); // no claimedAt: the time comes from the file, which then vanishes
  const gone = path.join(h.inboxOf(root), 'A', '.claims', '01_clip.mp4.json');
  const fsShim = {
    ...fs,
    lstatSync: (p, ...a) => {
      if (p === gone) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
      return fs.lstatSync(p, ...a);
    },
  };
  const [item] = await pick(root, '2026-10-17T09:00:00', { live: false, fsImpl: fsShim });
  assert.equal(item.json.clip_key, 'A/02_clip.mp4');
});

s.run();
