'use strict';
// Shared harness for the *.selfcheck.js files: runs a canonical Code-node
// script the way n8n 2.39.8's task runner does (async body, `this.helpers`,
// $input/$json/$env/$execution/$(...), global luxon `DateTime`, require()
// limited to fs/path/crypto) against a temp copy of the PVC layout.
//
// Also a child-process entry point for the overlapping-run race:
//   node selfcheck-harness.js --child '<json>'
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DateTime, Settings } = require('luxon');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ALLOWED_BUILTINS = new Set(['fs', 'path', 'crypto']); // NODE_FUNCTION_ALLOW_BUILTIN
const TZ = 'Africa/Johannesburg';

// n8n's default zone on this instance is not SAST; code must setZone() itself.
Settings.defaultZone = 'America/New_York';
Settings.throwOnInvalid = false;

function setNow(sast) {
  const dt = typeof sast === 'string' ? DateTime.fromISO(sast, { zone: TZ }) : sast;
  if (!dt.isValid) throw new Error('bad time ' + sast);
  Settings.now = () => dt.toMillis();
  return dt;
}

function replaceOnce(code, from, to) {
  const n = code.split(from).length - 1;
  if (n !== 1) throw new Error(`harness: expected exactly one "${from}", found ${n}`);
  return code.replace(from, to);
}

// Canonical script with DATA_ROOT pointed at `root` and, optionally, the real
// (non-dry) mode, exactly as deploy-workflow.sh patches DRY_RUN.
function loadNode(file, { root, live = false } = {}) {
  let code = fs.readFileSync(path.join(__dirname, file), 'utf8');
  if (root) code = replaceOnce(code, "const DATA_ROOT = '/data/reelsmith-inbox';", `const DATA_ROOT = ${JSON.stringify(root)};`);
  if (live) code = replaceOnce(code, 'const DRY_RUN = true;', 'const DRY_RUN = false;');
  return code;
}

function itemsAccessor(items) {
  return {
    all: () => items,
    first: () => items[0],
    last: () => items[items.length - 1],
  };
}

async function runNode(code, { input = [], nodes = {}, env = {}, execId = 'test-exec', helpers = {}, fsImpl, logs = [] } = {}) {
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`harness: no output for node "${name}"`);
    return itemsAccessor(nodes[name]);
  };
  const requireShim = (m) => {
    if (!ALLOWED_BUILTINS.has(m)) throw new Error(`Module '${m}' is disallowed`);
    if (m === 'fs' && fsImpl) return fsImpl;
    return require(m);
  };
  // n8n's Code-node console only forwards log(); capture it instead of printing.
  const consoleShim = { log: (...args) => logs.push(args.map(String).join(' ')) };
  const fn = new AsyncFunction('$input', '$json', '$env', '$execution', '$', 'DateTime', 'require', 'console', code);
  return fn.call(
    { helpers },
    itemsAccessor(input),
    input[0] ? input[0].json : {},
    env,
    { id: execId },
    $,
    DateTime,
    requireShim,
    consoleShim,
  );
}

// ---- fixtures ---------------------------------------------------------------

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reelsmith-selfcheck-'));
  fs.mkdirSync(path.join(root, 'reelsmith-inbox'));
  return root;
}

const inboxOf = (root) => path.join(root, 'reelsmith-inbox');

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Python csv.DictWriter style (CRLF, minimal quoting), like Reelsmith writes it.
function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(header.map((h) => csvCell(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

const MANIFEST_HEADER = ['filename', 'title', 'duration_seconds', 'file_size_mb', 'description',
  'hashtags', 'export_path', 'thumbnail_path', 'job_id', 'broll_credits', 'source'];

// rows: [{filename, title?, description?, hashtags?, source?, size?, onDisk?}]
//   size: bytes written to the clip file (default 4096; null = no file)
//   onDisk: the name to create on disk (default: filename)
function addJob(root, job, { rows, mtime, legacy = false, raw } = {}) {
  const jobDir = path.join(inboxOf(root), job);
  fs.mkdirSync(jobDir, { recursive: true });
  const header = legacy ? MANIFEST_HEADER.filter((h) => h !== 'source') : MANIFEST_HEADER;
  const csvRows = (rows || []).map((r) => ({
    title: `title ${r.filename}`,
    description: '',
    hashtags: '["#reels", "#clip"]',
    job_id: job,
    source: 'youtube',
    ...r,
  }));
  const manifestPath = path.join(jobDir, 'manifest.csv');
  fs.writeFileSync(manifestPath, raw !== undefined ? raw : toCsv(header, csvRows));
  for (const r of rows || []) {
    const size = r.size === undefined ? 4096 : r.size;
    if (size === null || !r.filename) continue;
    const file = path.join(jobDir, r.onDisk || r.filename);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, size); // sparse: large sizes cost no disk
  }
  if (mtime) {
    const t = DateTime.fromISO(mtime, { zone: TZ }).toJSDate();
    fs.utimesSync(manifestPath, t, t);
  }
  return { jobDir, manifestPath };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function listClaims(root) {
  const out = [];
  const inbox = inboxOf(root);
  for (const job of fs.readdirSync(inbox)) {
    const dir = path.join(inbox, job, '.claims');
    if (!exists(dir)) continue;
    for (const f of fs.readdirSync(dir)) out.push({ job, file: f, data: readJson(path.join(dir, f)) });
  }
  return out;
}

function listSlots(root) {
  const dir = path.join(root, '.slots');
  return exists(dir) ? fs.readdirSync(dir).sort() : [];
}

// fs whose lstat matches names byte-for-byte, as ext4 does. macOS APFS is
// normalization-insensitive, which would hide a missing NFD fallback.
function byteExactFs() {
  const shim = Object.create(fs);
  shim.lstatSync = (p, ...rest) => {
    const dir = path.dirname(p);
    const base = path.basename(p);
    let names = null;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      // let the real call raise
    }
    if (names && !names.includes(base)) {
      const err = new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return fs.lstatSync(p, ...rest);
  };
  return shim;
}

// Every document in <dir>/*.yaml (not recursive, like the ArgoCD source), via
// python3 + PyYAML (no JS YAML dependency).
function loadManifests(dir) {
  const { execFileSync } = require('child_process');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => path.join(dir, f));
  const py = 'import json, sys, yaml\n'
    + 'print(json.dumps([d for f in sys.argv[1:] for d in yaml.safe_load_all(open(f)) if d]))';
  return JSON.parse(execFileSync('python3', ['-I', '-c', py, ...files], { encoding: 'utf8' }));
}

// A tiny test runner: named async checks, every failure reported, exit 1 on any.
function suite(title) {
  const checks = [];
  return {
    check(name, fn) { checks.push({ name, fn }); },
    async run() {
      let failed = 0;
      console.log(`# ${title}`);
      for (const c of checks) {
        try {
          await c.fn();
          console.log(`ok   - ${c.name}`);
        } catch (e) {
          failed += 1;
          console.log(`FAIL - ${c.name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 14).join('\n       ')}`);
        }
      }
      console.log(`# ${checks.length - failed}/${checks.length} passed`);
      process.exitCode = failed ? 1 : 0;
    },
  };
}

// ---- overlapping runs in separate processes ---------------------------------

function runPickInChildren({ root, sast, live, count }) {
  const startAt = Date.now() + 400; // every child spins until the same instant
  const runs = [];
  for (let i = 0; i < count; i++) {
    runs.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [__filename, '--child', JSON.stringify({ root, sast, live, startAt, execId: `child-${i}` })], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (codeExit) => {
        if (codeExit !== 0) reject(new Error(`child ${i} exited ${codeExit}: ${err}`));
        else resolve(JSON.parse(out));
      });
    }));
  }
  return Promise.all(runs);
}

if (require.main === module && process.argv[2] === '--child') {
  const args = JSON.parse(process.argv[3]);
  setNow(args.sast);
  const code = loadNode('pick-due-clip.jsCode.js', { root: args.root, live: args.live });
  while (Date.now() < args.startAt) { /* spin: maximise overlap */ }
  runNode(code, { execId: args.execId })
    .then((items) => process.stdout.write(JSON.stringify(items)))
    .catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });
}

module.exports = {
  TZ, DateTime, setNow, loadNode, runNode, makeRoot, inboxOf, addJob, toCsv, MANIFEST_HEADER,
  readJson, exists, listClaims, listSlots, byteExactFs, loadManifests, suite, runPickInChildren,
};
