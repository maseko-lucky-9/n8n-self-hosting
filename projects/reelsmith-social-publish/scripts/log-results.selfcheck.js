#!/usr/bin/env node
'use strict';
// Falsifiable checks for the Log Results node (scripts/log-results.jsCode.js):
// every outcome row of the plan's table, the atomic claim write, claim-before-
// alert ordering, alert failure -> thrown run, and the dry-run release.
//   node log-results.selfcheck.js   -> exit 0 on pass, 1 on any failure.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./selfcheck-harness');

const s = h.suite('log-results');
const TOKEN = 'planted-bot-token-0123456789';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' };
const CAPTION = 'CAPTION-SENTINEL never in alerts';
const T = '2026-10-17T12:00:00';

// Picks one real clip (live mode: claim + slot 0 marker) and returns the item.
async function picked({ live = true, filename = '01_clip.mp4' } = {}) {
  const root = h.makeRoot();
  h.addJob(root, 'jobA', { rows: [{ filename, description: CAPTION }], mtime: '2026-10-15T10:00:00' });
  h.setNow(live ? T : '2026-10-17T09:00:00');
  const [item] = await h.runNode(h.loadNode('pick-due-clip.jsCode.js', { root, live }));
  assert.ok(item, 'fixture picked nothing');
  return { root, pick: item.json };
}

async function log(root, pick, response, { env = ENV, httpRequest, sast = '2026-10-17T12:05:00', logs } = {}) {
  const sent = [];
  h.setNow(sast);
  const helpers = {
    httpRequest: httpRequest || (async (opts) => { sent.push(opts); return { ok: true }; }),
  };
  const [out] = await h.runNode(h.loadNode('log-results.jsCode.js', { root }), {
    input: [{ json: response }], nodes: { 'Pick Due Clip': [{ json: pick }] }, env, helpers, execId: '77', logs,
  });
  return { out: out.json, sent };
}

const http = (statusCode, body) => ({ statusCode, statusMessage: 'x', headers: {}, body });
const sidecar = (statusCode, code, extra = {}) => http(statusCode, {
  status: statusCode === 200 ? 'success' : 'error', code, error_id: 'err-123', message: 'SIDECAR-OUTPUT-TAIL', ...extra,
});
const transport = (code, message) => ({ error: { code, message, name: 'AxiosError' } });

function resultRows(pick) {
  const lines = fs.readFileSync(path.join(pick.jobDir, 'results.log.csv'), 'utf8').trim().split('\n');
  return { header: lines[0], rows: lines.slice(1).map((l) => l.split(',')) };
}

const THROTTLE = 'You are posting too fast. Take a rest.';
const REFUSED_ALERT = /^Reelsmith: TikTok refused to publish it \(not posted\)\.\ncode: publish_rejected\nerror_id: err-123\nfile: 01_clip\.mp4\nCheck the caption \(see ADR-0002\) in the Mac export and let it sync, or leave it set aside; to retry, release the claim:\nssh homelab '[^\n]*'$/;

// [name, response, expected]
//   claim: final claim status, or null when the clip is released
//   slot: true when the slot marker survives
//   alert: RegExp the alert text must match, or null for no alert
const TABLE = [
  ['200 posted', sidecar(200, 'posted'), { kind: 'posted', claim: 'posted', slot: true, alert: /^Reelsmith: uploaded as Only me\. Set it to Everyone in TikTok Studio[\s\S]*file: /, row: 'posted' }],
  ['409 duplicate', sidecar(409, 'duplicate'), { kind: 'posted_elsewhere', claim: 'posted_elsewhere', slot: false, alert: null, row: 'posted_elsewhere' }],
  ['409 ambiguous', sidecar(409, 'ambiguous'), { kind: 'needs_you', claim: 'needs_you', slot: false, alert: /^Reelsmith: a clip is blocked by an earlier upload that may have posted[\s\S]*code: ambiguous/, row: 'needs_you' }],
  ['401 auth_invalid', sidecar(401, 'auth_invalid'), { kind: 'auth_invalid', claim: null, slot: false, alert: /^🔑[\s\S]*make refresh-cookies[\s\S]*code: auth_invalid/, row: 'auth_invalid' }],
  ['400 bad_input', sidecar(400, 'bad_input'), { kind: 'needs_you', claim: 'needs_you', slot: false, alert: /^Reelsmith: a clip was refused \(not posted[\s\S]*code: bad_input/, row: 'needs_you' }],
  ['413 too_large', sidecar(413, 'too_large'), { kind: 'needs_you', claim: 'needs_you', slot: false, alert: /^Reelsmith: a clip was refused \(not posted[\s\S]*code: too_large/, row: 'needs_you' }],
  ['429 daily_cap', sidecar(429, 'daily_cap'), { kind: 'daily_cap', claim: null, slot: true, alert: /^Reelsmith: today's upload cap is reached; clips wait for tomorrow \(this slot is used\)\.\ncode: daily_cap\nerror_id: err-123\nfile: 01_clip\.mp4$/, row: 'daily_cap' }],
  ['503 busy', sidecar(503, 'busy'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['503 clock_unsynced', sidecar(503, 'clock_unsynced'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['503 network_before_upload', sidecar(503, 'network_before_upload'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['503 paused', sidecar(503, 'paused'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['ECONNREFUSED', transport('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8000'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['ENOTFOUND', transport('ENOTFOUND', 'getaddrinfo ENOTFOUND tiktok-sidecar'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['EAI_AGAIN', transport('EAI_AGAIN', 'getaddrinfo EAI_AGAIN tiktok-sidecar'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['connect timeout (ETIMEDOUT)', transport('ETIMEDOUT', 'connect ETIMEDOUT 127.0.0.1:8000'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['connect EHOSTUNREACH', transport('EHOSTUNREACH', 'connect EHOSTUNREACH 127.0.0.1:8000'), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['ENETUNREACH (code only)', transport('ENETUNREACH', ''), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
  ['read ETIMEDOUT (after sending)', transport('ETIMEDOUT', 'read ETIMEDOUT'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: etimedout/, row: 'failed' }],
  ['EPIPE', transport('EPIPE', 'write EPIPE'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: epipe/, row: 'failed' }],
  ['HTTP timeout (ECONNABORTED)', transport('ECONNABORTED', 'timeout of 673000ms exceeded'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: timeout/, row: 'failed' }],
  ['ECONNRESET', transport('ECONNRESET', 'socket hang up'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: econnreset/, row: 'failed' }],
  // TikTok refused the post: not published, the clip is set aside, the slot stays used.
  ['502 publish_rejected', sidecar(502, 'publish_rejected', { tiktok_status_code: 5, tiktok_status_msg: null }), { kind: 'needs_you', claim: 'needs_you', slot: true, alert: REFUSED_ALERT, row: 'needs_you' }],
  ['502 publish_rejected, other TikTok text', sidecar(502, 'publish_rejected', { tiktok_status_msg: 'You are posting too fast.' }), { kind: 'needs_you', claim: 'needs_you', slot: true, alert: REFUSED_ALERT, row: 'needs_you' }],
  // Not the clip's fault: released for a later slot, this slot stays used, safety alert.
  ['502 publish_rejected, throttled', sidecar(502, 'publish_rejected', { tiktok_status_msg: THROTTLE }), { kind: 'deferred', claim: null, slot: true, alert: /^Reelsmith: TikTok says "posting too fast" \(not posted\)[\s\S]*released for a later slot; this slot stays used\.\ncode: publish_rejected\nerror_id: err-123\nfile: 01_clip\.mp4$/, row: 'deferred' }],
  ['502 signature_failed', sidecar(502, 'signature_failed'), { kind: 'deferred', claim: null, slot: true, alert: /^Reelsmith: the sidecar's signing helper failed \(not posted\)[\s\S]*released for a later slot; this slot stays used\.\ncode: signature_failed\nerror_id: err-123\nfile: 01_clip\.mp4$/, row: 'deferred' }],
  // Every other 502, and those codes on any other status, may have posted.
  ['502 other code', sidecar(502, 'upload_failed'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: upload_failed/, row: 'failed' }],
  ['502 no JSON body', http(502, 'Bad Gateway'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: http_502/, row: 'failed' }],
  ['500 publish_rejected', sidecar(500, 'publish_rejected', { tiktok_status_msg: THROTTLE }), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: publish_rejected/, row: 'failed' }],
  ['504 signature_failed', sidecar(504, 'signature_failed'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: signature_failed/, row: 'failed' }],
  ['500 internal', sidecar(500, 'internal'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: internal/, row: 'failed' }],
  ['504 timeout', sidecar(504, 'timeout'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: timeout/, row: 'failed' }],
  ['200 posting_disabled (real run, kill switch off)', http(200, { status: 'dry_run', code: 'posting_disabled' }), { kind: 'dry_run', claim: null, slot: false, alert: /^Reelsmith: the sidecar has POSTING_ENABLED=false while the workflow is live/, row: 'dry_run' }],
  ['read EHOSTUNREACH (established socket)', transport('EHOSTUNREACH', 'read EHOSTUNREACH'), { kind: 'ambiguous', claim: 'failed', slot: true, alert: /outcome unknown[\s\S]*code: ehostunreach/, row: 'failed' }],
  ['EHOSTUNREACH (code only)', transport('EHOSTUNREACH', ''), { kind: 'retryable', claim: null, slot: false, alert: null, row: 'retryable' }],
];

for (const [name, response, want] of TABLE) {
  s.check(`outcome: ${name}`, async () => {
    const { root, pick } = await picked();
    const { out, sent } = await log(root, pick, response);
    assert.equal(out.outcome, want.kind);
    if (want.claim === null) assert.equal(h.exists(pick.claimPath), false, 'clip not released');
    else {
      const claim = h.readJson(pick.claimPath);
      assert.equal(claim.status, want.claim);
      assert.equal(claim.clip_key, 'jobA/01_clip.mp4');
    }
    assert.equal(h.exists(pick.slotMarker), want.slot, want.slot ? 'slot released' : 'slot kept');
    const { header, rows } = resultRows(pick);
    assert.equal(header, 'timestamp,filename,title,tiktok_post_id,tiktok_post_url,youtube_video_id,youtube_status,error,tiktok_status');
    assert.equal(rows.length, 1);
    assert.equal(rows[0][1], '01_clip.mp4');
    assert.equal(rows[0][8], want.row);
    if (want.alert) {
      assert.equal(sent.length, 1, 'expected one alert');
      assert.match(sent[0].body.text, want.alert);
    } else assert.equal(sent.length, 0, 'unexpected alert');
  });
}

s.check('alerts: fixed text + code + error_id + filename only, <= 2000 chars, plain text', async () => {
  const { root, pick } = await picked();
  const long = { ...pick, filename: 'x'.repeat(2500) + '.mp4' };
  const { sent } = await log(root, long, sidecar(502, 'publish_rejected', { caption: CAPTION }));
  const { text } = sent[0].body;
  assert.ok(text.length <= 2000, `alert is ${text.length} chars`);
  // a name the rules refuse (here a shell-quote breaker) never reaches the copy-paste command
  const hostile = { ...pick, filename: "x'; touch pwned; '.mp4" };
  const quoted = (await log(root, hostile, sidecar(502, 'publish_rejected'))).sent[0].body.text;
  assert.equal(quoted.includes('ssh homelab'), false, 'a refused name reached a shell command');
  for (const leak of [CAPTION, 'SIDECAR-OUTPUT-TAIL', TOKEN]) assert.ok(!quoted.includes(leak), 'alert leaks ' + leak);
  assert.equal(sent[0].body.parse_mode, undefined);
  for (const leak of [CAPTION, 'SIDECAR-OUTPUT-TAIL', TOKEN]) assert.ok(!text.includes(leak), 'alert leaks ' + leak);
  const { sent: sent2 } = await log(root, pick, sidecar(502, 'publish_rejected'));
  assert.match(sent2[0].body.text, /code: publish_rejected\nerror_id: err-123\nfile: 01_clip\.mp4\n/);
  for (const leak of [CAPTION, 'SIDECAR-OUTPUT-TAIL', TOKEN]) assert.ok(!sent2[0].body.text.includes(leak), 'alert leaks ' + leak);
  assert.equal(sent2[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(sent2[0].body.chat_id, '42');
});

s.check('needs_you / ambiguous alerts carry the exact claim-release command', async () => {
  const { root, pick } = await picked();
  const cmd = `ssh homelab 'microk8s kubectl -n n8n-live exec deploy/n8n-application-worker -- rm "${h.inboxOf(root)}/jobA/.claims/01_clip.mp4.json"'`;
  const amb = (await log(root, pick, sidecar(504, 'timeout'))).sent[0].body.text;
  assert.ok(amb.endsWith('\n' + cmd), amb);
  for (const outcome of ['posted', 'not_posted']) {
    assert.ok(amb.includes(`\nmake ledger-resolve KEY='jobA/01_clip.mp4' OUTCOME=${outcome}\n`), outcome);
  }
  assert.equal(/OUTCOME=posted\|/.test(amb), false, 'a | in a command line pipes make into nothing');
  assert.match(amb, /refused with "no ledger rows" or "it is free", the upload never reached TikTok: go to 2\./);
  const blocked = (await log(root, pick, sidecar(409, 'ambiguous'))).sent[0].body.text;
  assert.ok(blocked.includes("make ledger-resolve KEY='jobA/01_clip.mp4' OUTCOME=not_posted") && blocked.endsWith(cmd));
  const bad = (await log(root, pick, sidecar(400, 'bad_input'))).sent[0].body.text;
  assert.ok(bad.includes('Fix the clip') && !bad.includes('ledger-resolve') && bad.endsWith(cmd));
});

s.check('the longest allowed name (200 bytes, with spaces) keeps every command whole inside the cap', async () => {
  const name = 'a b'.repeat(65) + 'a.mp4';
  assert.equal(Buffer.byteLength(name), 200);
  const { root, pick } = await picked({ filename: name });
  const { text } = (await log(root, pick, sidecar(504, 'timeout'))).sent[0].body;
  assert.ok(text.length <= 2000, `${text.length} chars`);
  assert.ok(text.includes(`KEY='jobA/${name}' OUTCOME=not_posted`), 'a name with spaces must stay one KEY');
  assert.ok(text.endsWith(`/jobA/.claims/${name}.json"'`), 'command cut off');
});

s.check('no command is built from a job id or a name the rules refuse', async () => {
  const { root, pick } = await picked();
  const hostileDir = path.join(path.dirname(pick.jobDir), "jobA';touch pwned;'");
  fs.mkdirSync(hostileDir);
  const cases = [
    { ...pick, jobDir: hostileDir },
    { ...pick, filename: 'a'.repeat(250) + '.mp4' }, // NAME_RE allows it, but it is over 200 bytes
  ];
  for (const hostile of cases) {
    const { text } = (await log(root, hostile, sidecar(504, 'timeout'))).sent[0].body;
    assert.equal(text.includes('ssh homelab'), false, text);
    assert.equal(text.includes('ledger-resolve'), false, text);
    assert.equal(text.includes('pwned'), false, text);
  }
});

s.check('a 200-byte CJK name is recorded (short tmp name, no ENAMETOOLONG)', async () => {
  const name = 'a'.repeat(16) + '字'.repeat(60) + '.mp4';
  assert.equal(Buffer.byteLength(name), 200);
  const { root, pick } = await picked({ filename: name });
  await log(root, pick, sidecar(200, 'posted'));
  assert.equal(h.readJson(pick.claimPath).status, 'posted');
});

s.check('releases refuse a symlinked .claims or .slots (nothing deleted through it)', async () => {
  const os = require('os');
  const a = await picked();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
  fs.writeFileSync(path.join(elsewhere, '01_clip.mp4.json'), '{}');
  fs.rmSync(path.dirname(a.pick.claimPath), { recursive: true });
  fs.symlinkSync(elsewhere, path.dirname(a.pick.claimPath));
  await assert.rejects(log(a.root, a.pick, sidecar(503, 'busy')), /not a real directory/);
  assert.ok(h.exists(path.join(elsewhere, '01_clip.mp4.json')), 'claim deleted through the symlink');

  const b = await picked();
  const slots = path.dirname(b.pick.slotMarker);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
  fs.renameSync(b.pick.slotMarker, path.join(other, path.basename(b.pick.slotMarker)));
  fs.rmSync(slots, { recursive: true });
  fs.symlinkSync(other, slots);
  await assert.rejects(log(b.root, b.pick, sidecar(503, 'busy')), /not a real directory/);
  assert.ok(h.exists(path.join(other, path.basename(b.pick.slotMarker))), 'slot marker deleted through the symlink');
});

s.check('manifest problems alert once per SAST day, as a count, and only once sent', async () => {
  const { root, pick } = await picked();
  const withErrors = { ...pick, manifestErrors: ['jobX: unterminated quoted field', 'jobA row 3: name too long'] };
  const reset = () => fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
  const fail = async () => { const e = new Error('x'); e.code = 'ECONNRESET'; throw e; };
  const logs = [];
  await log(root, withErrors, sidecar(409, 'duplicate'), { httpRequest: fail, logs }); // informational: no throw
  assert.match(logs.join('\n'), /informational alert not sent; the next run retries it/);
  assert.equal(h.readJson(pick.claimPath).status, 'posted_elsewhere');
  reset();
  const first = await log(root, withErrors, sidecar(409, 'duplicate'), { sast: '2026-10-17T15:05:00' });
  assert.equal(first.sent.length, 1, 'not retried after a failed send');
  assert.match(first.sent[0].body.text, /^Reelsmith: 2 manifest problem\(s\)/);
  assert.match(first.sent[0].body.text, /see \.state\/notices\.json/);
  assert.equal(/jobX|row 3|unterminated/.test(first.sent[0].body.text), false, 'manifest details leaked');
  reset();
  assert.equal((await log(root, withErrors, sidecar(409, 'duplicate'), { sast: '2026-10-17T18:05:00' })).sent.length, 0, 'twice in a day');
  reset();
  assert.equal((await log(root, withErrors, sidecar(409, 'duplicate'), { sast: '2026-10-18T12:05:00' })).sent.length, 1, 'next day');
  reset();
  assert.equal((await log(root, pick, sidecar(409, 'duplicate'), { sast: '2026-10-19T12:05:00' })).sent.length, 0, 'no problems');
});

s.check('a live workflow hitting the kill switch: released as before, told once a SAST day, never fails the run', async () => {
  const disabled = http(200, { status: 'dry_run', code: 'posting_disabled', caption: CAPTION, timeout_s: 250 });
  const { root, pick } = await picked();
  const run = async (sast, opts = {}) => {
    fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
    fs.writeFileSync(pick.slotMarker, JSON.stringify({ claimedAt: pick.claimedAt }));
    return log(root, pick, disabled, { sast, ...opts });
  };
  const fail = async () => { const e = new Error('x'); e.code = 'ETIMEDOUT'; throw e; };
  const logs = [];
  const failed = await run('2026-10-17T12:05:00', { httpRequest: fail, logs });
  assert.equal(failed.out.outcome, 'dry_run');
  assert.equal(h.exists(pick.claimPath), false, 'clip not released');
  assert.equal(h.exists(pick.slotMarker), false, 'slot not released');
  assert.equal(logs.length, 1);
  const sentAt = [];
  for (const t of ['2026-10-17T12:20:00', '2026-10-17T12:35:00', '2026-10-18T12:05:00']) {
    if ((await run(t)).sent.length) sentAt.push(t);
  }
  assert.deepEqual(sentAt, ['2026-10-17T12:20:00', '2026-10-18T12:05:00']);
  const dry = await picked({ live: false });
  assert.equal((await log(dry.root, dry.pick, disabled)).sent.length, 0, 'a dry-run deploy is not a live workflow');
});

s.check('daily cap: told once a SAST day (informational: a failed send is only logged and retried), clip released, slot kept', async () => {
  const { root, pick } = await picked();
  const run = async (sast, opts = {}) => {
    fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
    fs.writeFileSync(pick.slotMarker, JSON.stringify({ claimedAt: pick.claimedAt }));
    const r = await log(root, pick, sidecar(429, 'daily_cap'), { sast, ...opts });
    assert.equal(h.exists(pick.claimPath), false, `clip not released at ${sast}`);
    assert.equal(h.exists(pick.slotMarker), true, `slot freed at ${sast}`);
    return r;
  };
  const fail = async () => { const e = new Error('x'); e.code = 'ECONNRESET'; throw e; };
  const logs = [];
  await run('2026-10-17T09:05:00', { httpRequest: fail, logs }); // must not throw
  assert.match(logs.join('\n'), /informational alert not sent; the next run retries it/);
  const sentAt = [];
  for (const t of ['2026-10-17T12:05:00', '2026-10-17T15:05:00', '2026-10-17T18:05:00', '2026-10-18T09:05:00', '2026-10-18T12:05:00']) {
    const { sent } = await run(t);
    if (sent.length) {
      sentAt.push(t);
      assert.match(sent[0].body.text, /^Reelsmith: today's upload cap is reached/);
    }
  }
  assert.deepEqual(sentAt, ['2026-10-17T12:05:00', '2026-10-18T09:05:00']);
  assert.equal(h.readJson(path.join(root, '.state', 'retryable-failures.json')).dailyCapAlertDay, '2026-10-18');
});

s.check('a safety alert still fails the run when it cannot be sent, and leaves the daily notices unmarked', async () => {
  const { root, pick } = await picked();
  const withErrors = { ...pick, manifestErrors: ['jobX: unterminated quoted field'] };
  const fail = async () => { const e = new Error('x'); e.code = 'ECONNRESET'; throw e; };
  await assert.rejects(log(root, withErrors, sidecar(504, 'timeout'), { httpRequest: fail }), /Telegram alert failed/);
  assert.equal(h.readJson(path.join(root, '.state', 'retryable-failures.json')).manifestAlertDay, undefined);
});

s.check('needsCount restarts each SAST day and after a post', async () => {
  const { root, pick } = await picked();
  const step = async (response, sast) => {
    fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
    fs.writeFileSync(pick.slotMarker, JSON.stringify({ claimedAt: pick.claimedAt }));
    const r = await log(root, pick, response, { sast });
    return [r.out.needsCount, !h.exists(pick.slotMarker)];
  };
  assert.deepEqual(await step(sidecar(400, 'bad_input'), '2026-10-17T12:05:00'), [1, true]);
  assert.deepEqual(await step(sidecar(400, 'bad_input'), '2026-10-17T12:20:00'), [2, true]);
  assert.deepEqual(await step(sidecar(400, 'bad_input'), '2026-10-17T12:35:00'), [3, false]);
  assert.deepEqual(await step(sidecar(400, 'bad_input'), '2026-10-18T12:05:00'), [1, true], 'yesterday\'s streak carried over');
  assert.deepEqual(await step(sidecar(200, 'posted'), '2026-10-18T12:20:00'), [0, false]);
  assert.deepEqual(await step(sidecar(400, 'bad_input'), '2026-10-18T15:05:00'), [1, true]);
});

s.check('the claim is on disk with its outcome BEFORE the alert is sent', async () => {
  const { root, pick } = await picked();
  const seen = [];
  await log(root, pick, sidecar(400, 'bad_input'), {
    httpRequest: async () => { seen.push(h.readJson(pick.claimPath).status); return {}; },
  });
  assert.deepEqual(seen, ['needs_you'], 'every alert must see the recorded outcome');
});

s.check('a failed alert send fails the run, without the token, after recording', async () => {
  const { root, pick } = await picked();
  const boom = async (opts) => { const e = new Error(`request to ${opts.url} failed`); e.code = 'ECONNRESET'; throw e; };
  await assert.rejects(log(root, pick, sidecar(500, 'internal'), { httpRequest: boom }), (e) => {
    assert.match(e.message, /Telegram alert failed \(econnreset\)/);
    assert.ok(!e.message.includes(TOKEN), 'token leaked into the error');
    return true;
  });
  assert.equal(h.readJson(pick.claimPath).status, 'failed');
  assert.equal(resultRows(pick).rows.length, 1);
});

s.check('missing Telegram env fails the run instead of swallowing the alert', async () => {
  const { root, pick } = await picked();
  await assert.rejects(log(root, pick, sidecar(400, 'bad_input'), { env: {} }), /TELEGRAM_BOT_TOKEN/);
  assert.equal(h.readJson(pick.claimPath).status, 'needs_you');
});

s.check('atomic claim write: tmp + rename, no tmp left, refuses a symlinked .claims', async () => {
  const { root, pick } = await picked();
  const realRename = fs.renameSync;
  const renames = [];
  fs.renameSync = (a, b) => { renames.push([path.basename(a), path.basename(b)]); return realRename(a, b); };
  try {
    await log(root, pick, sidecar(200, 'posted'));
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(renames.some(([a, b]) => b === '01_clip.mp4.json' && /^\.tmp-77-\d+$/.test(a)), JSON.stringify(renames));
  assert.deepEqual(fs.readdirSync(path.dirname(pick.claimPath)), ['01_clip.mp4.json']);

  const second = await picked();
  const claims = path.dirname(second.pick.claimPath);
  const elsewhere = fs.mkdtempSync(path.join(require('os').tmpdir(), 'elsewhere-'));
  fs.rmSync(claims, { recursive: true });
  fs.symlinkSync(elsewhere, claims);
  await assert.rejects(log(second.root, second.pick, sidecar(200, 'posted')), /not a real directory/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'wrote through the symlink');
});

s.check('retryable: alert on the 3rd in a row, then every 12th; any other outcome resets', async () => {
  const { root, pick } = await picked();
  const alertsAt = [];
  for (let i = 1; i <= 16; i++) {
    fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
    const { out, sent } = await log(root, pick, sidecar(503, 'busy'));
    assert.equal(out.retryCount, i);
    if (sent.length) alertsAt.push(i);
  }
  assert.deepEqual(alertsAt, [3, 15]);
  fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
  await log(root, pick, sidecar(429, 'daily_cap'));
  fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
  const { out } = await log(root, pick, transport('ECONNREFUSED', 'connect ECONNREFUSED'));
  assert.equal(out.retryCount, 1, 'counter reset');
  assert.equal(h.readJson(path.join(root, '.state', 'retryable-failures.json')).count, 1);
});

s.check('auth_invalid: clip and slot released; alert on the 1st in a row, then every 12th; reset by any other outcome', async () => {
  const { root, pick } = await picked();
  const alertsAt = [];
  for (let i = 1; i <= 14; i++) {
    fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
    fs.writeFileSync(pick.slotMarker, JSON.stringify({ claimedAt: pick.claimedAt }));
    const { out, sent } = await log(root, pick, sidecar(401, 'auth_invalid'));
    assert.equal(out.authCount, i);
    assert.equal(h.exists(pick.claimPath), false, 'clip burned');
    assert.equal(h.exists(pick.slotMarker), false, 'slot burned');
    if (sent.length) {
      alertsAt.push(i);
      assert.match(sent[0].body.text, /^🔑 [\s\S]*make refresh-cookies/);
      assert.equal(/delete|claim/i.test(sent[0].body.text), false, 'asks for a manual claim deletion');
    }
  }
  assert.deepEqual(alertsAt, [1, 13]);
  fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
  await log(root, pick, sidecar(503, 'busy'));
  fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
  const again = await log(root, pick, sidecar(401, 'auth_invalid'));
  assert.equal(again.out.authCount, 1, 'authCount not reset');
  assert.equal(again.sent.length, 1);
  assert.equal(h.readJson(path.join(root, '.state', 'retryable-failures.json')).count, 0, 'retry count not reset by auth_invalid');
});

s.check('needs_you streak: slot freed for the first 2 in a row, kept from the 3rd (with a contract hint); reset by any other outcome', async () => {
  const { root, pick } = await picked();
  const HINT = '3+ clips refused in a row: check the sidecar contract.';
  const step = async (response) => {
    fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
    fs.writeFileSync(pick.slotMarker, JSON.stringify({ claimedAt: pick.claimedAt }));
    const r = await log(root, pick, response);
    return { needs: r.out.needsCount, slotFreed: !h.exists(pick.slotMarker), hint: r.sent.length > 0 && r.sent[0].body.text.includes(HINT), alerts: r.sent.length };
  };
  const got = [];
  for (const response of [sidecar(400, 'bad_input'), sidecar(413, 'too_large'), sidecar(409, 'ambiguous'), sidecar(400, 'bad_input')]) got.push(await step(response));
  assert.deepEqual(got, [
    { needs: 1, slotFreed: true, hint: false, alerts: 1 },
    { needs: 2, slotFreed: true, hint: false, alerts: 1 },
    { needs: 3, slotFreed: false, hint: true, alerts: 1 },
    { needs: 4, slotFreed: false, hint: true, alerts: 1 },
  ]);
  await step(sidecar(200, 'posted'));
  assert.deepEqual(await step(sidecar(400, 'bad_input')), { needs: 1, slotFreed: true, hint: false, alerts: 1 }, 'streak not reset');
  assert.equal(h.readJson(path.join(root, '.state', 'retryable-failures.json')).needsCount, 1);
});

s.check('publish_rejected: never frees the slot, leaves needsCount as it is, no contract hint; deferred resets it', async () => {
  const { root, pick } = await picked();
  const HINT = '3+ clips refused in a row: check the sidecar contract.';
  const step = async (response) => {
    fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
    fs.writeFileSync(pick.slotMarker, JSON.stringify({ claimedAt: pick.claimedAt }));
    const r = await log(root, pick, response);
    return { needs: r.out.needsCount, slotFreed: !h.exists(pick.slotMarker), hint: r.sent.length > 0 && r.sent[0].body.text.includes(HINT) };
  };
  const rejected = sidecar(502, 'publish_rejected');
  const got = [];
  for (const response of [rejected, sidecar(400, 'bad_input'), rejected, sidecar(400, 'bad_input'), rejected, sidecar(400, 'bad_input'), rejected]) {
    got.push(await step(response));
  }
  assert.deepEqual(got, [
    { needs: 0, slotFreed: false, hint: false },
    { needs: 1, slotFreed: true, hint: false },
    { needs: 1, slotFreed: false, hint: false },
    { needs: 2, slotFreed: true, hint: false },
    { needs: 2, slotFreed: false, hint: false },
    { needs: 3, slotFreed: false, hint: true },
    { needs: 3, slotFreed: false, hint: false },
  ]);
  assert.equal(h.readJson(path.join(root, '.state', 'retryable-failures.json')).needsCount, 3);
  for (const deferred of [sidecar(502, 'signature_failed'), sidecar(502, 'publish_rejected', { tiktok_status_msg: THROTTLE })]) {
    assert.deepEqual(await step(deferred), { needs: 0, slotFreed: false, hint: false });
    assert.equal(h.exists(pick.claimPath), false, 'deferred clip not released');
  }
});

s.check('deferred alerts are safety alerts: an unsent one fails the run, after the clip is released', async () => {
  const fail = async () => { const e = new Error('x'); e.code = 'ECONNRESET'; throw e; };
  for (const response of [sidecar(502, 'signature_failed'), sidecar(502, 'publish_rejected', { tiktok_status_msg: THROTTLE })]) {
    const { root, pick } = await picked();
    await assert.rejects(log(root, pick, response, { httpRequest: fail }), /Telegram alert failed/);
    assert.equal(h.exists(pick.claimPath), false, 'clip not released before the alert');
    assert.equal(h.exists(pick.slotMarker), true, 'slot freed');
  }
});

s.check('dry run: released claim (no slot), dry_run row, even for simulate=auth_invalid, 400 or 500', async () => {
  const { root, pick } = await picked({ live: false });
  assert.equal(pick.slotMarker, null);
  const ok = await log(root, pick, http(200, { status: 'dry_run', code: 'dry_run', caption: CAPTION, timeout_s: 250 }));
  assert.equal(ok.out.outcome, 'dry_run');
  assert.equal(h.exists(pick.claimPath), false);
  assert.equal(ok.sent.length, 0);

  fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
  const sim = await log(root, pick, sidecar(401, 'auth_invalid'));
  assert.equal(h.exists(pick.claimPath), false, 'dry-run 401 must not strand the clip');
  assert.match(sim.sent[0].body.text, /^\[dry run\] 🔑/);
  // a dry run never uploads, so "needs you" and "ambiguous" answers release the clip too
  for (const response of [sidecar(400, 'bad_input'), sidecar(500, 'internal')]) {
    fs.writeFileSync(pick.claimPath, JSON.stringify({ status: 'claimed' }));
    const r = await log(root, pick, response);
    assert.equal(h.exists(pick.claimPath), false, `dry-run ${response.statusCode} must not strand the clip`);
    assert.match(r.sent[0].body.text, /^\[dry run\] /);
    assert.equal(r.sent[0].body.text.includes('ssh homelab'), false, 'asks to release a claim a dry run already released');
  }
  const { rows } = resultRows(pick);
  assert.deepEqual(rows.map((r) => r[8]), ['dry_run', 'auth_invalid', 'needs_you', 'ambiguous']);
  assert.equal(h.listSlots(root).length, 0);
});

s.check('a real "posted" answer is kept even if the run was a dry run', async () => {
  const { root, pick } = await picked({ live: false });
  await log(root, pick, sidecar(200, 'posted'));
  assert.equal(h.readJson(pick.claimPath).status, 'posted');
});

s.check('an old 8-column results.log.csv keeps its header and gets 9-cell rows', async () => {
  const { root, pick } = await picked();
  const oldHeader = 'timestamp,filename,title,tiktok_post_id,tiktok_post_url,youtube_video_id,youtube_status,error\n';
  const oldRow = '2026-06-01T00:00:00Z,old.mp4,t,,,,unknown,\n';
  fs.writeFileSync(path.join(pick.jobDir, 'results.log.csv'), oldHeader + oldRow);
  await log(root, pick, sidecar(200, 'posted'));
  const text = fs.readFileSync(path.join(pick.jobDir, 'results.log.csv'), 'utf8');
  assert.ok(text.startsWith(oldHeader + oldRow), 'header or earlier rows rewritten');
  const added = text.slice((oldHeader + oldRow).length).trim().split(',');
  assert.equal(added.length, 9);
  assert.equal(added[8], 'posted');
});

s.check('results.log.csv keeps the live columns and escapes like the live node', async () => {
  const { root, pick } = await picked();
  const odd = { ...pick, title: 'Quote "this", ok' };
  await log(root, odd, sidecar(200, 'posted'));
  const text = fs.readFileSync(path.join(pick.jobDir, 'results.log.csv'), 'utf8');
  assert.ok(text.startsWith('timestamp,filename,title,tiktok_post_id,tiktok_post_url,youtube_video_id,youtube_status,error,'));
  assert.ok(text.includes(',"Quote ""this"", ok",'));
});

s.run();
