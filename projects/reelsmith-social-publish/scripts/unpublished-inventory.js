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
 *
 * Run on the cluster (the PVC is only mounted in-pod; Syncthing is Mac->cluster Send-Only):
 *   kubectl exec -i -n n8n-live <n8n-pod> -- node - < unpublished-inventory.js
 * Optional env: ROOT (defaults to the doubled live path).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ROOT || '/data/reelsmith-inbox/reelsmith-inbox';

function splitCSVLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { header: [], rows: [] };
  const header = splitCSVLine(lines[0]).map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const cells = splitCSVLine(l);
    const o = {}; header.forEach((h, i) => o[h] = (cells[i] ?? '').trim());
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
    const tt = nonEmpty(row.tiktok_post_url) || nonEmpty(row.tiktok_post_id) || (row.tiktok_status || '').toLowerCase() === 'success';
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

for (const jobDir of listJobDirs(ROOT)) {
  const job = path.basename(jobDir);
  for (const mf of manifestFiles(jobDir)) {
    const { rows } = parseCSV(fs.readFileSync(mf, 'utf8'));
    for (const r of rows) if (nonEmpty(r.filename)) catalog.set(`${job}/${r.filename}`, { job, filename: r.filename });
  }
  const led = path.join(jobDir, 'results.log.csv');
  if (fs.existsSync(led)) {
    const { header, rows } = parseCSV(fs.readFileSync(led, 'utf8'));
    for (const r of rows) {
      if (!nonEmpty(r.filename)) continue;
      const key = `${job}/${r.filename}`;
      const st = publishState(r, header);
      const rank = { unpublished: 0, posted_unverified: 1, published: 2 };
      if (!ledgerState.has(key) || rank[st] > rank[ledgerState.get(key)]) ledgerState.set(key, st);
    }
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
console.log('\n--- NEVER republished, by job ---');
for (const j of Object.keys(byJob).sort())
  console.log(`  [${byJob[j].length}] ${j}: ${byJob[j].join(', ')}`);
if (published.length) console.log('\n--- published ---\n  ' + published.join('\n  '));
