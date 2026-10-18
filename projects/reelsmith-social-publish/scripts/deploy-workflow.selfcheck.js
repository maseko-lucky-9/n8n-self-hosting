#!/usr/bin/env node
'use strict';
// Offline checks for deploy-workflow.sh: argument and env validation refuse
// before any network use; the remote port-forward command (the REMOTE line),
// run locally under dash like the homelab's /bin/sh, against a fake `microk8s`
// that is a chain of non-exec bash wrappers around a fake `kubectl` holding a
// real port, leaves nothing behind; and the whole script against a fake ssh.
// Nothing here contacts the homelab or n8n.
//   node deploy-workflow.selfcheck.js   -> exit 0 on pass, 1 on any failure.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const h = require('./selfcheck-harness');

const SCRIPT = path.join(__dirname, 'deploy-workflow.sh');
const s = h.suite('deploy-workflow');

const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-stubs-'));
const SSH_CALLED = path.join(stubs, 'ssh-called');
const writeStub = (name, body, shebang = '#!/bin/sh') => fs.writeFileSync(path.join(stubs, name), `${shebang}\n${body}\n`, { mode: 0o755 });
writeStub('ssh', `echo "$@" > "${SSH_CALLED}"; exit 99`);
writeStub('timeout', 'shift\nexec "$@"');
// macOS has no setsid(1): the same thing, a new session and process group, via perl.
writeStub('setsid', `exec perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' "$@"`);
// The remote `sh -c` is dash on the homelab (and on the Linux CI runner); use dash here too
// when it exists, because only dash ignores `kill -TERM -- -PID`.
const DASH = ['/bin/dash', '/usr/bin/dash'].find((p) => h.exists(p));
if (DASH) writeStub('sh', `exec ${DASH} "$@"`);
// `microk8s kubectl` as on the node: bash wrappers that do NOT exec the next stage.
writeStub('microk8s', [
  'echo "microk8s $$ $PPID" >> "$FAKE_PIDS"', // PPID: the remote sh that started it
  'shift # kubectl',
  'bash "$(dirname "$0")/microk8s-kubectl.wrapper" "$@"',
  'rc=$?',
  'exit $rc',
].join('\n'), '#!/bin/bash');
writeStub('microk8s-kubectl.wrapper', [
  'echo "wrapper $$" >> "$FAKE_PIDS"',
  '"$(dirname "$0")/kubectl" "$@"',
  'rc=$?',
  'exit $rc',
].join('\n'), '#!/bin/bash');
// The fake kubectl really binds the forwarded port, so a survivor is visible as a held port.
writeStub('kubectl', String.raw`'use strict';
const fs = require('fs');
const net = require('net');
const port = Number(process.argv.slice(2).find((a) => /^\d+:5678$/.test(a)).split(':')[0]);
fs.appendFileSync(process.env.FAKE_PIDS, 'kubectl ' + process.pid + '\n');
net.createServer(() => {}).listen(port, '127.0.0.1', () => {
  process.stdout.write('Forwarding from 127.0.0.1:' + port + ' -> 5678\n');
});
if (process.env.STUB_DIE_AFTER) {
  setTimeout(() => { process.stderr.write('error: lost connection to pod\n'); process.exit(1); }, Number(process.env.STUB_DIE_AFTER) * 1000);
}
process.on('SIGTERM', () => { process.stderr.write('stub kubectl: killed\n'); process.exit(143); });`, '#!/usr/bin/env node');
const ENV = { ...process.env, PATH: `${stubs}:${process.env.PATH}` };

function run(args, env = {}) {
  fs.rmSync(SSH_CALLED, { force: true });
  const r = spawnSync('bash', [SCRIPT, ...args], { env: { ...ENV, ...env }, input: '', encoding: 'utf8', timeout: 20000 });
  return { status: r.status, err: r.stderr, sshCalled: h.exists(SSH_CALLED) };
}

s.check('--no-publish is refused (dry runs never publish, --live always does)', () => {
  const r = run(['--workflow-id', 'abcdefgh12345678', '--dry-run', '--no-publish']);
  assert.equal(r.status, 1);
  assert.match(r.err, /--no-publish was removed/);
  assert.equal(r.sshCalled, false);
});

for (const [label, port] of [['shell metacharacters', '15678; touch /tmp/x'], ['too short', '80'], ['out of range', '99999'], ['privileged', '1023']]) {
  s.check(`N8N_FORWARD_PORT ${label} is refused before any ssh`, () => {
    const r = run(['--workflow-id', 'abcdefgh12345678', '--dry-run'], { N8N_FORWARD_PORT: port });
    assert.equal(r.status, 1, r.err);
    assert.match(r.err, /N8N_FORWARD_PORT must be a port number/);
    assert.equal(r.sshCalled, false);
  });
}

s.check('N8N_SSH_HOST that looks like an ssh option is refused', () => {
  const r = run(['--workflow-id', 'abcdefgh12345678', '--dry-run'], { N8N_SSH_HOST: '-oProxyCommand=touch /tmp/x' });
  assert.equal(r.status, 1);
  assert.match(r.err, /N8N_SSH_HOST must be a plain host alias/);
  assert.equal(r.sshCalled, false);
});

s.check('--simulate only with --dry-run; --workflow-id required', () => {
  const live = run(['--workflow-id', 'abcdefgh12345678', '--live', '--simulate', 'auth_invalid']);
  assert.match(live.err, /--simulate only works with --dry-run/);
  const noId = run(['--dry-run']);
  assert.match(noId.err, /--workflow-id is required/);
  assert.equal(live.sshCalled || noId.sshCalled, false);
});

// The REMOTE line exactly as the script builds it.
function remoteCommand(port) {
  const line = fs.readFileSync(SCRIPT, 'utf8').split('\n').find((l) => l.startsWith('REMOTE='));
  assert.ok(line, 'REMOTE= line not found');
  const r = spawnSync('bash', ['-c', `NAMESPACE=n8n-live SERVICE=svc/n8n-application FORWARD_PORT=${port}; ${line}; printf %s "$REMOTE"`], { encoding: 'utf8' });
  return r.stdout;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = require('net').createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const portFree = (port) => new Promise((resolve) => {
  const srv = require('net').createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs REMOTE as the ssh session would, ending it endAfterMs after kubectl's
// Forwarding line (at most 10 s after the start), either by closing its stdin
// (the local ssh went away) or by sending TERM to the remote sh, as `timeout 900`
// does, while the session stays open. Returns the output, the fake chain's PIDs
// and, once the remote command has exited, which of them survived and whether
// the port is free again. stdin is a pipe whose only writer is a `sleep`, so it
// stays open until we say so (node would close its own pipe when the shell exits).
async function runRemote({ endAfterMs, end = 'stdin', env = {} }) {
  const port = await freePort();
  const pids = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-pids-')), 'pids');
  fs.writeFileSync(pids, '');
  const feeder = spawn('sleep', ['600'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const child = spawn('bash', ['-c', remoteCommand(port)], {
    env: { ...ENV, FAKE_PIDS: pids, ...env }, stdio: [feeder.stdout, 'pipe', 'pipe'],
  });
  let out = '';
  const events = [];
  let timer = null;
  let sessionEnded;
  const ended = new Promise((resolve) => { sessionEnded = resolve; });
  const readChain = () => fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { const [name, pid, ppid] = l.split(' '); return { name, pid: Number(pid), ppid: Number(ppid) }; });
  const endSession = () => {
    events.push([Date.now(), '<session ended>']);
    sessionEnded();
    if (end === 'stdin') feeder.kill();
    else process.kill(readChain().find((c) => c.name === 'microk8s').ppid, 'SIGTERM');
  };
  const schedule = (ms) => { if (!timer) timer = setTimeout(endSession, ms); };
  child.stdout.on('data', (d) => {
    out += d;
    if (/Forwarding from/.test(out)) schedule(endAfterMs);
  });
  child.stderr.on('data', (d) => { out += d; events.push([Date.now(), String(d)]); });
  const started = Date.now();
  const fallback = setTimeout(() => schedule(0), 10000);
  // 'exit', not 'close': a leaked port-forward keeps the pipes open forever. A
  // remote shell still waiting 5 s after the session ended is hung (its kill
  // missed the port-forward); it is reported, then cleaned up below.
  const exited = new Promise((resolve) => child.on('exit', () => resolve(true)));
  const hung = !(await Promise.race([exited, ended.then(() => Promise.race([exited, sleep(5000).then(() => false)]))]));
  clearTimeout(timer);
  clearTimeout(fallback);
  const chain = readChain().map(({ name, pid, ppid }) => ({ name, pid, ppid }));
  let survivors = [];
  for (let i = 0; i < 20; i++) { // up to 2 s for the TERM to land
    survivors = chain.filter((c) => alive(c.pid));
    if (!survivors.length) break;
    await sleep(100);
  }
  const free = await portFree(port);
  feeder.kill(); // only now: a TERM-ended run must not be rescued by the stdin watcher
  const shells = chain.filter((c) => c.name === 'microk8s').map((c) => c.ppid);
  for (const pid of [...survivors.map((c) => c.pid), ...shells, child.pid]) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
  }
  for (const stream of [child.stdout, child.stderr]) stream.destroy();
  return { out, events, started, port, chain: chain.map(({ name, pid }) => ({ name, pid })), survivors, free, hung };
}

s.check('remote: the port-forward lives until the session ends, then the WHOLE wrapper chain dies and the port is free', async () => {
  const r = await runRemote({ endAfterMs: 1500 });
  assert.match(r.out, new RegExp(`Forwarding from 127\\.0\\.0\\.1:${r.port}`));
  assert.deepEqual(r.chain.map((c) => c.name), ['microk8s', 'wrapper', 'kubectl'], 'fake chain did not start');
  assert.deepEqual(r.survivors, [], 'left running: ' + r.survivors.map((c) => c.name).join(', '));
  assert.equal(r.free, true, 'the forwarded port is still held');
  assert.equal(r.hung, false, 'the remote shell never returned after the session ended');
  assert.match(r.out, /stub kubectl: killed/);
  assert.match(r.out, /deploy-workflow: port-forward exited \(143\)/);
  const endedAt = r.events.find(([, e]) => e === '<session ended>')[0];
  const exitedAt = r.events.find(([, e]) => e.includes('port-forward exited'))[0];
  assert.ok(exitedAt >= endedAt, 'the port-forward died before the session ended');
});

s.check('remote: timeout\'s TERM to the remote shell also takes the whole chain down', async () => {
  const r = await runRemote({ endAfterMs: 1500, end: 'TERM' });
  assert.deepEqual(r.chain.map((c) => c.name), ['microk8s', 'wrapper', 'kubectl']);
  assert.deepEqual(r.survivors, [], 'left running: ' + r.survivors.map((c) => c.name).join(', '));
  assert.equal(r.free, true, 'the forwarded port is still held');
  assert.equal(r.hung, false, 'the remote shell never returned after its TERM');
});

s.check('remote: a port-forward that dies on its own is reported while the session is open', async () => {
  const r = await runRemote({ endAfterMs: 3000, env: { STUB_DIE_AFTER: '1' } });
  assert.match(r.out, /error: lost connection to pod/);
  const reported = r.events.find(([, e]) => e.includes('deploy-workflow: port-forward exited (1)'));
  assert.ok(reported, r.out);
  assert.ok(reported[0] - r.started < 3500, 'death reported only when the session closed');
  assert.deepEqual(r.survivors, []);
});

s.check('the remote shell in these checks is dash, as on the homelab', () => {
  assert.ok(DASH, 'dash not installed: the dash-only `kill -TERM -- -PID` failure cannot be checked');
  const r = spawnSync('sh', ['-c', 'echo ${BASH_VERSION:-nobash}'], { env: ENV, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'nobash');
});

s.check('shellcheck -S style is clean', () => {
  const r = spawnSync('shellcheck', ['-S', 'style', SCRIPT], { encoding: 'utf8' });
  assert.ok(!r.error, 'shellcheck not installed');
  assert.equal(r.status, 0, r.stdout);
});

// ---- the whole script against a faithful fake tunnel -------------------------
// The fake `ssh` parses `-L <sock>:127.0.0.1:<port>`, binds that Unix socket at
// once (as ssh does with ExitOnForwardFailure), also listens on TCP <port> to
// catch anything sent over TCP instead, prints kubectl's "Forwarding from
// 127.0.0.1:<port>" line only after FAKE_FORWARD_DELAY_MS, and serves canned n8n
// answers. It records every request: transport, whether the API key came with
// it, and whether it arrived before the Forwarding line or after a tunnel death.
const FAKE_SSH = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const http = require('http');
const args = process.argv.slice(2);
const rec = (o) => fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n');
const li = args.indexOf('-L');
const m = li >= 0 && String(args[li + 1]).match(/^(.*):127\.0\.0\.1:(\d+)$/);
if (!m || !m[1].startsWith('/')) { rec({ event: 'bad-args', args }); process.exit(98); } // real ssh: a local socket path or a TCP bind
const [, sockPath, port] = m;
rec({ event: 'start', args, remote: args[args.length - 1] });
let forwarded = false;
let dead = false;
const handler = (transport) => (req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const r = {
      event: 'request', transport, method: req.method, url: req.url,
      keyOk: req.headers['x-n8n-api-key'] === process.env.FAKE_API_KEY,
      anyKey: 'x-n8n-api-key' in req.headers, afterForwarding: forwarded, afterDeath: dead, body,
    };
    rec(r);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/healthz/readiness') return send(200, { status: 'ok' });
    const wf = req.url.match(/^\/api\/v1\/workflows\/([A-Za-z0-9]+)(.*)$/);
    if (!wf) return send(404, { message: 'not found' });
    if (!r.keyOk) return send(401, { message: 'unauthorized' });
    const [, id, rest] = wf;
    if (req.method === 'GET' && rest === '') {
      send(200, { id, name: 'Reelsmith Social Publish', active: true, versionId: 'v-old-0001' });
      if (process.env.FAKE_DIE_AFTER === 'GET') {
        dead = true;
        process.stderr.write('error: lost connection to pod\ndeploy-workflow: port-forward exited (1)\n');
      }
      if (process.env.FAKE_EXIT_AFTER === 'GET') setTimeout(() => process.exit(255), 50);
      return undefined;
    }
    if (req.method === 'PUT' && rest === '?publishIfActive=false') return send(200, { id, active: true, versionId: 'v-new-0002' });
    if (req.method === 'POST' && rest === '/publish') return send(200, { id, active: true, activeVersionId: JSON.parse(body).versionId });
    if (req.method === 'POST' && rest === '/unpublish') return send(200, { id, active: false });
    return send(400, { message: 'unexpected' });
  });
};
http.createServer(handler('unix')).listen(sockPath);
http.createServer(handler('tcp')).listen(Number(port), '127.0.0.1');
setTimeout(() => {
  forwarded = true;
  rec({ event: 'forwarding' });
  process.stdout.write('Forwarding from 127.0.0.1:' + port + ' -> 5678\n');
}, Number(process.env.FAKE_FORWARD_DELAY_MS || 1500));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-fake-'));
fs.writeFileSync(path.join(fakeBin, 'ssh'), FAKE_SSH, { mode: 0o755 });
const API_KEY = 'test-api-key-0123456789abcdef';


// Runs a COPY of the current script in a temp project tree (its backups/ too),
// with the fake ssh first on PATH. -> {status, out, err, log: [records], tree}
async function deploy(args, env = {}) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-tree-'));
  fs.mkdirSync(path.join(tree, 'scripts'));
  fs.mkdirSync(path.join(tree, 'workflow'));
  fs.copyFileSync(SCRIPT, path.join(tree, 'scripts', 'deploy-workflow.sh'));
  fs.copyFileSync(path.join(__dirname, '..', 'workflow', 'reelsmith-social-publish.json'),
    path.join(tree, 'workflow', 'reelsmith-social-publish.json'));
  const logFile = path.join(tree, 'fake-ssh.jsonl');
  fs.writeFileSync(logFile, '');
  const port = await freePort();
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(tree, 'scripts', 'deploy-workflow.sh'), ...args], {
      cwd: tree,
      env: Object.fromEntries(Object.entries({
        ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, N8N_FORWARD_PORT: String(port),
        FAKE_SSH_LOG: logFile, FAKE_API_KEY: API_KEY, ...env,
      }).filter(([, v]) => v !== undefined)), // env: {X: undefined} unsets X
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end(API_KEY + '\n');
    const killer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (status) => {
      clearTimeout(killer);
      const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      resolve({ status, out, err, log, tree });
    });
  });
}
const requests = (log) => log.filter((r) => r.event === 'request');
const calls = (log) => requests(log).filter((r) => r.url.startsWith('/api/')).map((r) => `${r.method} ${r.url.replace(/workflows\/[A-Za-z0-9]+/, 'workflows/ID')}`);

function assertKeyOnlyOverTheVerifiedSocket(log) {
  const reqs = requests(log);
  assert.ok(reqs.length > 0, 'no request reached the fake');
  for (const r of reqs) {
    assert.equal(r.transport, 'unix', `${r.method} ${r.url} went over ${r.transport}`);
    assert.equal(r.afterForwarding, true, `${r.method} ${r.url} sent before kubectl reported its bind`);
  }
  for (const r of reqs.filter((x) => x.url.startsWith('/api/'))) assert.equal(r.keyOk, true, `${r.url} without the key`);
  assert.equal(reqs.some((r) => r.url === '/healthz/readiness' && r.anyKey), false, 'key sent with the health check');
}

s.check('--dry-run saves (backup, PUT with DRY_RUN=true) and never publishes', async () => {
  const r = await deploy(['--workflow-id', 'abcdefgh12345678', '--dry-run']);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(calls(r.log), ['GET /api/v1/workflows/ID', 'PUT /api/v1/workflows/ID?publishIfActive=false']);
  assertKeyOnlyOverTheVerifiedSocket(r.log);
  const put = JSON.parse(requests(r.log).find((x) => x.method === 'PUT').body);
  assert.deepEqual(Object.keys(put).sort(), ['connections', 'name', 'nodes', 'settings']);
  assert.match(put.nodes.find((n) => n.name === 'Pick Due Clip').parameters.jsCode, /^const DRY_RUN = true;/m);
  assert.match(r.out, /saved, not published/);
  const backups = fs.readdirSync(path.join(r.tree, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.statSync(path.join(r.tree, 'backups', backups[0])).mode & 0o777, 0o600);
  const start = r.log.find((x) => x.event === 'start');
  assert.match(start.remote, /^timeout 900 sh -c '/);
  assert.ok(start.args.includes('ServerAliveInterval=15') && start.args.includes('ServerAliveCountMax=2'));
});

s.check('--live saves with DRY_RUN=false, then publishes exactly that version', async () => {
  const r = await deploy(['--workflow-id', 'abcdefgh12345678', '--live']);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(calls(r.log), ['GET /api/v1/workflows/ID', 'PUT /api/v1/workflows/ID?publishIfActive=false',
    'POST /api/v1/workflows/ID/publish']);
  assertKeyOnlyOverTheVerifiedSocket(r.log);
  const put = JSON.parse(requests(r.log).find((x) => x.method === 'PUT').body);
  assert.match(put.nodes.find((n) => n.name === 'Pick Due Clip').parameters.jsCode, /^const DRY_RUN = false;/m);
  assert.deepEqual(JSON.parse(requests(r.log).find((x) => x.url.endsWith('/publish')).body), { versionId: 'v-new-0002' });
  assert.match(r.out, /published: Reelsmith Social Publish versionId=v-new-0002/);
});

s.check('--deactivate backs up, then only unpublishes', async () => {
  const r = await deploy(['--workflow-id', 'abcdefgh12345678', '--deactivate']);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(calls(r.log), ['GET /api/v1/workflows/ID', 'POST /api/v1/workflows/ID/unpublish']);
  assertKeyOnlyOverTheVerifiedSocket(r.log);
});

s.check('a port-forward that dies mid-run stops the script before any change', async () => {
  const r = await deploy(['--workflow-id', 'abcdefgh12345678', '--live'], { FAKE_DIE_AFTER: 'GET' });
  assert.equal(r.status, 1);
  assert.match(r.err, /the ssh tunnel or the remote port-forward to svc\/n8n-application died/);
  assert.deepEqual(calls(r.log), ['GET /api/v1/workflows/ID'], 'kept talking after the tunnel died');
});

s.check('ssh goes to homelab-tunnel (svc-ai-agent, the user allowed to forward) unless N8N_SSH_HOST says otherwise', async () => {
  const host = (r) => { const a = r.log.find((x) => x.event === 'start').args; return a[a.length - 2]; };
  const byDefault = await deploy(['--workflow-id', 'abcdefgh12345678', '--deactivate'], { N8N_SSH_HOST: undefined });
  assert.equal(byDefault.status, 0, byDefault.err);
  assert.equal(host(byDefault), 'homelab-tunnel');
  const override = await deploy(['--workflow-id', 'abcdefgh12345678', '--deactivate'], { N8N_SSH_HOST: 'other-alias' });
  assert.equal(override.status, 0, override.err);
  assert.equal(host(override), 'other-alias');
});

s.check('an ssh that exits mid-run stops the script before any change', async () => {
  const r = await deploy(['--workflow-id', 'abcdefgh12345678', '--live'], { FAKE_EXIT_AFTER: 'GET' });
  assert.equal(r.status, 1);
  assert.deepEqual(calls(r.log), ['GET /api/v1/workflows/ID']);
});

s.run();
