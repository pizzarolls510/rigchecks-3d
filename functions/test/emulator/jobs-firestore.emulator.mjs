// Runs only under `npm run test:emulator`. Exercises the job API's real Firestore adapter (transactions for the
// mutation lock, rate limits and terminal-state caching) against the Firestore emulator. GitHub, Actions and
// Storage are faked; no real repository or workflow is touched.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createApp } from '../../src/app.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { createFirestoreDb } from '../../src/job-store.js';
import { HEAD_A, PIPELINE_COMMON, createFakeGitHub, createFakeStore, fakeVerifyIdToken, listen } from '../support/fakes.mjs';

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'run via `npm run test:emulator`');

let adminApp;
let firestore;

before(() => {
  adminApp = initializeApp({ projectId: 'demo-rigcheck' }, 'jobs-firestore-test');
  firestore = getFirestore(adminApp);
});

beforeEach(async () => {
  for (const name of ['assetLibraryJobs', 'assetLibraryLocks', 'assetLibraryRate']) {
    const snapshot = await firestore.collection(name).get();
    await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
  }
});

after(async () => {
  await deleteApp(adminApp);
});

function harness() {
  const github = createFakeGitHub({
    head: HEAD_A,
    commits: { [HEAD_A]: { 'docs/ASSET_MANIFEST.yaml': Buffer.from('{"assets":[]}'), 'tools/asset_pipeline/common.py': Buffer.from(PIPELINE_COMMON) } }
  });
  const store = createFakeStore();
  const time = { now: Date.UTC(2027, 0, 15, 8) };
  let counter = 0;
  const app = createApp({
    verifyIdToken: fakeVerifyIdToken,
    github,
    store,
    db: createFirestoreDb(firestore),
    now: () => time.now,
    makeJobId: () => `emu-${String(++counter).padStart(4, '0')}-job`,
    logger: { error() {} }
  });
  return { app, github, store, time };
}

async function stagedReservation(server, store, token, fileName) {
  const bytes = Buffer.from(`bytes of ${fileName}`);
  const reservation = await server.request('/api/uploads', { method: 'POST', token, json: { fileName, size: bytes.length } });
  assert.equal(reservation.status, 201, reservation.text);
  store.objects.set(reservation.body.stagingPath, { bytes });
  return reservation.body.jobId;
}

test('concurrent mutations race for the lock in a Firestore transaction: exactly one is dispatched', async () => {
  const { app, github, store } = harness();
  const server = await listen(app);
  try {
    const tokens = ['writer', 'writer2', 'writer', 'writer2', 'writer'];
    const jobIds = [];
    for (const [index, token] of tokens.entries()) jobIds.push(await stagedReservation(server, store, token, `m${index}.glb`));
    const responses = await Promise.all(jobIds.map((jobId, index) => server.request('/api/jobs/ingest', {
      method: 'POST', token: tokens[index], json: { jobId, baseSha: HEAD_A, assetId: 'sample_asset' }
    })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409, 409, 409, 409]);
    assert.ok(responses.filter((response) => response.status === 409).every((response) => response.body.error.code === 'mutation_in_progress'));
    assert.equal(github.dispatches.length, 1);
    const winner = responses.find((response) => response.status === 202).body.job.jobId;
    assert.equal((await firestore.doc('assetLibraryLocks/mutation').get()).data().jobId, winner);
    for (const jobId of jobIds.filter((id) => id !== winner)) {
      assert.equal((await firestore.doc(`assetLibraryJobs/${jobId}`).get()).data().status, 'awaiting_upload', 'losers keep their upload for a retry');
    }
  } finally {
    await server.close();
  }
});

test('the rate limit holds under concurrent requests from one user', async () => {
  const { app, github } = harness();
  const server = await listen(app);
  try {
    const responses = await Promise.all(Array.from({ length: 24 }, () => server.request('/api/jobs/validate', { method: 'POST', token: 'writer', json: {} })));
    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 202).length, 20, JSON.stringify(statuses));
    assert.equal(statuses.filter((status) => status === 429).length, 4);
    assert.equal(github.dispatches.length, 20);
    assert.equal((await firestore.doc('assetLibraryRate/writer-uid').get()).data().dispatch.count, 20);
  } finally {
    await server.close();
  }
});

test('a finished mutation is cached in Firestore and releases the lock; the next mutation can start', async () => {
  const { app, github, store, time } = harness();
  const server = await listen(app);
  try {
    const first = await stagedReservation(server, store, 'writer', 'first.glb');
    const ingest = await server.request('/api/jobs/ingest', { method: 'POST', token: 'writer', json: { jobId: first, baseSha: HEAD_A, assetId: 'sample_asset', note: 'n' } });
    assert.equal(ingest.status, 202, ingest.text);
    const stored = (await firestore.doc(`assetLibraryJobs/${first}`).get()).data();
    assert.equal(stored.status, 'queued');
    assert.equal(stored.runId, 9000);
    assert.doesNotMatch(JSON.stringify(stored), /X-Goog-Signature/, 'the signed staging URL is never persisted');

    const run = github.runs.get(9000);
    Object.assign(run, {
      status: 'completed',
      conclusion: 'success',
      updatedAt: new Date(time.now).toISOString(),
      result: { schema: 1, job_id: first, operation: 'ingest', ok: true, commitSha: 'c'.repeat(40), pushed: true, pipeline: { ok: true, result: { revision_id: 'r_1' } } }
    });
    time.now += DEFAULT_CONFIG.jobPollMinIntervalMs;
    const polled = await server.request(`/api/jobs/${first}`, { token: 'reader' });
    assert.equal(polled.body.job.status, 'done');
    assert.equal(polled.body.job.commitSha, 'c'.repeat(40));
    assert.equal((await firestore.doc('assetLibraryLocks/mutation').get()).exists, false);
    const cached = (await firestore.doc(`assetLibraryJobs/${first}`).get()).data();
    assert.equal(cached.status, 'done');
    assert.equal(JSON.parse(cached.resultJson).pipeline.result.revision_id, 'r_1');

    const second = await stagedReservation(server, store, 'writer2', 'second.glb');
    const next = await server.request('/api/jobs/ingest', { method: 'POST', token: 'writer2', json: { jobId: second, baseSha: HEAD_A, assetId: 'other_asset' } });
    assert.equal(next.status, 202, next.text);
  } finally {
    await server.close();
  }
});

test('concurrent polls of a finishing job record one terminal state', async () => {
  const { app, github, time } = harness();
  const server = await listen(app);
  try {
    const job = (await server.request('/api/jobs/validate', { method: 'POST', token: 'writer', json: { assetId: 'sample_asset' } })).body.job;
    Object.assign(github.runs.get(job.runId), {
      status: 'completed', conclusion: 'success', updatedAt: new Date(time.now).toISOString(),
      result: { schema: 1, job_id: job.jobId, operation: 'validate', ok: true }
    });
    time.now += DEFAULT_CONFIG.jobPollMinIntervalMs;
    const polls = await Promise.all(Array.from({ length: 5 }, () => server.request(`/api/jobs/${job.jobId}`, { token: 'reader' })));
    assert.ok(polls.every((response) => response.status === 200), polls.map((response) => response.text).join('\n'));
    const stored = (await firestore.doc(`assetLibraryJobs/${job.jobId}`).get()).data();
    assert.equal(stored.status, 'done');
    assert.equal(stored.ok, true);
  } finally {
    await server.close();
  }
});

test('listing an asset\'s jobs queries the nested params.asset_id field in real Firestore', async () => {
  const { app } = harness();
  const server = await listen(app);
  try {
    for (const assetId of ['sample_asset', 'other_asset', 'sample_asset']) {
      assert.equal((await server.request('/api/jobs/validate', { method: 'POST', token: 'writer', json: { assetId } })).status, 202);
    }
    const list = await server.request('/api/jobs?asset=sample_asset', { token: 'reader' });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.jobs.length, 2);
    assert.ok(list.body.jobs.every((job) => job.operation === 'validate'));
  } finally {
    await server.close();
  }
});
