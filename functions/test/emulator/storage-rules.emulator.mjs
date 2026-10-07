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
