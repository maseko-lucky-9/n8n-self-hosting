// Pick Due Clip: chooses and claims AT MOST ONE clip per execution.
// Schedule: every 15 min, 12:00-20:45 SAST. One clip per slot (12:00, 15:00,
// 18:00), YouTube-sourced jobs only, rotating across source videos (jobs): never
// the same video twice in a row, a video holding most of the backlog every other
// post, otherwise the video used least recently; each video's intro (00_*) is never
// posted. Returning [] stops the run. Canonical source: scripts/pick-due-clip.jsCode.js; the
// workflow JSON is generated from it (scripts/build-workflow.js).
//
// n8n 2.x Code-node sandbox: luxon is the global `DateTime` (requiring the
// luxon package aborts the runner) and only fs/path/crypto may be required.
const fs = require('fs');
const path = require('path');

const DRY_RUN = true; // deploy-workflow.sh --live flips this in memory, never in git

const TZ = 'Africa/Johannesburg';
const DATA_ROOT = '/data/reelsmith-inbox';             // PVC root, outside the Syncthing folder
const INBOX = path.join(DATA_ROOT, 'reelsmith-inbox'); // Syncthing folder; the sidecar's /inbox
const SLOT_DIR = path.join(DATA_ROOT, '.slots');
const STATE_DIR = path.join(DATA_ROOT, '.state');
const STATE_FILE = path.join(STATE_DIR, 'retryable-failures.json'); // shared with Log Results
const NOTICES_FILE = path.join(STATE_DIR, 'notices.json');           // details for a human
// At most 3 uploads a day (owner policy). Slot markers are named by position
// (.slots/<day>-<i>.json), so keep 0/1/2 = 12:00/15:00/18:00, the order the deployed
// workflow writes: reordering would make a deploy read today's markers as other slots.
const SLOTS = ['12:00', '15:00', '18:00'];
// Since the newest slot marker's claimedAt. Runs fall on the quarter hour, so 160
// lets a late slot catch up by 15 min per slot (170 acted as 180 and never did).
const MIN_GAP_MIN = 160;
const LAST_CALL = '21:00';  // no catch-up at or after this time
const STALE_CLAIM_MIN = 30; // a claim with no outcome after this is released
const CUTOFF = '2026-10-11';  // manifests modified before this day (SAST) are ignored
const MIN_BYTES = 1024;       // a clip of 1 KB or less is junk
const MAX_CLIP_MB = 300;      // the sidecar's MAX_CLIP_MB: anything larger gets a 413
const TIMEOUT_BASE_S = 240;   // sidecar: timeout_s = 240 + ceil(1.5 * size_MiB)
const TIMEOUT_PER_MIB_S = 1.5;
const HTTP_MARGIN_S = 60;
const MAX_TIMEOUT_MS = 780000; // must stay under the workflow's executionTimeout (900 s)
// A subset of the sidecar's rule (tiktok-sidecar/sidecar/clip.py FILENAME_RE
// `[\w. -]{1,251}\.mp4`, Python \w = letters, digits, underscore; no leading
// dot; at most 255 bytes), capped at 200 bytes so `<name>.json` and every
// derived path stay far below NAME_MAX.
const NAME_RE = /^(?!\.)[\p{L}\p{N}_. -]{1,251}\.mp4$/u;
const MAX_NAME_BYTES = 200;
const NAME_MAX = 255; // a longer spelling (an NFD name grows) cannot exist on disk: never lstat it
// Jobs exported before manifest.csv had a `source` column, confirmed YouTube-sourced.
const YOUTUBE_LEGACY_JOBS = [
  '1979f8a4a33643b5a43d8f0fb4337d3e',
  '851cbce7386b47959c6136cc3fa9758e',
  'd7a54c8aa4454fc38949927c0e5c9505',
  '32508a2a96a14ce38cd087bfb1fdeb22',
  '48ac096bd9db4976a06f63be654a2900',
];
const JOB_RE = /^[A-Za-z0-9_-]+$/;
// Rotation: a claim counts as "this video was used" when the upload may have reached
// TikTok (posted, failed = ambiguous, claimed = in flight) or it predates the status
// field. needs_you and posted_elsewhere keep their claim but did not post here (most
// free the slot), so they do not count: the next run must not repeat the video that
// just posted.
const COUNTED_STATUSES = ['posted', 'failed', 'claimed'];
const FUTURE_SKEW_MIN = 5; // a claim dated further ahead is ignored (wrong boot clock)

const now = DateTime.now().setZone(TZ);
const today = now.toISODate();
const execId = (typeof $execution !== 'undefined' && $execution && $execution.id) ? String($execution.id) : 'manual';

// A video's intro needs extra editing and is never posted: a clip named 00_* (every
// export's first clip) or titled "Intro". Archive Manifest has the same rule and counts
// such a row as done; workflow-contract.selfcheck.js keeps the two copies identical.
function isIntro(row) {
  const name = String(row.filename == null ? '' : row.filename).normalize('NFC');
  return name.startsWith('00_') || String(row.title == null ? '' : row.title).trim().toLowerCase() === 'intro';
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

// lstat, never stat: a symlinked .claims/.slots would redirect writes elsewhere.
function ensureRealDir(p) {
  try {
    fs.mkdirSync(p);
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
  }
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) throw new Error('Pick Due Clip: not a real directory: ' + p);
}

function at(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return now.startOf('day').set({ hour, minute });
}

function readClaimedAt(file, claim) { // claim: the already-parsed file, to save a second read
  try {
    const parsed = DateTime.fromISO(String((claim || JSON.parse(fs.readFileSync(file, 'utf8'))).claimedAt || ''));
    if (parsed.isValid) return parsed;
  } catch (e) {
    // unreadable or half-written: fall back to the file's mtime below
  }
  const st = lstatOrNull(file);
  return st ? DateTime.fromMillis(st.mtimeMs) : null;
}

// A missing inbox means Syncthing's folder was renamed or unmounted: fail the
// run (the watchdog sees errors) instead of reporting "nothing to post".
function listJobs() {
  const st = lstatOrNull(INBOX);
  if (!st || !st.isDirectory()) throw new Error('Pick Due Clip: inbox missing or not a directory: ' + INBOX);
  return fs.readdirSync(INBOX).filter((n) => {
    if (!JOB_RE.test(n)) return false;
    const st = lstatOrNull(path.join(INBOX, n));
    return Boolean(st && st.isDirectory());
  });
}

// RFC 4180: quoted fields may hold commas, doubled quotes and newlines.
function parseCsv(text) {
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); records.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (cell !== '' || row.length) { row.push(cell); records.push(row); }
  const nonBlank = records.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (!nonBlank.length) throw new Error('empty manifest');
  const header = nonBlank[0].map((h) => h.trim());
  if (!header.includes('filename')) throw new Error('manifest has no filename column');
  const rows = nonBlank.slice(1).map((cells) => {
    const o = {};
    header.forEach((h, idx) => { o[h] = cells[idx] === undefined ? '' : cells[idx]; });
    return o;
  });
  return { header, rows };
}

// The sidecar's caption cleaning (tiktok-sidecar/sidecar/caption.py clean_body):
// drop URLs, non-BMP characters, invisibles, @ and #. Conservative: "empty" only
// when what is left is whitespace to both Python and JS, and the URL match stops
// at any character either side calls whitespace, so n8n never junks a caption
// the sidecar would accept (a wrong "usable" only costs a 400).
const BLANK_RE = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const BLANK_EDGES_RE = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
// String.prototype.trim also eats U+FEFF, which the sidecar keeps.
const trimBlank = (text) => String(text == null ? '' : text).replace(BLANK_EDGES_RE, '');
const URL_RE = /(?:https?:\/\/|www\.)[^\s\x1c-\x1f\x85]*/giu;
function captionUsable(text) {
  const body = String(text == null ? '' : text)
    .replace(URL_RE, ' ')
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u200d\ufe0e\ufe0f]/g, '')
    .replace(/[@#]/g, '');
  return !BLANK_RE.test(body);
}

// -> {kind: 'junk'|'missing'|'claimed'|'ready', ...}. Names are NFC; the on-disk
// name may be NFD (copied from macOS), so NFC is tried first, then NFD.
// junk.notice: a real clip that can never be posted as it is. It is reported
// (manifestErrors, a daily alert) and pins its manifest until a human acts.
function inspectClip(jobDir, rawName) {
  const name = String(rawName == null ? '' : rawName);
  if (!name.trim()) return { kind: 'junk', reason: 'empty filename' };
  const nfc = name.normalize('NFC');
  if (!nfc.endsWith('.mp4')) return { kind: 'junk', reason: 'not .mp4' };
  // Path safety first: nothing below may touch a path outside this job folder.
  if (nfc !== path.basename(nfc) || nfc.startsWith('.') || /[\\/\0]/.test(nfc)) {
    return { kind: 'junk', reason: 'unsafe filename', notice: true };
  }
  if (Buffer.byteLength(nfc, 'utf8') > MAX_NAME_BYTES) return { kind: 'junk', reason: 'name over 200 bytes', notice: true };
  if (!NAME_RE.test(nfc)) return { kind: 'junk', reason: 'name the sidecar refuses', notice: true };
  let diskName = null;
  let st = null;
  for (const candidate of [...new Set([nfc, name.normalize('NFD'), name])]) {
    if (Buffer.byteLength(candidate, 'utf8') > NAME_MAX) continue;
    st = lstatOrNull(path.join(jobDir, candidate));
    if (st) { diskName = candidate; break; }
  }
  if (!st) return { kind: 'missing', nfc };
  if (!st.isFile()) return { kind: 'junk', reason: 'not a regular file', notice: true };
  if (st.size <= MIN_BYTES) return { kind: 'junk', reason: '1 KB or less' };
  if (st.size > MAX_CLIP_MB * 1048576) return { kind: 'junk', reason: `over ${MAX_CLIP_MB} MiB`, notice: true };
  const claimPath = path.join(jobDir, '.claims', nfc + '.json');
  if (lstatOrNull(claimPath)) return { kind: 'claimed', nfc };
  return { kind: 'ready', nfc, diskName, size: st.size, claimPath };
}

function hashtagsField(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '[]';
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return JSON.stringify(parsed.map(String));
  } catch (e) {
    // not JSON: Contract v1 also accepts whitespace/comma separated tags
  }
  // The sidecar 400s anything that starts like a JSON array but is not one:
  // post without tags rather than set the clip aside.
  return s.startsWith('[') ? '[]' : s;
}

// 1. Stale-claim sweep. Only our own unresolved claims (status 'claimed') are
// released; outcomes and the pre-2026-10 workflow's markers (no status) stay.
// A released clip that did reach TikTok gets a 409 from the sidecar ledger.
// ponytail: the crashed run's slot marker is NOT released, so a crash costs
//   that slot (at most 3 a day); the safe direction for an upload that may
//   have posted.
const lastUsedMs = {}; // job -> newest counted claim, in ms
for (const job of listJobs()) {
  const claimDir = path.join(INBOX, job, '.claims');
  const dirSt = lstatOrNull(claimDir);
  if (!dirSt || !dirSt.isDirectory()) continue;
  for (const name of fs.readdirSync(claimDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(claimDir, name);
    let claim;
    try {
      claim = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      continue; // being written right now, or not ours
    }
    if (!claim || typeof claim !== 'object') continue;
    const claimedAt = readClaimedAt(file, claim);
    if (claim.status === 'claimed' && claimedAt && now.diff(claimedAt, 'minutes').minutes > STALE_CLAIM_MIN) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!claimedAt || (claim.status !== undefined && !COUNTED_STATUSES.includes(claim.status))) continue;
    if (claimedAt.diff(now, 'minutes').minutes > FUTURE_SKEW_MIN) continue;
    if (claimedAt.toMillis() > (lastUsedMs[job] || 0)) lastUsedMs[job] = claimedAt.toMillis();
  }
}

// 2. Slot gate (real runs only). A dry run may run at any time and takes no slot.
let slot = null;
if (!DRY_RUN) {
  if (now >= at(LAST_CALL)) return [];
  ensureRealDir(SLOT_DIR);
  const markerPath = (day, i) => path.join(SLOT_DIR, `${day}-${i}.json`);
  const due = SLOTS.findIndex((s, i) => at(s) <= now && !lstatOrNull(markerPath(today, i)));
  if (due < 0) return [];
  // ponytail: markers are never pruned (3 small files a day); only today's and
  // yesterday's are read, since the gap is far shorter than a day.
  const recentDays = [today, now.minus({ days: 1 }).toISODate()];
  let newest = null;
  for (const name of fs.readdirSync(SLOT_DIR)) {
    if (!name.endsWith('.json') || !recentDays.some((d) => name.startsWith(d + '-'))) continue;
    const claimedAt = readClaimedAt(path.join(SLOT_DIR, name));
    if (claimedAt && (!newest || claimedAt > newest)) newest = claimedAt;
  }
  if (newest && now.diff(newest, 'minutes').minutes < MIN_GAP_MIN) return [];
  slot = { index: due, date: today, marker: markerPath(today, due) };
}

// 3. Candidates: every non-archived manifest.csv modified on/after CUTOFF,
// newest first, rows in file order. (Step 4b rotates across videos.)
const cutoffMs = DateTime.fromISO(CUTOFF, { zone: TZ }).toMillis();
const manifests = [];
for (const job of listJobs()) {
  const manifestPath = path.join(INBOX, job, 'manifest.csv');
  const st = lstatOrNull(manifestPath);
  if (!st || !st.isFile() || st.mtimeMs < cutoffMs) continue;
  manifests.push({ job, jobDir: path.join(INBOX, job), manifestPath, mtimeMs: st.mtimeMs });
}
manifests.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.job < b.job ? -1 : a.job > b.job ? 1 : 0));

function writeStateAtomic(file, obj) {
  ensureRealDir(STATE_DIR);
  const tmp = path.join(STATE_DIR, `.tmp-pick-${execId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)}-${now.toMillis()}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

// 4. Scan EVERY row of every candidate manifest first, so problems anywhere are
// reported even when an earlier row gets posted. errors: the unexpected ones
// (unreadable manifest, a row that threw). notices: clips that can never be
// posted as they are. manifestErrors (both) goes to Log Results' daily alert.
const errors = [];
const notices = [];
const candidates = [];
for (const m of manifests) {
  let parsed;
  try {
    parsed = parseCsv(fs.readFileSync(m.manifestPath, 'utf8'));
  } catch (e) {
    errors.push(m.job + ': ' + String((e && e.message) || e).slice(0, 120));
    continue;
  }
  // YouTube only: with a `source` column every row must say youtube (an empty
  // cell counts only for a confirmed legacy job: its DB source is NULL); without
  // the column, the job must be on the confirmed legacy list. Everything else
  // is skipped and therefore never archived.
  const hasSource = parsed.header.includes('source');
  const legacyJob = YOUTUBE_LEGACY_JOBS.includes(m.job);
  if (!hasSource && !legacyJob) continue;

  for (let rowIndex = 0; rowIndex < parsed.rows.length; rowIndex++) {
    const row = parsed.rows[rowIndex];
    const source = String(row.source).trim();
    if (hasSource && source !== 'youtube' && !(source === '' && legacyJob)) continue;
    if (isIntro(row)) continue; // never posted, never reported, never pins the manifest
    const where = `${m.job} row ${rowIndex + 1}`;
    // One bad row never stops the others: an unexpected error (EACCES, EIO, ...)
    // skips that row for this run.
    let clip;
    try {
      clip = inspectClip(m.jobDir, row.filename);
    } catch (e) {
      errors.push(`${where}: ${(e && e.code) || 'error'}`);
      continue;
    }
    if (clip.kind === 'junk' && clip.notice) notices.push(`${where}: ${clip.reason}`);
    if (clip.kind !== 'ready') continue; // junk: skip; missing: wait for Syncthing; claimed: skip
    const title = trimBlank(row.title);
    const caption = captionUsable(row.description) ? trimBlank(row.description) : title;
    if (!captionUsable(caption)) {
      notices.push(`${where}: no usable caption`);
      continue;
    }
    candidates.push({ m, rowIndex, row, clip, title, caption });
  }
}

// 4b. Rotate across videos (jobs). Within a video, clips keep row order. Order of
// videos: (1) never the one used last while another has a ready clip; (2) a video
// holding more than half of all ready clips first, so it cannot pile up at the end;
// (3) the least recently used; ties keep the manifest order above (newest first).
// A clip that cannot be claimed (EEXIST) falls through to the next one in this order.
{
  const groups = new Map();
  for (const c of candidates) {
    if (!groups.has(c.m.job)) groups.set(c.m.job, []);
    groups.get(c.m.job).push(c);
  }
  const jobs = [...groups.keys()];
  let lastJob = null;
  let lastMs = 0;
  for (const j of Object.keys(lastUsedMs)) {
    if (lastUsedMs[j] > lastMs) { lastMs = lastUsedMs[j]; lastJob = j; }
  }
  const others = jobs.filter((j) => j !== lastJob);
  const total = candidates.length;
  const rank = (j) => jobs.indexOf(j);
  const lru = (a, b) => ((lastUsedMs[a] || 0) - (lastUsedMs[b] || 0)) || (rank(a) - rank(b));
  const big = others.filter((j) => groups.get(j).length * 2 > total)
    .sort((a, b) => (groups.get(b).length - groups.get(a).length) || (rank(a) - rank(b)))[0];
  const ordered = [];
  if (big !== undefined) ordered.push(big);
  ordered.push(...others.filter((j) => j !== big).sort(lru));
  if (groups.has(lastJob)) ordered.push(lastJob);
  candidates.length = 0;
  for (const j of ordered) candidates.push(...groups.get(j));
}
// 4c. A clip TikTok refused once (Log Results' retryAfter) is retried after another
// clip: it moves one place back within its video, for this pick only, unless it is
// that video's only ready clip. Log Results drops the flag once an attempt posts or
// the flagged clip reaches a final outcome; this node never writes it.
// A junk flag (not a string, or no such ready clip) matches nothing: a no-op.
const state = readState();
{
  const i = candidates.findIndex((c) => `${c.m.job}/${c.clip.nfc}` === state.retryAfter);
  const next = i < 0 ? -1 : candidates.findIndex((c, k) => k > i && c.m.job === candidates[i].m.job);
  if (next >= 0) [candidates[i], candidates[next]] = [candidates[next], candidates[i]];
}
const manifestErrors = [...errors, ...notices];
if (notices.length || lstatOrNull(NOTICES_FILE)) {
  writeStateAtomic(NOTICES_FILE, { updatedAt: now.toISO(), notices });
}

// 5. Claim the first candidate nobody else holds.
for (const { m, rowIndex, row, clip, title, caption } of candidates) {
  const timeoutMs = (TIMEOUT_BASE_S + Math.ceil(TIMEOUT_PER_MIB_S * clip.size / 1048576) + HTTP_MARGIN_S) * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Pick Due Clip: timeout ${timeoutMs} ms exceeds ${MAX_TIMEOUT_MS} ms; lower MAX_CLIP_MB or raise executionTimeout`);
  }

  // Claim = <jobDir>/.claims/<NFC filename>.json; it is never removed for a
  // posted, needs_you or failed clip. Recover a stuck clip by deleting its
  // claim (unpublished-inventory.js lists them).
  // ponytail: O_EXCL is atomic on this single-node local PVC; on NFS or a
  //   multi-node volume, move claims to a Postgres UNIQUE row.
  ensureRealDir(path.join(m.jobDir, '.claims'));
  const clipKey = `${m.job}/${clip.nfc}`;
  try {
    fs.writeFileSync(clip.claimPath, JSON.stringify({
      status: 'claimed',
      claimedAt: now.toISO(),
      execId,
      clip_key: clipKey,
      dryRun: DRY_RUN,
      slot: slot ? { date: slot.date, index: slot.index } : null,
    }) + '\n', { flag: 'wx' }); // O_EXCL: a concurrent run that got here first wins
  } catch (e) {
    if (e && e.code === 'EEXIST') continue;
    throw e;
  }
  if (slot) {
    try {
      fs.writeFileSync(slot.marker, JSON.stringify({
        claimedAt: now.toISO(),
        execId,
        clip_key: clipKey,
      }) + '\n', { flag: 'wx' });
    } catch (e) {
      fs.rmSync(clip.claimPath, { force: true });
      if (e && e.code === 'EEXIST') return []; // another run took this slot: stand down
      throw e;
    }
  }

  return [{
    json: {
      clip_path: clipKey,
      clip_key: clipKey,
      caption,
      hashtags: hashtagsField(row.hashtags),
      dryRun: DRY_RUN,
      timeoutMs,
      manifestPath: m.manifestPath,
      jobDir: m.jobDir,
      rowIndex,
      filename: clip.nfc,
      title,
      sizeBytes: clip.size,
      claimPath: clip.claimPath,
      slotMarker: slot ? slot.marker : null,
      claimedAt: now.toISO(),
      manifestErrors,
    },
  }];
}

// 6. Nothing to post. An unexpected error fails every run so the watchdog
// reports it. Clips that can never be posted fail ONE run a SAST day (the day
// is recorded first), so an idle dispatcher is not silent about them either;
// the list is in .state/notices.json.
if (errors.length) {
  throw new Error('Pick Due Clip: unreadable manifest(s) or row(s): ' + errors.join('; '));
}
if (notices.length) {
  if (state.idleNoticeDay !== today) {
    writeStateAtomic(STATE_FILE, { ...state, idleNoticeDay: today });
    throw new Error(`Pick Due Clip: ${notices.length} clip(s) can never be posted as they are; see .state/notices.json (reported once a day)`);
  }
}
return [];
