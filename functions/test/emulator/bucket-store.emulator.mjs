// Runs only under `npm run test:emulator`. Exercises the real Storage adapter against the Storage emulator;
// GitHub is faked and URL signing is stubbed (the emulator cannot produce production V4 signatures).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { after, before, test } from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { createApp } from '../../src/app.js';
import { createBucketStore } from '../../src/bucket-store.js';
import { HEAD_A, createFakeGitHub, fakeVerifyIdToken, listen, lfsPointer, sha256 } from '../support/fakes.mjs';

assert.ok(process.env.FIREBASE_STORAGE_EMULATOR_HOST, 'run via `npm run test:emulator`');

let adminApp;
let bucket;

before(async () => {
  adminApp = initializeApp({ projectId: 'demo-rigcheck', storageBucket: 'demo-rigcheck.appspot.com' }, 'bucket-store-test');
  bucket = getStorage(adminApp).bucket();
  const [files] = await bucket.getFiles({ prefix: 'asset-library-cache/' });
  await Promise.all(files.map((file) => file.delete()));
});

after(async () => {
  await deleteApp(adminApp);
});

// Note: the Storage emulator does not enforce generation preconditions (verified: a copy or upload with a
// bogus ifGenerationMatch succeeds). The create-only option itself is asserted in bucket-store.test.mjs;
// here we check the streaming, copy, metadata and delete behavior the emulator does implement.
test('streams a resumable upload, copies with metadata, repeats idempotently, and deletes', async () => {
  const store = createBucketStore(bucket);
  const bytes = randomBytes(3 * 1024 * 1024 + 17);
  const tmpNames = ['asset-library-cache/tmp/t1', 'asset-library-cache/tmp/t2'];
  try {
    for (const tmpName of tmpNames) {
      await pipeline(Readable.from([bytes]), store.createWriteStream(tmpName, {
        contentType: 'model/gltf-binary',
        metadata: { contentId: 'lfs/test' }
      }));
      assert.equal(await store.exists(tmpName), true);
      // A repeat fill of a content-addressed name always carries identical, already-verified bytes.
      await store.copyIfAbsent(tmpName, 'asset-library-cache/lfs/test');
    }
    const [copied] = await bucket.file('asset-library-cache/lfs/test').download();
    assert.ok(copied.equals(bytes));
    const [metadata] = await bucket.file('asset-library-cache/lfs/test').getMetadata();
    assert.equal(metadata.contentType, 'model/gltf-binary');
    assert.equal(metadata.metadata.contentId, 'lfs/test');
  } finally {
    for (const tmpName of [...tmpNames, 'asset-library-cache/tmp/never-existed']) await store.delete(tmpName);
  }
  assert.equal(await store.exists('asset-library-cache/tmp/t1'), false);
});

test('end to end: an LFS-backed file request fills the emulator cache and a repeat request is a hit', async () => {
  const glb = randomBytes(5 * 1024 * 1024 + 3);
  const manifest = Buffer.from(JSON.stringify({
    schema_version: 1,
    assets: [{ asset_id: 'suit', revisions: [{ revision_id: 'rev', files: [{ path: 'assets/suit.glb' }] }] }]
  }));
  const github = createFakeGitHub({
    head: HEAD_A,
    commits: { [HEAD_A]: { 'docs/ASSET_MANIFEST.yaml': manifest, 'assets/suit.glb': lfsPointer(glb) } },
    lfs: { [sha256(glb)]: glb }
  });
  const store = createBucketStore(bucket);
  const signed = [];
  store.signedReadUrl = async (name, options) => {
    signed.push([name, options]);
    return `https://signed.example/${name}`;
  };
  const server = await listen(createApp({ verifyIdToken: fakeVerifyIdToken, github, store, logger: { error() {} } }));
  try {
    const query = '/api/file?asset=suit&revision=rev&path=assets%2Fsuit.glb';
    const first = await server.request(query, { token: 'reader' });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.cacheHit, false);
    const name = `asset-library-cache/lfs/${sha256(glb)}`;
    const [stored] = await bucket.file(name).download();
    assert.ok(stored.equals(glb), 'cache object holds the real LFS bytes');
    const [tmpFiles] = await bucket.getFiles({ prefix: 'asset-library-cache/tmp/' });
    assert.deepEqual(tmpFiles.map((file) => file.name), [], 'no temporary objects left behind');

    const second = await server.request(query, { token: 'reader' });
    assert.equal(second.body.cacheHit, true);
    assert.equal(github.byteFetches().length, 1);
    assert.deepEqual(signed.map(([signedName, options]) => [signedName, options.fileName, options.contentType]), [
      [name, 'suit.glb', 'model/gltf-binary'],
      [name, 'suit.glb', 'model/gltf-binary']
    ]);
  } finally {
    await server.close();
  }
});
