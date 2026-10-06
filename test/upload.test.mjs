import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadCloudModel } from '../lib/firebase-cloud.mjs';

const config = {
  projectId: 'rigcheck-cfbe3',
  ownerUid: 'owner-123',
  storageBucket: 'rigcheck-cfbe3.firebasestorage.app'
};

const inspection = {
  path: '/tmp/model.glb',
  fileName: 'Model.glb',
  sizeBytes: 123,
  sha256: 'a'.repeat(64),
  triangles: 1,
  meshes: 1,
  bones: 0,
  skins: 0,
  clips: 0,
  valid: true
};

test('upload dry-run performs duplicate reads but no writes', async () => {
  const calls = [];
  const contextFactory = async () => fakeContext(calls);
  const result = await uploadCloudModel(config, inspection, { dryRun: true, contextFactory });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.document.schemaVersion, 1);
  assert.equal(result.document.sha256, inspection.sha256);
  assert.deepEqual(calls, ['firestore.get', 'close']);
});

test('upload rolls Storage back when Firestore document creation fails', async () => {
  const calls = [];
  const contextFactory = async () => fakeContext(calls, { failFirestoreSet: true });

  await assert.rejects(
    uploadCloudModel(config, inspection, { contextFactory }),
    (error) => {
      assert.equal(error.code, 'FIRESTORE_WRITE_FAILED');
      assert.equal(error.details.rollbackSucceeded, true);
      return true;
    }
  );
  assert.deepEqual(calls, ['firestore.get', 'storage.file', 'storage.upload', 'firestore.set', 'storage.delete', 'close']);
});

function fakeContext(calls, { failFirestoreSet = false } = {}) {
  const models = {
    async get() {
      calls.push('firestore.get');
      return { docs: [] };
    },
    doc() {
      return {
        async set() {
          calls.push('firestore.set');
          if (failFirestoreSet) throw new Error('simulated Firestore failure');
        }
      };
    }
  };
  return {
    db: {
      collection() {
        return {
          doc() {
            return { collection: () => models };
          }
        };
      }
    },
    bucket: {
      file() {
        calls.push('storage.file');
        return {
          async delete() {
            calls.push('storage.delete');
          }
        };
      },
      async upload() {
        calls.push('storage.upload');
      }
    },
    async close() {
      calls.push('close');
    }
  };
}
