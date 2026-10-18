#!/usr/bin/env node
'use strict';
// Assembles workflow/reelsmith-social-publish.json from the three canonical
// Code-node scripts plus the node definitions below. Never edit the JSON by
// hand: edit a script or this file, then run `node build-workflow.js`.
// workflow-contract.selfcheck.js fails if the committed JSON drifts from this.
//
// The JSON carries no top-level id/meta/pinData/shared, no node ids (n8n
// assigns them on save) and no credentials, so it passes the banned-keys check
// in scripts/import-workflows.sh and scripts/disclosure-sweep.sh.
const fs = require('fs');
const path = require('path');

const WORKFLOW_FILE = path.join(__dirname, '..', 'workflow', 'reelsmith-social-publish.json');
// Short in-cluster name (resolved through the pod's DNS search path); the
// fully qualified form trips disclosure-sweep.sh.
const SIDECAR_UPLOAD_URL = 'http://tiktok-sidecar.n8n-live.svc:8000/api/upload';

const code = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const formField = (name, value) => ({ parameterType: 'formData', name, value });

function buildWorkflow() {
  const nodes = [
    {
      parameters: {
        rule: { interval: [{ field: 'cronExpression', expression: '*/15 12-20 * * *' }] },
      },
      name: 'Schedule',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1,
      position: [0, 300],
      notesInFlow: true,
      notes: 'Every 15 min, 12:00-20:45 in the workflow time zone (Africa/Johannesburg). Pick Due Clip decides whether a slot is due.',
    },
    {
      parameters: { jsCode: code('pick-due-clip.jsCode.js') },
      name: 'Pick Due Clip',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [220, 300],
    },
    {
      parameters: {
        method: 'POST',
        url: SIDECAR_UPLOAD_URL,
        sendBody: true,
        contentType: 'multipart-form-data',
        // Contract v1: exactly these field names (workflow-contract.selfcheck.js).
        bodyParameters: {
          parameters: [
            formField('clip_path', '={{ $json.clip_path }}'),
            formField('caption', '={{ $json.caption }}'),
            formField('hashtags', '={{ $json.hashtags }}'),
            formField('account', 'reelsmith'),
            formField('source', 'n8n'),
            // Always explicit; anything but a literal false is a dry run.
            formField('dry_run', "={{ $json.dryRun === false ? 'false' : 'true' }}"),
          ],
        },
        options: {
          timeout: '={{ $json.timeoutMs }}',
          response: { response: { fullResponse: true, neverError: true } },
        },
      },
      name: 'TikTok Sidecar Upload',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [440, 300],
      notesInFlow: true,
      notes: 'tiktok-sidecar Contract v1. No retries here: the next 15-min run retries, and the sidecar ledger refuses duplicates.',
      continueOnFail: true,
      retryOnFail: false,
    },
    {
      parameters: { jsCode: code('log-results.jsCode.js') },
      name: 'Log Results',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [660, 300],
    },
    {
      parameters: { jsCode: code('archive-manifest.jsCode.js') },
      name: 'Archive Manifest',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [880, 300],
    },
  ];

  const chain = ['Schedule', 'Pick Due Clip', 'TikTok Sidecar Upload', 'Log Results', 'Archive Manifest'];
  const connections = {};
  for (let i = 0; i < chain.length - 1; i++) {
    connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
  }

  return {
    name: 'Reelsmith Social Publish',
    active: false,
    settings: {
      executionOrder: 'v1',
      timezone: 'Africa/Johannesburg',
      executionTimeout: 900,
      saveDataSuccessExecution: 'all',
      saveDataErrorExecution: 'all',
      saveManualExecutions: true,
      saveExecutionProgress: false,
    },
    nodes,
    connections,
    tags: [{ name: 'reelsmith' }, { name: 'social-publish' }],
  };
}

const render = () => JSON.stringify(buildWorkflow(), null, 2) + '\n';

module.exports = { buildWorkflow, render, WORKFLOW_FILE, SIDECAR_UPLOAD_URL };

if (require.main === module) {
  fs.writeFileSync(WORKFLOW_FILE, render());
  console.log('wrote ' + path.relative(process.cwd(), WORKFLOW_FILE));
}
