import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { authMiddleware, requireWriter } from '../src/access.js';
import { createApp, parseFileQuery } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { parseLfsPointer } from '../src/content-cache.js';
import {
  HEAD_A,
  HEAD_B,
  createFakeGitHub,
  createFakeStore,
  fakeVerifyIdToken,
  gitBlobSha,
  listen,
  lfsPointer,
  sha256
} from './support/fakes.mjs';

const PAGES = 'https://pizzarolls510.github.io';
const MANIFEST_PATH = 'docs/ASSET_MANIFEST.yaml';

const suitGlb = randomBytes(300 * 1024);
const suitTexture = randomBytes(40 * 1024);
const hudPng = randomBytes(12 * 1024);

function manifestBytes(note) {
  return Buffer.from(JSON.stringify({
    schema_version: 1,
    assets: [
      {
        asset_id: 'suit',
        display_name: 'Suit',
        category: 'operators',
        canonical_revision: 'rev_walk',
        revisions: [{
          revision_id: 'rev_walk',
          canonical_state: 'canonical',
          note,
          files: [
            { path: 'assets/operator/suit.glb', role: 'runtime', format: 'glb' },
            { path: 'assets/operator/suit_tex.jpg', role: 'textures', format: 'jpg' }
          ]
        }]
      },
      {
        asset_id: 'hud',
        display_name: 'HUD',
        category: 'ui',
        canonical_revision: 'rev_hud',
        revisions: [{
          revision_id: 'rev_hud',
          canonical_state: 'canonical',
          files: [
            { path: 'assets/ui/hud.png', role: 'runtime', format: 'png' },
            { path: 'assets/ui/unpushed.png', role: 'reference', format: 'png' }
          ]
        }]
      }
    ]
  }, null, 2));
}

function repoFiles(note) {
  return {
    [MANIFEST_PATH]: manifestBytes(note),
    'assets/operator/suit.glb': lfsPointer(suitGlb),
    'assets/operator/suit_tex.jpg': suitTexture,
    'assets/operator/unlisted_secret.glb': randomBytes(64),
    'assets/ui/hud.png': hudPng
  };
}

function harness({ lfs = { [sha256(suitGlb)]: suitGlb }, config = {}, clock } = {}) {
  const github = createFakeGitHub({
    head: HEAD_A,
    commits: { [HEAD_A]: repoFiles('state at A'), [HEAD_B]: repoFiles('state at B') },
    lfs
  });
  const store = createFakeStore();
  let tmpCounter = 0;
  const time = clock ?? { now: 1_800_000_000_000 };
  const app = createApp({
    verifyIdToken: fakeVerifyIdToken,
    github,
    store,
    config: { ...DEFAULT_CONFIG, ...config },
    now: () => time.now,
    makeTmpId: () => `tmp-${++tmpCounter}`,
    logger: { error() {} }
  });
  return { github, store, app, time };
}

async function withServer(app, run) {
  const server = await listen(app);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

const fileQuery = (asset, revision, path) =>
  `/api/file?asset=${encodeURIComponent(asset)}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(path)}`;

test('authentication: missing, malformed and invalid tokens get 401; no claim or unknown role gets 403', async () => {
  const { app, github } = harness();
  await withServer(app, async (server) => {
    for (const [options, status, code] of [
      [{}, 401, 'unauthenticated'],
      [{ headers: { Authorization: 'Basic abc' } }, 401, 'unauthenticated'],
      [{ token: 'forged' }, 401, 'unauthenticated'],
      [{ token: 'noclaim' }, 403, 'not_authorized'],
      [{ token: 'bogusrole' }, 403, 'not_authorized']
    ]) {
      const response = await server.request('/api/manifest', options);
      assert.equal(response.status, status, JSON.stringify(options));
      assert.equal(response.body.error.code, code);
    }
  });
  assert.equal(github.calls.length, 0, 'unauthorized requests never reach GitHub');
});

test('authorization: readers and writers can read; a reader on a writer-only route is rejected', async () => {
  const { app } = harness();
  await withServer(app, async (server) => {
    assert.equal((await server.request('/api/manifest', { token: 'reader' })).status, 200);
    assert.equal((await server.request('/api/manifest', { token: 'writer' })).status, 200);
  });

  const writerOnly = express();
  writerOnly.use(authMiddleware({ verifyIdToken: fakeVerifyIdToken }));
  writerOnly.post('/mutate', requireWriter, (req, res) => res.json({ ok: true }));
  await withServer(writerOnly, async (server) => {
    const reader = await server.request('/mutate', { token: 'reader', method: 'POST' });
    assert.equal(reader.status, 403);
    assert.equal(reader.body.error.code, 'writer_required');
    assert.equal((await server.request('/mutate', { token: 'writer', method: 'POST' })).status, 200);
  });
});

test('manifest is returned with the exact commit SHA it was read at; head lookups are briefly cached', async () => {
  const { app, github, time } = harness();
  await withServer(app, async (server) => {
    const first = await server.request('/api/manifest', { token: 'reader' });
    assert.equal(first.status, 200);
    assert.equal(first.body.commitSha, HEAD_A);
    assert.equal(first.body.branch, '3d-migration');
    assert.equal(first.body.manifestPath, MANIFEST_PATH);
    assert.equal(first.body.manifest.assets[0].revisions[0].note, 'state at A');
    assert.equal(first.headers.get('cache-control'), 'no-store');

    github.state.head = HEAD_B;
    const cached = await server.request('/api/manifest', { token: 'reader' });
    assert.equal(cached.body.commitSha, HEAD_A, 'within the head TTL the previous head is reused');

    time.now += DEFAULT_CONFIG.headCacheTtlMs + 1;
    const fresh = await server.request('/api/manifest', { token: 'reader' });
    assert.equal(fresh.body.commitSha, HEAD_B);
    assert.equal(fresh.body.manifest.assets[0].revisions[0].note, 'state at B', 'content always matches the SHA it is labelled with');
    assert.deepEqual(
      github.calls.filter(([name, , path]) => name === 'fileText' && path === MANIFEST_PATH).map(([, sha, path]) => [sha, path]),
      [[HEAD_A, MANIFEST_PATH], [HEAD_B, MANIFEST_PATH]]
    );
  });
});

test('traversal and malformed file requests are rejected before any GitHub or Storage call', async () => {
  const { app, github, store } = harness();
  await withServer(app, async (server) => {
    for (const query of [
      fileQuery('suit', 'rev_walk', '../docs/ASSET_MANIFEST.yaml'),
      fileQuery('suit', 'rev_walk', 'assets/operator/../../.git/config'),
      fileQuery('suit', 'rev_walk', '/etc/passwd'),
      fileQuery('suit', 'rev_walk', 'assets\\operator\\suit.glb'),
      fileQuery('suit', 'rev_walk', 'assets//operator/suit.glb'),
      fileQuery('suit', 'rev_walk', 'assets/./operator/suit.glb'),
      fileQuery('suit', 'rev_walk', 'assets/operator/suit.glb\u0000'),
      fileQuery('Suit!', 'rev_walk', 'assets/operator/suit.glb'),
      fileQuery('suit', '../rev', 'assets/operator/suit.glb'),
      '/api/file?asset=suit&revision=rev_walk',
      '/api/file?asset=suit&asset=hud&revision=rev_walk&path=assets/ui/hud.png'
    ]) {
      const response = await server.request(query, { token: 'reader' });
      assert.equal(response.status, 400, query);
      assert.equal(response.body.error.code, 'invalid_request', query);
    }
  });
  assert.equal(github.calls.length, 0);
  assert.equal(store.calls.length, 0);
});

test('a path not listed for that asset revision is rejected without fetching bytes or touching Storage', async () => {
  const { app, github, store } = harness();
  await withServer(app, async (server) => {
    for (const query of [
      fileQuery('suit', 'rev_walk', 'assets/operator/unlisted_secret.glb'),
      fileQuery('suit', 'rev_walk', 'assets/ui/hud.png'), // listed, but for a different asset
      fileQuery('suit', 'rev_missing', 'assets/operator/suit.glb'),
      fileQuery('ghost', 'rev_walk', 'assets/operator/suit.glb')
    ]) {
      const response = await server.request(query, { token: 'reader' });
      assert.equal(response.status, 404, query);
      assert.equal(response.body.error.code, 'not_registered', query);
    }
  });
  assert.deepEqual([...new Set(github.calls.map(([name]) => name))].sort(), ['branchHead', 'fileText'], 'only the manifest was read');
  assert.equal(store.calls.length, 0);
});

test('an LFS pointer resolves to lfs/<oid>, the LFS object fills the cache, and only a signed URL is returned', async () => {
  const { app, github, store, time } = harness();
  await withServer(app, async (server) => {
    const response = await server.request(fileQuery('suit', 'rev_walk', 'assets/operator/suit.glb'), { token: 'reader', origin: PAGES });
    assert.equal(response.status, 200, response.text);
    const oid = sha256(suitGlb);
    assert.deepEqual(Object.keys(response.body).sort(), ['cacheHit', 'commitSha', 'contentId', 'contentType', 'expiresAt', 'fileName', 'size', 'url']);
    assert.equal(response.body.contentId, `lfs/${oid}`);
    assert.equal(response.body.size, suitGlb.length);
    assert.equal(response.body.fileName, 'suit.glb');
    assert.equal(response.body.contentType, 'model/gltf-binary');
    assert.equal(response.body.commitSha, HEAD_A);
    assert.equal(response.body.cacheHit, false);
    assert.equal(response.body.expiresAt, new Date(time.now + 10 * 60 * 1000).toISOString());
    assert.match(response.body.url, /^https:\/\/storage\.googleapis\.com\/fake-bucket\/asset-library-cache\/lfs\//);

    const cached = store.objects.get(`asset-library-cache/lfs/${oid}`);
    assert.ok(cached, 'final content-addressed object exists');
    assert.ok(cached.bytes.equals(suitGlb), 'cache holds the real LFS bytes, not the pointer');
    assert.equal(cached.options.contentType, 'model/gltf-binary');
    assert.deepEqual(cached.options.metadata, {
      sourceRepo: 'pizzarolls510/invasion-godot',
      sourceSha: HEAD_A,
      path: 'assets/operator/suit.glb',
      contentId: `lfs/${oid}`
    });
    assert.equal([...store.objects.keys()].some((name) => name.includes('/tmp/')), false, 'temporary object removed');
    assert.deepEqual(github.byteFetches().map(([name]) => name), ['lfsDownloadStream']);

    // The browser-facing response never carries GitHub/LFS locations or asset bytes.
    assert.doesNotMatch(response.text, /github|lfs\.|githubusercontent|token/i);
    assert.ok(response.text.length < 1024);
  });
});

test('a plain git blob resolves to git/<blobSha> and is verified against the git object id', async () => {
  const { app, store, github } = harness();
  await withServer(app, async (server) => {
    const response = await server.request(fileQuery('hud', 'rev_hud', 'assets/ui/hud.png'), { token: 'reader' });
    assert.equal(response.status, 200, response.text);
    const blobSha = gitBlobSha(hudPng);
    assert.equal(response.body.contentId, `git/${blobSha}`);
    assert.equal(response.body.contentType, 'image/png');
    assert.ok(store.objects.get(`asset-library-cache/git/${blobSha}`).bytes.equals(hudPng));
    assert.deepEqual(github.byteFetches().map(([name]) => name), ['blobStream']);
  });
});

test('a cache hit signs a fresh URL without fetching any bytes from GitHub', async () => {
  const { app, github, store } = harness();
  await withServer(app, async (server) => {
    const path = fileQuery('suit', 'rev_walk', 'assets/operator/suit.glb');
    await server.request(path, { token: 'reader' });
    const before = github.byteFetches().length;
    const writesBefore = store.calls.filter(([name]) => name === 'createWriteStream').length;
    const second = await server.request(path, { token: 'writer' });
    assert.equal(second.status, 200);
    assert.equal(second.body.cacheHit, true);
    assert.equal(github.byteFetches().length, before);
    assert.equal(store.calls.filter(([name]) => name === 'createWriteStream').length, writesBefore);
  });
});

test('integrity mismatches (wrong bytes or wrong size) leave no cache object and return an error', async () => {
  const oid = sha256(suitGlb);
  const tampered = Buffer.from(suitGlb);
  tampered[1000] ^= 0xff;
  for (const [label, bytes] of [['wrong sha256', tampered], ['too short', suitGlb.subarray(0, 1000)], ['too long', Buffer.concat([suitGlb, Buffer.from('x')])]]) {
    const { app, store } = harness({ lfs: { [oid]: bytes } });
    await withServer(app, async (server) => {
      const response = await server.request(fileQuery('suit', 'rev_walk', 'assets/operator/suit.glb'), { token: 'reader' });
      assert.equal(response.status, 502, label);
      assert.equal(response.body.error.code, 'integrity_mismatch', label);
      assert.equal(store.objects.size, 0, `${label}: no final or temporary object remains`);
      assert.equal(store.calls.some(([name]) => name === 'signedReadUrl'), false);
    });
  }

  const { app, store, github } = harness();
  github.blobOverrides.set(gitBlobSha(hudPng), Buffer.from(hudPng).fill(7, 0, 10));
  await withServer(app, async (server) => {
    const response = await server.request(fileQuery('hud', 'rev_hud', 'assets/ui/hud.png'), { token: 'reader' });
    assert.equal(response.body.error.code, 'integrity_mismatch', 'git blob checked against its object id');
    assert.equal(store.objects.size, 0);
  });
});

test('a manifest-listed path that is not in the repository at that commit is not_published', async () => {
  const { app, store, github } = harness();
  await withServer(app, async (server) => {
    const response = await server.request(fileQuery('hud', 'rev_hud', 'assets/ui/unpushed.png'), { token: 'reader' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'not_published');
    assert.equal(response.body.error.message, 'Not yet available from the authoritative repository.');
  });
  assert.equal(store.calls.length, 0);
  assert.equal(github.byteFetches().length, 0);
});

test('files above the delivery limit are refused before any byte transfer', async () => {
  const { app, github, store } = harness({ config: { maxAssetBytes: 1000 } });
  await withServer(app, async (server) => {
    const response = await server.request(fileQuery('suit', 'rev_walk', 'assets/operator/suit.glb'), { token: 'reader' });
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, 'asset_too_large');
  });
  assert.equal(github.byteFetches().length, 0);
  assert.equal(store.objects.size, 0);
});

test('concurrent cache misses for the same content are harmless and produce one object', async () => {
  const { app, store } = harness();
  await withServer(app, async (server) => {
    const path = fileQuery('suit', 'rev_walk', 'assets/operator/suit.glb');
    const responses = await Promise.all([1, 2, 3].map(() => server.request(path, { token: 'reader' })));
    assert.ok(responses.every((response) => response.status === 200));
    assert.deepEqual([...store.objects.keys()], [`asset-library-cache/lfs/${sha256(suitGlb)}`]);
  });
});

test('CORS: Pages and local dev origins are allowed with preflight; other origins are refused', async () => {
  const { app } = harness();
  await withServer(app, async (server) => {
    const preflight = await server.request('/api/file', {
      method: 'OPTIONS',
      origin: PAGES,
      headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), PAGES);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);

    const allowed = await server.request('/api/manifest', { token: 'reader', origin: PAGES });
    assert.equal(allowed.headers.get('access-control-allow-origin'), PAGES);
    assert.equal(allowed.headers.get('vary'), 'Origin');

    const dev = await server.request('/api/manifest', { token: 'reader', origin: 'http://127.0.0.1:5001' });
    assert.equal(dev.status, 200);

    for (const origin of ['https://evil.example', 'https://pizzarolls510.github.io.evil.example', 'http://localhost.evil.example']) {
      const refused = await server.request('/api/manifest', { token: 'reader', origin });
      assert.equal(refused.status, 403, origin);
      assert.equal(refused.body.error.code, 'origin_not_allowed');
      assert.equal(refused.headers.get('access-control-allow-origin'), null);
    }

    const noOrigin = await server.request('/api/manifest', { token: 'reader' });
    assert.equal(noOrigin.status, 200, 'non-browser clients still rely on token auth');
  });
});

test('unknown endpoints return a JSON 404 and upstream failures a generic 502', async () => {
  const { app, github } = harness();
  github.branchHead = async () => {
    const { UpstreamError } = await import('../src/errors.js');
    throw new UpstreamError(500, 'boom with secret details');
  };
  await withServer(app, async (server) => {
    const unknown = await server.request('/api/nope', { token: 'reader' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'not_found');
    const upstream = await server.request('/api/manifest', { token: 'reader' });
    assert.equal(upstream.status, 502);
    assert.equal(upstream.body.error.code, 'upstream_error');
    assert.doesNotMatch(upstream.text, /secret details/);
  });
});

test('parseFileQuery and parseLfsPointer accept only well-formed input', () => {
  assert.deepEqual(parseFileQuery({ asset: 'sample_asset', revision: 'baseline_0123456789abcdef', path: 'assets/a b/c.glb' }), {
    assetId: 'sample_asset',
    revisionId: 'baseline_0123456789abcdef',
    path: 'assets/a b/c.glb'
  });
  assert.throws(() => parseFileQuery({ asset: 'a', revision: 'r', path: 'x/'.repeat(300) }), /repository-relative/);
  assert.equal(parseLfsPointer('not a pointer'), null);
  assert.equal(parseLfsPointer('version https://git-lfs.github.com/spec/v1\noid sha256:xyz\nsize 1\n'), null);
  const pointer = lfsPointer(Buffer.from('hello')).toString();
  assert.deepEqual(parseLfsPointer(pointer), { oid: sha256(Buffer.from('hello')), size: 5 });
});
