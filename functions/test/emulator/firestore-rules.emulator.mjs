// Runs only under `npm run test:emulator` (Firestore emulator).
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, getDocs, collection, setDoc, updateDoc } from 'firebase/firestore';

const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rigcheck',
    firestore: { host, port: Number(port), rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8') }
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'assetLibraryJobs/job-0001-test'), { status: 'queued', uid: 'writer-uid' });
    await setDoc(doc(db, 'assetLibraryLocks/mutation'), { jobId: 'job-0001-test' });
    await setDoc(doc(db, 'assetLibraryRate/writer-uid'), { dispatch: { count: 1 } });
  });
});

after(async () => {
  await env?.cleanup();
});

test('any Asset Library role can read job status; nobody else can', async () => {
  for (const claims of [{ assetLibraryRole: 'writer' }, { assetLibraryRole: 'reader' }]) {
    const db = env.authenticatedContext('some-uid', claims).firestore();
    await assertSucceeds(getDoc(doc(db, 'assetLibraryJobs/job-0001-test')));
    await assertSucceeds(getDocs(collection(db, 'assetLibraryJobs')));
  }
  for (const db of [env.authenticatedContext('plain-uid').firestore(), env.authenticatedContext('x', { assetLibraryRole: 'admin' }).firestore(), env.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(doc(db, 'assetLibraryJobs/job-0001-test')));
  }
});

test('clients never write job metadata, and never read or write the lock or rate counters', async () => {
  const writer = env.authenticatedContext('writer-uid', { assetLibraryRole: 'writer' }).firestore();
  await assertFails(setDoc(doc(writer, 'assetLibraryJobs/job-0002-test'), { status: 'done' }));
  await assertFails(updateDoc(doc(writer, 'assetLibraryJobs/job-0001-test'), { status: 'done' }));
  await assertFails(deleteDoc(doc(writer, 'assetLibraryJobs/job-0001-test')));
  for (const path of ['assetLibraryLocks/mutation', 'assetLibraryRate/writer-uid']) {
    await assertFails(getDoc(doc(writer, path)));
    await assertFails(setDoc(doc(writer, path), { forged: true }));
    await assertFails(deleteDoc(doc(writer, path)));
  }
});

test('existing Cloud Library owner rules are unchanged', async () => {
  const owner = env.authenticatedContext('owner-uid').firestore();
  const other = env.authenticatedContext('other-uid').firestore();
  await assertSucceeds(setDoc(doc(owner, 'users/owner-uid/models/m1'), { name: 'm' }));
  await assertSucceeds(getDoc(doc(owner, 'users/owner-uid/models/m1')));
  await assertFails(getDoc(doc(other, 'users/owner-uid/models/m1')));
  await assertFails(setDoc(doc(other, 'users/owner-uid/models/m2'), { name: 'x' }));
});
