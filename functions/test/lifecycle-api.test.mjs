// Annotate, archive/reject/unarchive, restore (rollback) and the read-only reports: permissions per principal, the
// human-only confirm, the pipeline feature gate and the exact runner inputs. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { DEFAULT_AGENT_PERMISSIONS, PERMISSIONS } from '../src/permissions.js';
import { ALLOWED, REQUIRED } from '../src/runner-contract.js';
import {
  HEAD_A,
  PIPELINE_COMMON,
  agentToken,
  createFakeDb,
  createFakeGitHub,
  createFakeStore,
  fakeVerifyAgentToken,
  fakeVerifyIdToken,
  listen
} from './support/fakes.mjs';

const START = 1_800_000_000_000;
const UPGRADED_COMMON = `${PIPELINE_COMMON}
CHANGE_KINDS = {"initial", "skeleton_upgrade", "animation_revision"}
PIPELINE_FEATURES = {"identity_guard", "lineage", "provenance", "lifecycle", "references", "restore", "annotate"}
`;
const MANIFEST = {
  schema_version: 1,
  assets: [{
    asset_id: 'sample_suit', canonical_revision: 'r_new',
    revisions: [
      { revision_id: 'r_old', canonical_state: 'superseded' },
      { revision_id: 'r_new', canonical_state: 'canonical' },
      { revision_id: 'r_cand', canonical_state: 'candidate' }
    ]
  }]
};
const CURATOR = agentToken('curator');

function harness({ common = UPGRADED_COMMON, permissions = [...DEFAULT_AGENT_PERMISSIONS, PERMISSIONS.archiveCandidate, PERMISSIONS.annotate, PERMISSIONS.restoreDryRun] } = {}) {
  const github = createFakeGitHub({
    head: HEAD_A,
    commits: { [HEAD_A]: { 'docs/ASSET_MANIFEST.yaml': Buffer.from(JSON.stringify(MANIFEST)), 'tools/asset_pipeline/common.py': Buffer.from(common) } }
  });
  const db = createFakeDb();
  db.docs.set('assetLibraryAgents/asset-curator', {
    agentId: 'asset-curator', serviceAccountEmail: 'asset-curator@example-project.iam.gserviceaccount.com', serviceAccountId: '1001',
    permissions, expiresAt: START + 86_400_000, disabled: false
  });
  const time = { now: START };
  let counter = 0;
  const app = createApp({
    verifyIdToken: fakeVerifyIdToken, verifyAgentToken: fakeVerifyAgentToken, github, store: createFakeStore(), db,
    config: DEFAULT_CONFIG, now: () => time.now, makeJobId: () => `job-${String(++counter).padStart(4, '0')}-life`, logger: { error() {} }
  });
  return { app, github, db, time };
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
const context = (dispatch) => JSON.parse(dispatch.inputs.context);

function assertRunnerContract(github) {
  for (const { inputs } of github.dispatches) {
    const provided = Object.keys(inputs).filter((key) => key !== 'job_id' && key !== 'operation');
    assert.deepEqual(provided.filter((key) => !ALLOWED[inputs.operation].includes(key)), [], `unexpected inputs for ${inputs.operation}`);
    assert.deepEqual(REQUIRED[inputs.operation].filter((key) => !provided.includes(key)), [], `missing inputs for ${inputs.operation}`);
  }
}

test('annotate sends only the given fields and lineage to the runner', async () => {
  const { app, github } = harness();
  await withServer(app, async (server) => {
    const response = await post(server, '/api/jobs/annotate', { baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_cand',
      source: 'Synthetic export', parentRevision: 'r_new', changeKind: 'animation_revision' }, CURATOR);
    assert.equal(response.status, 202, response.text);
    assert.equal((await post(server, '/api/jobs/annotate', { baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_cand' })).status, 400);
    assert.equal((await post(server, '/api/jobs/annotate', { baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_cand', changeKind: 'bogus' })).status, 400);
  });
  assert.equal(github.dispatches[0].inputs.operation, 'annotate');
  assert.deepEqual(context(github.dispatches[0]), { actor: 'agent:asset-curator', fields: { source: 'Synthetic export' },
    parent_revision: 'r_new', change_kind: 'animation_revision' });
  assertRunnerContract(github);
});

test('people archive and reject with a reason; agents archive and unarchive candidates only', async () => {
  const { app, github } = harness();
  await withServer(app, async (server) => {
    const body = (extra) => ({ baseSha: HEAD_A, assetId: 'sample_suit', ...extra });
    assert.equal((await post(server, '/api/jobs/lifecycle', body({ action: 'archive', revisionId: 'r_old' }))).status, 400, 'a reason is required');
    let response = await post(server, '/api/jobs/lifecycle', body({ action: 'archive', revisionId: 'r_old', reason: 'old rig' }));
    assert.equal(response.status, 202, response.text);
    response = await post(server, '/api/jobs/lifecycle', body({ action: 'archive', revisionId: 'r_old', reason: 'old rig' }), CURATOR);
    assert.deepEqual([response.status, response.body.error.code], [403, 'permission_denied'], 'agents never archive superseded revisions');
    response = await post(server, '/api/jobs/lifecycle', body({ action: 'reject', revisionId: 'r_cand', reason: 'wrong scale' }), CURATOR);
    assert.equal(response.status, 403, 'rejecting is a person\'s decision');
    response = await post(server, '/api/jobs/lifecycle', body({ action: 'archive', revisionId: 'r_cand', reason: 'duplicate walk' }), CURATOR);
    assert.equal(response.status, 409, 'one mutation at a time');
    assert.equal(response.body.error.code, 'mutation_in_progress');
  });
  assert.deepEqual(github.dispatches.map((d) => [d.inputs.operation, context(d)]),
    [['archive', { actor: 'human:writer-uid', reason: 'old rig' }]]);
  assertRunnerContract(github);
});

test('an agent archive carries candidates_only so the pipeline enforces it as well', async () => {
  const { app, github } = harness();
  await withServer(app, async (server) => {
    const response = await post(server, '/api/jobs/lifecycle', { action: 'archive', baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_cand', reason: 'duplicate walk' }, CURATOR);
    assert.equal(response.status, 202, response.text);
  });
  assert.deepEqual(context(github.dispatches[0]), { actor: 'agent:asset-curator', reason: 'duplicate walk', candidates_only: true });
  const noGrant = harness({ permissions: [...DEFAULT_AGENT_PERMISSIONS] });
  await withServer(noGrant.app, async (server) => {
    const response = await post(server, '/api/jobs/lifecycle', { action: 'archive', baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_cand', reason: 'x' }, CURATOR);
    assert.deepEqual([response.status, response.body.error.code], [403, 'permission_denied'], 'archive:candidate is not a default grant');
  });
});

test('a rollback needs a dry run and a confirm by the same person; agents may only prepare it', async () => {
  const { app, github, time } = harness();
  await withServer(app, async (server) => {
    assert.equal((await post(server, '/api/jobs/restore', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_cand' })).status, 400,
      'only superseded revisions can be restored');
    const agentDry = await post(server, '/api/jobs/restore', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_old' }, CURATOR);
    assert.equal(agentDry.status, 202, agentDry.text);
    const dry = (await post(server, '/api/jobs/restore', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_old' })).body.job;
    assert.equal(dry.mutation, false);
    const run = github.runs.get(dry.runId);
    Object.assign(run, { status: 'completed', conclusion: 'success', updatedAt: new Date(time.now).toISOString(),
      result: { schema: 1, job_id: dry.jobId, operation: 'restore_dry_run', ok: true, pipeline: { ok: true, result: { warnings: [{ code: 'SKELETON_CHANGED' }] } } } });
    time.now += DEFAULT_CONFIG.jobPollMinIntervalMs;
    assert.equal((await server.request(`/api/jobs/${dry.jobId}`, { token: 'writer' })).body.job.status, 'done');
    const agentConfirm = await post(server, '/api/jobs/restore', { dryRun: false, dryRunJobId: dry.jobId, acceptWarnings: true }, CURATOR);
    assert.deepEqual([agentConfirm.status, agentConfirm.body.error.code], [403, 'human_approval_required']);
    const other = await post(server, '/api/jobs/restore', { dryRun: false, dryRunJobId: dry.jobId, acceptWarnings: true }, 'writer2');
    assert.equal(other.body.error.code, 'dry_run_not_owned');
    const unaccepted = await post(server, '/api/jobs/restore', { dryRun: false, dryRunJobId: dry.jobId });
    assert.equal(unaccepted.body.error.code, 'warnings_not_accepted');
    const confirm = await post(server, '/api/jobs/restore', { dryRun: false, dryRunJobId: dry.jobId, acceptWarnings: true });
    assert.equal(confirm.status, 202, confirm.text);
    assert.equal(confirm.body.job.operation, 'restore_confirm');
    const promoteWithRestoreRun = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: dry.jobId, acceptWarnings: true });
    assert.equal(promoteWithRestoreRun.status, 409, 'a restore dry run cannot confirm a promotion');
  });
  assert.deepEqual(github.dispatches.at(-1).inputs, { job_id: 'job-0003-life', operation: 'restore_confirm', base_sha: HEAD_A, asset_id: 'sample_suit',
    revision_id: 'r_old', accept_warnings: 'true', context: JSON.stringify({ actor: 'human:writer-uid' }) });
  assertRunnerContract(github);
});

test('reports are read-only jobs any reader may start', async () => {
  const { app, github, db } = harness();
  await withServer(app, async (server) => {
    assert.equal((await post(server, '/api/jobs/report', { report: 'references', assetId: 'sample_suit', revisionId: 'r_old' }, 'reader')).status, 202);
    assert.equal((await post(server, '/api/jobs/report', { report: 'lineage', assetId: 'sample_suit' }, CURATOR)).status, 202);
    assert.equal((await post(server, '/api/jobs/report', { report: 'retention' }, CURATOR)).status, 202);
    assert.equal((await post(server, '/api/jobs/report', { report: 'everything' })).status, 400);
  });
  assert.deepEqual(github.dispatches.map((d) => d.inputs.operation), ['references', 'lineage', 'retention']);
  assert.equal(db.docs.has('assetLibraryLocks/mutation'), false, 'reports never take the mutation lock');
  assertRunnerContract(github);
});

test('an older pipeline refuses lifecycle requests before any job starts', async () => {
  const { app, github } = harness({ common: PIPELINE_COMMON });
  await withServer(app, async (server) => {
    for (const [path, body] of [
      ['/api/jobs/annotate', { baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_cand', note: 'n' }],
      ['/api/jobs/lifecycle', { action: 'archive', baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_cand', reason: 'r' }],
      ['/api/jobs/restore', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_old' }],
      ['/api/jobs/report', { report: 'retention' }]
    ]) {
      const response = await post(server, path, body);
      assert.deepEqual([response.status, response.body.error.code], [503, 'feature_unavailable'], path);
    }
  });
  assert.equal(github.dispatches.length, 0);
});
