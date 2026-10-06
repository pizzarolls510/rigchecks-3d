import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCloudModelDocument,
  modelStoragePath,
  safeDisplayName,
  safeStorageName
} from '../dist/lib/model-schema.js';

test('model schema matches the website cloud document and adds version and hash', () => {
  const sha256 = 'a'.repeat(64);
  const document = createCloudModelDocument({
    modelId: 'model-1',
    originalName: 'Heavy_Gunner.glb',
    storagePath: 'users/user-1/models/model-1/Heavy_Gunner.glb',
    sizeBytes: 123,
    triangles: 12,
    meshes: 2,
    bones: 8,
    clips: 3,
    sha256,
    timestamp: 'SERVER_TIMESTAMP'
  });

  assert.deepEqual(document, {
    schemaVersion: 1,
    id: 'model-1',
    name: 'Heavy Gunner',
    originalName: 'Heavy_Gunner.glb',
    storagePath: 'users/user-1/models/model-1/Heavy_Gunner.glb',
    thumbnailPath: null,
    sizeBytes: 123,
    contentType: 'model/gltf-binary',
    triangles: 12,
    meshes: 2,
    bones: 8,
    clips: 3,
    sha256,
    favorite: false,
    uploadedAt: 'SERVER_TIMESTAMP',
    updatedAt: 'SERVER_TIMESTAMP',
    lastOpenedAt: 'SERVER_TIMESTAMP'
  });
});

test('shared filename helpers preserve website behavior', () => {
  assert.equal(safeDisplayName('Heavy_Gunner-v2.glb'), 'Heavy Gunner v2');
  assert.equal(safeStorageName('Heavy Gunner (final).glb'), 'Heavy_Gunner_final_.glb');
  assert.equal(modelStoragePath('user-1', 'model-1', 'Heavy Gunner.glb'), 'users/user-1/models/model-1/Heavy_Gunner.glb');
});
