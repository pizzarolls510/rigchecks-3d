// RigCheck Asset Library — pure mapping from INVASION's docs/ASSET_MANIFEST.yaml to UI-facing views.
// No I/O, no DOM, no Firebase. The manifest stays authoritative; this module only reshapes it for display
// and never decides canonical state, validity, or readiness on its own.

export const UNKNOWN = 'Unknown';
export const NOT_AVAILABLE = 'Not available';

// Mirrors the pipeline's controlled vocabularies (tools/asset_pipeline/common.py) for display order only.
export const CATEGORY_ORDER = ['operators', 'enemies', 'structures', 'environments', 'weapons', 'ui', 'effects', 'audio', 'other'];
export const STATE_ORDER = ['canonical', 'candidate', 'superseded'];

const CATEGORY_LABELS = {
  operators: 'Operators',
  enemies: 'Enemies',
  structures: 'Structures',
  environments: 'Environments',
  weapons: 'Weapons',
  ui: 'UI / 2D',
  effects: 'Effects',
  audio: 'Audio',
  other: 'Other'
};

const STATE_LABELS = {
  canonical: 'Current / Canonical',
  candidate: 'Candidate',
  superseded: 'Superseded',
  other: 'Unrecognized state'
};

const MODEL_FORMATS = new Set(['glb', 'gltf']);
const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const PREVIEW_ROLE_ORDER = ['runtime', 'source', 'reference', 'textures'];
// glTF-Validator numeric severities as stored in rig.issues.
const VALIDATOR_SEVERITIES = ['error', 'warning', 'info', 'hint'];

// Production compliance is evaluated only by the INVASION pipeline (tools/asset_pipeline/production.py); these
// helpers just label what it recorded. Unknown or missing values never read as a pass.
const PRODUCTION_STATUS_LABELS = {
  pass: 'Pass',
  warning: 'Warning',
  fail: 'Fail',
  not_verified: 'Not verified',
  not_evaluated: 'Not evaluated',
  not_applicable: 'Not applicable',
  info: 'Info'
};

export function productionStatusLabel(status) {
  return PRODUCTION_STATUS_LABELS[status] ?? PRODUCTION_STATUS_LABELS.not_verified;
}

function formatMeasured(check) {
  const value = check?.measured;
  if (typeof value !== 'number') return isMissing(value) ? NOT_AVAILABLE : String(value);
  const text = value.toLocaleString('en-US');
  return check.id === 'textures' ? `${text} px` : text;
}

export function mapProduction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = raw.status in PRODUCTION_STATUS_LABELS && raw.status !== 'info' ? raw.status : 'not_verified';
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
  return {
    status,
    statusLabel: productionStatusLabel(status),
    profile: raw.profile ?? null,
    profileLabel: raw.profile_label ?? null,
    profileSource: raw.profile_source ?? null,
    exception: typeof raw.exception === 'string' ? raw.exception : null,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    checks: (Array.isArray(raw.checks) ? raw.checks : []).filter((check) => check && typeof check === 'object').map((check) => {
      const checkStatus = check.status in PRODUCTION_STATUS_LABELS && check.status !== 'not_applicable' ? check.status : 'not_verified';
      return {
        id: check.id ?? null,
        label: check.label ?? check.id ?? UNKNOWN,
        status: checkStatus,
        statusLabel: productionStatusLabel(checkStatus),
        measured: formatMeasured(check),
        target: isMissing(check.target) ? NOT_AVAILABLE : String(check.target),
        message: typeof check.message === 'string' ? check.message : '',
        fix: typeof check.fix === 'string' ? check.fix : null,
        enforcement: ['blocker', 'warning', 'none'].includes(check.enforcement) ? check.enforcement : null
      };
    }),
    outstanding: strings(raw.outstanding),
    notVerified: strings(raw.not_verified),
    // Acceptance at promotion is shown next to the unchanged status; it never turns a violation into a pass.
    warningsAccepted: raw.warnings_accepted_at_promotion === true,
    policyVersion: Number.isInteger(raw.policy_version) ? raw.policy_version : null,
    evaluatedAt: raw.evaluated_at ?? null,
    source: raw.source ?? null
  };
}

export function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function displayValue(value, fallback = UNKNOWN) {
  if (isMissing(value)) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-US') : fallback;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((item) => displayValue(item, fallback)).join(', ');
  if (typeof value === 'object') return fallback;
  return String(value);
}

export function formatDate(value, fallback = UNKNOWN) {
  if (isMissing(value)) return fallback;
  const date = new Date(value);
  // Never reinterpret an unparseable stored value; show it as recorded.
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatBytes(value, fallback = UNKNOWN) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

export function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? displayValue(category);
}

export function stateLabel(state) {
  return STATE_LABELS[state] ?? STATE_LABELS.other;
}

function fileFormat(file) {
  if (!isMissing(file?.format)) return String(file.format).toLowerCase();
  const match = /\.([a-z0-9]+)$/i.exec(file?.path ?? '');
  return match ? match[1].toLowerCase() : null;
}

function fileKind(format) {
  if (MODEL_FORMATS.has(format)) return 'model';
  if (IMAGE_FORMATS.has(format)) return 'image';
  return 'other';
}

function mapFile(file) {
  const format = fileFormat(file);
  return {
    path: file?.path ?? null,
    role: file?.role ?? null,
    format,
    kind: fileKind(format),
    sizeBytes: typeof file?.size_bytes === 'number' ? file.size_bytes : null,
    sha256: file?.sha256 ?? null
  };
}

function normalizeSeverity(severity) {
  if (typeof severity === 'number') return VALIDATOR_SEVERITIES[severity] ?? 'unknown';
  return isMissing(severity) ? 'unknown' : String(severity).toLowerCase();
}

function mapIssue(issue, source) {
  return {
    source,
    severity: normalizeSeverity(issue?.severity),
    code: issue?.code ?? null,
    message: issue?.message ?? null,
    location: issue?.location ?? issue?.pointer ?? null
  };
}

export function collectKnownIssues(revision) {
  return [
    ...(revision?.technical_issues ?? []).map((issue) => mapIssue(issue, 'technical_issues')),
    ...(revision?.technical?.issues ?? []).map((issue) => mapIssue(issue, 'technical')),
    ...(revision?.rig?.issues ?? []).map((issue) => mapIssue(issue, 'rig'))
  ];
}

// Manual review is derived only from manifest data: recorded technical_issues at warning/error severity,
// a RigCheck rig status that is not a pass (except "unknown" explicitly marked not_applicable), and an
// asset-level rig_compatibility requirement the revision does not meet. No asset IDs are special-cased.
export function deriveManualReview(revision, asset = null) {
  const reasons = [];
  for (const issue of revision?.technical_issues ?? []) {
    const severity = normalizeSeverity(issue?.severity);
    if (severity === 'error' || severity === 'warning') {
      reasons.push({ source: 'technical_issues', severity, code: issue?.code ?? null, message: issue?.message ?? null });
    }
  }

  const rig = revision?.rig ?? null;
  const rigStatus = rig?.status ?? null;
  if (rigStatus === 'warning' || rigStatus === 'fail') {
    reasons.push({
      source: 'rig',
      severity: rigStatus === 'fail' ? 'error' : 'warning',
      code: `RIG_${rigStatus.toUpperCase()}`,
      message: rig?.reason ?? `RigCheck reported "${rigStatus}".`
    });
  } else if ((rigStatus === 'unknown' || isMissing(rigStatus)) && rig?.reason !== 'not_applicable') {
    reasons.push({
      source: 'rig',
      severity: 'warning',
      code: 'RIG_UNKNOWN',
      message: rig?.reason ?? 'RigCheck status is unknown for an applicable revision.'
    });
  }

  if (asset?.requirements?.rig_compatibility === true && rig?.compatible !== true) {
    reasons.push({
      source: 'rig_compatibility',
      severity: 'error',
      code: 'RIG_COMPATIBILITY_UNMET',
      message: 'The asset requires rig compatibility, but this revision is not recorded as compatible.'
    });
  }

  return { required: reasons.length > 0, reasons };
}

function revisionDates(revision) {
  return {
    createdAt: revision?.created_at ?? null,
    ingestedAt: revision?.ingested_at ?? null,
    recordedAt: revision?.recorded_at ?? null,
    promotedAt: revision?.promoted_at ?? null
  };
}

function latestTimestamp(values) {
  let latest = null;
  let latestTime = -Infinity;
  for (const value of values) {
    if (isMissing(value)) continue;
    const time = new Date(value).getTime();
    if (!Number.isNaN(time) && time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function findFile(files, path) {
  return isMissing(path) ? null : files.find((file) => file.path === path) ?? null;
}

// Only paths listed in files[] are returned, because those are the only paths the backend will serve.
function modelFile(files, revision) {
  for (const path of [revision?.runtime_path, revision?.source_path]) {
    const file = findFile(files, path);
    if (file?.kind === 'model') return file;
  }
  return files.find((file) => file.kind === 'model') ?? null;
}

function previewImageFile(files, revision) {
  const runtime = findFile(files, revision?.runtime_path);
  if (runtime?.kind === 'image') return runtime;
  for (const role of PREVIEW_ROLE_ORDER) {
    const file = files.find((candidate) => candidate.kind === 'image' && candidate.role === role);
    if (file) return file;
  }
  return null;
}

function mapModel(model) {
  const skeletons = Array.isArray(model?.skeletons) ? model.skeletons : null;
  return {
    triangles: typeof model?.triangles === 'number' ? model.triangles : null,
    polygons: typeof model?.polygons === 'number' ? model.polygons : null,
    meshes: typeof model?.meshes === 'number' ? model.meshes : null,
    materials: Array.isArray(model?.materials) ? model.materials.map((material) => material?.name ?? null) : null,
    textureCount: Array.isArray(model?.textures) ? model.textures.length : null,
    skeletons: skeletons ? skeletons.map((skeleton) => ({ name: skeleton?.name ?? null, boneCount: skeleton?.bones?.length ?? null })) : null,
    animations: Array.isArray(model?.animations) ? model.animations.map((animation) => animation?.name ?? null) : null
  };
}

function mapRigCheck(rig) {
  const result = rig?.result ?? null;
  return {
    status: rig?.status ?? null,
    reason: rig?.reason ?? null,
    provider: rig?.provider ?? null,
    scope: rig?.scope ?? null,
    compatible: typeof rig?.compatible === 'boolean' ? rig.compatible : null,
    missingBones: rig?.missing_bones ?? null,
    checkedAt: rig?.checked_at ?? null,
    valid: typeof result?.valid === 'boolean' ? result.valid : null,
    errorCount: result?.validation?.errorCount ?? null,
    warningCount: result?.validation?.warningCount ?? null,
    bones: result?.bones ?? null,
    clips: result?.clips ?? null
  };
}

export function mapRevision(revision, asset = null) {
  const files = (revision?.files ?? []).map(mapFile);
  const dates = revisionDates(revision);
  const model = modelFile(files, revision);
  const preview = model ? null : previewImageFile(files, revision);
  return {
    revisionId: revision?.revision_id ?? null,
    state: revision?.canonical_state ?? null,
    isCanonical: !isMissing(asset?.canonical_revision) && asset.canonical_revision === revision?.revision_id,
    pipelineStatus: revision?.pipeline_status ?? null,
    ...dates,
    latestDate: latestTimestamp(Object.values(dates)),
    note: revision?.note ?? null,
    sourcePath: revision?.source_path ?? null,
    runtimePath: revision?.runtime_path ?? null,
    files,
    provenance: {
      source: revision?.source ?? null,
      creator: revision?.creator ?? null,
      gitReference: revision?.git_reference ?? null,
      legacyInPlace: typeof revision?.legacy_in_place === 'boolean' ? revision.legacy_in_place : null
    },
    model: mapModel(revision?.model),
    rigCheck: mapRigCheck(revision?.rig),
    technical: {
      status: revision?.technical?.status ?? null,
      checkedAt: revision?.technical?.checked_at ?? null
    },
    knownIssues: collectKnownIssues(revision),
    manualReview: deriveManualReview(revision, asset),
    supersedes: revision?.supersedes ?? null,
    supersededBy: revision?.superseded_by ?? null,
    openInRigCheckPath: model?.path ?? null,
    previewImagePath: preview?.path ?? null,
    hasModel: files.some((file) => file.kind === 'model'),
    production: mapProduction(revision?.production)
  };
}

function compareRevisionsForDisplay(a, b) {
  const timeA = a.latestDate ? new Date(a.latestDate).getTime() : -Infinity;
  const timeB = b.latestDate ? new Date(b.latestDate).getTime() : -Infinity;
  if (timeA !== timeB) return timeB - timeA;
  return String(a.revisionId).localeCompare(String(b.revisionId));
}

export function shortNote(note, maxLength = 160) {
  if (isMissing(note)) return null;
  const text = String(note).trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length <= maxLength ? sentence : `${sentence.slice(0, maxLength - 1).trimEnd()}…`;
}

export function mapAsset(asset) {
  const revisions = (asset?.revisions ?? []).map((revision) => mapRevision(revision, asset));
  const groups = { canonical: [], candidate: [], superseded: [], other: [] };
  for (const revision of revisions) {
    (STATE_ORDER.includes(revision.state) ? groups[revision.state] : groups.other).push(revision);
  }
  for (const group of Object.values(groups)) group.sort(compareRevisionsForDisplay);

  // Canonical comes only from asset.canonical_revision; newest is never assumed to be canonical.
  const canonicalRevisionId = asset?.canonical_revision ?? null;
  const canonical = revisions.find((revision) => revision.isCanonical) ?? null;
  const canonicalIssues = [];
  if (isMissing(canonicalRevisionId)) {
    canonicalIssues.push('No canonical revision is recorded.');
  } else if (!canonical) {
    canonicalIssues.push(`Recorded canonical revision "${canonicalRevisionId}" is not among this asset's revisions.`);
  } else if (canonical.state !== 'canonical') {
    canonicalIssues.push(`Recorded canonical revision "${canonicalRevisionId}" has state "${displayValue(canonical.state)}".`);
  }
  const otherCanonical = groups.canonical.filter((revision) => revision.revisionId !== canonicalRevisionId);
  if (otherCanonical.length) {
    canonicalIssues.push(`Revision(s) marked canonical but not recorded as the asset's canonical: ${otherCanonical.map((r) => r.revisionId).join(', ')}.`);
  }

  const manualReviewRevisionIds = revisions.filter((revision) => revision.manualReview.required).map((revision) => revision.revisionId);
  return {
    assetId: asset?.asset_id ?? null,
    displayName: asset?.display_name ?? null,
    category: asset?.category ?? null,
    categoryLabel: categoryLabel(asset?.category),
    requirements: {
      source: asset?.requirements?.source ?? null,
      runtime: asset?.requirements?.runtime ?? null,
      rigCompatibility: asset?.requirements?.rig_compatibility ?? null
    },
    canonicalRevisionId,
    canonical,
    canonicalIssues,
    revisionCount: revisions.length,
    stateCounts: Object.fromEntries(Object.entries(groups).map(([state, list]) => [state, list.length])),
    groups,
    latestDate: latestTimestamp(revisions.map((revision) => revision.latestDate)),
    noteSummary: shortNote(canonical?.note),
    needsManualReview: manualReviewRevisionIds.length > 0,
    manualReviewRevisionIds
  };
}

function compareAssetsForDisplay(a, b) {
  return String(a.displayName ?? a.assetId).localeCompare(String(b.displayName ?? b.assetId))
    || String(a.assetId).localeCompare(String(b.assetId));
}

export function groupManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.assets)) {
    throw new TypeError('Asset manifest must be an object with an "assets" array.');
  }
  const byCategory = new Map();
  for (const asset of manifest.assets.map(mapAsset)) {
    const key = isMissing(asset.category) ? 'other' : asset.category;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(asset);
  }
  // Known categories in pipeline order; any unrecognized category is kept and listed after them.
  const keys = [
    ...CATEGORY_ORDER.filter((key) => byCategory.has(key)),
    ...[...byCategory.keys()].filter((key) => !CATEGORY_ORDER.includes(key)).sort()
  ];
  const categories = keys.map((key) => ({
    category: key,
    label: categoryLabel(key),
    assets: byCategory.get(key).sort(compareAssetsForDisplay)
  }));
  const assets = categories.flatMap((category) => category.assets);
  return {
    schemaVersion: manifest.schema_version ?? null,
    schemaSupported: manifest.schema_version === 1,
    assetCount: assets.length,
    revisionCount: assets.reduce((total, asset) => total + asset.revisionCount, 0),
    manualReviewAssetIds: assets.filter((asset) => asset.needsManualReview).map((asset) => asset.assetId),
    categories
  };
}
