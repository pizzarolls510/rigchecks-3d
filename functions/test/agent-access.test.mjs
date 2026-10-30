// Agent principals: service-account tokens, the registry and kill switch, server-side permissions, rate limits, the
// audit log and the identity lookups. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTokenVerifier } from '../src/agent-auth.js';
import { createApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { DEFAULT_AGENT_PERMISSIONS, PERMISSIONS } from '../src/permissions.js';
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
const DAY = 24 * 60 * 60 * 1000;
const MANIFEST = {
  schema_version: 1,
  assets: [
    { asset_id: 'sample_suit', identity: { kind: 'character', aliases: ['working_name'], alias_candidates: [{ name: 'other_suit_v2', status: 'pending' }] },
      revisions: [{ revision_id: 'r_1', canonical_state: 'canonical', files: [{ path: 'assets/operators/sample_suit/runtime/sample_suit.glb', sha256: 'a'.repeat(64) }] }] }
  ]
};

function harness({ agent = {}, control = null, config = {} } = {}) {
  const github = createFakeGitHub({
    head: HEAD_A,
    commits: { [HEAD_A]: { 'docs/ASSET_MANIFEST.yaml': Buffer.from(JSON.stringify(MANIFEST)), 'tools/asset_pipeline/common.py': Buffer.from(PIPELINE_COMMON) } }
  });
  const store = createFakeStore();
  const db = createFakeDb();
  const time = { now: START };
  db.docs.set('assetLibraryAgents/asset-curator', {
    agentId: 'asset-curator', serviceAccountEmail: 'asset-curator@example-project.iam.gserviceaccount.com', serviceAccountId: '1001',
    permissions: [...DEFAULT_AGENT_PERMISSIONS], expiresAt: START + 30 * DAY, disabled: false, ...agent
  });
  if (control) db.docs.set('assetLibraryControl/agents', control);
  let counter = 0;
  const app = createApp({
    verifyIdToken: fakeVerifyIdToken, verifyAgentToken: fakeVerifyAgentToken, github, store, db,
    config: { ...DEFAULT_CONFIG, ...config }, now: () => time.now,
    makeJobId: () => `job-${String(++counter).padStart(4, '0')}-agent`, logger: { error() {} }
  });
  return { app, github, store, db, time };
}

async function withServer(app, run) {
  const server = await listen(app);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

const CURATOR = agentToken('curator');
const post = (server, path, json, token = CURATOR) => server.request(path, { method: 'POST', token, json });

async function stagedUpload(server, store, token = CURATOR) {
  const bytes = Buffer.from('glTF-agent-bytes');
  const reservation = await post(server, '/api/uploads', { fileName: 'walk_v2.glb', size: bytes.length, contentType: 'model/gltf-binary' }, token);
  assert.equal(reservation.status, 201, reservation.text);
  store.objects.set(reservation.body.stagingPath, { bytes, options: { contentType: 'model/gltf-binary' } });
  return reservation.body;
}

function audited(db) {
  return [...db.docs.entries()].filter(([path]) => path.startsWith('assetLibraryAudit/')).map(([, entry]) => entry);
}

test('a registered agent is identified with exactly its grantable permissions', async () => {
  const { app } = harness({ agent: { permissions: [...DEFAULT_AGENT_PERMISSIONS, PERMISSIONS.promoteConfirm, PERMISSIONS.assetCreate, 'made:up'] } });
  await withServer(app, async (server) => {
    const response = await server.request('/api/whoami', { token: CURATOR });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.kind, 'agent');
    assert.equal(response.body.id, 'asset-curator');
    assert.deepEqual(response.body.permissions, [...DEFAULT_AGENT_PERMISSIONS].sort());
    assert.deepEqual(response.body.ignoredPermissions, ['asset:create', 'made:up', 'promote:confirm'], 'never-grantable permissions are reported and not applied');
    assert.equal(response.body.tokenExpiresAt, new Date(1_800_003_600 * 1000).toISOString());
  });
});

test('unregistered, disabled, expired and impostor agents and the kill switch are refused on the next request', async () => {
  for (const [label, options, token, status, code] of [
    ['bad token', {}, agentToken('nobody'), 401, 'unauthenticated'],
    ['unregistered', {}, agentToken('stranger'), 403, 'agent_not_registered'],
    ['disabled', { agent: { disabled: true } }, CURATOR, 403, 'agent_disabled'],
    ['expired', { agent: { expiresAt: START - 1 } }, CURATOR, 403, 'agent_expired'],
    ['no expiry', { agent: { expiresAt: null } }, CURATOR, 403, 'agent_expired'],
    ['other service account with the same email', {}, agentToken('impostor'), 403, 'agent_identity_mismatch'],
    ['kill switch', { control: { agentsDisabled: true } }, CURATOR, 403, 'agents_disabled']
  ]) {
    const { app, db } = harness(options);
    await withServer(app, async (server) => {
      const response = await server.request('/api/manifest', { token });
      assert.equal(response.status, status, label);
      assert.equal(response.body.error.code, code, label);
    });
    await app.locals.audit.flush();
    const [entry] = audited(db);
    assert.equal(entry?.outcome, 'denied', `${label} is audited`);
    assert.equal(entry.principal.kind, 'agent');
  }
});

test('an upload agent can reserve, upload through a signed URL and ingest a candidate into an existing asset', async () => {
  const { app, github, store, db } = harness();
  await withServer(app, async (server) => {
    const upload = await stagedUpload(server, store);
    assert.match(upload.stagingPath, /^asset-library-staging\/agent_asset-curator\/job-0001-agent\/walk_v2\.glb$/);
    assert.equal(upload.upload.method, 'PUT');
    assert.deepEqual(upload.upload.headers, { 'Content-Type': 'model/gltf-binary', 'x-goog-content-length-range': '16,16' });
    const ingest = await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'sample_suit', parentRevision: 'r_1' });
    assert.equal(ingest.status, 202, ingest.text);
    assert.equal(ingest.body.job.createdByKind, 'agent');
    assert.deepEqual(JSON.parse(github.dispatches[0].inputs.context), { actor: 'agent:asset-curator', parent_revision: 'r_1' });
    assert.deepEqual(db.docs.get(`assetLibraryJobs/${upload.jobId}`).principal, { kind: 'agent', id: 'asset-curator' });
  });
  await app.locals.audit.flush();
  assert.deepEqual(audited(db).map((entry) => [entry.path, entry.outcome, entry.principal.id]),
    [['/api/uploads', 'allowed', 'asset-curator'], ['/api/jobs/ingest', 'allowed', 'asset-curator']]);
});

test('agents can never create assets, override identity checks, bind, import a library file or confirm a promotion', async () => {
  const { app, github, store } = harness({ agent: { permissions: [...DEFAULT_AGENT_PERMISSIONS, PERMISSIONS.promoteConfirm, PERMISSIONS.bind] } });
  await withServer(app, async (server) => {
    const upload = await stagedUpload(server, store);
    for (const [label, extra] of [['create', { assetId: 'new_suit', createAsset: true }], ['confirm', { assetId: 'sample_suit', confirmIdentity: true }],
      ['duplicate', { assetId: 'sample_suit', allowDuplicateContent: true }]]) {
      const response = await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, ...extra });
      assert.equal(response.status, 403, label);
      assert.equal(response.body.error.code, 'permission_denied', label);
    }
    assert.equal((await post(server, '/api/jobs/bind', { baseSha: HEAD_A, assetId: 'sample_suit', slots: {} })).body.error.code, 'permission_denied');
    assert.equal((await post(server, '/api/uploads/library', { modelId: 'm1' })).body.error.code, 'permission_denied');
    const confirm = await post(server, '/api/jobs/promote', { dryRun: false, dryRunJobId: 'job-0001-agent', acceptWarnings: true });
    assert.equal(confirm.status, 403);
    assert.equal(confirm.body.error.code, 'human_approval_required', 'even a Firestore grant cannot let an agent confirm');
    const dryRun = await post(server, '/api/jobs/promote', { dryRun: true, baseSha: HEAD_A, assetId: 'sample_suit', revisionId: 'r_1' });
    assert.equal(dryRun.status, 202, 'an agent may prepare a promotion for a person to review');
  });
  assert.deepEqual(github.dispatches.map(({ inputs }) => inputs.operation), ['promote_dry_run']);
});

test('the API refuses an alias or unknown asset before any job starts and names the right asset', async () => {
  const { app, github, store } = harness();
  await withServer(app, async (server) => {
    const upload = await stagedUpload(server, store);
    const alias = await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'working_name' });
    assert.equal(alias.status, 409);
    assert.deepEqual([alias.body.error.code, alias.body.error.details], ['alias_of_asset', { assetId: 'sample_suit' }]);
    const unknown = await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'brand_new' });
    assert.deepEqual([unknown.status, unknown.body.error.code], [409, 'unknown_asset']);
    const parent = await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'sample_suit', parentRevision: 'r_9' });
    assert.equal(parent.status, 400);
  });
  assert.equal(github.dispatches.length, 0);
});

test('a person can still create an asset and confirm identities; the actor is recorded as human', async () => {
  const { app, github, store } = harness();
  await withServer(app, async (server) => {
    const upload = await stagedUpload(server, store, 'writer');
    assert.equal(upload.upload, undefined, 'people upload through Storage rules, not a signed URL');
    const response = await post(server, '/api/jobs/ingest', { jobId: upload.jobId, baseSha: HEAD_A, assetId: 'brand_new', createAsset: true, confirmIdentity: true }, 'writer');
    assert.equal(response.status, 202, response.text);
  });
  assert.deepEqual(JSON.parse(github.dispatches[0].inputs.context), { actor: 'human:writer-uid', new_asset: true, confirm_identity: true });
});

test('agent rate limits are lower than people\'s and a registration can only lower them', async () => {
  const { app, store } = harness({ agent: { rateLimits: { upload: 2 } } });
  await withServer(app, async (server) => {
    await stagedUpload(server, store);
    await stagedUpload(server, store);
    const third = await post(server, '/api/uploads', { fileName: 'c.glb', size: 4 });
    assert.equal(third.status, 429);
  });
  const generous = harness({ agent: { rateLimits: { upload: 1000 } } });
  await withServer(generous.app, async (server) => {
    for (let i = 0; i < DEFAULT_CONFIG.agentRateLimits.upload; i += 1) assert.equal((await post(server, '/api/uploads', { fileName: 'c.glb', size: 4 })).status, 201);
    assert.equal((await post(server, '/api/uploads', { fileName: 'c.glb', size: 4 })).status, 429, 'the shared agent ceiling still applies');
  });
});

test('identity lookups resolve aliases and find exact duplicates without uploading anything', async () => {
  const { app } = harness();
  await withServer(app, async (server) => {
    const alias = await server.request('/api/identity/resolve?name=working_name', { token: CURATOR });
    assert.equal(alias.status, 200, alias.text);
    assert.deepEqual([alias.body.assetId, alias.body.via], ['sample_suit', 'alias']);
    const pending = await server.request('/api/identity/resolve?name=other_suit', { token: CURATOR });
    assert.deepEqual([pending.body.assetId, pending.body.pendingAliasOf], [null, ['sample_suit']], 'pending candidates are reported, never resolved');
    const duplicate = await post(server, '/api/identity/check', { sha256: ['a'.repeat(64), 'b'.repeat(64)] });
    assert.deepEqual(duplicate.body.matches.map((m) => [m.assetId, m.revisionId]), [['sample_suit', 'r_1']]);
    assert.equal((await post(server, '/api/identity/check', { sha256: ['XYZ'] })).status, 400);
    assert.equal((await server.request('/api/identity/resolve?name=working_name', { token: 'reader' })).status, 200, 'readers may look up identities');
  });
});

test('the token verifier accepts only short-lived, verified-email tokens for its audience', async () => {
  const payloads = {
    good: { email: 'Agent@Example.com', email_verified: true, sub: '7', iat: 100, exp: 3700 },
    unverified: { email: 'agent@example.com', email_verified: false, sub: '7', iat: 100, exp: 3700 },
    long: { email: 'agent@example.com', email_verified: true, sub: '7', iat: 100, exp: 100 + 24 * 3600 }
  };
  const seen = [];
  const client = { async verifyIdToken({ idToken, audience }) { seen.push(audience); return { getPayload: () => payloads[idToken] }; } };
  const verify = createAgentTokenVerifier({ audience: 'https://api.example.test/assetLibraryApi', client });
  assert.deepEqual(await verify('good'), { email: 'agent@example.com', sub: '7', iat: 100, exp: 3700 });
  await assert.rejects(verify('unverified'), /verified email/);
  await assert.rejects(verify('long'), /lifetime/);
  assert.deepEqual(seen, Array(3).fill('https://api.example.test/assetLibraryApi'));
  assert.throws(() => createAgentTokenVerifier({ audience: 'not-a-url' }), /https audience/);
});
