// Log Results: turns the sidecar's answer into ONE outcome for the picked clip.
// Order matters: the claim (and slot) are settled on disk BEFORE any alert, so
// a failed Telegram send can never leave a clip half-recorded; the send
// failure then fails the run so the watchdog sees it. Canonical source:
// scripts/log-results.jsCode.js.
const fs = require('fs');
const path = require('path');

const TZ = 'Africa/Johannesburg';
const DATA_ROOT = '/data/reelsmith-inbox';
const INBOX = path.join(DATA_ROOT, 'reelsmith-inbox');
const STATE_DIR = path.join(DATA_ROOT, '.state');
const RETRY_STATE = path.join(STATE_DIR, 'retryable-failures.json');
const RETRY_ALERT_AFTER = 3;    // consecutive retryable failures before the first alert
const AUTH_ALERT_AFTER = 1;     // consecutive auth_invalid answers before the first alert
const REALERT_EVERY = 12;       // then one more alert per 12 in a row (about 3h at */15)
const NEEDS_SLOT_RELEASES = 2;  // needs_you frees the slot only for the first 2 in a row
// TikTok refusals (502 publish_rejected) are often intermittent: the same clip and
// caption can post on a later try. A refused clip is released for a later slot and
// set aside at its 2nd refusal; 2 bounds the retries, and the sidecar pauses 12h
// after 2 failed attempts in a row anyway.
const REFUSAL_LIMIT = 2;
const REFUSALS_KEPT = 50;       // per-clip refusal counts kept in the state file (newest)
// Names are at most 200 UTF-8 bytes (Pick Due Clip), so even the longest alert,
// which repeats the name in two ledger commands and the claim-release command,
// stays under this cap (Telegram's own limit is 4096).
const ALERT_MAX_CHARS = 2000;
const HEADER = 'timestamp,filename,title,tiktok_post_id,tiktok_post_url,youtube_video_id,youtube_status,error,tiktok_status\n';
// Failures before the request left n8n: connect and DNS errors. Anything later
// (read ETIMEDOUT, read EHOSTUNREACH, ECONNRESET, EPIPE, the HTTP timeout) may
// have posted. These codes count on their own only when there is no message.
const RETRYABLE_CODES = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENOTFOUND', 'EAI_AGAIN'];
const JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE = /^(?!\.)[\p{L}\p{N}_. -]{1,251}\.mp4$/u; // as Pick Due Clip
const MAX_NAME_BYTES = 200;
// The sidecar passes TikTok's message through only for this throttling refusal.
const THROTTLE_MSG = 'You are posting too fast. Take a rest.';
const SSH_EXEC = "ssh homelab 'microk8s kubectl -n n8n-live exec deploy/n8n-application-worker --";

const pick = $('Pick Due Clip').first().json;
const res = $input.first().json || {};
const now = DateTime.now().setZone(TZ);
const today = now.toISODate();
const helpers = this.helpers;
const execId = (typeof $execution !== 'undefined' && $execution && $execution.id) ? String($execution.id) : 'manual';

const safeCode = (v) => (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : '');
const safeErrorId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : '');

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {
      // not JSON: classified by HTTP status alone
    }
  }
  return {};
}

// continueOnFail turns a transport failure into {error: <AxiosError JSON>}.
// Classified by PHASE: Node's connect/DNS errors read "connect <ERRNO> ..." or
// "getaddrinfo <ERRNO> ..." and never sent the request, so they are retried.
// Everything after that may have reached the sidecar: ambiguous. axios's own
// timeout is ECONNABORTED, "timeout of <n>ms exceeded" (n8n does not set
// clarifyTimeoutError).
function transportFailure(err) {
  const e = (err && typeof err === 'object') ? err : { message: String(err) };
  const code = String(e.code || (e.cause && e.cause.code) || '').toUpperCase();
  const message = String(e.message || e.description || '');
  if (/^(connect|getaddrinfo) /.test(message) || (!message && RETRYABLE_CODES.includes(code))) {
    return { kind: 'retryable', code: safeCode(code.toLowerCase()) || 'connect_error' };
  }
  if (code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(message)) {
    return { kind: 'ambiguous', code: 'timeout' };
  }
  return { kind: 'ambiguous', code: safeCode(code.toLowerCase()) || 'request_error' };
}

// -> {kind, status?, code, errorId, httpStatus}
//    kind: posted | posted_elsewhere | dry_run | daily_cap | retryable | auth_invalid
//          | needs_you (definitely not uploaded, this clip is set aside) | ambiguous (may have posted)
//          | deferred (definitely not published, not the clip's fault: retried at a later slot)
function classify(r) {
  if (r.statusCode === undefined && r.error !== undefined) {
    return { ...transportFailure(r.error), errorId: '', httpStatus: null };
  }
  const httpStatus = Number(r.statusCode);
  const body = parseBody(r.body);
  const code = safeCode(body.code);
  const errorId = safeErrorId(body.error_id);
  const out = (kind, fallback) => ({ kind, code: code || fallback, errorId, httpStatus });
  if (httpStatus === 200) {
    if (body.status === 'success' && body.code === 'posted') return out('posted', 'posted');
    if (body.status === 'dry_run') return out('dry_run', 'dry_run');
    return out('ambiguous', 'unexpected_200');
  }
  if (httpStatus === 409) return code === 'duplicate' ? out('posted_elsewhere', 'duplicate') : out('needs_you', 'ambiguous');
  if (httpStatus === 401) return out('auth_invalid', 'auth_invalid');
  if (httpStatus === 400) return out('needs_you', 'bad_input');
  if (httpStatus === 413) return out('needs_you', 'too_large');
  if (httpStatus === 429) return out('daily_cap', 'daily_cap');
  if (httpStatus === 503) return out('retryable', 'unavailable');
  // 502 with these codes: the sidecar recorded the upload as failed and freed its
  // ledger key, so nothing was published. TikTok refusing the post is about this
  // clip, unless it says we post too fast; a signing failure is the sidecar's.
  if (httpStatus === 502 && code === 'publish_rejected') {
    return body.tiktok_status_msg === THROTTLE_MSG ? out('deferred', 'publish_rejected') : out('needs_you', 'publish_rejected');
  }
  if (httpStatus === 502 && code === 'signature_failed') return out('deferred', 'signature_failed');
  // 500 internal, any other 502, 504 timeout, anything unexpected
  return out('ambiguous', 'http_' + (Number.isFinite(httpStatus) ? httpStatus : 'unknown'));
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function assertRealDir(dir) {
  const st = lstatOrNull(dir);
  if (!st || !st.isDirectory()) throw new Error('Log Results: not a real directory: ' + dir);
}

// lstat the directory, write a fresh tmp (O_EXCL, so a planted symlink is
// never followed), then rename over the target: readers see old or new, never half.
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  assertRealDir(dir);
  // Short on purpose: a name derived from the clip's would exceed NAME_MAX.
  const tmp = path.join(dir, `.tmp-${execId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)}-${now.toMillis()}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function appendResultRow(jobDir, cells) {
  assertRealDir(jobDir);
  const logPath = path.join(jobDir, 'results.log.csv');
  try {
    fs.writeFileSync(logPath, HEADER, { flag: 'wx' });
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
  }
  const st = fs.lstatSync(logPath);
  if (!st.isFile()) throw new Error('Log Results: results.log.csv is not a regular file');
  fs.appendFileSync(logPath, cells.map(csvEscape).join(',') + '\n');
}

async function sendAlert(text) {
  const token = $env.TELEGRAM_BOT_TOKEN;
  const chatId = $env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Log Results: alert not sent, TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset');
  try {
    await helpers.httpRequest({
      method: 'POST',
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      json: true,
      timeout: 10000,
      body: { chat_id: chatId, text: text.slice(0, ALERT_MAX_CHARS), disable_web_page_preview: true },
    });
  } catch (e) {
    // Never echo e.message: it can carry the request URL, and with it the bot token.
    const why = safeCode(String((e && (e.code || e.httpCode)) || '').toLowerCase()) || 'send_failed';
    throw new Error('Log Results: Telegram alert failed (' + why + '); the outcome is already recorded');
  }
}

const outcome = classify(res);

// Consecutive-outcome counters: sidecar unavailable (count), TikTok session
// invalid (authCount), clip refused as needs_you (needsCount, today only, so
// an old streak never blocks a later day). Any other outcome resets each to 0,
// except a TikTok refusal (publish_rejected): it is needs_you but neither counts
// toward the needs_you streak nor ends it (it says nothing about the sidecar
// contract, and never frees a slot). Refusals are counted per clip instead
// (state.refusals, {clip_key: n}, oldest first); a dry run never reads or changes them.
fs.mkdirSync(STATE_DIR, { recursive: true });
let state = {};
try {
  state = JSON.parse(fs.readFileSync(RETRY_STATE, 'utf8')) || {};
} catch (e) {
  state = {};
}
const retryCount = outcome.kind === 'retryable' ? (Number(state.count) || 0) + 1 : 0;
const authCount = outcome.kind === 'auth_invalid' ? (Number(state.authCount) || 0) + 1 : 0;
const tiktokRefused = outcome.kind === 'needs_you' && outcome.code === 'publish_rejected';
const needsCount = outcome.kind === 'needs_you'
  ? (state.needsDay === today ? Number(state.needsCount) || 0 : 0) + (tiktokRefused ? 0 : 1) : 0;
const tracksRefusals = pick.dryRun !== true;
const isClipKey = (k) => typeof k === 'string' && k.includes('/'); // <job>/<file>
const refusals = new Map(); // a Map: no key (not even __proto__) touches a prototype
if (tracksRefusals && state.refusals && typeof state.refusals === 'object' && !Array.isArray(state.refusals)) {
  for (const [k, v] of Object.entries(state.refusals)) {
    // a key is <job>/<file> and a stored count is 1..REFUSAL_LIMIT-1; anything else is junk, read as 0
    if (isClipKey(k) && Number.isInteger(v) && v >= 1 && v < REFUSAL_LIMIT) refusals.set(k, v);
  }
}
const clipKey = String(pick.clip_key || '');
const refusalCount = tiktokRefused && tracksRefusals ? (refusals.get(clipKey) || 0) + 1 : 0;
// The first refusal(s): retried after another clip, at a later slot, instead of being
// set aside. A clip without a proper key is never retried (no count could stop it).
const retryRefused = refusalCount > 0 && refusalCount < REFUSAL_LIMIT && isClipKey(clipKey);

// Released clips are retried by a later run: nothing reached TikTok (retryable,
// auth_invalid, dry run), today's cap was hit, TikTok did not publish for a
// reason that is not the clip's (deferred), or TikTok refused it fewer than
// REFUSAL_LIMIT times. The clip goes back to the pool and is retried after another
// clip, at a later slot (retryAfter below); rotation does not count a released claim.
// A dry run never uploads, so even a "needs you" answer (e.g. simulate=auth_invalid)
// releases the clip there. A real "posted" is always kept, whatever the mode.
const releaseClip = ['retryable', 'auth_invalid', 'dry_run', 'daily_cap', 'deferred'].includes(outcome.kind)
  || retryRefused
  || (pick.dryRun === true && ['needs_you', 'ambiguous'].includes(outcome.kind));
// The slot stays used when an upload may have reached TikTok (posted, ambiguous),
// TikTok refused it, it was deferred, or the daily cap is hit; any other definite
// "not uploaded" frees it for the next 15-minute run. needs_you frees it only for
// the first 2 of a streak (needsCount; any other outcome, a 503 included, ends the
// streak, while a TikTok refusal neither counts toward it nor ends it), so a
// systematic refusal costs at most 2 extra clips per streak beyond the slots.
const releaseSlot = ['retryable', 'auth_invalid', 'dry_run', 'posted_elsewhere'].includes(outcome.kind)
  || (outcome.kind === 'needs_you' && !tiktokRefused && needsCount <= NEEDS_SLOT_RELEASES)
  || (pick.dryRun === true && outcome.kind !== 'posted');
const claimStatus = {
  posted: 'posted', posted_elsewhere: 'posted_elsewhere', needs_you: 'needs_you', ambiguous: 'failed',
}[outcome.kind];
const rowStatus = retryRefused ? 'refused_retry' : releaseClip ? outcome.kind : claimStatus;
// A clip's refusal count lives until its outcome is final: set on a retried refusal,
// dropped once the claim is kept (posted, posted_elsewhere, needs_you, ambiguous),
// untouched while the clip is only released (retryable, auth, daily cap, deferred).
if (tracksRefusals) {
  if (retryRefused) {
    refusals.delete(clipKey); // re-insert: newest last
    refusals.set(clipKey, refusalCount);
  } else if (!releaseClip) {
    refusals.delete(clipKey);
  }
  for (const k of refusals.keys()) {
    if (refusals.size <= REFUSALS_KEPT) break;
    refusals.delete(k); // oldest first
  }
}

// 1. Settle the claim and the slot on disk.
if (releaseClip) {
  assertRealDir(path.dirname(pick.claimPath));
  fs.rmSync(pick.claimPath, { force: true });
} else {
  writeJsonAtomic(pick.claimPath, {
    status: claimStatus,
    claimedAt: pick.claimedAt,
    decidedAt: now.toISO(),
    execId,
    clip_key: pick.clip_key,
    code: outcome.code,
    error_id: outcome.errorId,
    http_status: outcome.httpStatus,
    dryRun: pick.dryRun === true,
  });
}
if (releaseSlot && pick.slotMarker) {
  assertRealDir(path.dirname(pick.slotMarker));
  fs.rmSync(pick.slotMarker, { force: true });
}

// 2. Persist the consecutive-outcome counters computed above.
const counters = {
  ...state, // keeps the once-a-day markers (Pick Due Clip writes idleNoticeDay here)
  count: retryCount,
  authCount,
  needsCount,
  needsDay: today,
  lastCode: outcome.code,
  updatedAt: now.toISO(),
  ...(tracksRefusals ? { refusals: Object.fromEntries(refusals) } : {}),
};
// retryAfter: the clip just released after a refusal; Pick Due Clip puts another
// clip of its video first. Kept while attempts are only released, dropped once a
// claim is kept (the next attempt settled). Dry runs never touch it.
if (tracksRefusals) {
  if (retryRefused) counters.retryAfter = clipKey;
  else if (!releaseClip || !isClipKey(state.retryAfter)) delete counters.retryAfter;
}
// Accepted window: a crash after step 1 and before this write loses the refusal
// count, so that clip gets one extra retry. Never a lost or doubled post.
writeJsonAtomic(RETRY_STATE, counters);

// 3. One row per outcome in the job's results.log.csv (live column order; the
// TikTok outcome goes in the trailing tiktok_status column). A file that still
// has the old 8-column header keeps it; unpublished-inventory.js reads the 9th cell.
appendResultRow(pick.jobDir, [
  now.toISO(),
  pick.filename,
  pick.title,
  '',
  '',
  '',
  '',
  [outcome.code, outcome.errorId].filter(Boolean).join(' '),
  rowStatus,
]);

// 4. Alert last. Fixed strings + code + error_id + filename (and the claim
// path built from the validated job id and filename) only: never the caption
// or any other sidecar output.
const line = (label, v) => (v ? `\n${label}: ${v}` : '');
const detail = `${line('code', outcome.code)}${line('error_id', outcome.errorId)}${line('file', pick.filename)}`;
const due = (n, first) => n >= first && (n - first) % REALERT_EVERY === 0;

function releaseSteps(withLedger, fixLine) {
  if (pick.dryRun === true) return ''; // a dry run already released its claim
  const job = path.basename(String(pick.jobDir || ''));
  const file = String(pick.filename || '');
  if (!JOB_RE.test(job) || !NAME_RE.test(file) || Buffer.byteLength(file, 'utf8') > MAX_NAME_BYTES) {
    return '\nThen delete the clip\'s claim file under .claims/ in its job folder to let n8n retry it.';
  }
  // NAME_RE allows no quote, so single quotes keep a name with spaces one KEY.
  const key = `'${job}/${file}'`;
  const release = `${SSH_EXEC} rm "${INBOX}/${job}/.claims/${file}.json"'`;
  if (fixLine) return `\n${fixLine}\n${release}`;
  if (!withLedger) {
    return `\n1. Fix the clip (re-export it), or leave it set aside.\n2. To let n8n retry it, release the n8n claim:\n${release}`;
  }
  return '\n1. Check TikTok, then in tiktok-sidecar run the line that matches:'
    + `\nmake ledger-resolve KEY=${key} OUTCOME=posted`
    + `\nmake ledger-resolve KEY=${key} OUTCOME=not_posted`
    + '\nIf it is refused with "no ledger rows" or "it is free", the upload never reached TikTok: go to 2.'
    + '\n2. Release the n8n claim (the clip is retried; one resolved as posted comes back as a 409 duplicate and its manifest archives):'
    + `\n${release}`;
}

// safety: the run fails if these cannot be sent. info: once-a-day notices; a
// failed send is logged and retried by the next run (its day stays unmarked).
const safety = [];
const info = [];
const infoDays = {};
if (outcome.kind === 'auth_invalid' && due(authCount, AUTH_ALERT_AFTER)) {
  safety.push(`🔑 Reelsmith: TikTok session invalid (${authCount} in a row). Run \`make refresh-cookies\` in tiktok-sidecar; clips wait and retry every 15 min.` + detail);
} else if (retryRefused) {
  // Routine (about 2 a day): informational, a failed send is only logged.
  info.push(`Reelsmith: TikTok refused it (not posted); it will be retried at a later slot (refusal ${refusalCount} of ${REFUSAL_LIMIT}).` + detail);
} else if (tiktokRefused) {
  safety.push(`Reelsmith: TikTok refused to publish it${refusalCount >= REFUSAL_LIMIT ? ' twice' : ''} (not posted)`
    + (pick.dryRun === true ? ' (dry run: the clip is released).' : '; it is set aside.') + detail
    + releaseSteps(false, 'Probably this clip: re-export it, or leave it set aside; to retry, release the claim:'));
} else if (outcome.kind === 'deferred') {
  safety.push((outcome.code === 'signature_failed'
    ? 'Reelsmith: the sidecar\'s signing helper failed (not posted). Check the signing helper in tiktok-sidecar.'
    : 'Reelsmith: TikTok says "posting too fast" (not posted). Possible throttling: if it repeats, lower DAILY_CAP.')
    + ' The clip is released for a later slot; this slot stays used.' + detail);
} else if (outcome.kind === 'needs_you') {
  safety.push((outcome.code === 'ambiguous'
    ? 'Reelsmith: a clip is blocked by an earlier upload that may have posted (it will not be retried).'
    : 'Reelsmith: a clip was refused (not posted, will not be retried).')
    + (needsCount > NEEDS_SLOT_RELEASES ? '\n3+ clips refused in a row: check the sidecar contract.' : '')
    + detail + releaseSteps(outcome.code === 'ambiguous'));
} else if (outcome.kind === 'ambiguous') {
  safety.push('Reelsmith: upload outcome unknown (it may have posted).' + detail + releaseSteps(true));
} else if (outcome.kind === 'retryable' && due(retryCount, RETRY_ALERT_AFTER)) {
  safety.push(`Reelsmith: sidecar unavailable ${retryCount} times in a row; clips are waiting.` + detail);
}
// Every upload is Only me (the sidecar passes --visibility=1): tell the owner so they can publish it.
// Informational: the claim is already settled, so a failed send is only logged.
if (outcome.kind === 'posted') {
  info.push(`Reelsmith: uploaded as Only me. Set it to Everyone in TikTok Studio when you are ready.${line('file', pick.filename)}`);
}
// Unusable manifests or clips Pick Due Clip reported: once per SAST day, a count only.
const manifestIssues = Array.isArray(pick.manifestErrors) ? pick.manifestErrors.length : 0;
if (manifestIssues > 0 && counters.manifestAlertDay !== today) {
  info.push(`Reelsmith: ${manifestIssues} manifest problem(s) (an unreadable manifest, or clips that can never be posted as they are); see .state/notices.json or the Pick Due Clip output in today's n8n executions.`);
  infoDays.manifestAlertDay = today;
}
// The kill switch is off while the workflow runs live: every clip is released
// and retried every 15 min, so say so once a day.
if (outcome.kind === 'dry_run' && outcome.code === 'posting_disabled' && pick.dryRun !== true
  && counters.postingDisabledAlertDay !== today) {
  info.push('Reelsmith: the sidecar has POSTING_ENABLED=false while the workflow is live; clips are released and retried every 15 min.');
  infoDays.postingDisabledAlertDay = today;
}
// The sidecar's daily cap is reached (a manual upload the same day, or the caps
// not yet synced): the clip is released and the slot stays used, so say so once a day.
if (outcome.kind === 'daily_cap' && counters.dailyCapAlertDay !== today) {
  info.push('Reelsmith: today\'s upload cap is reached; clips wait for tomorrow (this slot is used).' + detail);
  infoDays.dailyCapAlertDay = today;
}
const parts = [...safety, ...info];
const alertText = parts.length ? (pick.dryRun === true ? '[dry run] ' : '') + parts.join('\n\n') : null;
if (alertText) {
  let sent = false;
  try {
    await sendAlert(alertText);
    sent = true;
  } catch (e) {
    if (safety.length) throw e;
    console.log('Log Results: informational alert not sent; the next run retries it. ' + e.message);
  }
  if (sent && info.length) writeJsonAtomic(RETRY_STATE, { ...counters, ...infoDays });
}

return [{
  json: {
    clip_key: pick.clip_key,
    filename: pick.filename,
    manifestPath: pick.manifestPath,
    jobDir: pick.jobDir,
    dryRun: pick.dryRun === true,
    outcome: retryRefused ? 'refused_retry' : outcome.kind,
    status: rowStatus,
    code: outcome.code,
    error_id: outcome.errorId,
    httpStatus: outcome.httpStatus,
    clipReleased: releaseClip,
    slotReleased: Boolean(releaseSlot && pick.slotMarker),
    retryCount,
    authCount,
    needsCount,
    alerted: Boolean(alertText),
  },
}];
