import assert from 'node:assert/strict';
import test from 'node:test';
import { createBucketStore } from '../src/bucket-store.js';

function stubBucket(copyBehavior) {
  const calls = [];
  const file = (name) => ({
    name,
    async copy(destination, options) {
      calls.push(['copy', name, destination.name, options]);
      return copyBehavior();
    },
    async getSignedUrl(options) {
      calls.push(['getSignedUrl', name, options]);
      return ['https://signed.example/url'];
    },
    async delete(options) {
      calls.push(['delete', name, options]);
    }
  });
  return { bucket: { file }, calls };
}

test('copyIfAbsent asks Storage for a create-only copy (ifGenerationMatch: 0)', async () => {
  const { bucket, calls } = stubBucket(async () => {});
  await createBucketStore(bucket).copyIfAbsent('asset-library-cache/tmp/1', 'asset-library-cache/lfs/x');
  assert.deepEqual(calls, [['copy', 'asset-library-cache/tmp/1', 'asset-library-cache/lfs/x', { preconditionOpts: { ifGenerationMatch: 0 } }]]);
});

test('copyIfAbsent treats 412 (already cached) as success and rethrows anything else', async () => {
  const exists = stubBucket(async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
  await createBucketStore(exists.bucket).copyIfAbsent('a', 'b');
  const denied = stubBucket(async () => { throw Object.assign(new Error('forbidden'), { code: 403 }); });
  await assert.rejects(createBucketStore(denied.bucket).copyIfAbsent('a', 'b'), /forbidden/);
});

test('signedReadUrl requests a V4 read URL with the exact expiry, filename and content type', async () => {
  const { bucket, calls } = stubBucket(async () => {});
  const url = await createBucketStore(bucket).signedReadUrl('asset-library-cache/lfs/x', {
    expiresAt: 1_800_000_600_000,
    fileName: 'suit "walk".glb',
    contentType: 'model/gltf-binary'
  });
  assert.equal(url, 'https://signed.example/url');
  assert.deepEqual(calls[0][2], {
    version: 'v4',
    action: 'read',
    expires: 1_800_000_600_000,
    responseDisposition: 'inline; filename="suit _walk_.glb"; filename*=UTF-8\'\'suit%20%22walk%22.glb',
    responseType: 'model/gltf-binary'
  });
});

test('delete ignores objects that are already gone', async () => {
  const { bucket, calls } = stubBucket(async () => {});
  await createBucketStore(bucket).delete('asset-library-cache/tmp/1');
  assert.deepEqual(calls, [['delete', 'asset-library-cache/tmp/1', { ignoreNotFound: true }]]);
});
