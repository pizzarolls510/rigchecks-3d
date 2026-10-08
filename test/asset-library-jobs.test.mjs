import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetApiError, apiPost, describeApiError } from '../dist/lib/asset-library-api.js';
import {
  buildIngestRequest,
  buildPromoteConfirmRequest,
  buildPromoteDryRunRequest,
  checkIngestForm,
  checkUploadFile,
  describeJobError,
  isTerminalJob,
  jobStatusText,
  pollJob,
  roleFromClaims,
  summarizeDryRun,
  summarizeIngest,
  summarizeValidation
} from '../dist/lib/asset-library-jobs.js';

// Same shape as the API's `vocabulary` field (synthetic values).
const vocabulary = {
  assetIdPattern: '^[a-z][a-z0-9_]{0,63}$',
  revisionIdPattern: '^[a-z0-9][a-z0-9_-]{0,95}$',
  categories: ['enemies', 'operators', 'ui'],
  roles: ['reference', 'runtime', 'source', 'textures'],
  supportedExtensions: ['.glb', '.jpg', '.png'],
  maxUploadBytes: 200 * 1024 * 1024,
  textLimits: { display_name: 120, note: 2000, source: 500, creator: 120 }
};
const SHA = 'a'.repeat(40);

test('the role comes only from the assetLibraryRole claim', () => {
  assert.equal(roleFromClaims({ assetLibraryRole: 'writer' }), 'writer');
  assert.equal(roleFromClaims({ assetLibraryRole: 'reader' }), 'reader');
  assert.equal(roleFromClaims({ assetLibraryRole: 'admin' }), null);
  assert.equal(roleFromClaims(null), null);
});

test('upload files are pre-checked against the pipeline vocabulary', () => {
  assert.equal(checkUploadFile({ name: 'Walk Cycle_v2.GLB', size: 10 }, vocabulary), null);
  assert.match(checkUploadFile(null, vocabulary), /Choose a file/);
  assert.match(checkUploadFile({ name: 'model.fbx', size: 10 }, vocabulary), /does not accept \.fbx/);
  assert.match(checkUploadFile({ name: 'model (1).glb', size: 10 }, vocabulary), /Rename the file/);
  assert.match(checkUploadFile({ name: 'model.glb', size: 0 }, vocabulary), /empty/);
  assert.match(checkUploadFile({ name: 'model.glb', size: 200 * 1024 * 1024 + 1 }, vocabulary), /200 MB/);
  assert.equal(checkUploadFile({ name: 'model.glb', size: 1 }, null), describeApiError('vocabulary_unavailable'));
});

test('the upload form is pre-checked field by field, counting characters as the runner does', () => {
  assert.deepEqual(checkIngestForm({ assetId: 'sample_asset', category: 'ui', role: 'runtime', displayName: '🙂'.repeat(120) }, vocabulary), {});
  assert.deepEqual(Object.keys(checkIngestForm({
    assetId: 'Sample', revisionId: 'Bad Rev', category: 'vehicles', role: 'preview', displayName: '🙂'.repeat(121), note: 'x'.repeat(2001), source: 'a\u0001b'
  }, vocabulary)).sort(), ['assetId', 'category', 'displayName', 'note', 'revisionId', 'role', 'source']);
  assert.deepEqual(checkIngestForm({ assetId: 'a', note: 'line one\r\nline two' }, vocabulary), {}, 'Windows line endings are normalised, not rejected');
});

test('requests carry only filled-in fields, trimmed, plus the reviewed base commit', () => {
  assert.deepEqual(buildIngestRequest({ assetId: ' sample_asset ', revisionId: '', category: 'ui', role: '', displayName: ' Name ', note: ' a\r\nb ', source: '', creator: 'Me' }, { jobId: 'job-1-abcdef', baseSha: SHA }), {
    jobId: 'job-1-abcdef', baseSha: SHA, assetId: 'sample_asset', category: 'ui', displayName: 'Name', note: 'a\nb', creator: 'Me'
  });
  assert.deepEqual(buildPromoteDryRunRequest({ baseSha: SHA, assetId: 'a', revisionId: 'r', displayName: '', category: 'ui', destination: ' assets/ui/a ' }), {
    dryRun: true, baseSha: SHA, assetId: 'a', revisionId: 'r', category: 'ui', destination: 'assets/ui/a'
  });
  assert.deepEqual(buildPromoteConfirmRequest({ jobId: 'job-2-abcdef' }, undefined), { dryRun: false, dryRunJobId: 'job-2-abcdef', acceptWarnings: false });
});

test('job states and errors read clearly; the runner message is preferred except for stale bases', () => {
  assert.equal(isTerminalJob({ status: 'done' }), true);
  assert.equal(isTerminalJob({ status: 'running' }), false);
  assert.equal(jobStatusText({ operation: 'promote_dry_run', status: 'queued' }), 'Promotion dry run: queued on GitHub Actions');
  assert.equal(describeJobError({ error: { code: 'pipeline_rejected', message: 'Revision already exists: a/r' } }), 'Revision already exists: a/r');
  assert.equal(describeJobError({ error: { code: 'stale_base', message: 'runner text' } }), describeApiError('stale_base'));
  assert.equal(describeJobError({ error: { code: 'run_cancelled' } }), 'The job run was cancelled.');
  assert.match(jobStatusText({ operation: 'ingest', status: 'error', error: { code: 'push_failed' } }), /^Upload candidate: failed — The job could not push/);
});

test('the dry-run summary renders the tool payload and requires acceptance for any or unreadable warnings', () => {
  const job = {
    jobId: 'job-3-abcdef',
    baseSha: SHA,
    params: { asset_id: 'sample_asset', revision_id: 'r_1' },
    result: { pipeline: { ok: true, result: {
      asset_id: 'sample_asset', revision_id: 'r_1', previous_canonical: 'r_0', warnings: [{ code: 'LOW_POLY', message: 'Few triangles' }],
      files: [{ candidate_path: 'assets/_workbench/x/r_1/runtime/a.glb', path: 'assets/operators/sample_asset/runtime/a.glb', role: 'runtime', size_bytes: 12 }],
      lfs_rules_to_add: [], integration_required: 'Review Godot references.'
    } } }
  };
  const summary = summarizeDryRun(job);
  assert.equal(summary.previousCanonical, 'r_0');
  assert.deepEqual(summary.files, [{ from: 'assets/_workbench/x/r_1/runtime/a.glb', to: 'assets/operators/sample_asset/runtime/a.glb', role: 'runtime', sizeBytes: 12 }]);
  assert.deepEqual(summary.warnings, ['LOW_POLY — Few triangles']);
  assert.equal(summary.requiresAcceptance, true);
  assert.equal(summary.integrationRequired, 'Review Godot references.');

  const clean = structuredClone(job);
  clean.result.pipeline.result.warnings = [];
  assert.equal(summarizeDryRun(clean).requiresAcceptance, false);
  assert.equal(summarizeDryRun({ ...clean, resultTruncated: true }).requiresAcceptance, true);
  assert.equal(summarizeDryRun({ result: { ok: true } }).requiresAcceptance, true);
});

test('ingest and validation summaries tolerate missing fields', () => {
  assert.deepEqual(summarizeIngest({ params: { asset_id: 'a' }, result: { pipeline: { ok: true, result: { revision_id: 'r_x', files: [{ path: 'p', role: 'runtime', size_bytes: 3 }], warnings: ['w'] } } } }), {
    available: true, assetId: 'a', revisionId: 'r_x', files: [{ path: 'p', role: 'runtime', sizeBytes: 3 }], warnings: ['w']
  });
  assert.equal(summarizeIngest({}).available, false);
  const validation = summarizeValidation({ result: { pipeline: { ok: true, result: { findings: [{ severity: 'warning', code: 'ASSET_ISSUE' }, { severity: 'error', code: 'X' }, { code: 'Y' }], fresh_inspections: [1, 2] } } } });
  assert.deepEqual(validation.counts, { error: 1, warning: 1, info: 1 });
  assert.equal(validation.freshInspections, 2);
});

test('pollJob stops at a terminal state, reports each update and gives up after the timeout', async () => {
  const states = ['queued', 'running', 'done'];
  const seen = [];
  const job = await pollJob({ getJob: async () => ({ status: states.shift() }), onUpdate: (update) => seen.push(update.status), sleep: async () => {} });
  assert.equal(job.status, 'done');
  assert.deepEqual(seen, ['queued', 'running', 'done']);

  let clock = 0;
  const stuck = await pollJob({ getJob: async () => ({ status: 'queued' }), sleep: async (ms) => { clock += ms; }, now: () => clock, intervalMs: 1000, timeoutMs: 3000 });
  assert.equal(stuck.status, 'queued');
});

test('apiPost sends JSON with the token and surfaces details, validation messages and Retry-After', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/jobs/validate')) {
      return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x', details: { retryAfterSeconds: 60 } } }), { status: 429, headers: { 'Retry-After': '60' } });
    }
    if (url.endsWith('/api/uploads')) return new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'size must be between 1 and 209715200 bytes.' } }), { status: 400 });
    return new Response(JSON.stringify({ job: { jobId: 'j' } }), { status: 202 });
  };
  const getIdToken = async () => 'tok';
  assert.deepEqual(await apiPost({ base: 'https://api.example', path: '/api/jobs/promote', body: { dryRun: true }, getIdToken, fetchImpl }), { job: { jobId: 'j' } });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"dryRun":true}');
  await assert.rejects(apiPost({ base: 'https://api.example', path: '/api/jobs/validate', getIdToken, fetchImpl }),
    (error) => error instanceof AssetApiError && error.code === 'rate_limited' && error.retryAfterSeconds === 60 && error.details.retryAfterSeconds === 60);
  await assert.rejects(apiPost({ base: 'https://api.example', path: '/api/uploads', body: {}, getIdToken, fetchImpl }),
    (error) => error.code === 'invalid_request' && error.message === 'size must be between 1 and 209715200 bytes.');
});
