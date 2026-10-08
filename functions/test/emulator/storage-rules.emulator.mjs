// Runs only under `npm run test:emulator` (Firebase Storage emulator).
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

const [host, port] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199').split(':');
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rigcheck',
    storage: { host, port: Number(port), rules: readFileSync(new URL('../../../storage.rules', import.meta.url), 'utf8') }
  });
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (context) => {
    await uploadBytes(ref(context.storage(), 'asset-library-cache/lfs/abc'), new Uint8Array([1, 2, 3]));
  });
});

after(async () => {
  await env?.cleanup();
});

test('no client identity can read or write the Asset Library cache, writers included', async () => {
  const writer = env.authenticatedContext('writer-uid', { assetLibraryRole: 'writer' }).storage();
  const reader = env.authenticatedContext('reader-uid', { assetLibraryRole: 'reader' }).storage();
  const anonymous = env.unauthenticatedContext().storage();
  for (const storage of [writer, reader, anonymous]) {
    await assertFails(getBytes(ref(storage, 'asset-library-cache/lfs/abc')));
    await assertFails(uploadBytes(ref(storage, 'asset-library-cache/lfs/new'), new Uint8Array([9])));
    await assertFails(uploadBytes(ref(storage, 'asset-library-cache/tmp/x'), new Uint8Array([9])));
  }
});

test('existing Cloud Library owner rules are unchanged', async () => {
  const owner = env.authenticatedContext('owner-uid').storage();
  const other = env.authenticatedContext('other-uid').storage();
  const path = 'users/owner-uid/models/m1/model.glb';
  await assertSucceeds(uploadBytes(ref(owner, path), new Uint8Array([1])));
  await assertSucceeds(getBytes(ref(owner, path)));
  await assertFails(getBytes(ref(other, path)));
  await assertFails(uploadBytes(ref(other, path), new Uint8Array([2])));
});

test('only an Asset Library writer can stage a supported upload, only in their own folder, and nobody reads it back', async () => {
  const writer = env.authenticatedContext('writer-uid', { assetLibraryRole: 'writer' }).storage();
  const reader = env.authenticatedContext('reader-uid', { assetLibraryRole: 'reader' }).storage();
  const plain = env.authenticatedContext('plain-uid').storage();
  const anonymous = env.unauthenticatedContext().storage();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const own = 'asset-library-staging/writer-uid/job-0001-test/Walk Cycle_v2.glb';

  await assertSucceeds(uploadBytes(ref(writer, own), bytes));
  await assertSucceeds(uploadBytes(ref(writer, own), bytes), 'a retry of the same upload is allowed');
  await assertSucceeds(uploadBytes(ref(writer, 'asset-library-staging/writer-uid/job-0002-test/HUD.PNG'), bytes));

  for (const [label, storage, path, data = bytes] of [
    ['reader', reader, 'asset-library-staging/reader-uid/job-0001-test/a.glb'],
    ['no claim', plain, 'asset-library-staging/plain-uid/job-0001-test/a.glb'],
    ['anonymous', anonymous, 'asset-library-staging/anon/job-0001-test/a.glb'],
    ['another user folder', writer, 'asset-library-staging/other-uid/job-0001-test/a.glb'],
    ['unsupported type', writer, 'asset-library-staging/writer-uid/job-0001-test/run.exe'],
    ['no extension', writer, 'asset-library-staging/writer-uid/job-0001-test/model'],
    ['hidden file', writer, 'asset-library-staging/writer-uid/job-0001-test/.glb'],
    ['bad job id', writer, 'asset-library-staging/writer-uid/short/a.glb'],
    ['nested path', writer, 'asset-library-staging/writer-uid/job-0001-test/sub/a.glb'],
    ['empty file', writer, 'asset-library-staging/writer-uid/job-0001-test/empty.glb', new Uint8Array([])]
  ]) {
    await assertFails(uploadBytes(ref(storage, path), data), label);
  }

  for (const storage of [writer, reader, anonymous]) await assertFails(getBytes(ref(storage, own)));
  const { deleteObject } = await import('firebase/storage');
  await assertFails(deleteObject(ref(writer, own)));
});
