// Asset Library HTTP API (Phase 2: read-only). Authorization and resolution only; asset bytes are delivered
// exclusively through short-lived signed Storage URLs.
import { randomUUID } from 'node:crypto';
import express from 'express';
import { authMiddleware, corsMiddleware } from './access.js';
import { DEFAULT_CONFIG } from './config.js';
import { contentTypeFor, ensureCached, resolveContent } from './content-cache.js';
import { ApiError, errorHandler, sendError } from './errors.js';
import { createManifestSource, findListedFile } from './manifest-source.js';

// Same identifier rules as tools/asset_pipeline/common.py (ID, REVISION_ID).
const ASSET_ID = /^[a-z][a-z0-9_]{0,63}$/;
const REVISION_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const MAX_PATH_LENGTH = 512;

// Purely syntactic screening, applied before any GitHub or Storage call. The authoritative check is still
// that the exact path is listed in the revision's files[] at the current commit.
export function parseFileQuery(query) {
  const { asset, revision, path } = query ?? {};
  const invalid = (message) => new ApiError(400, 'invalid_request', message);
  if (typeof asset !== 'string' || !ASSET_ID.test(asset)) throw invalid('A valid asset ID is required.');
  if (typeof revision !== 'string' || !REVISION_ID.test(revision)) throw invalid('A valid revision ID is required.');
  if (typeof path !== 'string' || !path || path.length > MAX_PATH_LENGTH) throw invalid('A repository-relative file path is required.');
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalid('File paths must be plain repository-relative paths.');
  }
  return { assetId: asset, revisionId: revision, path };
}

export function createApp({
  verifyIdToken,
  github,
  store,
  config = DEFAULT_CONFIG,
  now = Date.now,
  makeTmpId = randomUUID,
  logger = console
}) {
  const source = createManifestSource({
    github,
    branch: config.manifestBranch,
    manifestPath: config.manifestPath,
    headCacheTtlMs: config.headCacheTtlMs,
    now
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(corsMiddleware({ allowedOrigins: config.allowedOrigins, allowDevOrigins: config.allowDevOrigins }));
  app.use('/api', authMiddleware({ verifyIdToken }));

  app.get('/api/manifest', async (req, res) => {
    const { sha, manifest } = await source.current();
    res.json({
      commitSha: sha,
      branch: config.manifestBranch,
      manifestPath: config.manifestPath,
      manifest
    });
  });

  app.get('/api/file', async (req, res) => {
    const { assetId, revisionId, path } = parseFileQuery(req.query);
    const { sha, manifest } = await source.current();
    if (!findListedFile(manifest, assetId, revisionId, path)) {
      throw new ApiError(404, 'not_registered', 'That file is not listed for this asset revision in the manifest.');
    }

    const content = await resolveContent({ source, github, commitSha: sha, path });
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    const contentType = contentTypeFor(path);
    const cached = await ensureCached({
      store,
      github,
      content,
      contentType,
      maxBytes: config.maxAssetBytes,
      makeTmpId,
      // Debugging aid only; never read back as truth.
      metadata: {
        sourceRepo: `${config.githubOwner}/${config.githubRepo}`,
        sourceSha: sha,
        path,
        contentId: content.contentId
      }
    });

    const expiresAt = now() + config.signedUrlTtlMs;
    const url = await store.signedReadUrl(cached.name, { expiresAt, fileName, contentType });
    res.json({
      url,
      expiresAt: new Date(expiresAt).toISOString(),
      contentId: content.contentId,
      size: content.size,
      fileName,
      contentType,
      commitSha: sha,
      cacheHit: cached.cacheHit
    });
  });

  app.use((req, res) => sendError(res, 404, 'not_found', 'Unknown Asset Library endpoint.'));
  app.use(errorHandler(logger));
  return app;
}
