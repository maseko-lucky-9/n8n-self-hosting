// Archive Manifest: moves the picked clip's manifest.csv into processed/ once
// EVERY row is done: posted, posted_elsewhere or junk. A missing clip (Syncthing
// still copying), a failed or needs-you clip, or a row from a non-YouTube
// source keeps the manifest where it is. Canonical source:
// scripts/archive-manifest.jsCode.js.
const fs = require('fs');
const path = require('path');

const TZ = 'Africa/Johannesburg';
const DONE = ['posted', 'posted_elsewhere'];
// Junk rules, kept identical to Pick Due Clip (workflow-contract.selfcheck.js compares them).
const MIN_BYTES = 1024;       // a clip of 1 KB or less is junk
const MAX_CLIP_MB = 300;      // the sidecar's MAX_CLIP_MB: anything larger gets a 413
const NAME_RE = /^(?!\.)[\p{L}\p{N}_. -]{1,251}\.mp4$/u;
const MAX_NAME_BYTES = 200;

const pick = $('Pick Due Clip').first().json;
const items = $input.all();
const now = DateTime.now().setZone(TZ);

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

// Same RFC 4180 reader as Pick Due Clip (quoted commas, quotes and newlines).
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

// Junk exactly as Pick Due Clip defines it; otherwise done only if the claim
// records a posted outcome.
function rowDone(jobDir, row) {
  const name = String(row.filename == null ? '' : row.filename);
  if (!name.trim()) return true;
  const nfc = name.normalize('NFC');
  if (!nfc.endsWith('.mp4')) return true;
  if (nfc !== path.basename(nfc) || nfc.startsWith('.') || /[\\/\0]/.test(nfc)) return true;
  if (Buffer.byteLength(nfc, 'utf8') > MAX_NAME_BYTES || !NAME_RE.test(nfc)) return true;
  let st = null;
  for (const candidate of [...new Set([nfc, name.normalize('NFD'), name])]) {
    st = lstatOrNull(path.join(jobDir, candidate));
    if (st) break;
  }
  if (!st) return false; // missing: wait, never archive
  if (!st.isFile() || st.size <= MIN_BYTES || st.size > MAX_CLIP_MB * 1048576) return true;
  if (!captionUsable(row.description) && !captionUsable(row.title)) return true;
  try {
    const claim = JSON.parse(fs.readFileSync(path.join(jobDir, '.claims', nfc + '.json'), 'utf8'));
    return Boolean(claim && DONE.includes(claim.status));
  } catch (e) {
    return false; // no claim yet, or unreadable
  }
}

// One bad row never pins a manifest: a row that throws counts as junk, as it
// does in Pick Due Clip.
function rowDoneSafe(jobDir, row) {
  try {
    return rowDone(jobDir, row);
  } catch (e) {
    return true;
  }
}

const passthrough = items.map((it) => ({ json: it.json }));
const manifestPath = pick.manifestPath;
const jobDir = pick.jobDir;
if (!manifestPath || !jobDir || path.dirname(manifestPath) !== jobDir) return passthrough;
const st = lstatOrNull(manifestPath);
if (!st || !st.isFile()) return passthrough;

const { rows } = parseCsv(fs.readFileSync(manifestPath, 'utf8'));
if (!rows.every((r) => rowDoneSafe(jobDir, r))) return passthrough;

const processed = path.join(jobDir, 'processed');
try {
  fs.mkdirSync(processed);
} catch (e) {
  if (!e || e.code !== 'EEXIST') throw e;
}
if (!fs.lstatSync(processed).isDirectory()) throw new Error('Archive Manifest: processed/ is not a real directory');
const dest = path.join(processed, `manifest-${now.toUTC().toISO().replace(/[:.]/g, '-')}.csv`);
fs.renameSync(manifestPath, dest);
return items.map((it) => ({ json: { ...it.json, archived_to: dest } }));
