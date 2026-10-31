#!/usr/bin/env node
'use strict';
// Static checks for the sidecar's scrape and alert manifests, the parts promtool cannot see
// (the rules' behaviour is tested by tests/reelsmith-alerts.test.yml):
//  - the ServiceMonitor -> Service -> container port chain for metrics (9100), 30 s;
//  - only Prometheus (observability namespace AND Prometheus pod, one `from` element) may
//    reach 9100, and nothing new reaches the upload API on 8000;
//  - the PrometheusRule holds exactly the 11 alert names the homelab desk allowlists, each
//    with the static namespace label and its severity, and no annotation that would break
//    Alertmanager's HTML Telegram template.
//   node monitoring.selfcheck.js   -> exit 0 on pass, 1 on any failure.
const assert = require('node:assert/strict');
const path = require('path');
const h = require('./selfcheck-harness');

// Overridable only so the mutation check can point it at an edited copy.
const MANIFESTS_DIR = process.env.MANIFESTS_DIR || path.join(__dirname, '..', 'manifests');
const NAMESPACE = 'n8n-live';
const SIDECAR = 'tiktok-sidecar';
const API_PORT = 8000;
const METRICS_PORT = 9100;
// In-namespace components allowed on the API port (n8n main, n8n worker, the watchdog).
const API_CLIENTS = ['n8n', 'reelsmith-watchdog', 'worker'];
const PROMETHEUS_PEER = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'observability' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus' } },
};
// The homelab desk allowlists these by exact name (plan section A4).
const CRITICAL = ['ReelsmithLedgerUnreadable', 'ReelsmithSessionInvalid', 'ReelsmithSidecarDown'];
const WARNING = ['ReelsmithAmbiguousUpload', 'ReelsmithBacklogLow', 'ReelsmithClipsSetAside',
  'ReelsmithDispatcherSilent', 'ReelsmithNoPostToday', 'ReelsmithPaused', 'ReelsmithPostingDisabled',
  'ReelsmithThrottled'];

const s = h.suite('monitoring');
const docs = h.loadManifests(MANIFESTS_DIR);
const inNs = (kind) => docs.filter((d) => d.kind === kind && d.metadata && d.metadata.namespace === NAMESPACE);
const isSubset = (labels, of) => Boolean(labels) && Object.keys(labels).length > 0
  && Object.entries(labels).every(([k, v]) => (of || {})[k] === v);
const one = (list, what) => {
  assert.equal(list.length, 1, `expected exactly one ${what}, found ${list.length}`);
  return list[0];
};
const sidecarDeployment = () => one(inNs('Deployment').filter((d) => d.metadata.name === SIDECAR), `Deployment ${SIDECAR}`);
const podLabels = () => sidecarDeployment().spec.template.metadata.labels;

s.check('the ServiceMonitor scrapes the Service\'s metrics port, which the sidecar serves', () => {
  const sm = one(inNs('ServiceMonitor').filter((d) => d.metadata.name === SIDECAR), `ServiceMonitor ${SIDECAR}`);
  assert.equal(sm.metadata.labels.release, 'kube-prom-stack');
  assert.deepEqual(sm.spec.namespaceSelector, { matchNames: [NAMESPACE] });
  const endpoint = one(sm.spec.endpoints, 'ServiceMonitor endpoint');
  assert.equal(endpoint.port, 'metrics');
  assert.equal(endpoint.path, '/metrics');
  assert.equal(endpoint.interval, '30s');

  // The rules select job="tiktok-sidecar": the job is the Service name unless jobLabel says otherwise.
  assert.equal(sm.spec.jobLabel, undefined, 'jobLabel would change the job the rules select on');
  const svc = one(inNs('Service').filter((d) => isSubset(sm.spec.selector.matchLabels, d.metadata.labels)),
    'Service matched by the ServiceMonitor');
  assert.equal(svc.metadata.name, SIDECAR);
  const ports = svc.spec.ports.map((p) => `${p.name}:${p.port}->${p.targetPort}`).sort();
  assert.deepEqual(ports, [`http:${API_PORT}->${API_PORT}`, `metrics:${METRICS_PORT}->${METRICS_PORT}`]);
  assert.ok(isSubset(svc.spec.selector, podLabels()), 'Service selector does not match the sidecar pods');

  const container = one(sidecarDeployment().spec.template.spec.containers.filter((c) => c.name === SIDECAR),
    `container ${SIDECAR}`);
  const metrics = one(container.ports.filter((p) => p.name === 'metrics'), 'container port named metrics');
  assert.equal(metrics.containerPort, METRICS_PORT);
  const env = (container.env || []).find((e) => e.name === 'METRICS_PORT');
  assert.ok(env === undefined || env.value === String(METRICS_PORT), 'METRICS_PORT disagrees with the container port');
});

s.check('only Prometheus reaches the metrics port, and nothing new reaches the API port', () => {
  const policies = inNs('NetworkPolicy').filter((np) => (np.spec.policyTypes || []).includes('Ingress')
    && isSubset(np.spec.podSelector.matchLabels, podLabels()));
  assert.ok(policies.length > 0, 'no Ingress NetworkPolicy selects the sidecar pods');
  let metricsRules = 0;
  for (const np of policies) {
    for (const [i, rule] of (np.spec.ingress || []).entries()) {
      const where = `${np.metadata.name} ingress[${i}]`;
      // A rule without ports opens every port; one without `from` admits every source.
      assert.ok(Array.isArray(rule.ports) && rule.ports.length > 0, `${where} lists no ports (opens all)`);
      assert.ok(Array.isArray(rule.from) && rule.from.length > 0, `${where} lists no sources (admits all)`);
      const ports = rule.ports.map((p) => p.port);
      if (ports.includes(METRICS_PORT)) {
        metricsRules += 1;
        assert.deepEqual(ports, [METRICS_PORT], `${where} opens more than the metrics port`);
        for (const peer of rule.from) {
          // Both selectors in ONE element (AND). Split into two elements they would be OR'd.
          assert.deepEqual(peer, PROMETHEUS_PEER, `${where} admits a peer that is not Prometheus in observability`);
        }
      } else {
        assert.deepEqual(ports, [API_PORT], `${where} opens a port other than ${API_PORT} or ${METRICS_PORT}`);
        const components = rule.from.map((peer) => {
          assert.deepEqual(Object.keys(peer), ['podSelector'], `${where} admits a peer outside the namespace`);
          assert.deepEqual(Object.keys(peer.podSelector), ['matchLabels'], `${where} uses an expression selector`);
          return peer.podSelector.matchLabels['app.kubernetes.io/component'];
        });
        assert.deepEqual(components.sort(), API_CLIENTS, `${where} admits a component outside ${API_CLIENTS}`);
      }
    }
  }
  assert.equal(metricsRules, 1, 'expected exactly one ingress rule for the metrics port');
});

s.check('reelsmith-alerts holds exactly the 11 alerts the desk allowlists, each labelled', () => {
  const pr = one(inNs('PrometheusRule').filter((d) => d.metadata.name === 'reelsmith-alerts'), 'PrometheusRule reelsmith-alerts');
  assert.equal(pr.metadata.labels.release, 'kube-prom-stack');
  const rules = pr.spec.groups.flatMap((g) => g.rules);
  const names = rules.map((r) => r.alert);
  assert.deepEqual([...names].sort(), [...CRITICAL, ...WARNING].sort());
  for (const r of rules) {
    assert.equal(r.labels.namespace, NAMESPACE, `${r.alert}: static namespace label`);
    assert.equal(r.labels.severity, CRITICAL.includes(r.alert) ? 'critical' : 'warning', `${r.alert}: severity`);
    for (const [key, text] of Object.entries(r.annotations || {})) {
      assert.equal(/[<>&]/.test(text), false, `${r.alert}: ${key} has <, > or & (breaks the HTML Telegram message)`);
    }
  }
});

s.run();
