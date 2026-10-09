import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { UpstreamError } from '../src/errors.js';
import { ALLOWED, REQUIRED } from '../src/runner-contract.js';
import {
  HEAD_A,
  HEAD_B,
  PIPELINE_COMMON,
  createFakeDb,
  createFakeGitHub,
  createFakeStore,
  fakeVerifyIdToken,
  listen
} from './support/fakes.mjs';

const MANIFEST_PATH = 'docs/ASSET_MANIFEST.yaml';
const COMMON_PATH = 'tools/asset_pipeline/common.py';
const START = 1_800_000_000_000;
const MINUTE = 60 * 1000;

function repo(common = PIPELINE_COMMON) {
  return {
    [MANIFEST_PATH]: Buffer.from(JSON.stringify({ schema_version: 1, assets: [] })),
    [COMMON_PATH]: Buffer.from(common)
  };
}

function harness({ returnRunDetails = true, common, config = {} } = {}) {
  const github = createFakeGitHub({ head: HEAD_A, commits: { [HEAD_A]: repo(common), [HEAD_B]: repo(common) }, returnRunDetails });
  const store = createFakeStore();
  const db = createFakeDb();
  const time = { now: START };
  let counter = 0;
  const errors = [];
  const app = createApp({
    verifyIdToken: fakeVerifyIdToken,
    github,
    store,
    db,
    config: { ...DEFAULT_CONFIG, ...config },
    now: () => time.now,
    makeJobId: () => `job-${String(++counter).padStart(4, '0')}-test`,
    logger: { error: (...args) => errors.push(args) }
  });
  return { github, store, db, time, app, errors };
}

async function withServer(app, run) {
  const server = await listen(app);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

const post = (server, path, json, token = 'writer') => server.request(path, { method: 'POST', token, json });
const md5 = (bytes) => createHash('md5').update(bytes).digest('base64');

async function reserveAndStage(server, store, { fileName = 'model.glb', bytes = Buffer.from('glTF-bytes'), token = 'writer' } = {}) {
  const reservation = await post(server, '/api/uploads', { fileName, size: bytes.length, contentType: 'model/gltf-binary' }, token);
  assert.equal(reservation.status, 201, reservation.text);
  store.objects.set(reservation.body.stagingPath, { bytes, options: { contentType: 'model/gltf-binary' } });
  return { ...reservation.body, bytes };
}

function completeRun(github, time, runId, result, conclusion = result?.ok ? 'success' : 'failure') {
  const run = github.runs.get(runId);
  Object.assign(run, { status: 'completed', conclusion, updatedAt: new Date(time.now).toISOString(), result });
}

function runnerResult(job, fields = {}) {
  return { schema: 1, job_id: job.jobId, operation: job.operation, ok: true, ...fields };
}

async function poll(server, time, jobId, token = 'reader') {
  time.now += DEFAULT_CONFIG.jobPollMinIntervalMs;
  const response = await server.request(`/api/jobs/${jobId}`, { token });
  assert.equal(response.status, 200, response.text);
  return response.body.job;
}

// Every dispatch must satisfy the Phase 3 runner contract exactly (run_job.py ALLOWED/REQUIRED).
function assertRunnerContract(github) {
  for (const { inputs, ref, workflow } of github.dispatches) {
    assert.equal(workflow, 'asset-library-job.yml');
    assert.equal(ref, 'main');
    const provided = Object.keys(inputs).filter((key) => key !== 'job_id' && key !== 'operation');
    assert.deepEqual(provided.filter((key) => !ALLOWED[inputs.operation].includes(key)), [], `unexpected inputs for ${inputs.operation}`);
    assert.deepEqual(REQUIRED[inputs.operation].filter((key) => !provided.includes(key)), [], `missing inputs for ${inputs.operation}`);
    for (const value of Object.values(inputs)) assert.equal(typeof value, 'string');
    for (const name of ['accept_warnings', 'recheck', 'strict']) assert.ok(!(name in inputs) || inputs[name] === 'true', `${name} is sent only as 'true'`);
    assert.match(inputs.job_id, /^[A-Za-z0-9_-]{8,64}$/);
  }
}

test('unauthenticated callers, callers without a role and readers can never reach write routes', async () => {
  const { app, github, db } = harness();
  await withServer(app, async (server) => {
    const routes = [
      ['/api/uploads', { fileName: 'a.glb', size: 1 }],
      ['/api/jobs/ingest', { jobId: 'job-0001-test', baseSha: HEAD_A, assetId: 'a' }],
      ['/api/jobs/promote', { dryRun: true, baseSha: HEAD_A, assetId: 'a', revisionId: 'r' }],
      ['/api/jobs/validate', {}]
    ];
    for (const [path, json] of routes) {
      assert.equal((await post(server, path, json, null)).status, 401, path);
      assert.equal((await post(server, path, json, 'noclaim')).body.error.code, 'not_authorized', path);
      const reader = await post(server, path, json, 'reader');
      assert.equal(reader.status, 403, path);
      assert.equal(reader.body.error.code, 'writer_required', path);
    }
    assert.equal((await server.request('/api/jobs/job-0001-test')).status, 401);
  });
  assert.equal(github.dispatches.length, 0);
  assert.equal(db.docs.size, 0, 'nothing was reserved, counted or locked');
});

test('upload reservation validates the file name against the pipeline vocabulary and the size ceiling', async () => {
  const { app, db, github } = harness();
  await withServer(app, async (server) => {
    for (const json of [
      { fileName: 'virus.exe', size: 10 },
      { fileName: 'model', size: 10 },
      { fileName: '../model.glb', size: 10 },
      { fileName: 'dir/model.glb', size: 10 },
      { fileName: '.glb', size: 10 },
      { fileName: 'model.glb', size: 0 },
      { fileName: 'model.glb', size: 200 * 1024 * 1024 + 1 },
      { fileName: 'model.glb', size: 1.5 },
      { fileName: 'model.glb', size: '10' },
      { fileName: 'model.glb', size: 10, contentType: 'not a type' },
      { fileName: 'model.glb', size: 10, extra: true },
      [],
      'model.glb'
    ]) {
      const response = await post(server, '/api/uploads', json);
      assert.equal(response.status, 400, JSON.stringify(json));
      assert.equal(response.body.error.code, 'invalid_request');
    }
    assert.equal(db.docs.size, 0, 'rejected reservations create nothing and use no quota');

    const ok = await post(server, '/api/uploads', { fileName: 'Walk Cycle_v2.GLB', size: 200 * 1024 * 1024, contentType: 'model/gltf-binary' });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.jobId, 'job-0001-test');
    assert.equal(ok.body.stagingPath, 'asset-library-staging/writer-uid/job-0001-test/Walk Cycle_v2.GLB');
    assert.equal(ok.body.maxBytes, 200 * 1024 * 1024);
    assert.equal(ok.body.expiresAt, new Date(START + 2 * 24 * 60 * MINUTE).toISOString());
    const job = db.docs.get('assetLibraryJobs/job-0001-test');
    assert.equal(job.status, 'awaiting_upload');
    assert.equal(job.uid, 'writer-uid');
    assert.equal(db.docs.get('assetLibraryRate/writer-uid').upload.count, 1);
  });
  assert.equal(github.dispatches.length, 0);
});

test('ingest dispatches the runner with a signed staged URL, the recorded size and the Cloud Storage MD5', async () => {
  const { app, github, store, db, time } = harness();
  await withServer(app, async (server) => {
    const upload = await reserveAndStage(server, store);
    const response = await post(server, '/api/jobs/ingest', {
      jobId: upload.jobId,
      baseSha: HEAD_A,
      assetId: 'sample_asset',
      category: 'operators',
      role: 'runtime',
      displayName: 'Sample Asset',
      note: 'First pass.\nTabs\tare fine.',
      source: 'Synthetic test',
      creator: 'Test'
    });
    assert.equal(response.status, 202, response.text);
    assert.equal(response.body.job.status, 'queued');
    assert.equal(response.body.job.runId, 9000);
    assert.equal(response.body.job.runUrl, 'https://github.com/example/runs/9000');

    assert.equal(github.dispatches.length, 1);
    const { inputs } = github.dispatches[0];
    const { staged_url: stagedUrl, ...rest } = inputs;
    assert.deepEqual(rest, {
      job_id: upload.jobId,
      operation: 'ingest',
      base_sha: HEAD_A,
      asset_id: 'sample_asset',
      category: 'operators',
      role: 'runtime',
      display_name: 'Sample Asset',
      note: 'First pass.\nTabs\tare fine.',
      source: 'Synthetic test',
      creator: 'Test',
      file_name: 'model.glb',
      expected_size: String(upload.bytes.length),
      expected_md5: md5(upload.bytes)
    });
    assert.ok(stagedUrl.startsWith('https://storage.googleapis.com/'), 'the runner only accepts Cloud Storage URLs');
    const signing = store.calls.find(([name]) => name === 'signedStagedReadUrl');
    assert.deepEqual(signing, ['signedStagedReadUrl', upload.stagingPath, { expiresAt: time.now + 30 * MINUTE }]);

    // The signed URL is never stored in Firestore (which readers can see) and never returned to the browser.
    assert.doesNotMatch(JSON.stringify([...db.docs.values()]), /X-Goog-Signature/);
    assert.doesNotMatch(response.text, /X-Goog-Signature/);
    assert.equal(db.docs.get('assetLibraryLocks/mutation').jobId, upload.jobId);
    assert.equal(db.docs.get('assetLibraryLocks/mutation').expiresAt, time.now + 20 * MINUTE);
    assert.equal(db.docs.get('assetLibraryRate/writer-uid').dispatch.count, 1);

    const again = await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'sample_asset' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'job_already_started');
  });
  assertRunnerContract(github);
});

test('bad enum values, malformed IDs, over-long text and missing fields are rejected before dispatch', async () => {
  const { app, github, store, db } = harness();
  await withServer(app, async (server) => {
    const upload = await reserveAndStage(server, store);
    const base = { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'sample_asset' };
    for (const [label, json] of [
      ['unknown category', { ...base, category: 'vehicles' }],
      ['unknown role', { ...base, role: 'preview' }],
      ['asset id', { ...base, assetId: 'Sample-Asset' }],
      ['revision id', { ...base, revisionId: '../rev' }],
      ['carriage return', { ...base, note: 'line\r\nline' }],
      ['display name length', { ...base, displayName: '🙂'.repeat(121) }],
      ['note length', { ...base, note: 'x'.repeat(2001) }],
      ['unknown field', { ...base, destination: 'assets/x' }],
      ['missing base', { jobId: upload.jobId, assetId: 'sample_asset' }],
      ['short base', { ...base, baseSha: 'abc123' }],
      ['missing asset', { jobId: upload.jobId, baseSha: HEAD_A }],
      ['bad job id', { ...base, jobId: 'short' }]
    ]) {
      const response = await post(server, '/api/jobs/ingest', json);
      assert.equal(response.status, 400, label);
      assert.equal(response.body.error.code, 'invalid_request', label);
    }
    // Code points, not UTF-16 units, as Python counts them: 120 emoji are allowed.
    const emoji = await post(server, '/api/jobs/ingest', { ...base, displayName: '🙂'.repeat(120) });
    assert.equal(emoji.status, 202, emoji.text);
    assert.equal(db.docs.get(`assetLibraryJobs/${upload.jobId}`).status, 'queued');
  });
  assert.equal(github.dispatches.length, 1, 'only the valid request was dispatched');
  assertRunnerContract(github);
});

test('ingest refuses missing, mismatched, foreign, expired and stale-base uploads; a stale base can be retried', async () => {
  const { app, github, store, time } = harness();
  await withServer(app, async (server) => {
    const missing = await post(server, '/api/uploads', { fileName: 'a.png', size: 4 });
    let response = await post(server, '/api/jobs/ingest', { jobId: missing.body.jobId, baseSha: HEAD_A, assetId: 'a' });
    assert.equal(response.body.error.code, 'upload_missing');

    const mismatched = await post(server, '/api/uploads', { fileName: 'b.png', size: 4 });
    store.objects.set(mismatched.body.stagingPath, { bytes: Buffer.from('12345') });
    response = await post(server, '/api/jobs/ingest', { jobId: mismatched.body.jobId, baseSha: HEAD_A, assetId: 'a' });
    assert.equal(response.body.error.code, 'upload_mismatch');

    const composite = await post(server, '/api/uploads', { fileName: 'c.png', size: 4 });
    store.objects.set(composite.body.stagingPath, { bytes: Buffer.from('1234'), md5Hash: null });
    response = await post(server, '/api/jobs/ingest', { jobId: composite.body.jobId, baseSha: HEAD_A, assetId: 'a' });
    assert.equal(response.body.error.code, 'upload_mismatch', 'an object without an MD5 cannot be verified by the runner');

    const foreign = await reserveAndStage(server, store, { token: 'writer2' });
    response = await post(server, '/api/jobs/ingest', { jobId: foreign.jobId, baseSha: HEAD_A, assetId: 'a' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'job_not_found');

    const stale = await reserveAndStage(server, store);
    github.state.head = HEAD_B;
    response = await post(server, '/api/jobs/ingest', { jobId: stale.jobId, baseSha: HEAD_A, assetId: 'a' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'stale_base');
    assert.deepEqual(response.body.error.details, { expected: HEAD_A, actual: HEAD_B });
    response = await post(server, '/api/jobs/ingest', { jobId: stale.jobId, baseSha: HEAD_B, assetId: 'a' });
    assert.equal(response.status, 202, 'the same upload is reused after refreshing');

    const expired = await reserveAndStage(server, store);
    time.now += 2 * 24 * 60 * MINUTE + 1;
    response = await post(server, '/api/jobs/ingest', { jobId: expired.jobId, baseSha: HEAD_B, assetId: 'a' });
    assert.equal(response.status, 410);
    assert.equal(response.body.error.code, 'upload_expired');
  });
  assert.equal(github.dispatches.length, 1);
  assert.equal(github.dispatches[0].inputs.base_sha, HEAD_B);
});

test('a promote dry run dispatches promote_dry_run without taking the mutation lock', async () => {
  const { app, github, db } = harness();
  await withServer(app, async (server) => {
    for (const destination of ['assets', 'assets/', 'assets/../x', 'assets//x', 'textures/x', ' assets/x', 'assets\\x', `assets/${'x'.repeat(300)}`]) {
      const response = await post(server, '/api/jobs/promote', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1', destination });
      assert.equal(response.status, 400, destination);
    }
    for (const json of [
      { dryRun: true, baseSha: HEAD_A, assetId: 'sample_asset' },
      { dryRun: true, baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1', acceptWarnings: true },
      { dryRun: 'yes', baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1' },
      { baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1' }
    ]) {
      assert.equal((await post(server, '/api/jobs/promote', json)).status, 400, JSON.stringify(json));
    }
    const response = await post(server, '/api/jobs/promote', {
      dryRun: true, baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1', category: 'operators', displayName: 'Sample', destination: 'assets/operators/sample_asset'
    });
    assert.equal(response.status, 202, response.text);
    assert.equal(response.body.job.operation, 'promote_dry_run');
    assert.equal(response.body.job.mutation, false);
    assert.equal(db.docs.has('assetLibraryLocks/mutation'), false);
  });
  assert.deepEqual(github.dispatches.map(({ inputs }) => inputs), [{
    job_id: 'job-0001-test',
    operation: 'promote_dry_run',
    base_sha: HEAD_A,
    asset_id: 'sample_asset',
    revision_id: 'r_1',
    category: 'operators',
    display_name: 'Sample',
    destination: 'assets/operators/sample_asset'
  }]);
  assertRunnerContract(github);
});

async function finishedDryRun(server, github, time, { warnings = [], token = 'writer', ok = true } = {}) {
  const started = await post(server, '/api/jobs/promote', {
    dryRun: true, baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1', destination: 'assets/operators/sample_asset'
  }, token);
  assert.equal(started.status, 202, started.text);
  const job = started.body.job;
  completeRun(github, time, job.runId, runnerResult(job, ok
    ? { pipeline: { ok: true, result: { asset_id: 'sample_asset', revision_id: 'r_1', previous_canonical: 'r_0', warnings, files: [], dry_run: true } } }
    : { ok: false, error: { code: 'pipeline_rejected', message: 'Promotion requires an existing candidate revision' } }));
  const done = await poll(server, time, job.jobId);
  assert.equal(done.status, ok ? 'done' : 'error');
  return done;
}

test('confirm is refused without a successful dry run by the same user, and without accepting reported warnings', async () => {
  const { app, github, time } = harness();
  await withServer(app, async (server) => {
    let response = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: 'job-9999-none' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'dry_run_required');

    const running = (await post(server, '/api/jobs/promote', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1' })).body.job;
    response = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: running.jobId });
    assert.equal(response.body.error.code, 'dry_run_required', 'an unfinished dry run cannot be confirmed');

    const failed = await finishedDryRun(server, github, time, { ok: false });
    response = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: failed.jobId });
    assert.equal(response.body.error.code, 'dry_run_required', 'a failed dry run cannot be confirmed');

    const others = await finishedDryRun(server, github, time, { token: 'writer2' });
    response = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: others.jobId });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'dry_run_not_owned');

    const warned = await finishedDryRun(server, github, time, { warnings: [{ severity: 'warning', code: 'LOW_POLY', message: 'x' }] });
    response = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: warned.jobId });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'warnings_not_accepted');
    assert.equal(response.body.error.details.warningCount, 1);
    response = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: warned.jobId, acceptWarnings: false });
    assert.equal(response.body.error.code, 'warnings_not_accepted');

    const notValidation = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: (await post(server, '/api/jobs/validate', {})).body.job.jobId });
    assert.equal(notValidation.body.error.code, 'dry_run_required', 'only promote dry runs can be confirmed');
  });
  assert.equal(github.dispatches.filter(({ inputs }) => inputs.operation === 'promote_confirm').length, 0);
});

test('confirm inherits every parameter and the base commit from its dry run, and can only be used once', async () => {
  const { app, github, time, db } = harness();
  await withServer(app, async (server) => {
    const warned = await finishedDryRun(server, github, time, { warnings: [{ severity: 'warning', code: 'W', message: 'w' }] });
    github.state.head = HEAD_B; // The runner's stale-base check owns this case; confirm still carries the reviewed base.

    const tampered = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: warned.jobId, acceptWarnings: true, revisionId: 'r_other' });
    assert.equal(tampered.status, 400, 'a confirm cannot override dry-run parameters');

    const response = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: warned.jobId, acceptWarnings: true });
    assert.equal(response.status, 202, response.text);
    const confirm = response.body.job;
    assert.equal(confirm.operation, 'promote_confirm');
    assert.equal(confirm.dryRunJobId, warned.jobId);
    assert.equal(confirm.baseSha, HEAD_A);
    assert.deepEqual(github.dispatches.at(-1).inputs, {
      job_id: confirm.jobId,
      operation: 'promote_confirm',
      base_sha: HEAD_A,
      asset_id: 'sample_asset',
      revision_id: 'r_1',
      destination: 'assets/operators/sample_asset',
      accept_warnings: 'true'
    });
    assert.equal(db.docs.get(`assetLibraryJobs/${warned.jobId}`).confirmJobId, confirm.jobId);

    const twice = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: warned.jobId, acceptWarnings: true });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'dry_run_already_confirmed');
  });
  assertRunnerContract(github);
});

test('a dry run without warnings confirms without accept_warnings; an unreadable warning list requires acceptance', async () => {
  const { app, github, time, db } = harness();
  await withServer(app, async (server) => {
    const clean = await finishedDryRun(server, github, time);
    const response = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: clean.jobId });
    assert.equal(response.status, 202, response.text);
    assert.equal('accept_warnings' in github.dispatches.at(-1).inputs, false);
    completeRun(github, time, response.body.job.runId, runnerResult(response.body.job, { commitSha: 'c'.repeat(40), pushed: true }));
    await poll(server, time, response.body.job.jobId);

    const truncated = await finishedDryRun(server, github, time);
    const doc = db.docs.get(`assetLibraryJobs/${truncated.jobId}`);
    db.docs.set(`assetLibraryJobs/${truncated.jobId}`, { ...doc, resultTruncated: true, resultJson: '{"ok":true}' });
    const refused = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: truncated.jobId });
    assert.equal(refused.body.error.code, 'warnings_not_accepted');
  });
});

test('a second mutation while the lock is held returns 409; the lock frees on completion or after 20 minutes', async () => {
  const { app, github, store, time, db } = harness();
  await withServer(app, async (server) => {
    const dryRun = await finishedDryRun(server, github, time);
    const first = await reserveAndStage(server, store);
    const ingest = await post(server, '/api/jobs/ingest', { jobId: first.jobId, baseSha: HEAD_A, assetId: 'sample_asset' });
    assert.equal(ingest.status, 202);

    const blockedConfirm = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: dryRun.jobId });
    assert.equal(blockedConfirm.status, 409);
    assert.equal(blockedConfirm.body.error.code, 'mutation_in_progress');
    assert.equal(db.docs.get(`assetLibraryJobs/${dryRun.jobId}`).confirmJobId, undefined, 'a refused confirm leaves the dry run usable');

    const second = await reserveAndStage(server, store, { token: 'writer2' });
    const blockedIngest = await post(server, '/api/jobs/ingest', { jobId: second.jobId, baseSha: HEAD_A, assetId: 'other_asset' }, 'writer2');
    assert.equal(blockedIngest.body.error.code, 'mutation_in_progress');
    assert.equal(db.docs.get(`assetLibraryJobs/${second.jobId}`).status, 'awaiting_upload', 'the upload can be retried later');
    assert.equal(db.docs.get('assetLibraryRate/writer2-uid').dispatch, undefined, 'a refused mutation uses no dispatch quota');

    // Read-only jobs never wait for the lock.
    assert.equal((await post(server, '/api/jobs/validate', { assetId: 'sample_asset' })).status, 202);
    assert.equal((await post(server, '/api/jobs/promote', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1' })).status, 202);

    completeRun(github, time, ingest.body.job.runId, runnerResult(ingest.body.job, { commitSha: 'c'.repeat(40), pushed: true }));
    const done = await poll(server, time, first.jobId, 'writer');
    assert.equal(done.status, 'done');
    assert.equal(db.docs.has('assetLibraryLocks/mutation'), false, 'a terminal job releases its lock');

    const retry = await post(server, '/api/jobs/ingest', { jobId: second.jobId, baseSha: HEAD_A, assetId: 'other_asset' }, 'writer2');
    assert.equal(retry.status, 202, retry.text);

    time.now += 20 * MINUTE + 1;
    const afterExpiry = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: dryRun.jobId });
    assert.equal(afterExpiry.status, 202, 'a lost run cannot hold the lock beyond 20 minutes');
    assert.equal(db.docs.get('assetLibraryLocks/mutation').jobId, afterExpiry.body.job.jobId);
  });
  assertRunnerContract(github);
});

test('rate limits allow 20 dispatches and 20 upload reservations per user per hour, then return 429', async () => {
  const { app, github, time } = harness();
  await withServer(app, async (server) => {
    for (let i = 0; i < 20; i += 1) assert.equal((await post(server, '/api/jobs/validate', {})).status, 202);
    const limited = await post(server, '/api/jobs/validate', {});
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.equal(limited.headers.get('retry-after'), '3600');
    assert.equal((await post(server, '/api/jobs/promote', { dryRun: true, baseSha: HEAD_A, assetId: 'a', revisionId: 'r' })).status, 429, 'dispatches share one budget');
    assert.equal((await post(server, '/api/jobs/validate', {}, 'writer2')).status, 202, 'limits are per user');

    for (let i = 0; i < 20; i += 1) assert.equal((await post(server, '/api/uploads', { fileName: `f${i}.png`, size: 1 })).status, 201);
    assert.equal((await post(server, '/api/uploads', { fileName: 'f.png', size: 1 })).status, 429);

    time.now += 30 * MINUTE;
    assert.equal((await post(server, '/api/jobs/validate', {})).headers.get('retry-after'), '1800');
    time.now += 30 * MINUTE;
    assert.equal((await post(server, '/api/jobs/validate', {})).status, 202, 'a new window starts after an hour');
    assert.equal((await post(server, '/api/uploads', { fileName: 'g.png', size: 1 })).status, 201);
  });
  assert.equal(github.dispatches.length, 22);
});

test('run status and the result artifact map to queued, running, done and error; final results are cached', async () => {
  const { app, github, time } = harness();
  await withServer(app, async (server) => {
    const job = (await post(server, '/api/jobs/validate', { assetId: 'sample_asset', recheck: true })).body.job;
    assert.equal((await poll(server, time, job.jobId)).status, 'queued');
    github.runs.get(job.runId).status = 'in_progress';
    assert.equal((await poll(server, time, job.jobId)).status, 'running');

    const throttled = github.calls.filter(([name]) => name === 'getRun').length;
    await server.request(`/api/jobs/${job.jobId}`, { token: 'reader' });
    assert.equal(github.calls.filter(([name]) => name === 'getRun').length, throttled, 'GitHub is consulted at most every few seconds per job');

    const pipeline = { ok: true, result: { asset_id: 'sample_asset', findings: [{ severity: 'warning', code: 'ASSET_ISSUE' }], fresh_inspections: [] } };
    completeRun(github, time, job.runId, runnerResult(job, { pipeline, exit_code: 0, checked_out_sha: HEAD_A }));
    const done = await poll(server, time, job.jobId);
    assert.equal(done.status, 'done');
    assert.equal(done.ok, true);
    assert.deepEqual(done.result.pipeline, pipeline);
    assert.equal(done.error, null);

    const callsAfterDone = github.calls.length;
    const cached = await poll(server, time, job.jobId, 'writer');
    assert.deepEqual(cached, done);
    assert.equal(github.calls.length, callsAfterDone, 'later polls are served from Firestore');
  });
});

test('runner failures keep their error code and result; cancelled, missing, foreign and corrupt results become errors', async () => {
  const { app, github, store, time, db } = harness();
  await withServer(app, async (server) => {
    const upload = await reserveAndStage(server, store);
    const ingest = (await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'sample_asset' })).body.job;
    completeRun(github, time, ingest.runId, runnerResult(ingest, {
      ok: false,
      error: { code: 'stale_base', message: 'The branch changed since the manifest was reviewed; refresh and review again.', details: { expected: HEAD_A, actual: HEAD_B } }
    }));
    const stale = await poll(server, time, ingest.jobId);
    assert.equal(stale.status, 'error');
    assert.deepEqual(stale.error, { code: 'stale_base', message: 'The branch changed since the manifest was reviewed; refresh and review again.' });
    assert.deepEqual(stale.result.error.details, { expected: HEAD_A, actual: HEAD_B });
    assert.equal(stale.pushed, false);
    assert.equal(db.docs.has('assetLibraryLocks/mutation'), false, 'a failed mutation releases the lock');

    const cancelled = (await post(server, '/api/jobs/validate', {})).body.job;
    completeRun(github, time, cancelled.runId, null, 'cancelled');
    assert.equal((await poll(server, time, cancelled.jobId)).status, 'running', 'artifacts may lag completion briefly');
    time.now += DEFAULT_CONFIG.artifactGraceMs;
    const gone = await poll(server, time, cancelled.jobId);
    assert.equal(gone.status, 'error');
    assert.equal(gone.error.code, 'run_cancelled');

    const foreign = (await post(server, '/api/jobs/validate', {})).body.job;
    completeRun(github, time, foreign.runId, { schema: 1, job_id: 'job-other-test', operation: 'validate', ok: true });
    assert.equal((await poll(server, time, foreign.jobId)).error.code, 'result_mismatch');

    const corrupt = (await post(server, '/api/jobs/validate', {})).body.job;
    completeRun(github, time, corrupt.runId, { ok: true });
    github.runs.get(corrupt.runId).zip = new Uint8Array([1, 2, 3, 4]);
    assert.equal((await poll(server, time, corrupt.jobId)).error.code, 'result_invalid');

    const disagreeing = (await post(server, '/api/jobs/validate', {})).body.job;
    completeRun(github, time, disagreeing.runId, runnerResult(disagreeing), 'failure');
    const mismatch = await poll(server, time, disagreeing.jobId);
    assert.equal(mismatch.status, 'error', 'a run that concluded failure is never reported as done');
  });
});

test('a large final result is cached as a summary instead of exceeding the Firestore document limit', async () => {
  const { app, github, time } = harness({ config: { maxCachedResultChars: 2000 } });
  await withServer(app, async (server) => {
    const job = (await post(server, '/api/jobs/validate', { recheck: true })).body.job;
    completeRun(github, time, job.runId, runnerResult(job, { pipeline: { ok: true, result: { findings: Array.from({ length: 200 }, (_, i) => ({ code: `F${i}` })) } } }));
    const done = await poll(server, time, job.jobId);
    assert.equal(done.status, 'done');
    assert.equal(done.resultTruncated, true);
    assert.equal(done.result.ok, true);
    assert.equal(done.result.pipeline, undefined);
  });
});

test('without run details in the dispatch response the run is found by its run-name, or times out', async () => {
  const { app, github, time, db, store } = harness({ returnRunDetails: false });
  await withServer(app, async (server) => {
    const job = (await post(server, '/api/jobs/validate', {})).body.job;
    assert.equal(job.runId, null);
    const found = await poll(server, time, job.jobId);
    assert.equal(found.runId, 9000);
    const lookup = github.calls.find(([name]) => name === 'findDispatchedRun');
    assert.equal(lookup[4], `asset-job ${job.jobId}`);
    assert.equal(lookup[2], 'main');
    assert.ok(lookup[3] < START, 'the search window starts before the dispatch to allow clock skew');

    const upload = await reserveAndStage(server, store);
    const lost = (await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'sample_asset' })).body.job;
    github.runs.clear();
    assert.equal((await poll(server, time, lost.jobId)).status, 'queued');
    time.now += 15 * MINUTE + 1;
    const timedOut = await poll(server, time, lost.jobId);
    assert.equal(timedOut.status, 'error');
    assert.equal(timedOut.error.code, 'run_not_found');
    assert.equal(db.docs.has('assetLibraryLocks/mutation'), false);
  });
});

test('a definitive dispatch rejection fails the job and frees the lock; an ambiguous failure keeps it for polling', async () => {
  const { app, github, store, db, errors } = harness();
  await withServer(app, async (server) => {
    github.state.dispatchError = new UpstreamError(403, 'Resource not accessible by personal access token');
    const upload = await reserveAndStage(server, store);
    const refused = await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'sample_asset' });
    assert.equal(refused.status, 502);
    assert.equal(refused.body.error.code, 'dispatch_failed');
    assert.doesNotMatch(refused.text, /personal access token/);
    assert.equal(db.docs.get(`assetLibraryJobs/${upload.jobId}`).status, 'error');
    assert.equal(db.docs.has('assetLibraryLocks/mutation'), false);

    github.state.dispatchError = new Error('socket hang up');
    const second = await reserveAndStage(server, store);
    const unknown = await post(server, '/api/jobs/ingest', { jobId: second.jobId, baseSha: HEAD_A, assetId: 'sample_asset' });
    assert.equal(unknown.status, 202);
    assert.equal(unknown.body.job.status, 'queued');
    assert.equal(db.docs.get('assetLibraryLocks/mutation').jobId, second.jobId, 'the run may exist, so the lock stays until it is found or times out');
  });
  assert.ok(errors.length >= 2);
});

test('validate dispatches only the asset scope and the flags that are on', async () => {
  const { app, github } = harness();
  await withServer(app, async (server) => {
    assert.equal((await post(server, '/api/jobs/validate', { revisionId: 'r_1' })).status, 400);
    assert.equal((await post(server, '/api/jobs/validate', { baseSha: HEAD_A })).status, 400);
    assert.equal((await post(server, '/api/jobs/validate', { recheck: 'true' })).status, 400);
    assert.equal((await post(server, '/api/jobs/validate', { assetId: 'sample_asset', revisionId: 'r_1', recheck: true, strict: false })).status, 202);
    assert.equal((await server.request('/api/jobs/validate', { method: 'POST', token: 'writer' })).status, 202, 'an empty body validates the whole manifest');
  });
  assert.deepEqual(github.dispatches.map(({ inputs }) => inputs), [
    { job_id: 'job-0001-test', operation: 'validate', asset_id: 'sample_asset', revision_id: 'r_1', recheck: 'true' },
    { job_id: 'job-0002-test', operation: 'validate' }
  ]);
  assertRunnerContract(github);
});

test('the manifest response carries the pipeline vocabulary; an unreadable vocabulary blocks jobs but not browsing', async () => {
  const good = harness();
  await withServer(good.app, async (server) => {
    const response = await server.request('/api/manifest', { token: 'reader' });
    assert.deepEqual(response.body.vocabulary.categories, ['audio', 'effects', 'enemies', 'environments', 'operators', 'other', 'structures', 'ui', 'weapons']);
    assert.deepEqual(response.body.vocabulary.roles, ['reference', 'runtime', 'source', 'textures']);
    assert.ok(response.body.vocabulary.supportedExtensions.includes('.glb'));
    assert.equal(response.body.vocabulary.assetIdPattern, '^[a-z][a-z0-9_]{0,63}$');
    assert.equal(response.body.vocabulary.maxUploadBytes, 200 * 1024 * 1024);
    assert.deepEqual(response.body.vocabulary.textLimits, { display_name: 120, note: 2000, source: 500, creator: 120 });
  });

  const broken = harness({ common: PIPELINE_COMMON.replace('SUPPORTED = LFS_EXTENSIONS |', 'SUPPORTED = frozenset(LFS_EXTENSIONS) |') });
  await withServer(broken.app, async (server) => {
    const manifest = await server.request('/api/manifest', { token: 'reader' });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.vocabulary, null);
    const upload = await post(server, '/api/uploads', { fileName: 'a.glb', size: 1 });
    assert.equal(upload.status, 503);
    assert.equal(upload.body.error.code, 'vocabulary_unavailable');
  });
  assert.equal(broken.github.dispatches.length, 0);
});

test('malformed bodies, malformed job IDs and unknown jobs get clear errors; POST preflight allows JSON', async () => {
  const { app } = harness();
  await withServer(app, async (server) => {
    const malformed = await server.request('/api/jobs/validate', { method: 'POST', token: 'writer', body: '{"assetId":' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'invalid_request');
    const huge = await server.request('/api/jobs/validate', { method: 'POST', token: 'writer', body: JSON.stringify({ note: 'x'.repeat(20000) }) });
    assert.equal(huge.status, 413);

    assert.equal((await server.request('/api/jobs/short', { token: 'reader' })).status, 400);
    const unknown = await server.request('/api/jobs/job-9999-none', { token: 'reader' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'job_not_found');

    const preflight = await server.request('/api/jobs/ingest', {
      method: 'OPTIONS',
      origin: 'https://pizzarolls510.github.io',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/);
  });
});

test('recent jobs for an asset can be listed by any role, newest first, without their results', async () => {
  const { app, github, time, store } = harness();
  await withServer(app, async (server) => {
    const first = (await post(server, '/api/jobs/validate', { assetId: 'sample_asset', recheck: true })).body.job;
    completeRun(github, time, first.runId, runnerResult(first, { pipeline: { ok: true, result: { findings: [], fresh_inspections: [], production: [] } } }));
    await poll(server, time, first.jobId);
    time.now += MINUTE;
    const second = (await post(server, '/api/jobs/promote', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_asset', revisionId: 'r_1' })).body.job;
    time.now += MINUTE;
    await post(server, '/api/jobs/validate', { assetId: 'other_asset' });
    await post(server, '/api/uploads', { fileName: 'pending.glb', size: 4 }); // an unused reservation has no asset yet
    await reserveAndStage(server, store);

    for (const token of ['reader', 'writer']) {
      const list = await server.request('/api/jobs?asset=sample_asset', { token });
      assert.equal(list.status, 200, list.text);
      assert.deepEqual(list.body.jobs.map((job) => [job.jobId, job.operation, job.status]), [
        [second.jobId, 'promote_dry_run', 'queued'],
        [first.jobId, 'validate', 'done']
      ]);
      assert.equal(list.body.jobs[1].hasResult, true);
      assert.equal(list.body.jobs[0].revisionId, 'r_1');
      assert.equal('result' in list.body.jobs[1] || 'resultJson' in list.body.jobs[1], false, 'lists never carry results');
    }
    assert.equal((await server.request('/api/jobs?asset=sample_asset')).status, 401);
    for (const query of ['', '?asset=', '?asset=Bad-ID', '?asset=../x', '?asset=a&asset=b']) {
      const bad = await server.request(`/api/jobs${query}`, { token: 'reader' });
      assert.equal(bad.status, 400, query);
    }
    assert.deepEqual((await server.request('/api/jobs?asset=nothing_here', { token: 'reader' })).body, { jobs: [] });
  });
});

test('the job list is capped at the most recent ten', async () => {
  const { app, time } = harness();
  await withServer(app, async (server) => {
    for (let i = 0; i < 12; i += 1) {
      assert.equal((await post(server, '/api/jobs/validate', { assetId: 'sample_asset' })).status, 202);
      time.now += 1000;
    }
    const list = await server.request('/api/jobs?asset=sample_asset', { token: 'reader' });
    assert.equal(list.body.jobs.length, 10);
    assert.equal(list.body.jobs[0].jobId, 'job-0012-test');
  });
});
