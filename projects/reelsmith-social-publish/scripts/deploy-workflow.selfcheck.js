#!/usr/bin/env node
'use strict';
// Offline checks for deploy-workflow.sh: argument and env validation refuse
// before any network use, and the remote port-forward wrapper (the REMOTE
// line) is killed with the session and reports its own death. Nothing here
// contacts the homelab or n8n: `ssh` on PATH is a stub that records any call,
// and the wrapper runs locally against stub `microk8s` and `timeout`.
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
const writeStub = (name, body) => fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
writeStub('ssh', `echo "$@" > "${SSH_CALLED}"; exit 99`);
writeStub('timeout', 'shift\nexec "$@"');
writeStub('microk8s', [
  'echo "Forwarding from 127.0.0.1:15678 -> 5678"',
  'if [ -n "$STUB_DIE_AFTER" ]; then sleep "$STUB_DIE_AFTER"; echo "error: lost connection to pod" >&2; exit 1; fi',
  'trap \'echo "stub kubectl: killed" >&2; exit 143\' TERM',
  'while :; do sleep 1; done',
].join('\n'));
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

// The REMOTE line exactly as the script builds it, for the validated defaults.
function remoteCommand() {
  const line = fs.readFileSync(SCRIPT, 'utf8').split('\n').find((l) => l.startsWith('REMOTE='));
  assert.ok(line, 'REMOTE= line not found');
  const r = spawnSync('bash', ['-c', `NAMESPACE=n8n-live SERVICE=svc/n8n-application FORWARD_PORT=15678; ${line}; printf %s "$REMOTE"`], { encoding: 'utf8' });
  return r.stdout;
}

function runRemote({ closeStdinAfterMs, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', remoteCommand()], { env: { ...ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const events = [];
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; events.push([Date.now(), String(d)]); });
    const started = Date.now();
    const timer = setTimeout(() => { events.push([Date.now(), '<stdin closed>']); child.stdin.end(); }, closeStdinAfterMs);
    child.on('close', () => { clearTimeout(timer); resolve({ out, events, started }); });
  });
}

s.check('remote wrapper: the port-forward lives until the session ends, then is killed and says so', async () => {
  const { out, events } = await runRemote({ closeStdinAfterMs: 1500 });
  assert.match(out, /Forwarding from 127\.0\.0\.1:15678/);
  assert.match(out, /stub kubectl: killed/);
  assert.match(out, /deploy-workflow: port-forward exited \(143\)/);
  const closedAt = events.find(([, e]) => e === '<stdin closed>')[0];
  const exitedAt = events.find(([, e]) => e.includes('port-forward exited'))[0];
  assert.ok(exitedAt >= closedAt, 'the port-forward died before the session ended');
});

s.check('remote wrapper: a port-forward that dies on its own is reported while the session is open', async () => {
  const { out, events, started } = await runRemote({ closeStdinAfterMs: 4000, env: { STUB_DIE_AFTER: '1' } });
  assert.match(out, /error: lost connection to pod/);
  const reported = events.find(([, e]) => e.includes('deploy-workflow: port-forward exited (1)'));
  assert.ok(reported, out);
  assert.ok(reported[0] - started < 3500, 'death reported only when the session closed');
});

s.check('the API is reached only through the Unix socket in the private temp dir', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /-L "\$SOCK:127\.0\.0\.1:\$FORWARD_PORT"/);
  assert.match(src, /--unix-socket "\$SOCK"/);
  assert.equal(/127\.0\.0\.1:\$\{?LOCAL_PORT/.test(src), false, 'a local TCP listener is back');
  assert.match(src, /-o ServerAliveInterval=15 -o ServerAliveCountMax=2/);
  assert.match(src, /^REMOTE="timeout 900 sh -c '/m);
});

s.run();
