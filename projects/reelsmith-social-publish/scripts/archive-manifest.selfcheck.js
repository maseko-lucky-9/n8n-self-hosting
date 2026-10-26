#!/usr/bin/env node
'use strict';
// Falsifiable checks for the Archive Manifest node (scripts/archive-manifest.jsCode.js):
// a manifest moves to processed/ only when every row is posted, posted_elsewhere or junk.
//   node archive-manifest.selfcheck.js   -> exit 0 on pass, 1 on any failure.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./selfcheck-harness');

const s = h.suite('archive-manifest');

function setup(rows, opts = {}) {
  const root = h.makeRoot();
  const { jobDir, manifestPath } = h.addJob(root, 'jobA', { rows, mtime: '2026-10-15T10:00:00', ...opts });
  fs.mkdirSync(path.join(jobDir, '.claims'));
  return { root, jobDir, manifestPath };
}

function claim(jobDir, filename, status) {
  const data = status === undefined ? { claimedAt: '2026-06-01T00:00:00Z' } : { status };
  fs.writeFileSync(path.join(jobDir, '.claims', filename.normalize('NFC') + '.json'), JSON.stringify(data));
}

async function archive({ jobDir, manifestPath }, fsImpl) {
  h.setNow('2026-10-17T12:05:00');
  const pick = { manifestPath, jobDir, clip_key: 'jobA/x.mp4' };
  const logged = [{ json: { outcome: 'posted', clip_key: 'jobA/x.mp4' } }];
  const [out] = await h.runNode(h.loadNode('archive-manifest.jsCode.js'), {
    input: logged, nodes: { 'Pick Due Clip': [{ json: pick }] }, fsImpl,
  });
  return out.json;
}

const JUNK_ROWS = [{ filename: '' }, { filename: 'notes.txt' }, { filename: 'tiny.mp4', size: 1024 }];

s.check('archives once every row is posted, posted_elsewhere or junk', async () => {
  const ctx = setup([{ filename: 'a.mp4' }, { filename: 'b.mp4' }, ...JUNK_ROWS]);
  claim(ctx.jobDir, 'a.mp4', 'posted');
  claim(ctx.jobDir, 'b.mp4', 'posted_elsewhere');
  const out = await archive(ctx);
  assert.equal(h.exists(ctx.manifestPath), false);
  assert.match(path.basename(out.archived_to), /^manifest-2026-10-17T10-05-00-000Z\.csv$/);
  assert.equal(path.dirname(out.archived_to), path.join(ctx.jobDir, 'processed'));
  assert.equal(out.outcome, 'posted', 'passes the Log Results item through');
});

for (const [name, mutate] of [
  ['a missing clip (Syncthing still copying)', (ctx) => fs.rmSync(path.join(ctx.jobDir, 'b.mp4'))],
  ['an unresolved claim', (ctx) => claim(ctx.jobDir, 'b.mp4', 'claimed')],
  ['a needs_you claim', (ctx) => claim(ctx.jobDir, 'b.mp4', 'needs_you')],
  ['a failed (ambiguous) claim', (ctx) => claim(ctx.jobDir, 'b.mp4', 'failed')],
  ['an old marker without status', (ctx) => claim(ctx.jobDir, 'b.mp4', undefined)],
  ['no claim at all', () => {}],
]) {
  s.check(`keeps the manifest with ${name}`, async () => {
    const ctx = setup([{ filename: 'a.mp4' }, { filename: 'b.mp4' }, ...JUNK_ROWS]);
    claim(ctx.jobDir, 'a.mp4', 'posted');
    mutate(ctx);
    const out = await archive(ctx);
    assert.equal(out.archived_to, undefined);
    assert.equal(h.exists(ctx.manifestPath), true);
    assert.equal(h.exists(path.join(ctx.jobDir, 'processed')), false);
  });
}

for (const [name, row, prep] of [
  ['a name over 200 bytes', { filename: 'a'.repeat(17) + '字'.repeat(60) + '.mp4' }],
  ['a name the sidecar refuses', { filename: "Don't.mp4" }],
  ['an unsafe name', { filename: 'sub/x.mp4', size: null }],
  ['a clip over 300 MiB', { filename: 'huge.mp4', size: 300 * 1048576 + 1 }],
  ['a clip with no usable caption', { filename: 'mute.mp4', title: '', description: '@ # https://x.example' }],
  ['a folder named .mp4', { filename: 'dir.mp4', size: null }, (ctx) => fs.mkdirSync(path.join(ctx.jobDir, 'dir.mp4'))],
]) {
  s.check(`keeps (pins) the manifest with ${name}: Pick reports it, a human decides`, async () => {
    const ctx = setup([{ filename: 'a.mp4' }, row, ...JUNK_ROWS]);
    claim(ctx.jobDir, 'a.mp4', 'posted');
    if (prep) prep(ctx);
    assert.equal((await archive(ctx)).archived_to, undefined, 'a reported clip was archived away');
    assert.equal(h.exists(ctx.manifestPath), true);
  });
}

s.check('a URL cut at a Python-whitespace control char leaves a usable caption (archived)', async () => {
  const ctx = setup([{ filename: 'a.mp4', title: '', description: 'https://x\x1cHello' }]);
  claim(ctx.jobDir, 'a.mp4', 'posted');
  assert.ok((await archive(ctx)).archived_to, 'the sidecar would post "Hello"; the row is not junk');
});

s.check('a row that cannot be checked keeps the manifest (never archived away unannounced)', async () => {
  const ctx = setup([{ filename: 'a.mp4' }, { filename: 'b.mp4' }]);
  claim(ctx.jobDir, 'a.mp4', 'posted');
  const fsShim = Object.create(fs);
  fsShim.lstatSync = (p, ...rest) => {
    if (String(p).endsWith(`${path.sep}b.mp4`)) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
    return fs.lstatSync(p, ...rest);
  };
  assert.equal((await archive(ctx, fsShim)).archived_to, undefined);
  assert.equal(h.exists(ctx.manifestPath), true);
});

s.check('a missing clip whose NFD spelling is over 255 bytes waits (kept, no ENAMETOOLONG)', async () => {
  const name = '01_' + '한'.repeat(60) + '.mp4';
  assert.equal(Buffer.byteLength(name.normalize('NFC')), 187);
  assert.ok(Buffer.byteLength(name.normalize('NFD')) > 255);
  const ctx = setup([{ filename: 'a.mp4' }, { filename: name, size: null }]);
  claim(ctx.jobDir, 'a.mp4', 'posted');
  const looked = [];
  const fsShim = Object.create(fs);
  fsShim.lstatSync = (p, ...rest) => { looked.push(String(p)); return fs.lstatSync(p, ...rest); };
  assert.equal((await archive(ctx, fsShim)).archived_to, undefined);
  assert.deepEqual(looked.filter((p) => Buffer.byteLength(path.basename(p)) > 255), [], 'lstat of a name longer than NAME_MAX');
});

s.check('NFD clip on disk with an NFC claim counts as posted', async () => {
  const nfc = '13_Alizé Umbrella.mp4'.normalize('NFC');
  const ctx = setup([{ filename: nfc, onDisk: nfc.normalize('NFD') }]);
  claim(ctx.jobDir, nfc, 'posted');
  const out = await archive(ctx, h.byteExactFs());
  assert.ok(out.archived_to, 'not archived');
});

s.check('quoted newlines in a description do not create phantom rows', async () => {
  const ctx = setup([{ filename: 'a.mp4', description: 'one\ntwo.mp4\nthree' }]);
  claim(ctx.jobDir, 'a.mp4', 'posted');
  assert.ok((await archive(ctx)).archived_to);
});

s.check('refuses a symlinked processed/', async () => {
  const ctx = setup([{ filename: 'a.mp4' }]);
  claim(ctx.jobDir, 'a.mp4', 'posted');
  const elsewhere = fs.mkdtempSync(path.join(require('os').tmpdir(), 'elsewhere-'));
  fs.symlinkSync(elsewhere, path.join(ctx.jobDir, 'processed'));
  await assert.rejects(archive(ctx), /not a real directory/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(h.exists(ctx.manifestPath), true);
});

s.check('a never-posted intro (00_*, or titled Intro) does not pin the manifest; an unposted ordinary clip still does', async () => {
  const done = setup([{ filename: '00_intro.mp4' }, { filename: 'x.mp4', title: ' Intro ' }, { filename: 'a.mp4' }]);
  claim(done.jobDir, 'a.mp4', 'posted');
  await archive(done);
  assert.equal(h.exists(done.manifestPath), false, 'archived: only intros were left unposted');
  const kept = setup([{ filename: '00_intro.mp4' }, { filename: 'a.mp4' }, { filename: 'b.mp4' }]);
  claim(kept.jobDir, 'a.mp4', 'posted');
  await archive(kept);
  assert.equal(h.exists(kept.manifestPath), true, 'b.mp4 is unposted: keep');
});

s.run();
