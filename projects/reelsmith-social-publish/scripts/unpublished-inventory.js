#!/usr/bin/env node
/*
 * Reelsmith un-republished inventory (durable, repeatable).
 *
 * Answers: "which clips were never republished by ANYTHING (neither TikTok nor YouTube)?"
 *
 * Design notes (from adversarial review):
 *  - Keys are JOB-SCOPED ("<jobDir>/<filename>") because every job re-uses 00_*.mp4 etc.
 *    A bare-filename comparison silently collapses distinct clips across jobs.
 *  - HEADER-AWARE: two ledger formats coexist —
 *      live : timestamp,filename,title,tiktok_post_id,tiktok_post_url,youtube_video_id,youtube_status,error
 *      old  : timestamp,filename,title,status,error   (status=rendered => NOT a real post)
 *  - Three states: published | posted_unverified | unpublished. Only `published` counts as republished.
 *  - Catalog includes both active manifest.csv and archived processed/manifest-*.csv.
 *  - Dispatcher claims (<jobDir>/.claims/<filename>.json, written by Pick Due Clip / Log Results)
 *    are read too: status posted|posted_elsewhere counts as published; needs_you|failed is listed
 *    under "needs you" (release one with `rm <jobDir>/.claims/<filename>.json` once resolved).
 *  - CSV is parsed per RFC 4180 (descriptions carry quoted newlines); names compare NFC.
 *
 * Run on the cluster (the PVC is only mounted in-pod; Syncthing is Mac->cluster Send-Only):
 *   kubectl exec -i -n n8n-live <n8n-pod> -- node - < unpublished-inventory.js
 * Optional env: ROOT (defaults to the doubled live path).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ROOT || '/data/reelsmith-inbox/reelsmith-inbox';

function parseCSV(txt) {
  const records = []; let row = [], cur = '', q = false;
  for (let i = txt.charCodeAt(0) === 0xfeff ? 1 : 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) {
      if (ch === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && txt[i + 1] === '\n') i++;
      row.push(cur); records.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); records.push(row); }
  const lines = records.filter(r => !(r.length === 1 && !r[0].trim()));
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].map(h => h.trim());
  // Log Results appends a 9th cell (tiktok_status) even to a results.log.csv that
  // still has the old 8-column live header.
  const ninthIsStatus = header.length === 8 && header.includes('tiktok_post_url') && !header.includes('tiktok_status');
  const rows = lines.slice(1).map(cells => {
    const o = {}; header.forEach((h, i) => o[h] = (cells[i] ?? '').trim());
    if (ninthIsStatus && cells.length > 8) o.tiktok_status = cells[8].trim();
    return o;
  });
  return { header, rows };
}
const nonEmpty = v => v != null && String(v).trim().length > 0;

function listJobDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => path.join(root, d.name));
}
function manifestFiles(jobDir) {
  const files = [];
  const m = path.join(jobDir, 'manifest.csv');
  if (fs.existsSync(m)) files.push(m);
  const proc = path.join(jobDir, 'processed');
  if (fs.existsSync(proc)) {
    for (const f of fs.readdirSync(proc))
      if (/^manifest.*\.csv$/.test(f)) files.push(path.join(proc, f));
  }
  return files;
}
function publishState(row, header) {
  const live = header.includes('tiktok_post_url') || header.includes('youtube_video_id') || header.includes('tiktok_post_id');
  if (live) {
    const tt = nonEmpty(row.tiktok_post_url) || nonEmpty(row.tiktok_post_id)
      || ['success', 'posted', 'posted_elsewhere'].includes((row.tiktok_status || '').toLowerCase());
    const yt = nonEmpty(row.youtube_video_id);
    if (tt || yt) return 'published';
    // sidecar success with empty url would be posted_unverified once tiktok_status lands; absent that, treat as unpublished
    return 'unpublished';
  }
  // old format: only a generic status column
  const st = (row.status || '').toLowerCase();
  if (['posted', 'published', 'success', 'live'].includes(st)) return 'published';
  return 'unpublished'; // 'rendered' etc. are NOT real posts
}

const catalog = new Map();      // key -> {job, filename}
const ledgerState = new Map();  // key -> best state seen
const needsYou = [];            // keys whose dispatcher claim says needs_you/failed
const rank = { unpublished: 0, posted_unverified: 1, published: 2 };
const keyOf = (job, filename) => `${job}/${String(filename).normalize('NFC')}`;
function noteState(key, st) {
  if (!ledgerState.has(key) || rank[st] > rank[ledgerState.get(key)]) ledgerState.set(key, st);
}
function readClaims(jobDir) {
  const dir = path.join(jobDir, '.claims');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push({ filename: f.slice(0, -'.json'.length), claim: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); }
    catch (e) { /* half-written or foreign: ignore */ }
  }
  return out;
}

for (const jobDir of listJobDirs(ROOT)) {
  const job = path.basename(jobDir);
  for (const mf of manifestFiles(jobDir)) {
    const { rows } = parseCSV(fs.readFileSync(mf, 'utf8'));
    for (const r of rows) if (nonEmpty(r.filename)) catalog.set(keyOf(job, r.filename), { job, filename: r.filename });
  }
  const led = path.join(jobDir, 'results.log.csv');
  if (fs.existsSync(led)) {
    const { header, rows } = parseCSV(fs.readFileSync(led, 'utf8'));
    for (const r of rows) {
      if (!nonEmpty(r.filename)) continue;
      noteState(keyOf(job, r.filename), publishState(r, header));
    }
  }
  for (const { filename, claim } of readClaims(jobDir)) {
    const status = String((claim && claim.status) || '');
    if (status === 'posted' || status === 'posted_elsewhere') noteState(keyOf(job, filename), 'published');
    else if (status === 'needs_you' || status === 'failed') needsYou.push(`${keyOf(job, filename)} (${status}${claim.code ? ': ' + claim.code : ''})`);
  }
}

const unpublished = [], unverified = [], published = [];
for (const [key, info] of catalog) {
  const st = ledgerState.get(key) || 'unpublished';
  if (st === 'published') published.push(key);
  else if (st === 'posted_unverified') unverified.push(key);
  else unpublished.push(key);
}
unpublished.sort(); unverified.sort(); published.sort();

const byJob = {};
for (const k of unpublished) { const j = k.split('/')[0]; (byJob[j] ||= []).push(k.split('/').slice(1).join('/')); }

console.log('=== Reelsmith un-republished inventory ===');
console.log('ROOT:', ROOT);
console.log(`catalog clips        : ${catalog.size}`);
console.log(`published (TT or YT) : ${published.length}`);
console.log(`posted_unverified    : ${unverified.length}`);
console.log(`NEVER republished    : ${unpublished.length}`);
console.log(`needs you (claim)    : ${needsYou.length}`);
console.log('\n--- NEVER republished, by job ---');
for (const j of Object.keys(byJob).sort())
  console.log(`  [${byJob[j].length}] ${j}: ${byJob[j].join(', ')}`);
if (needsYou.length) console.log('\n--- needs you (claim kept; rm it to retry) ---\n  ' + needsYou.sort().join('\n  '));
if (published.length) console.log('\n--- published ---\n  ' + published.join('\n  '));
