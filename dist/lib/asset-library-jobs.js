// RigCheck Asset Library — write-side helpers (upload candidate, promote, re-validate). No DOM and no Firebase
// imports, so they are unit-tested in Node. The browser only pre-checks for fast feedback: the API re-checks
// everything against the asset pipeline at the reviewed commit, and the job runner checks again.
import { describeApiError } from './asset-library-api.js';
import { mapProduction } from './asset-library-model.js';

export const TERMINAL_JOB_STATUSES = Object.freeze(['done', 'error']);
export const POLL_INTERVAL_MS = 4000;
export const POLL_TIMEOUT_MS = 50 * 60 * 1000;

const TEXT_FIELDS = Object.freeze({ displayName: 'display_name', note: 'note', source: 'source', creator: 'creator' });
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

export function roleFromClaims(claims) {
  const role = claims?.assetLibraryRole;
  return role === 'writer' || role === 'reader' ? role : null;
}

export function fileExtension(name) {
  const dot = typeof name === 'string' ? name.lastIndexOf('.') : -1;
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function codePoints(value) {
  return [...value].length;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Returns an error message for a file the pipeline would not accept, or null.
export function checkUploadFile(file, vocabulary) {
  if (!file) return 'Choose a file to upload.';
  if (!vocabulary) return describeApiError('vocabulary_unavailable');
  if (!FILE_NAME.test(file.name)) {
    return 'Rename the file first: letters, digits, spaces, dots, dashes and underscores only, starting with a letter or digit.';
  }
  if (!vocabulary.supportedExtensions.includes(fileExtension(file.name))) {
    return `The asset pipeline does not accept ${fileExtension(file.name) || 'files without an extension'}. Supported: ${vocabulary.supportedExtensions.join(' ')}.`;
  }
  if (!file.size) return 'The file is empty.';
  if (file.size > vocabulary.maxUploadBytes) return `The file is larger than the ${Math.round(vocabulary.maxUploadBytes / 1048576)} MB upload limit.`;
  return null;
}

// Field-level pre-checks for the upload form. Returns { field: message } (empty when valid).
export function checkIngestForm(form, vocabulary) {
  const errors = {};
  if (!vocabulary) return { form: describeApiError('vocabulary_unavailable') };
  const assetId = clean(form.assetId);
  if (!new RegExp(vocabulary.assetIdPattern).test(assetId)) {
    errors.assetId = 'Use a lowercase ID: a letter, then letters, digits or underscores (up to 64).';
  }
  const revisionId = clean(form.revisionId);
  if (revisionId && !new RegExp(vocabulary.revisionIdPattern).test(revisionId)) {
    errors.revisionId = 'Use lowercase letters, digits, dashes or underscores (leave blank to derive it from the file).';
  }
  if (clean(form.category) && !vocabulary.categories.includes(clean(form.category))) errors.category = 'Choose a listed category.';
  if (clean(form.role) && !vocabulary.roles.includes(clean(form.role))) errors.role = 'Choose a listed role.';
  for (const [field, limitName] of Object.entries(TEXT_FIELDS)) {
    const value = field === 'note' ? (form.note ?? '').replace(/\r\n?/g, '\n') : clean(form[field]);
    const limit = vocabulary.textLimits[limitName];
    if (value && (codePoints(value) > limit || CONTROL_CHARS.test(value))) {
      errors[field] = `At most ${limit} characters, without control characters.`;
    }
  }
  return errors;
}

export function buildIngestRequest(form, { jobId, baseSha }) {
  const body = { jobId, baseSha, assetId: clean(form.assetId) };
  for (const field of ['revisionId', 'category', 'role', 'displayName', 'source', 'creator']) {
    if (clean(form[field])) body[field] = clean(form[field]);
  }
  const note = (form.note ?? '').replace(/\r\n?/g, '\n').trim();
  if (note) body.note = note;
  return body;
}

export function buildPromoteDryRunRequest({ baseSha, assetId, revisionId, displayName, category, destination }) {
  const body = { dryRun: true, baseSha, assetId, revisionId };
  if (clean(displayName)) body.displayName = clean(displayName);
  if (clean(category)) body.category = clean(category);
  if (clean(destination)) body.destination = clean(destination);
  return body;
}

export function buildPromoteConfirmRequest(dryRunJob, acceptWarnings) {
  return { dryRun: false, dryRunJobId: dryRunJob.jobId, acceptWarnings: Boolean(acceptWarnings) };
}

export function isTerminalJob(job) {
  return TERMINAL_JOB_STATUSES.includes(job?.status);
}

const OPERATION_LABELS = {
  ingest: 'Upload candidate',
  promote_dry_run: 'Promotion dry run',
  promote_confirm: 'Promotion',
  validate: 'Re-validation'
};

export function operationLabel(operation) {
  return OPERATION_LABELS[operation] ?? 'Job';
}

export function jobStatusText(job) {
  const label = OPERATION_LABELS[job?.operation] ?? 'Job';
  switch (job?.status) {
    case 'awaiting_upload': return `${label}: waiting for the upload`;
    case 'queued': return `${label}: queued on GitHub Actions`;
    case 'running': return `${label}: running`;
    case 'done': return `${label}: finished`;
    case 'error': return `${label}: failed — ${describeJobError(job)}`;
    default: return `${label}: ${job?.status ?? 'unknown'}`;
  }
}

// Prefer the specific message the runner or pipeline reported (e.g. the pipeline's AssetError text).
export function describeJobError(job) {
  const error = job?.error;
  if (!error) return describeApiError('internal');
  const generic = describeApiError(error.code);
  if (error.code === 'stale_base') return generic;
  return typeof error.message === 'string' && error.message ? error.message : generic;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function issueText(issue) {
  if (typeof issue === 'string') return issue;
  return [issue?.code, issue?.message, issue?.location].filter((part) => typeof part === 'string' && part).join(' — ') || JSON.stringify(issue);
}

// The tool's own dry-run payload: selected candidate, current canonical, validation state, production
// compliance, blockers and file/manifest changes. A blocked dry run carries the same partial plan.
export function summarizeDryRun(job) {
  const pipeline = job?.result?.pipeline ?? null;
  const plan = pipeline?.result ?? null;
  const warningsReadable = Array.isArray(plan?.warnings) && !job?.resultTruncated;
  const blockers = asArray(pipeline?.blockers).map(issueText);
  return {
    available: Boolean(plan),
    blocked: blockers.length > 0 || pipeline?.ok === false,
    blockers: blockers.length ? blockers : (pipeline?.ok === false && typeof pipeline?.error === 'string' ? [pipeline.error] : []),
    production: mapProduction(plan?.production),
    assetId: plan?.asset_id ?? job?.params?.asset_id ?? null,
    revisionId: plan?.revision_id ?? job?.params?.revision_id ?? null,
    previousCanonical: plan?.previous_canonical ?? null,
    files: asArray(plan?.files).map((file) => ({ from: file?.candidate_path ?? null, to: file?.path ?? null, role: file?.role ?? null, sizeBytes: file?.size_bytes ?? null })),
    warnings: asArray(plan?.warnings).map(issueText),
    warningsReadable,
    // Accepting is required whenever warnings exist or cannot be read, matching the API's rule.
    requiresAcceptance: !warningsReadable || plan.warnings.length > 0,
    lfsRulesToAdd: asArray(plan?.lfs_rules_to_add),
    integrationRequired: typeof plan?.integration_required === 'string' ? plan.integration_required : null,
    baseSha: job?.baseSha ?? null
  };
}

export function summarizeIngest(job) {
  const report = job?.result?.pipeline?.result ?? null;
  return {
    available: Boolean(report),
    assetId: report?.asset_id ?? job?.params?.asset_id ?? null,
    revisionId: report?.revision_id ?? null,
    files: asArray(report?.files).map((file) => ({ path: file?.path ?? null, role: file?.role ?? null, sizeBytes: file?.size_bytes ?? null })),
    warnings: asArray(report?.warnings).map(issueText),
    production: mapProduction(report?.production)
  };
}

export function summarizeValidation(job) {
  const result = job?.result?.pipeline?.result ?? null;
  const findings = asArray(result?.findings);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    const severity = ['error', 'warning'].includes(finding?.severity) ? finding.severity : 'info';
    counts[severity] += 1;
  }
  return {
    available: Boolean(result),
    ok: job?.result?.pipeline?.ok ?? null,
    counts,
    freshInspections: asArray(result?.fresh_inspections).length,
    findings: findings.slice(0, 50).map((finding) => ({ severity: finding?.severity ?? 'info', text: issueText(finding) })),
    more: Math.max(0, findings.length - 50),
    allFindings: findings.map((finding) => ({ severity: ['error', 'warning'].includes(finding?.severity) ? finding.severity : 'info', text: issueText(finding) })),
    production: asArray(result?.production).map((entry) => ({
      revisionId: entry?.revision_id ?? null,
      canonicalState: entry?.canonical_state ?? null,
      production: mapProduction(entry)
    }))
  };
}

// Polls until the job is terminal. `getJob` returns the latest job; `onUpdate` sees every state.
export async function pollJob({ getJob, onUpdate = () => {}, intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS, sleep, now = Date.now, isCancelled = () => false }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  for (;;) {
    const job = await getJob();
    onUpdate(job);
    if (isTerminalJob(job) || isCancelled()) return job;
    if (now() - started > timeoutMs) return job;
    await wait(intervalMs);
  }
}

const VALIDATOR_SEVERITIES = ['error', 'warning', 'info', 'hint'];
const TECHNICAL_EXPLANATIONS = {
  DEEP_INSPECTION_UNAVAILABLE: 'Only the file type, signature, size and hash are checked for this format; its content is not inspected.',
  RIGCHECK_UNAVAILABLE: 'RigCheck could not inspect this model.'
};

function severityName(value) {
  if (typeof value === 'number') return VALIDATOR_SEVERITIES[value] ?? 'info';
  return VALIDATOR_SEVERITIES.includes(value) ? value : 'info';
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// One entry per file the pipeline re-inspected (validate --recheck), as recorded in the job result: identity,
// technical status and, for GLBs, RigCheck's measurements and glTF-validator diagnostics. Nothing is computed here.
export function summarizeInspections(job) {
  return asArray(job?.result?.pipeline?.result?.fresh_inspections).map((entry) => {
    const inspection = entry?.inspection ?? {};
    const rig = inspection.rig ?? {};
    const result = rig.result && typeof rig.result === 'object' ? rig.result : null;
    const metrics = result?.metrics && typeof result.metrics === 'object' ? result.metrics : null;
    const declaredMaterials = Array.isArray(inspection.model?.materials) ? inspection.model.materials.length : null;
    const validation = result?.validation ?? null;
    const path = typeof entry?.path === 'string' ? entry.path : null;
    return {
      path,
      fileName: path ? path.slice(path.lastIndexOf('/') + 1) : null,
      format: inspection.format ?? null,
      sizeBytes: count(inspection.size_bytes),
      sha256: inspection.sha256 ?? null,
      technicalStatus: inspection.technical?.status ?? null,
      technicalIssues: asArray(inspection.technical?.issues).map((issue) => ({
        severity: severityName(issue?.severity),
        code: issue?.code ?? null,
        text: TECHNICAL_EXPLANATIONS[issue?.code] ?? issueText(issue)
      })),
      model: inspection.format === 'glb' ? {
        rigStatus: rig.status ?? null,
        valid: typeof result?.valid === 'boolean' ? result.valid : null,
        triangles: count(result?.triangles),
        meshes: count(result?.meshes),
        bones: count(result?.bones),
        skins: count(result?.skins),
        clips: count(result?.clips),
        materialsUsed: count(metrics?.materials?.used),
        materialsDeclared: count(metrics?.materials?.declared) ?? declaredMaterials,
        skinnedMeshes: count(metrics?.skinnedMeshNodes),
        drawCalls: count(metrics?.drawCalls),
        vertices: count(metrics?.vertices),
        textures: metrics ? asArray(metrics.images).map((image) => ({ width: count(image?.width), height: count(image?.height), mimeType: image?.mimeType ?? null })) : null,
        maxTexture: count(metrics?.maxImageDimension),
        animations: metrics ? asArray(metrics.animations).filter((name) => typeof name === 'string')
          : asArray(inspection.model?.animations).map((animation) => animation?.name).filter((name) => typeof name === 'string'),
        validator: validation ? {
          errors: count(validation.errorCount) ?? 0,
          warnings: count(validation.warningCount) ?? 0,
          infos: count(validation.infoCount) ?? 0,
          hints: count(validation.hintCount) ?? 0,
          truncated: validation.truncated === true,
          messages: asArray(validation.messages).map((message) => ({
            severity: severityName(message?.severity),
            code: message?.code ?? null,
            message: message?.message ?? '',
            pointer: message?.pointer ?? null
          }))
        } : null
      } : null
    };
  });
}
