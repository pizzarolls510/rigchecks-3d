// Asset Library jobs (Phase 4): upload reservations, dispatch of the GitHub Actions job runner, the mutation
// lock, per-user rate limits and result polling. The job interface is owned here, so the runner can be swapped
// without touching the UI. Inputs are only ever fixed, validated fields mapped onto the runner's contract.
import { unzipSync, strFromU8 } from 'fflate';
import { ApiError, UpstreamError } from './errors.js';
import { TERMINAL_STATUSES, consumeRate, lockIsHeld } from './job-store.js';
import { PERMISSIONS } from './permissions.js';
import { slotPolicy } from './profiles-source.js';
import {
  BASE_SHA,
  JOB_ID,
  MAX_JSON,
  MAX_SOURCES,
  MAX_UPLOAD_BYTES,
  MAX_JSON as RUNNER_JSON,
  buildDispatchInputs,
  checkDestination,
  checkFileName,
  checkText,
  invalid
} from './runner-contract.js';

const UID = /^[A-Za-z0-9_-]{1,128}$/;
// Syntactic screening only (the pipeline's ID rule); listing reads job metadata, never the manifest.
const LIST_ASSET_ID = /^[a-z][a-z0-9_]{0,63}$/;
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const MAX_ERROR_MESSAGE = 2000;
const LIBRARY_MODEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Recipe keys mirror tools/animation/bake.py; the runner and the bake re-validate everything.
const RECIPE_KEYS = ['overrides', 'options', 'thresholds'];
const OVERRIDE_KEYS = ['source', 'clip', 'output', 'mode', 'root_motion', 'loop', 'frame_start', 'frame_end', 'skip'];
const OPTION_KEYS = ['fps', 'legs', 'leg_from_rest', 'bone_offsets'];
const CLIP_OUTPUT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function componentOf(revision) {
  return revision?.component || 'model';
}

function findRevision(manifest, assetId, revisionId) {
  const asset = manifest.assets.find((candidate) => candidate?.asset_id === assetId);
  return { asset: asset ?? null, revision: asset?.revisions?.find((candidate) => candidate?.revision_id === revisionId) ?? null };
}

function hasFile(revision, extensions) {
  return (revision?.files ?? []).some((file) => typeof file?.path === 'string' && extensions.some((ext) => file.path.toLowerCase().endsWith(ext)));
}

function checkRecipe(recipe, sourceCount) {
  if (recipe === undefined || recipe === null) return undefined;
  if (typeof recipe !== 'object' || Array.isArray(recipe)) throw invalid('recipe must be an object.');
  const unknown = Object.keys(recipe).filter((key) => !RECIPE_KEYS.includes(key));
  if (unknown.length) throw invalid(`Unexpected recipe fields: ${unknown.join(', ')}.`);
  const overrides = recipe.overrides ?? [];
  if (!Array.isArray(overrides) || overrides.length > 64) throw invalid('recipe.overrides must be a list of at most 64 clip settings.');
  for (const entry of overrides) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => !OVERRIDE_KEYS.includes(key))) throw invalid('Each override needs only source, clip and clip settings.');
    if (!Number.isInteger(entry.source) || entry.source < 0 || entry.source >= sourceCount) throw invalid('An override names a source that is not in this job.');
    if (typeof entry.clip !== 'string' || !entry.clip || entry.clip.length > 128) throw invalid('Each override needs a clip name.');
    if (entry.output !== undefined && (typeof entry.output !== 'string' || !CLIP_OUTPUT.test(entry.output))) throw invalid(`Output clip name ${JSON.stringify(entry.output)} is not allowed.`);
    if (entry.mode !== undefined && !['auto', 'cyclic', 'absolute'].includes(entry.mode)) throw invalid('mode must be auto, cyclic or absolute.');
    if (entry.root_motion !== undefined && !['in_place', 'keep'].includes(entry.root_motion)) throw invalid('root_motion must be in_place or keep.');
    for (const flag of ['loop', 'skip']) if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') throw invalid(`${flag} must be true or false.`);
  }
  const options = recipe.options ?? {};
  if (typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !OPTION_KEYS.includes(key))) {
    throw invalid(`recipe.options accepts only ${OPTION_KEYS.join(', ')}.`);
  }
  const text = JSON.stringify(recipe);
  if (text.length > MAX_JSON.recipe) throw invalid(`The recipe is too large (at most ${MAX_JSON.recipe} characters).`);
  return text;
}

function only(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('A JSON object body is required.');
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`Unexpected fields: ${unknown.join(', ')}.`);
  return body;
}

function optionalBoolean(body, name) {
  const value = body[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalid(`${name} must be true or false.`);
  return value;
}

function requiredId(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid(`A valid ${name} is required.`);
  return value;
}

function optionalId(value, pattern, name) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredId(value, pattern, name);
}

function optionalChoice(value, choices, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !choices.has(value)) {
    throw invalid(`${name} must be one of ${[...choices].sort().join(', ')}.`);
  }
  return value;
}

function cleanError(error) {
  if (!error || typeof error !== 'object') return null;
  const code = typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : 'run_failed';
  const message = typeof error.message === 'string' ? error.message.slice(0, MAX_ERROR_MESSAGE) : 'The job failed.';
  return { code, message };
}

// The dry run's own warning list decides whether a confirm must accept warnings. Anything unreadable counts as
// "has warnings", matching the CLI's --accept-warnings gate conservatively.
export function dryRunWarnings(job) {
  if (job?.resultTruncated) return null;
  const warnings = parseResult(job)?.pipeline?.result?.warnings;
  return Array.isArray(warnings) ? warnings : null;
}

function parseResult(job) {
  if (typeof job?.resultJson !== 'string') return null;
  try {
    return JSON.parse(job.resultJson);
  } catch {
    return null;
  }
}

// A list entry: enough to choose a report, never the result itself (GET /api/jobs/:id returns that).
export function jobSummary(job) {
  return {
    jobId: job.jobId,
    operation: job.operation,
    status: job.status,
    ok: job.ok ?? null,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    createdBy: job.uid,
    createdByKind: job.principal?.kind ?? 'human',
    baseSha: job.baseSha ?? null,
    revisionId: job.params?.revision_id ?? null,
    commitSha: job.commitSha ?? null,
    errorCode: job.error?.code ?? null,
    hasResult: typeof job.resultJson === 'string',
    resultTruncated: Boolean(job.resultTruncated)
  };
}

export function publicJob(job) {
  return {
    jobId: job.jobId,
    operation: job.operation,
    status: job.status,
    mutation: Boolean(job.mutation),
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    createdBy: job.uid,
    createdByKind: job.principal?.kind ?? 'human',
    baseSha: job.baseSha ?? null,
    params: job.params ?? null,
    upload: job.upload ? { fileName: job.upload.fileName, size: job.upload.size, contentType: job.upload.contentType } : null,
    dryRunJobId: job.dryRunJobId ?? null,
    confirmJobId: job.confirmJobId ?? null,
    runId: job.runId ?? null,
    runUrl: job.runUrl ?? null,
    ok: job.ok ?? null,
    error: job.error ?? null,
    commitSha: job.commitSha ?? null,
    pushed: Boolean(job.pushed),
    result: parseResult(job),
    resultTruncated: Boolean(job.resultTruncated)
  };
}

export function createJobService({ db, github, store, source, vocabulary, profiles, config, now, makeJobId, logger }) {
  const jobPath = (jobId) => `${config.jobsCollection}/${jobId}`;
  const ratePath = (uid) => `${config.rateCollection}/${uid}`;
  const lockPath = config.lockDoc;
  // Agents share a lower ceiling that a registration can only lower further.
  const rateOptions = (kind, user) => ({
    now: now(),
    limit: user?.kind === 'agent'
      ? Math.min(config.agentRateLimits?.[kind] ?? config.rateLimits[kind], Number.isInteger(user.rateLimits?.[kind]) ? user.rateLimits[kind] : Infinity)
      : config.rateLimits[kind],
    windowMs: config.rateWindowMs
  });
  const actorOf = (user) => `${user.kind === 'agent' ? 'agent' : 'human'}:${user.kind === 'agent' ? user.id : user.uid}`;
  const can = (user, permission) => Boolean(user.permissions?.has?.(permission));
  function demand(user, permission, what) {
    if (can(user, permission)) return;
    if (user.kind !== 'agent') throw new ApiError(403, 'writer_required', 'This action requires Asset Library write access.');
    throw new ApiError(403, 'permission_denied', `This agent may not ${what}.`, { permission });
  }
  // The runner's one JSON input for the principal and newer options (see runner-contract.js CONTEXT_KEYS).
  function contextFor(user, extra = {}) {
    const context = Object.fromEntries(Object.entries({ actor: actorOf(user), ...extra }).filter(([, value]) => value !== undefined && value !== false));
    const text = JSON.stringify(context);
    if (text.length > RUNNER_JSON.context) throw invalid('The request carries too much context.');
    return text;
  }
  const displayTitle = (jobId) => `asset-job ${jobId}`;

  function checkUser(user) {
    if (!UID.test(user.uid)) throw new ApiError(403, 'not_authorized', 'This account cannot use Asset Library jobs.');
  }

  // Mutations and dry runs must be reviewed against the live branch head; the runner re-checks before running
  // and again before pushing.
  async function requireCurrentBase(baseSha) {
    const head = await source.freshSha();
    if (head !== baseSha) {
      throw new ApiError(409, 'stale_base', 'The branch changed since you loaded it — refresh and review again.', { expected: baseSha, actual: head });
    }
    return vocabulary.at(head);
  }

  function newJob(user, fields) {
    const at = now();
    return { uid: user.uid, principal: { kind: user.kind ?? 'human', id: user.id ?? user.uid }, createdAt: at, updatedAt: at,
      baseSha: null, params: null, mutation: false, ...fields };
  }

  // Takes the mutation lock for `jobId` inside a transaction (all reads already done by the caller).
  function takeLock(tx, lock, holder, jobId, user, operation) {
    if (lockIsHeld(lock, holder, now())) {
      throw new ApiError(409, 'mutation_in_progress', 'Another asset change is already running. Wait for it to finish.', { jobId: lock.jobId });
    }
    tx.set(lockPath, { jobId, uid: user.uid, operation, acquiredAt: now(), expiresAt: now() + config.mutationLockTtlMs });
  }

  async function readLock(tx) {
    const lock = await tx.get(lockPath);
    const holder = lock?.jobId ? await tx.get(jobPath(lock.jobId)) : null;
    return { lock, holder };
  }

  // Non-terminal progress (run discovered, queued -> running). Never overwrites a job that already finished.
  async function progress(jobId, fields) {
    return db.runTransaction(async (tx) => {
      const job = await tx.get(jobPath(jobId));
      if (!job || TERMINAL_STATUSES.includes(job.status)) return job;
      const next = { ...job, ...fields, updatedAt: now() };
      tx.set(jobPath(jobId), next);
      return next;
    });
  }

  // Records a terminal state once; the first writer wins and releases the lock if this job holds it.
  async function finish(jobId, fields) {
    return db.runTransaction(async (tx) => {
      const job = await tx.get(jobPath(jobId));
      const lock = await tx.get(lockPath);
      if (!job || TERMINAL_STATUSES.includes(job.status)) return job;
      const next = { ...job, ...fields, updatedAt: now() };
      tx.set(jobPath(jobId), next);
      if (lock?.jobId === jobId) tx.delete(lockPath);
      return next;
    });
  }

  function isDefinitiveRejection(error) {
    return error instanceof UpstreamError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
  }

  async function dispatch(job, inputs) {
    try {
      const { runId, htmlUrl } = await github.dispatchWorkflow({ workflow: config.workflowFile, ref: config.workflowRef, inputs });
      return runId ? (await progress(job.jobId, { runId, runUrl: htmlUrl })) ?? job : job;
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        logger.error('Asset Library dispatch rejected', { jobId: job.jobId, status: error.status });
        await finish(job.jobId, { status: 'error', ok: false, error: { code: 'dispatch_failed', message: 'GitHub refused to start the job.' } });
        throw new ApiError(502, 'dispatch_failed', 'GitHub refused to start the job. Nothing was changed.');
      }
      // The dispatch may still have happened; polling finds the run by name or times out.
      logger.error('Asset Library dispatch outcome unknown', { jobId: job.jobId, message: error?.message });
      return job;
    }
  }

  async function reserveUpload(user, body) {
    checkUser(user);
    const { fileName, size, contentType } = only(body, ['fileName', 'size', 'contentType']);
    const vocab = await vocabulary.at(await source.currentSha());
    checkFileName(fileName, vocab.supportedExtensions);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
      throw invalid(`size must be between 1 and ${MAX_UPLOAD_BYTES} bytes.`, { maxBytes: MAX_UPLOAD_BYTES });
    }
    if (contentType !== undefined && contentType !== '' && (typeof contentType !== 'string' || !CONTENT_TYPE.test(contentType))) {
      throw invalid('contentType must be a MIME type.');
    }
    const jobId = makeJobId();
    const stagingPath = `${config.stagingPrefix}${user.uid}/${jobId}/${fileName}`;
    const expiresAt = now() + config.uploadReservationTtlMs;
    const job = newJob(user, {
      jobId,
      operation: 'ingest',
      status: 'awaiting_upload',
      mutation: true,
      upload: { fileName, size, contentType: contentType || 'application/octet-stream', stagingPath, expiresAt }
    });
    await db.runTransaction(async (tx) => {
      const rate = await tx.get(ratePath(user.uid));
      tx.set(ratePath(user.uid), consumeRate(rate, 'upload', rateOptions('upload', user)));
      tx.set(jobPath(jobId), job);
    });
    const reservation = { jobId, stagingPath, maxBytes: MAX_UPLOAD_BYTES, expiresAt: new Date(expiresAt).toISOString() };
    if (user.kind === 'agent') {
      // Agents are not Firebase users, so Storage rules cannot admit them: they PUT to a short-lived URL signed for
      // exactly this object, content type and size. The ingest step still verifies size and MD5.
      const uploadExpiresAt = now() + config.stagedUrlTtlMs;
      const upload = await store.signedStagedUploadUrl(stagingPath, { expiresAt: uploadExpiresAt, contentType: job.upload.contentType, size });
      reservation.upload = { method: 'PUT', url: upload.url, headers: upload.headers, expiresAt: new Date(uploadExpiresAt).toISOString() };
    }
    return reservation;
  }

  async function startIngest(user, body) {
    checkUser(user);
    only(body, ['jobId', 'baseSha', 'assetId', 'category', 'displayName', 'revisionId', 'role', 'note', 'source', 'creator', 'component',
      'createAsset', 'confirmIdentity', 'allowDuplicateContent', 'parentRevision', 'changeKind']);
    const createAsset = optionalBoolean(body, 'createAsset');
    const confirmIdentity = optionalBoolean(body, 'confirmIdentity');
    const allowDuplicateContent = optionalBoolean(body, 'allowDuplicateContent');
    if (createAsset) demand(user, PERMISSIONS.assetCreate, 'create a new logical asset; ask a person to create it');
    if (confirmIdentity || allowDuplicateContent) demand(user, PERMISSIONS.identityOverride, 'override an identity or duplicate check');
    const jobId = requiredId(body.jobId, JOB_ID, 'jobId');
    const baseSha = requiredId(body.baseSha, BASE_SHA, 'baseSha');
    const reserved = await db.get(jobPath(jobId));
    if (!reserved || reserved.uid !== user.uid || reserved.operation !== 'ingest') {
      throw new ApiError(404, 'job_not_found', 'That upload reservation does not exist for this account.');
    }
    if (reserved.status !== 'awaiting_upload') {
      throw new ApiError(409, 'job_already_started', 'That upload has already been submitted.');
    }
    if (reserved.upload.expiresAt <= now()) throw new ApiError(410, 'upload_expired', 'That upload reservation has expired. Upload the file again.');

    const vocab = await requireCurrentBase(baseSha);
    const params = {
      asset_id: requiredId(body.assetId, vocab.assetId, 'asset ID'),
      revision_id: optionalId(body.revisionId, vocab.revisionId, 'revision ID'),
      category: optionalChoice(body.category, vocab.categories, 'category'),
      display_name: checkText('display_name', body.displayName),
      role: optionalChoice(body.role, vocab.roles, 'role'),
      component: optionalChoice(body.component, vocab.components, 'component'),
      note: checkText('note', body.note),
      source: checkText('source', body.source),
      creator: checkText('creator', body.creator)
    };
    checkFileName(reserved.upload.fileName, vocab.supportedExtensions);
    const parentRevision = optionalId(body.parentRevision, vocab.revisionId, 'parent revision ID');
    const changeKind = optionalChoice(body.changeKind, vocab.changeKinds ?? new Set(), 'changeKind');
    // Refuse what the pipeline would refuse, before any job starts: an alias, or an unknown asset without createAsset.
    const { manifest } = await source.current();
    const named = manifest.assets.find((candidate) => candidate?.asset_id === params.asset_id);
    const aliasOf = named ? null : manifest.assets.find((candidate) => (candidate?.identity?.aliases ?? []).includes(params.asset_id));
    if (aliasOf) {
      throw new ApiError(409, 'alias_of_asset', `${params.asset_id} is an alias of ${aliasOf.asset_id}; upload into ${aliasOf.asset_id}.`, { assetId: aliasOf.asset_id });
    }
    if (!named && !createAsset) {
      throw new ApiError(409, 'unknown_asset', `${params.asset_id} is not a recorded asset. Upload into an existing asset, or have a person create it.`);
    }
    if (named && createAsset) throw invalid(`${params.asset_id} already exists; createAsset is only for new assets.`);
    if (parentRevision && !named?.revisions?.some((revision) => revision?.revision_id === parentRevision)) {
      throw invalid(`${parentRevision} is not a revision of ${params.asset_id}.`);
    }
    const context = contextFor(user, { new_asset: createAsset, confirm_identity: confirmIdentity, allow_duplicate_content: allowDuplicateContent,
      parent_revision: parentRevision, change_kind: changeKind });

    const staged = await store.stat(reserved.upload.stagingPath);
    if (!staged) throw new ApiError(409, 'upload_missing', 'The uploaded file was not found. Upload it again.');
    if (staged.size !== reserved.upload.size || !staged.md5Hash) {
      throw new ApiError(409, 'upload_mismatch', 'The uploaded file does not match its reservation. Upload it again.');
    }
    const dispatchParams = {
      ...params,
      file_name: reserved.upload.fileName,
      expected_size: String(staged.size),
      expected_md5: staged.md5Hash
    };
    const publicParams = Object.fromEntries(Object.entries({ ...dispatchParams, context: JSON.parse(context) }).filter(([, value]) => value !== undefined));

    const job = await db.runTransaction(async (tx) => {
      const current = await tx.get(jobPath(jobId));
      const { lock, holder } = await readLock(tx);
      const rate = await tx.get(ratePath(user.uid));
      if (current?.status !== 'awaiting_upload') throw new ApiError(409, 'job_already_started', 'That upload has already been submitted.');
      takeLock(tx, lock, holder, jobId, user, 'ingest');
      tx.set(ratePath(user.uid), consumeRate(rate, 'dispatch', rateOptions('dispatch', user)));
      const next = { ...current, status: 'queued', baseSha, params: publicParams, dispatchRequestedAt: now(), updatedAt: now() };
      tx.set(jobPath(jobId), next);
      return next;
    });

    let stagedUrl;
    try {
      stagedUrl = await store.signedStagedReadUrl(reserved.upload.stagingPath, { expiresAt: now() + config.stagedUrlTtlMs });
    } catch (error) {
      logger.error('Asset Library could not sign the staged upload', { jobId, message: error?.message });
      await finish(jobId, { status: 'error', ok: false, error: { code: 'internal', message: 'The upload could not be prepared for the job.' } });
      throw new ApiError(500, 'internal', 'The upload could not be prepared for the job. Nothing was changed.');
    }
    // The signed URL goes only into the dispatch; it is never stored or returned.
    return dispatch(job, buildDispatchInputs(jobId, 'ingest', { base_sha: baseSha, ...dispatchParams, staged_url: stagedUrl, context }));
  }

  // Copies a file from the caller's own RigCheck Cloud Library into staging (no re-upload from the device) and returns
  // an ordinary upload reservation; the ingest job then verifies its size and MD5 like any upload.
  async function reserveFromLibrary(user, body) {
    checkUser(user);
    const { modelId } = only(body, ['modelId']);
    if (typeof modelId !== 'string' || !LIBRARY_MODEL_ID.test(modelId)) throw invalid('A valid Cloud Library model ID is required.');
    const model = await db.get(`users/${user.uid}/models/${modelId}`);
    if (!model) throw new ApiError(404, 'library_file_not_found', 'That file is not in your RigCheck Cloud Library.');
    const prefix = `users/${user.uid}/models/${modelId}/`;
    const path = model.storagePath;
    if (typeof path !== 'string' || !path.startsWith(prefix) || path.slice(prefix.length).includes('/') || path.includes('..')) {
      throw new ApiError(403, 'library_file_not_owned', 'That Cloud Library entry does not point at your own file.');
    }
    const fileName = path.slice(prefix.length);
    const vocab = await vocabulary.at(await source.currentSha());
    checkFileName(fileName, vocab.supportedExtensions);
    const stat = await store.stat(path);
    if (!stat) throw new ApiError(404, 'library_file_not_found', 'The Cloud Library file is missing from storage.');
    if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_UPLOAD_BYTES) {
      throw invalid(`The file must be between 1 and ${MAX_UPLOAD_BYTES} bytes.`, { maxBytes: MAX_UPLOAD_BYTES });
    }
    const jobId = makeJobId();
    const stagingPath = `${config.stagingPrefix}${user.uid}/${jobId}/${fileName}`;
    const expiresAt = now() + config.uploadReservationTtlMs;
    const job = newJob(user, {
      jobId,
      operation: 'ingest',
      status: 'awaiting_upload',
      mutation: true,
      upload: { fileName, size: stat.size, contentType: stat.contentType || 'application/octet-stream', stagingPath, expiresAt, libraryModelId: modelId }
    });
    await db.runTransaction(async (tx) => {
      const rate = await tx.get(ratePath(user.uid));
      tx.set(ratePath(user.uid), consumeRate(rate, 'upload', rateOptions('upload', user)));
      tx.set(jobPath(jobId), job);
    });
    await store.copy(path, stagingPath);
    return { jobId, stagingPath, fileName, size: stat.size, sha256: model.sha256 ?? null, maxBytes: MAX_UPLOAD_BYTES, expiresAt: new Date(expiresAt).toISOString(), copiedFromLibrary: true };
  }

  // Offline bake of manifest source clips onto a manifest model revision; the result becomes a candidate collection.
  async function startAnimate(user, body) {
    checkUser(user);
    only(body, ['baseSha', 'assetId', 'targetRevisionId', 'sources', 'recipe', 'note']);
    const baseSha = requiredId(body.baseSha, BASE_SHA, 'baseSha');
    const vocab = await requireCurrentBase(baseSha);
    const { manifest } = await source.current();
    const assetId = requiredId(body.assetId, vocab.assetId, 'asset ID');
    const targetRevisionId = requiredId(body.targetRevisionId, vocab.revisionId, 'target revision ID');
    const target = findRevision(manifest, assetId, targetRevisionId);
    if (!target.revision) throw new ApiError(404, 'not_found', 'That target revision is not in the manifest.');
    if (componentOf(target.revision) !== 'model' || !hasFile(target.revision, ['.glb'])) {
      throw invalid('The bake target must be a model revision with a GLB.');
    }
    if (!Array.isArray(body.sources) || body.sources.length < 1 || body.sources.length > MAX_SOURCES) {
      throw invalid(`sources must list 1-${MAX_SOURCES} source revisions.`);
    }
    const refs = [];
    for (const entry of body.sources) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => !['assetId', 'revisionId'].includes(key))) throw invalid('Each source needs assetId and revisionId.');
      const ref = `${requiredId(entry.assetId, vocab.assetId, 'source asset ID')}/${requiredId(entry.revisionId, vocab.revisionId, 'source revision ID')}`;
      const found = findRevision(manifest, entry.assetId, entry.revisionId);
      if (!found.revision) throw new ApiError(404, 'not_found', `Source ${ref} is not in the manifest.`);
      if (!hasFile(found.revision, ['.glb', '.fbx'])) throw invalid(`Source ${ref} has no GLB or FBX file.`);
      if (refs.includes(ref)) throw invalid(`Source ${ref} is listed twice.`);
      refs.push(ref);
    }
    const recipe = checkRecipe(body.recipe, refs.length);
    const params = Object.fromEntries(Object.entries({
      asset_id: assetId, revision_id: targetRevisionId, sources: refs.join(','), recipe, note: checkText('note', body.note)
    }).filter(([, value]) => value !== undefined));
    return startMutation(user, 'animate', baseSha, params);
  }

  // Gameplay slot -> clip bindings (manifest only; Godot is never edited by a binding).
  async function startBind(user, body) {
    checkUser(user);
    only(body, ['baseSha', 'assetId', 'slots', 'note']);
    const baseSha = requiredId(body.baseSha, BASE_SHA, 'baseSha');
    const vocab = await requireCurrentBase(baseSha);
    const { sha, manifest } = await source.current();
    const assetId = requiredId(body.assetId, vocab.assetId, 'asset ID');
    const asset = manifest.assets.find((candidate) => candidate?.asset_id === assetId);
    if (!asset) throw new ApiError(404, 'not_found', 'That asset is not in the manifest.');
    const policy = slotPolicy(await profiles.at(sha), asset.category);
    if (!policy) throw invalid('No gameplay animation slots are defined for this asset\'s category.');
    const slots = body.slots;
    if (!slots || typeof slots !== 'object' || Array.isArray(slots) || !Object.keys(slots).length) throw invalid('slots must map at least one slot.');
    const bindings = {};
    for (const [slot, value] of Object.entries(slots)) {
      if (!Object.hasOwn(policy, slot)) throw invalid(`Unknown slot ${slot}; this asset has ${Object.keys(policy).join(', ')}.`);
      if (value === null) {
        bindings[slot] = null;
        continue;
      }
      if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !['revisionId', 'clip', 'loop', 'rootMotion'].includes(key))) {
        throw invalid(`Slot ${slot} needs revisionId and clip (optional loop, rootMotion).`);
      }
      const revision = asset.revisions?.find((candidate) => candidate?.revision_id === value.revisionId);
      if (!revision || componentOf(revision) !== 'animation_collection') throw invalid(`Slot ${slot}: ${value.revisionId} is not an animation collection of this asset.`);
      const clips = (revision.animation?.clips ?? []).map((clip) => clip?.name);
      if (!clips.includes(value.clip)) throw invalid(`Slot ${slot}: ${value.clip} is not a clip of ${value.revisionId}.`);
      if (value.loop !== undefined && typeof value.loop !== 'boolean') throw invalid('loop must be true or false.');
      if (value.rootMotion !== undefined && !['in_place', 'keep'].includes(value.rootMotion)) throw invalid('rootMotion must be in_place or keep.');
      bindings[slot] = { revision_id: value.revisionId, clip: value.clip, ...(value.loop !== undefined ? { loop: value.loop } : {}),
        ...(value.rootMotion ? { root_motion: value.rootMotion } : {}) };
    }
    const text = JSON.stringify(bindings);
    if (text.length > MAX_JSON.bindings) throw invalid('The bindings are too large.');
    const params = Object.fromEntries(Object.entries({ asset_id: assetId, bindings: text, note: checkText('note', body.note) })
      .filter(([, value]) => value !== undefined));
    return startMutation(user, 'bind', baseSha, params);
  }

  // Shared path for dispatching a mutation that has no upload: lock, rate limit, job record, dispatch.
  async function startMutation(user, operation, baseSha, params, extraContext = {}) {
    const jobId = makeJobId();
    const job = await db.runTransaction(async (tx) => {
      const { lock, holder } = await readLock(tx);
      const rate = await tx.get(ratePath(user.uid));
      takeLock(tx, lock, holder, jobId, user, operation);
      tx.set(ratePath(user.uid), consumeRate(rate, 'dispatch', rateOptions('dispatch', user)));
      const next = newJob(user, { jobId, operation, status: 'queued', mutation: true, baseSha, params, dispatchRequestedAt: now() });
      tx.set(jobPath(jobId), next);
      return next;
    });
    return dispatch(job, buildDispatchInputs(jobId, operation, { base_sha: baseSha, ...params, context: contextFor(user, extraContext) }));
  }

  async function startPromoteDryRun(user, body) {
    only(body, ['dryRun', 'baseSha', 'assetId', 'revisionId', 'displayName', 'category', 'destination']);
    const baseSha = requiredId(body.baseSha, BASE_SHA, 'baseSha');
    const vocab = await requireCurrentBase(baseSha);
    const params = Object.fromEntries(Object.entries({
      asset_id: requiredId(body.assetId, vocab.assetId, 'asset ID'),
      revision_id: requiredId(body.revisionId, vocab.revisionId, 'revision ID'),
      category: optionalChoice(body.category, vocab.categories, 'category'),
      display_name: checkText('display_name', body.displayName),
      destination: checkDestination(body.destination)
    }).filter(([, value]) => value !== undefined));
    const jobId = makeJobId();
    const job = newJob(user, { jobId, operation: 'promote_dry_run', status: 'queued', baseSha, params, dispatchRequestedAt: now() });
    await db.runTransaction(async (tx) => {
      const rate = await tx.get(ratePath(user.uid));
      tx.set(ratePath(user.uid), consumeRate(rate, 'dispatch', rateOptions('dispatch', user)));
      tx.set(jobPath(jobId), job);
    });
    return dispatch(job, buildDispatchInputs(jobId, 'promote_dry_run', { base_sha: baseSha, ...params, context: contextFor(user) }));
  }

  // A confirm takes every parameter and the base commit from its dry run; the request only names that dry run.
  async function startPromoteConfirm(user, body) {
    only(body, ['dryRun', 'dryRunJobId', 'acceptWarnings']);
    if (user.kind !== 'human') {
      throw new ApiError(403, 'human_approval_required', 'Only a person can confirm a promotion. The dry run is ready for review.');
    }
    demand(user, PERMISSIONS.promoteConfirm, 'confirm a promotion');
    const dryRunJobId = requiredId(body.dryRunJobId, JOB_ID, 'dryRunJobId');
    const acceptWarnings = optionalBoolean(body, 'acceptWarnings');
    const dryRun = await refresh(dryRunJobId);
    if (!dryRun || dryRun.operation !== 'promote_dry_run') {
      throw new ApiError(409, 'dry_run_required', 'Confirming a promotion requires a successful dry run.');
    }
    if (dryRun.uid !== user.uid) {
      throw new ApiError(403, 'dry_run_not_owned', 'Only the person who ran this dry run can confirm it.');
    }
    if (dryRun.status !== 'done' || dryRun.ok !== true) {
      throw new ApiError(409, 'dry_run_required', 'Confirming a promotion requires a successful dry run.');
    }
    if (dryRun.confirmJobId) throw new ApiError(409, 'dry_run_already_confirmed', 'This dry run has already been confirmed.');
    const warnings = dryRunWarnings(dryRun);
    if ((warnings === null || warnings.length > 0) && !acceptWarnings) {
      throw new ApiError(409, 'warnings_not_accepted', 'This promotion has validation warnings. Review them and accept them explicitly.', {
        warningCount: warnings?.length ?? null
      });
    }

    const jobId = makeJobId();
    const params = { ...dryRun.params, ...(acceptWarnings ? { accept_warnings: true } : {}) };
    const job = await db.runTransaction(async (tx) => {
      const current = await tx.get(jobPath(dryRunJobId));
      const { lock, holder } = await readLock(tx);
      const rate = await tx.get(ratePath(user.uid));
      if (current?.confirmJobId) throw new ApiError(409, 'dry_run_already_confirmed', 'This dry run has already been confirmed.');
      takeLock(tx, lock, holder, jobId, user, 'promote_confirm');
      tx.set(ratePath(user.uid), consumeRate(rate, 'dispatch', rateOptions('dispatch', user)));
      tx.update(jobPath(dryRunJobId), { confirmJobId: jobId, updatedAt: now() });
      const next = newJob(user, {
        jobId,
        operation: 'promote_confirm',
        status: 'queued',
        mutation: true,
        baseSha: dryRun.baseSha,
        params,
        dryRunJobId,
        dispatchRequestedAt: now()
      });
      tx.set(jobPath(jobId), next);
      return next;
    });
    return dispatch(job, buildDispatchInputs(jobId, 'promote_confirm', { base_sha: dryRun.baseSha, ...params, context: contextFor(user) }));
  }

  async function startValidate(user, body) {
    const input = only(body ?? {}, ['assetId', 'revisionId', 'recheck', 'strict']);
    const vocab = await vocabulary.at(await source.currentSha());
    const params = Object.fromEntries(Object.entries({
      asset_id: optionalId(input.assetId, vocab.assetId, 'asset ID'),
      revision_id: optionalId(input.revisionId, vocab.revisionId, 'revision ID'),
      recheck: optionalBoolean(input, 'recheck') || undefined,
      strict: optionalBoolean(input, 'strict') || undefined
    }).filter(([, value]) => value !== undefined));
    if (params.revision_id && !params.asset_id) throw invalid('revisionId requires assetId.');
    const jobId = makeJobId();
    const job = newJob(user, { jobId, operation: 'validate', status: 'queued', params, dispatchRequestedAt: now() });
    await db.runTransaction(async (tx) => {
      const rate = await tx.get(ratePath(user.uid));
      tx.set(ratePath(user.uid), consumeRate(rate, 'dispatch', rateOptions('dispatch', user)));
      tx.set(jobPath(jobId), job);
    });
    return dispatch(job, buildDispatchInputs(jobId, 'validate', { ...params, context: contextFor(user) }));
  }

  function readResult(bytes, job) {
    let files;
    try {
      files = unzipSync(bytes, { filter: (file) => file.name === 'result.json' && file.originalSize <= config.maxArtifactBytes });
    } catch {
      return null;
    }
    if (!files['result.json']) return null;
    try {
      const result = JSON.parse(strFromU8(files['result.json']));
      return result?.job_id === job.jobId && result?.operation === job.operation ? result : { mismatch: true };
    } catch {
      return null;
    }
  }

  function terminalFields(result, run) {
    const ok = result.ok === true && run.conclusion === 'success';
    const json = JSON.stringify(result);
    const fits = json.length <= config.maxCachedResultChars;
    const summary = { schema: result.schema, job_id: result.job_id, operation: result.operation, ok: result.ok, error: result.error ?? null, commitSha: result.commitSha ?? null, pushed: result.pushed === true };
    return {
      status: ok ? 'done' : 'error',
      ok,
      error: ok ? null : (cleanError(result.error) ?? { code: 'run_failed', message: `The job run ended with ${run.conclusion}.` }),
      commitSha: typeof result.commitSha === 'string' ? result.commitSha : null,
      pushed: result.pushed === true,
      resultJson: fits ? json : JSON.stringify(summary),
      resultTruncated: !fits,
      runConclusion: run.conclusion
    };
  }

  const CONCLUSION_ERRORS = { cancelled: 'run_cancelled', timed_out: 'timeout', startup_failure: 'run_failed', failure: 'result_missing' };

  // Advances a job from GitHub's run state. Final states (and their result) are cached so later polls skip GitHub.
  async function refresh(jobId) {
    let job = await db.get(jobPath(jobId));
    if (!job || TERMINAL_STATUSES.includes(job.status) || job.status === 'awaiting_upload') return job;
    if (now() - (job.lastCheckedAt ?? 0) < config.jobPollMinIntervalMs) return job;
    await db.update(jobPath(jobId), { lastCheckedAt: now() });

    let { runId, runUrl } = job;
    if (!runId) {
      const run = await github.findDispatchedRun({
        workflow: config.workflowFile,
        branch: config.workflowRef,
        createdAfter: job.dispatchRequestedAt - 2 * 60 * 1000,
        displayTitle: displayTitle(jobId)
      });
      if (!run) {
        if (now() - job.dispatchRequestedAt > config.runDiscoveryTimeoutMs) {
          return finish(jobId, { status: 'error', ok: false, error: { code: 'run_not_found', message: 'The job run never started on GitHub.' } });
        }
        return job;
      }
      job = await progress(jobId, { runId: run.id, runUrl: run.htmlUrl });
      if (!job || TERMINAL_STATUSES.includes(job.status)) return job;
      ({ runId, runUrl } = job);
    }

    const run = await github.getRun(runId);
    if (run.status !== 'completed') {
      const status = run.status === 'in_progress' ? 'running' : 'queued';
      const nextUrl = run.htmlUrl ?? runUrl ?? null;
      return status !== job.status || nextUrl !== job.runUrl ? progress(jobId, { status, runUrl: nextUrl }) : job;
    }

    const artifact = await github.findArtifact(runId, config.resultArtifact);
    if (!artifact) {
      // Artifacts can lag the run's completion briefly.
      const finishedAt = Date.parse(run.updatedAt ?? '') || now();
      if (now() - finishedAt < config.artifactGraceMs) {
        return job.status === 'running' ? job : progress(jobId, { status: 'running' });
      }
      const code = CONCLUSION_ERRORS[run.conclusion] ?? 'result_missing';
      return finish(jobId, { status: 'error', ok: false, runConclusion: run.conclusion, error: { code, message: `The job run ended (${run.conclusion}) without a result.` } });
    }
    if (artifact.sizeInBytes !== null && artifact.sizeInBytes > config.maxArtifactBytes) {
      return finish(jobId, { status: 'error', ok: false, error: { code: 'result_invalid', message: 'The job result is too large to read.' } });
    }
    const result = readResult(await github.downloadArtifact(artifact.id, { maxBytes: config.maxArtifactBytes }), job);
    if (!result || result.mismatch) {
      return finish(jobId, {
        status: 'error',
        ok: false,
        error: result?.mismatch
          ? { code: 'result_mismatch', message: 'The job result belongs to a different job.' }
          : { code: 'result_invalid', message: 'The job result could not be read.' }
      });
    }
    return finish(jobId, terminalFields(result, run));
  }

  // Recent jobs for one asset, newest first, so a dismissed report can be reopened. Read-only; any role.
  async function listJobs(assetId) {
    if (typeof assetId !== 'string' || !LIST_ASSET_ID.test(assetId)) throw invalid('A valid asset ID is required.');
    const jobs = await db.findEqual(config.jobsCollection, 'params.asset_id', assetId, config.jobListScanLimit);
    return jobs
      .filter((job) => job.status !== 'awaiting_upload')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, config.jobListLimit)
      .map(jobSummary);
  }

  async function getJob(jobId) {
    requiredId(jobId, JOB_ID, 'job ID');
    const job = await refresh(jobId);
    if (!job) throw new ApiError(404, 'job_not_found', 'That job does not exist.');
    return job;
  }

  return {
    reserveUpload,
    reserveFromLibrary,
    startIngest,
    startAnimate,
    startBind,
    startPromote(user, body) {
      checkUser(user);
      if (body?.dryRun === true) {
        demand(user, PERMISSIONS.promoteDryRun, 'start a promotion dry run');
        return startPromoteDryRun(user, body);
      }
      if (body?.dryRun === false) return startPromoteConfirm(user, body);
      throw invalid('dryRun must be true (start a dry run) or false (confirm one).');
    },
    startValidate(user, body) {
      checkUser(user);
      return startValidate(user, body);
    },
    getJob,
    listJobs
  };
}
