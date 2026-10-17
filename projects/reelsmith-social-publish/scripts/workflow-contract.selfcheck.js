#!/usr/bin/env node
'use strict';
// Contract + drift checks for workflow/reelsmith-social-publish.json:
//  - the TikTok Sidecar Upload node sends EXACTLY the Contract v1 form fields;
//  - fullResponse/neverError/continueOnFail on, retries off, per-item timeout;
//  - settings the n8n 2.39.8 public API accepts (no maxConcurrency);
//  - DRY_RUN defaults to true;
//  - drift guard: every jsCode equals its script file, and the JSON equals
//    build-workflow.js output byte for byte;
//  - the sidecar URL names the Service in manifests/, and the NetworkPolicies
//    there let the n8n main and worker pods reach it on that port;
//  - the repo's import banned-keys check and disclosure sweep both pass.
//   node workflow-contract.selfcheck.js   -> exit 0 on pass, 1 on any failure.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const h = require('./selfcheck-harness');
const { render, WORKFLOW_FILE, SIDECAR_UPLOAD_URL } = require('./build-workflow');

// Contract v1 (sidecar <-> n8n). `simulate` is optional and dry-run only; the
// committed workflow never sends it (deploy-workflow.sh --simulate adds it in memory).
const CONTRACT_V1_FIELDS = ['clip_path', 'caption', 'hashtags', 'account', 'source', 'dry_run'];
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// Overridable only so the mutation check can point it at an edited copy.
const MANIFESTS_DIR = process.env.MANIFESTS_DIR || path.join(__dirname, '..', 'manifests');
const SETTINGS_ALLOWED = ['saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution',
  'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder',
  'binaryMode', 'callerPolicy', 'callerIds', 'timeSavedMode', 'timeSavedPerExecution',
  'redactionPolicy', 'availableInMCP', 'customTelemetryTags', 'credentialResolverId'];
const SCRIPTS = {
  'Pick Due Clip': 'pick-due-clip.jsCode.js',
  'Log Results': 'log-results.jsCode.js',
  'Archive Manifest': 'archive-manifest.jsCode.js',
};

const s = h.suite('workflow-contract');
const text = fs.readFileSync(WORKFLOW_FILE, 'utf8');
const wf = JSON.parse(text);
const node = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  assert.ok(n, `node "${name}" missing`);
  return n;
};
const upload = () => node('TikTok Sidecar Upload');

s.check('upload sends exactly the Contract v1 form fields', () => {
  const p = upload().parameters;
  assert.equal(p.method, 'POST');
  assert.equal(p.url, SIDECAR_UPLOAD_URL);
  assert.match(p.url, /^http:\/\/tiktok-sidecar\.n8n-live\.svc:8000\/api\/upload$/);
  assert.equal(p.sendBody, true);
  assert.equal(p.contentType, 'multipart-form-data');
  const fields = p.bodyParameters.parameters;
  assert.deepEqual(fields.map((f) => f.name).sort(), [...CONTRACT_V1_FIELDS].sort());
  assert.equal(new Set(fields.map((f) => f.name)).size, fields.length, 'duplicate field');
  for (const f of fields) assert.equal(f.parameterType, 'formData', `${f.name} must be plain form data`);
  const value = Object.fromEntries(fields.map((f) => [f.name, f.value]));
  assert.equal(value.clip_path, '={{ $json.clip_path }}');
  assert.equal(value.caption, '={{ $json.caption }}');
  assert.equal(value.hashtags, '={{ $json.hashtags }}');
  assert.equal(value.account, 'reelsmith');
  assert.equal(value.source, 'n8n');
});

s.check('dry_run is always sent, fail-safe to "true"', () => {
  const expr = upload().parameters.bodyParameters.parameters.find((f) => f.name === 'dry_run').value;
  assert.match(expr, /^=\{\{ (.*) \}\}$/);
  // evaluate the expression body the way n8n would, for each possible dryRun value
  const body = expr.slice(4, -3);
  const evalFor = (dryRun) => new Function('$json', `return (${body});`)({ dryRun });
  assert.equal(evalFor(false), 'false');
  for (const v of [true, undefined, null, 'false', 0, '']) assert.equal(evalFor(v), 'true', `dryRun=${JSON.stringify(v)}`);
});

s.check('fullResponse + neverError + continueOnFail, retries off, per-item timeout', () => {
  const n = upload();
  assert.deepEqual(n.parameters.options.response, { response: { fullResponse: true, neverError: true } });
  assert.equal(n.parameters.options.timeout, '={{ $json.timeoutMs }}');
  assert.equal(n.continueOnFail, true);
  assert.equal(n.retryOnFail, false);
  assert.equal(n.maxTries, undefined);
  assert.equal(n.typeVersion, 4.2);
});

s.check('nodes, versions, schedule and connections', () => {
  assert.deepEqual(wf.nodes.map((n) => n.name),
    ['Schedule', 'Pick Due Clip', 'TikTok Sidecar Upload', 'Log Results', 'Archive Manifest']);
  const sched = node('Schedule');
  assert.equal(sched.type, 'n8n-nodes-base.scheduleTrigger');
  assert.equal(sched.typeVersion, 1);
  assert.deepEqual(sched.parameters.rule.interval, [{ field: 'cronExpression', expression: '*/15 12-20 * * *' }]);
  for (const name of Object.keys(SCRIPTS)) {
    assert.equal(node(name).type, 'n8n-nodes-base.code');
    assert.equal(node(name).typeVersion, 2);
  }
  const next = (from) => wf.connections[from].main[0].map((c) => c.node);
  assert.deepEqual(next('Schedule'), ['Pick Due Clip']);
  assert.deepEqual(next('Pick Due Clip'), ['TikTok Sidecar Upload']);
  assert.deepEqual(next('TikTok Sidecar Upload'), ['Log Results']);
  assert.deepEqual(next('Log Results'), ['Archive Manifest']);
  assert.deepEqual(Object.keys(wf.connections).sort(),
    ['Log Results', 'Pick Due Clip', 'Schedule', 'TikTok Sidecar Upload']);
});

s.check('settings: SAST, 900 s, saved executions, no maxConcurrency, API-accepted keys only', () => {
  assert.deepEqual(wf.settings, {
    executionOrder: 'v1',
    timezone: 'Africa/Johannesburg',
    executionTimeout: 900,
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    saveExecutionProgress: false,
  });
  for (const k of Object.keys(wf.settings)) assert.ok(SETTINGS_ALLOWED.includes(k), `settings.${k} is rejected by the API`);
  assert.equal(wf.active, false);
  assert.equal(wf.name, 'Reelsmith Social Publish');
  assert.deepEqual(wf.tags, [{ name: 'reelsmith' }, { name: 'social-publish' }]);
});

s.check('no ids, credentials, pinData, meta or shared anywhere', () => {
  for (const k of ['id', 'shared', 'meta', 'pinData', 'versionId', 'activeVersion', 'activeVersionId',
    'versionCounter', 'triggerCount', 'staticData']) assert.equal(k in wf, false, `top-level ${k}`);
  for (const n of wf.nodes) {
    assert.equal('id' in n, false, `${n.name}.id`);
    assert.equal('credentials' in n, false, `${n.name}.credentials`);
    assert.equal('webhookId' in n, false, `${n.name}.webhookId`);
  }
});

s.check('DRY_RUN defaults to true (exactly one switch)', () => {
  const js = node('Pick Due Clip').parameters.jsCode;
  assert.equal(js.split('const DRY_RUN = true;').length - 1, 1);
  assert.equal(/const DRY_RUN = false/.test(js), false);
});

s.check('drift guard: every jsCode equals its canonical script file', () => {
  for (const [name, file] of Object.entries(SCRIPTS)) {
    assert.equal(node(name).parameters.jsCode, fs.readFileSync(path.join(__dirname, file), 'utf8'), `${name} drifted from ${file}`);
    assert.deepEqual(Object.keys(node(name).parameters), ['jsCode']);
  }
});

s.check('drift guard: committed JSON equals build-workflow.js output', () => {
  assert.equal(text, render(), 'run `node scripts/build-workflow.js` and commit the result');
});

s.check('Code nodes need only fs/path and the global DateTime', () => {
  for (const file of Object.values(SCRIPTS)) {
    const js = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const mods = [...js.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const m of mods) assert.ok(['fs', 'path', 'crypto'].includes(m), `${file} requires ${m}`);
    assert.equal(/process\.env/.test(js), false, `${file} uses process.env (not available in the task runner)`);
    assert.equal(/new Date\(|Date\.now\(/.test(js), false, `${file} reads the clock outside luxon`);
  }
});

// Every document in manifests/*.yaml, via python3 + PyYAML (no JS YAML dependency).
function loadManifests(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => path.join(dir, f));
  const py = 'import json, sys, yaml\n'
    + 'print(json.dumps([d for f in sys.argv[1:] for d in yaml.safe_load_all(open(f)) if d]))';
  return JSON.parse(execFileSync('python3', ['-I', '-c', py, ...files], { encoding: 'utf8' }));
}
const isSubset = (labels, of) => Boolean(labels) && Object.keys(labels).length > 0
  && Object.entries(labels).every(([k, v]) => of[k] === v);

s.check('sidecar URL resolves to the manifests\' Service, and the NetworkPolicies let n8n reach it', () => {
  const url = new URL(upload().parameters.url);
  assert.equal(url.protocol, 'http:');
  const [svcName, namespace, svcSuffix, ...rest] = url.hostname.split('.');
  assert.equal(svcSuffix, 'svc', `host ${url.hostname} is not <service>.<namespace>.svc`);
  assert.deepEqual(rest, []);
  const port = Number(url.port);
  assert.equal(port, 8000);

  const docs = loadManifests(MANIFESTS_DIR);
  const inNs = (kind) => docs.filter((d) => d.kind === kind && d.metadata && d.metadata.namespace === namespace);
  const svc = inNs('Service').find((d) => d.metadata.name === svcName);
  assert.ok(svc, `no Service ${svcName} in namespace ${namespace} under manifests/`);
  const svcPort = (svc.spec.ports || []).find((p) => p.port === port);
  assert.ok(svcPort, `Service ${svcName} exposes no port ${port}`);
  const podPort = svcPort.targetPort === undefined ? port : svcPort.targetPort;
  const selector = svc.spec.selector;
  assert.ok(inNs('Deployment').some((d) => isSubset(selector, d.spec.template.metadata.labels)),
    `no Deployment in ${namespace} matches Service ${svcName}'s selector`);

  const allowsPort = (rule) => (rule.ports || []).some((p) => p.port === podPort);
  const n8nComponents = ['n8n', 'worker'];
  const policies = inNs('NetworkPolicy');
  const ingress = policies.find((np) => (np.spec.policyTypes || []).includes('Ingress')
    && np.spec.podSelector.matchLabels
    && np.spec.podSelector.matchLabels['app.kubernetes.io/name'] === svcName
    && isSubset(np.spec.podSelector.matchLabels, selector));
  assert.ok(ingress, `no Ingress NetworkPolicy in ${namespace} selects the ${svcName} pods`);
  for (const component of n8nComponents) {
    assert.ok(ingress.spec.ingress.some((r) => allowsPort(r) && (r.from || []).some((f) => f.podSelector
      && f.podSelector.matchLabels && f.podSelector.matchLabels['app.kubernetes.io/component'] === component)),
    `${ingress.metadata.name} does not admit component=${component} on port ${podPort}`);
  }
  const egress = policies.find((np) => (np.spec.policyTypes || []).includes('Egress')
    && np.spec.egress.some((r) => allowsPort(r) && (r.to || []).some((t) => t.podSelector
      && isSubset(t.podSelector.matchLabels, selector))));
  assert.ok(egress, `no Egress NetworkPolicy in ${namespace} lets pods reach ${svcName}:${podPort}`);
  const sel = egress.spec.podSelector;
  const covered = (sel.matchExpressions || []).find((e) => e.key === 'app.kubernetes.io/component' && e.operator === 'In');
  for (const component of n8nComponents) {
    assert.ok(covered && covered.values.includes(component), `${egress.metadata.name} does not cover component=${component}`);
  }
});

s.check('passes the import banned-keys check (scripts/import-workflows.sh)', () => {
  const sh = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'import-workflows.sh'), 'utf8');
  const m = sh.match(/python3 - "\$f" <<'PY'\n([\s\S]*?)\nPY\n/);
  assert.ok(m, 'banned-keys check not found in import-workflows.sh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banned-keys-'));
  const checker = path.join(tmp, 'check.py');
  fs.writeFileSync(checker, m[1]);
  const out = execFileSync('python3', ['-I', checker, WORKFLOW_FILE], { encoding: 'utf8' });
  assert.match(out, /^ {2}ok {3}.*\(5 nodes\)\n$/);
  assert.equal(/WARN/.test(out), false, out);
});

s.check('passes scripts/disclosure-sweep.sh', () => {
  const out = execFileSync('bash', [path.join(REPO_ROOT, 'scripts', 'disclosure-sweep.sh'), WORKFLOW_FILE], { encoding: 'utf8' });
  assert.match(out, /disclosure-sweep: clean \(1 file\(s\)\)/);
});

s.run();
