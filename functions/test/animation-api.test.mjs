// Animation endpoints: Cloud Library association, offline bake (animate) and slot bindings. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ALLOWED, REQUIRED } from '../src/runner-contract.js';
import { HEAD_A, PIPELINE_COMMON, createFakeDb, createFakeGitHub, createFakeStore, fakeVerifyIdToken, listen } from './support/fakes.mjs';

const START = 1_800_000_000_000;
const glb = (path, role = 'runtime') => ({ path, role, sha256: 'a'.repeat(64), size_bytes: 10, format: 'glb' });
const MANIFEST = {
  schema_version: 1,
  assets: [{
    asset_id: 'sample_operator', display_name: 'Sample Operator', category: 'operators', canonical_revision: 'r_model',
    requirements: { source: false, runtime: true, rig_compatibility: false },
    revisions: [
      { revision_id: 'r_model', canonical_state: 'canonical', files: [glb('assets/operators/sample_operator/runtime/model.glb')] },
      { revision_id: 'r_clips', component: 'animation_collection', canonical_state: 'candidate',
        files: [glb('assets/_workbench/operators/sample_operator/r_clips/runtime/clips.glb')],
        animation: { clips: [{ name: 'Walk' }, { name: 'Aim' }] } },
      { revision_id: 'r_walk', component: 'source_clip', canonical_state: 'candidate',
        files: [{ path: 'assets/_workbench/operators/sample_operator/r_walk/source/walk.fbx', role: 'source', sha256: 'b'.repeat(64), size_bytes: 9, format: 'fbx' }] },
      { revision_id: 'r_texture', component: 'materials', canonical_state: 'candidate',
        files: [{ path: 'assets/_workbench/operators/sample_operator/r_texture/textures/t.png', role: 'textures', sha256: 'c'.repeat(64), size_bytes: 5, format: 'png' }] }
    ]
  }, {
    asset_id: 'sample_tower', display_name: 'Sample Tower', category: 'structures', canonical_revision: null,
    requirements: { source: false, runtime: true, rig_compatibility: false },
    revisions: [{ revision_id: 'r_tower', canonical_state: 'candidate', files: [glb('assets/_workbench/structures/sample_tower/r_tower/runtime/t.glb')] }]
  }]
};
const PROFILES = { profiles_version: 1, namings: { generic: { family: 'humanoid', bones: {} } }, rigs: {},
  slots: { operator: { idle: { loop: true }, walk: { loop: true }, run: { loop: true }, fall: { loop: false } } } };

function harness({ profiles = PROFILES } = {}) {
  const files = {
    'docs/ASSET_MANIFEST.yaml': Buffer.from(JSON.stringify(MANIFEST)),
    'tools/asset_pipeline/common.py': Buffer.from(PIPELINE_COMMON),
    ...(profiles ? { 'docs/ASSET_RIG_PROFILES.json': Buffer.from(JSON.stringify(profiles)) } : {})
  };
  const github = createFakeGitHub({ head: HEAD_A, commits: { [HEAD_A]: files } });
  const store = createFakeStore();
  const db = createFakeDb();
  let counter = 0;
  const app = createApp({ verifyIdToken: fakeVerifyIdToken, github, store, db, config: DEFAULT_CONFIG, now: () => START,
    makeJobId: () => `job-${String(++counter).padStart(4, '0')}-anim`, logger: { error() {} } });
  return { app, github, store, db };
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

function assertContract(github) {
  for (const { inputs } of github.dispatches) {
    const provided = Object.keys(inputs).filter((key) => key !== 'job_id' && key !== 'operation');
    assert.deepEqual(provided.filter((key) => !ALLOWED[inputs.operation].includes(key)), []);
    assert.deepEqual(REQUIRED[inputs.operation].filter((key) => !provided.includes(key)), []);
    for (const value of Object.values(inputs)) assert.equal(typeof value, 'string');
  }
}

test('the manifest response carries the rig profiles and component vocabulary; older commits carry none', async () => {
  for (const profiles of [PROFILES, null]) {
    const { app } = harness({ profiles });
    await withServer(app, async (server) => {
      const response = await server.request('/api/manifest', { token: 'reader' });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.rigProfiles, profiles);
      assert.ok(response.body.vocabulary.components.includes('animation_collection'));
    });
  }
});

test('animate dispatches manifest references and a checked recipe as one mutation', async () => {
  const { app, github, db } = harness();
  await withServer(app, async (server) => {
    const response = await post(server, '/api/jobs/animate', {
      baseSha: HEAD_A, assetId: 'sample_operator', targetRevisionId: 'r_model',
      sources: [{ assetId: 'sample_operator', revisionId: 'r_walk' }, { assetId: 'sample_operator', revisionId: 'r_clips' }],
      recipe: { overrides: [{ source: 1, clip: 'Aim', output: 'aim', mode: 'absolute', loop: true }], options: { fps: 30 } },
      note: 'Bake test'
    });
    assert.equal(response.status, 202, response.text);
    const inputs = github.dispatches[0].inputs;
    assert.equal(inputs.operation, 'animate');
    assert.equal(inputs.sources, 'sample_operator/r_walk,sample_operator/r_clips');
    assert.equal(JSON.parse(inputs.recipe).overrides[0].output, 'aim');
    assert.equal(db.docs.get('assetLibraryLocks/mutation').jobId, response.body.job.jobId);
    assert.equal(response.body.job.params.asset_id, 'sample_operator');
    const second = await post(server, '/api/jobs/bind', { baseSha: HEAD_A, assetId: 'sample_operator', slots: { walk: { revisionId: 'r_clips', clip: 'Walk' } } });
    assert.equal(second.body.error.code, 'mutation_in_progress');
  });
  assertContract(github);
});

test('animate refuses bad targets, sources and recipes before dispatch', async () => {
  const { app, github } = harness();
  const base = { baseSha: HEAD_A, assetId: 'sample_operator', targetRevisionId: 'r_model', sources: [{ assetId: 'sample_operator', revisionId: 'r_walk' }] };
  await withServer(app, async (server) => {
    const cases = [
      [{ ...base, targetRevisionId: 'r_clips' }, 400, 'invalid_request'],
      [{ ...base, targetRevisionId: 'r_missing' }, 404, 'not_found'],
      [{ ...base, sources: [{ assetId: 'sample_operator', revisionId: 'r_texture' }] }, 400, 'invalid_request'],
      [{ ...base, sources: [] }, 400, 'invalid_request'],
      [{ ...base, sources: [base.sources[0], base.sources[0]] }, 400, 'invalid_request'],
      [{ ...base, sources: [{ assetId: 'sample_operator', revisionId: 'r_walk', path: '/etc/passwd' }] }, 400, 'invalid_request'],
      [{ ...base, recipe: { target: { path: '/etc/passwd' } } }, 400, 'invalid_request'],
      [{ ...base, recipe: { overrides: [{ source: 3, clip: 'Walk' }] } }, 400, 'invalid_request'],
      [{ ...base, recipe: { overrides: [{ source: 0, clip: 'Walk', output: '../x' }] } }, 400, 'invalid_request'],
      [{ ...base, recipe: { options: { include_mesh: true } } }, 400, 'invalid_request'],
      [{ ...base, baseSha: 'b'.repeat(40) }, 409, 'stale_base']
    ];
    for (const [json, status, code] of cases) {
      const response = await post(server, '/api/jobs/animate', json);
      assert.equal(response.status, status, `${JSON.stringify(json)} ${response.text}`);
      assert.equal(response.body.error.code, code);
    }
    assert.equal((await post(server, '/api/jobs/animate', base, 'reader')).status, 403);
  });
  assert.equal(github.dispatches.length, 0);
});

test('bind validates slots against the profiles and the collection clips', async () => {
  const { app, github } = harness();
  await withServer(app, async (server) => {
    const bad = [
      { slots: { dance: { revisionId: 'r_clips', clip: 'Walk' } } },
      { slots: { walk: { revisionId: 'r_model', clip: 'Walk' } } },
      { slots: { walk: { revisionId: 'r_clips', clip: 'Missing' } } },
      { slots: { walk: { revisionId: 'r_clips', clip: 'Walk', loop: 'yes' } } },
      { slots: {} }
    ];
    for (const json of bad) {
      const response = await post(server, '/api/jobs/bind', { baseSha: HEAD_A, assetId: 'sample_operator', ...json });
      assert.equal(response.status, 400, JSON.stringify(json));
    }
    const tower = await post(server, '/api/jobs/bind', { baseSha: HEAD_A, assetId: 'sample_tower', slots: { walk: null } });
    assert.match(tower.body.error.message, /No gameplay animation slots/);
    const ok = await post(server, '/api/jobs/bind', { baseSha: HEAD_A, assetId: 'sample_operator',
      slots: { walk: { revisionId: 'r_clips', clip: 'Walk' }, run: { revisionId: 'r_clips', clip: 'Aim', loop: true, rootMotion: 'in_place' }, idle: null } });
    assert.equal(ok.status, 202, ok.text);
    assert.deepEqual(JSON.parse(github.dispatches[0].inputs.bindings), {
      walk: { revision_id: 'r_clips', clip: 'Walk' }, run: { revision_id: 'r_clips', clip: 'Aim', loop: true, root_motion: 'in_place' }, idle: null
    });
  });
  assertContract(github);
});

test('a Cloud Library file is copied into staging for its owner only, then ingests like an upload', async () => {
  const { app, github, store, db } = harness();
  const path = 'users/writer-uid/models/m1/sample_walks.glb';
  store.objects.set(path, { bytes: Buffer.from('glTF-library'), options: { contentType: 'model/gltf-binary' } });
  db.docs.set('users/writer-uid/models/m1', { id: 'm1', storagePath: path, sha256: 'd'.repeat(64) });
  db.docs.set('users/writer-uid/models/evil', { id: 'evil', storagePath: 'users/other-uid/models/x/a.glb' });
  db.docs.set('users/writer-uid/models/exe', { id: 'exe', storagePath: 'users/writer-uid/models/exe/a.exe' });
  await withServer(app, async (server) => {
    assert.equal((await post(server, '/api/uploads/library', { modelId: 'm1' }, 'reader')).status, 403);
    assert.equal((await post(server, '/api/uploads/library', { modelId: 'nope' })).body.error.code, 'library_file_not_found');
    assert.equal((await post(server, '/api/uploads/library', { modelId: 'evil' })).body.error.code, 'library_file_not_owned');
    assert.equal((await post(server, '/api/uploads/library', { modelId: 'exe' })).status, 400);
    assert.equal((await post(server, '/api/uploads/library', { modelId: '../m1' })).status, 400);
    const reserved = await post(server, '/api/uploads/library', { modelId: 'm1' });
    assert.equal(reserved.status, 201, reserved.text);
    assert.equal(reserved.body.fileName, 'sample_walks.glb');
    assert.equal(reserved.body.copiedFromLibrary, true);
    assert.deepEqual(store.objects.get(reserved.body.stagingPath).bytes, Buffer.from('glTF-library'));
    const ingest = await post(server, '/api/jobs/ingest', { jobId: reserved.body.jobId, baseSha: HEAD_A, assetId: 'sample_operator', component: 'animation_collection' });
    assert.equal(ingest.status, 202, ingest.text);
    assert.equal(github.dispatches[0].inputs.component, 'animation_collection');
    assert.equal(github.dispatches[0].inputs.expected_size, String(Buffer.from('glTF-library').length));
    const badComponent = await post(server, '/api/uploads/library', { modelId: 'm1' });
    const rejected = await post(server, '/api/jobs/ingest', { jobId: badComponent.body.jobId, baseSha: HEAD_A, assetId: 'sample_operator', component: 'script' });
    assert.equal(rejected.status, 400);
  });
  assertContract(github);
});
