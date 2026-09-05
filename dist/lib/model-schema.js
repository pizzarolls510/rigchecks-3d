export const RIGCHECK_SCHEMA_VERSION = 1;
export const RIGCHECK_PROJECT_ID = 'rigcheck-cfbe3';
export const RIGCHECK_STORAGE_BUCKET = 'rigcheck-cfbe3.firebasestorage.app';
export const MAX_GLB_BYTES = 200 * 1024 * 1024;
export const GLB_CONTENT_TYPE = 'model/gltf-binary';

export function safeDisplayName(fileName) {
  return fileName.replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim() || 'Untitled model';
}

export function safeStorageName(fileName) {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'model.glb';
}

export function modelStoragePath(ownerUid, modelId, originalName) {
  return `users/${ownerUid}/models/${modelId}/${safeStorageName(originalName)}`;
}

export function createCloudModelDocument({
  modelId,
  originalName,
  storagePath,
  sizeBytes,
  triangles,
  meshes,
  bones,
  clips,
  thumbnailPath = null,
  sha256 = null,
  timestamp
}) {
  if (!modelId || !originalName || !storagePath) {
    throw new Error('modelId, originalName, and storagePath are required.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error('sizeBytes must be a non-negative integer.');
  }
  if (sha256 !== null && !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('sha256 must be a 64-character hexadecimal digest or null.');
  }
  if (timestamp === undefined) {
    throw new Error('timestamp is required.');
  }

  return {
    schemaVersion: RIGCHECK_SCHEMA_VERSION,
    id: modelId,
    name: safeDisplayName(originalName),
    originalName,
    storagePath,
    thumbnailPath,
    sizeBytes,
    contentType: GLB_CONTENT_TYPE,
    triangles: nullableCount(triangles),
    meshes: nullableCount(meshes),
    bones: nullableCount(bones),
    clips: nullableCount(clips),
    sha256: sha256?.toLowerCase() || null,
    favorite: false,
    uploadedAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp
  };
}

function nullableCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}
