import { randomUUID } from 'node:crypto';
import { FieldValue, Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import {
  createCloudModelDocument,
  GLB_CONTENT_TYPE,
  modelStoragePath
} from '../dist/lib/model-schema.js';

export class CloudError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.details = details;
  }
}

export async function createCloudContext(config) {
  const auth = new GoogleAuth({
    projectId: config.projectId,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const db = new Firestore({ projectId: config.projectId });
  const storage = new Storage({ projectId: config.projectId });

  return {
    auth,
    db,
    bucket: storage.bucket(config.storageBucket),
    async close() {
      await db.terminate();
    }
  };
}

export async function verifyCloudAccess(config) {
  const context = await createCloudContext(config);
  const checks = {
    adc: { ok: false, message: 'Application Default Credentials are unavailable.' },
    firestore: { ok: false, message: 'Firestore was not checked.' },
    storage: { ok: false, message: 'Cloud Storage was not checked.' }
  };

  try {
    const authClient = await context.auth.getClient();
    await authClient.getAccessToken();
    checks.adc = { ok: true, message: 'Application Default Credentials produced an access token.' };

    try {
      await context.db.collection('users').doc(config.ownerUid).collection('models').limit(1).get();
      checks.firestore = { ok: true, message: `Firestore can read users/${config.ownerUid}/models.` };
    } catch (error) {
      checks.firestore = { ok: false, message: cloudMessage(error, 'Firestore read failed.') };
    }

    try {
      const [metadata] = await context.bucket.getMetadata();
      checks.storage = {
        ok: true,
        message: `Cloud Storage bucket ${context.bucket.name} is reachable.`,
        location: metadata.location || null
      };
    } catch (error) {
      checks.storage = { ok: false, message: cloudMessage(error, 'Cloud Storage read failed.') };
    }
  } catch (error) {
    checks.adc = { ok: false, message: cloudMessage(error, 'Application Default Credentials are unavailable.') };
  } finally {
    await context.close();
  }

  return checks;
}

export async function listCloudModels(config) {
  const context = await createCloudContext(config);
  try {
    const snapshot = await context.db
      .collection('users')
      .doc(config.ownerUid)
      .collection('models')
      .orderBy('updatedAt', 'desc')
      .get();
    return snapshot.docs.map((entry) => normalizeModel(entry.id, entry.data()));
  } catch (error) {
    throw new CloudError('LIST_FAILED', cloudMessage(error, 'Could not list RigCheck cloud models.'));
  } finally {
    await context.close();
  }
}

export async function uploadCloudModel(config, inspection, { dryRun = false, contextFactory = createCloudContext } = {}) {
  const context = await contextFactory(config);
  let uploadedFile = null;

  try {
    const existing = await readModels(context.db, config.ownerUid);
    const exactDuplicate = existing.find((model) => model.sha256 && model.sha256 === inspection.sha256);
    const likelyDuplicates = existing.filter((model) =>
      !model.sha256
      && model.originalName === inspection.fileName
      && model.sizeBytes === inspection.sizeBytes
    );

    if (exactDuplicate) {
      return {
        status: 'duplicate',
        dryRun,
        modelId: exactDuplicate.id,
        duplicateOf: exactDuplicate.id,
        sha256: inspection.sha256,
        message: 'An existing model has the same SHA-256; no upload was performed.'
      };
    }

    const modelId = randomUUID();
    const storagePath = modelStoragePath(config.ownerUid, modelId, inspection.fileName);
    const timestamp = dryRun ? 'SERVER_TIMESTAMP' : FieldValue.serverTimestamp();
    const document = createCloudModelDocument({
      modelId,
      originalName: inspection.fileName,
      storagePath,
      sizeBytes: inspection.sizeBytes,
      triangles: inspection.triangles,
      meshes: inspection.meshes,
      bones: inspection.bones,
      clips: inspection.clips,
      sha256: inspection.sha256,
      timestamp
    });

    if (dryRun) {
      return {
        status: 'dry-run',
        dryRun: true,
        modelId,
        storagePath,
        likelyDuplicates: likelyDuplicates.map(duplicateSummary),
        document
      };
    }

    uploadedFile = context.bucket.file(storagePath);
    await context.bucket.upload(inspection.path, {
      destination: storagePath,
      resumable: inspection.sizeBytes >= 5 * 1024 * 1024,
      validation: 'crc32c',
      metadata: {
        contentType: GLB_CONTENT_TYPE,
        metadata: {
          originalName: inspection.fileName,
          sha256: inspection.sha256,
          schemaVersion: String(document.schemaVersion)
        }
      }
    });

    try {
      await context.db
        .collection('users')
        .doc(config.ownerUid)
        .collection('models')
        .doc(modelId)
        .set(document);
    } catch (firestoreError) {
      let rollbackError = null;
      try {
        await uploadedFile.delete({ ignoreNotFound: true });
      } catch (error) {
        rollbackError = cloudMessage(error, 'Storage rollback failed.');
      }
      throw new CloudError(
        'FIRESTORE_WRITE_FAILED',
        rollbackError
          ? 'Firestore creation failed and the uploaded Storage object could not be rolled back.'
          : 'Firestore creation failed; the uploaded Storage object was rolled back.',
        { storagePath, rollbackSucceeded: !rollbackError, rollbackError }
      );
    }

    return {
      status: 'uploaded',
      dryRun: false,
      modelId,
      storagePath,
      sha256: inspection.sha256,
      likelyDuplicates: likelyDuplicates.map(duplicateSummary),
      document: normalizeModel(modelId, document)
    };
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError('UPLOAD_FAILED', cloudMessage(error, 'RigCheck cloud upload failed.'));
  } finally {
    await context.close();
  }
}

async function readModels(db, ownerUid) {
  const snapshot = await db.collection('users').doc(ownerUid).collection('models').get();
  return snapshot.docs.map((entry) => normalizeModel(entry.id, entry.data()));
}

function duplicateSummary(model) {
  return {
    id: model.id,
    name: model.name || null,
    originalName: model.originalName || null,
    sizeBytes: model.sizeBytes ?? null,
    sha256: model.sha256 || null
  };
}

function normalizeModel(id, model) {
  return {
    ...model,
    id: model.id || id,
    uploadedAt: timestampToIso(model.uploadedAt),
    updatedAt: timestampToIso(model.updatedAt),
    lastOpenedAt: timestampToIso(model.lastOpenedAt)
  };
}

function timestampToIso(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value && typeof value === 'object' && '_methodName' in value) return 'SERVER_TIMESTAMP';
  return value ?? null;
}

function cloudMessage(error, fallback) {
  const code = error?.code ? ` (${String(error.code)})` : '';
  return `${fallback}${code}`;
}
