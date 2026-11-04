// Asset Library HTTP API. Phase 2: read-only manifest and file resolution; asset bytes are delivered exclusively
// through short-lived signed Storage URLs. Phase 4: writer-only upload reservations and job dispatch, and job
// status for any role (see jobs.js).
import { randomUUID } from 'node:crypto';
import express from 'express';
import { authMiddleware, corsMiddleware, createAgentResolver, requirePermission } from './access.js';
import { createAuditLog } from './audit.js';
import { DEFAULT_CONFIG } from './config.js';
import { contentTypeFor, ensureCached, resolveContent } from './content-cache.js';
import { ApiError, errorHandler, sendError } from './errors.js';
import { createJobService, publicJob } from './jobs.js';
import { duplicateMatches, resolveAssetName } from './identity.js';
import { createManifestSource, findListedFile } from './manifest-source.js';
import { PERMISSIONS } from './permissions.js';
import { createProfilesSource } from './profiles-source.js';
import { MAX_TEXT, MAX_UPLOAD_BYTES } from './runner-contract.js';
import { createVocabularySource, publicVocabulary } from './vocabulary.js';

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
  verifyAgentToken = null,
  github,
  store,
  db,
  config = DEFAULT_CONFIG,
  now = Date.now,
  makeTmpId = randomUUID,
  makeJobId = randomUUID,
  logger = console
}) {
  const source = createManifestSource({
    github,
    branch: config.manifestBranch,
    manifestPath: config.manifestPath,
    headCacheTtlMs: config.headCacheTtlMs,
    now
  });
  const vocabulary = createVocabularySource({ github, path: config.vocabularyPath });
  const profiles = createProfilesSource({ github, path: config.rigProfilesPath ?? 'docs/ASSET_RIG_PROFILES.json' });
  const jobs = createJobService({ db, github, store, source, vocabulary, profiles, config, now, makeJobId, logger });
  const jsonBody = express.json({ limit: '16kb', strict: true });
  const audit = createAuditLog({ db, config, now, logger });
  const resolveAgent = verifyAgentToken ? createAgentResolver({ db, config, now }) : null;
  const can = (permission) => requirePermission(permission);
  const started = (res, job) => {
    res.locals.jobId = job.jobId;
    return { job: publicJob(job) };
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(corsMiddleware({ allowedOrigins: config.allowedOrigins, allowDevOrigins: config.allowDevOrigins }));
  app.use('/api', audit.middleware);
  app.use('/api', authMiddleware({ verifyIdToken, verifyAgentToken, resolveAgent }));
  app.locals.audit = audit;

  // Who the API takes the caller to be, so an agent host can prove its credentials end to end (never secrets).
  app.get('/api/whoami', (req, res) => {
    const principal = req.principal;
    res.json({
      kind: principal.kind,
      id: principal.id,
      role: principal.role,
      permissions: [...principal.permissions].sort(),
      ignoredPermissions: principal.ignoredPermissions ?? [],
      tokenExpiresAt: principal.tokenExpiresAt ? new Date(principal.tokenExpiresAt).toISOString() : null
    });
  });

  // Which logical asset a name means (asset ID or declared alias), before anything is uploaded.
  app.get('/api/identity/resolve', can(PERMISSIONS.identityCheck), async (req, res) => {
    const { sha, manifest } = await source.current();
    res.json({ commitSha: sha, ...resolveAssetName(manifest, req.query.name) });
  });

  // Whether these exact bytes (SHA-256) are already recorded anywhere, before anything is uploaded.
  app.post('/api/identity/check', can(PERMISSIONS.identityCheck), jsonBody, async (req, res) => {
    const { sha, manifest } = await source.current();
    res.json({ commitSha: sha, matches: duplicateMatches(manifest, req.body) });
  });

  app.get('/api/manifest', can(PERMISSIONS.libraryRead), async (req, res) => {
    const { sha, manifest } = await source.current();
    // Form choices for the write UI, from the pipeline at the same commit. Browsing never depends on it.
    let pipelineVocabulary = null;
    try {
      pipelineVocabulary = { ...publicVocabulary(await vocabulary.at(sha)), maxUploadBytes: MAX_UPLOAD_BYTES, textLimits: MAX_TEXT };
    } catch (error) {
      logger.error('Asset Library vocabulary unavailable', { sha, code: error?.code, message: error?.message });
    }
    // Private rig profiles for client-side classification of files before upload (null on older commits).
    let rigProfiles = null;
    try {
      rigProfiles = await profiles.at(sha);
    } catch (error) {
      logger.error('Asset Library rig profiles unavailable', { sha, message: error?.message });
    }
    res.json({
      commitSha: sha,
      branch: config.manifestBranch,
      manifestPath: config.manifestPath,
      manifest,
      vocabulary: pipelineVocabulary,
      rigProfiles
    });
  });

  app.get('/api/file', can(PERMISSIONS.libraryRead), async (req, res) => {
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

  app.post('/api/uploads', can(PERMISSIONS.uploadCandidate), jsonBody, async (req, res) => {
    const reservation = await jobs.reserveUpload(req.assetUser, req.body);
    res.locals.jobId = reservation.jobId;
    res.status(201).json(reservation);
  });

  app.post('/api/uploads/library', can(PERMISSIONS.libraryImport), jsonBody, async (req, res) => {
    const reservation = await jobs.reserveFromLibrary(req.assetUser, req.body);
    res.locals.jobId = reservation.jobId;
    res.status(201).json(reservation);
  });

  app.post('/api/jobs/animate', can(PERMISSIONS.animateCandidate), jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startAnimate(req.assetUser, req.body)));
  });

  app.post('/api/jobs/bind', can(PERMISSIONS.bind), jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startBind(req.assetUser, req.body)));
  });

  app.post('/api/jobs/ingest', can(PERMISSIONS.ingestCandidate), jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startIngest(req.assetUser, req.body)));
  });

  // Dry run (promote:dry_run) or confirm (promote:confirm, people only); the service checks which one is asked for.
  app.post('/api/jobs/promote', jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startPromote(req.assetUser, req.body)));
  });

  app.post('/api/jobs/annotate', can(PERMISSIONS.annotate), jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startAnnotate(req.assetUser, req.body)));
  });

  // archive | reject | unarchive; the service checks archive (people) or archive:candidate (agents, candidates only).
  app.post('/api/jobs/lifecycle', jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startLifecycle(req.assetUser, req.body)));
  });

  // Rollback: dry run (restore:dry_run) or confirm (restore:confirm, people only).
  app.post('/api/jobs/restore', jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startRestore(req.assetUser, req.body)));
  });

  app.post('/api/jobs/report', can(PERMISSIONS.libraryRead), jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startReport(req.assetUser, req.body)));
  });

  app.post('/api/jobs/validate', can(PERMISSIONS.validate), jsonBody, async (req, res) => {
    res.status(202).json(started(res, await jobs.startValidate(req.assetUser, req.body)));
  });

  app.get('/api/jobs', can(PERMISSIONS.jobsRead), async (req, res) => {
    res.json({ jobs: await jobs.listJobs(req.query.asset) });
  });

  app.get('/api/jobs/:jobId', can(PERMISSIONS.jobsRead), async (req, res) => {
    res.json({ job: publicJob(await jobs.getJob(req.params.jobId)) });
  });

  app.use((req, res) => sendError(res, 404, 'not_found', 'Unknown Asset Library endpoint.'));
  app.use(errorHandler(logger));
  return app;
}
