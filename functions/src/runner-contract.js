// The job runner's input contract, mirrored from .github/asset-library/run_job.py on invasion-godot `main`
// (Phase 3). The runner is authoritative and re-validates every input against the checked-out pipeline; these
// checks exist so the API refuses doomed requests before dispatching, and so it never sends an input the runner
// would reject as unexpected. Asset vocabularies (IDs, categories, roles, extensions) are not here: they are read
// from the pipeline itself (see vocabulary.js).
import { ApiError } from './errors.js';

// selftest exists in the runner but is a maintenance operation, not part of the API.
export const OPERATIONS = Object.freeze(['validate', 'ingest', 'promote_dry_run', 'promote_confirm']);
export const MUTATIONS = Object.freeze(['ingest', 'promote_confirm']);

// Inputs each operation accepts (job_id and operation are always sent). A runner input counts as "provided"
// whenever it is non-empty, so false booleans and absent values are omitted rather than sent as "false" or "".
export const ALLOWED = Object.freeze({
  validate: ['asset_id', 'revision_id', 'recheck', 'strict'],
  ingest: ['base_sha', 'asset_id', 'revision_id', 'category', 'display_name', 'role', 'note', 'source', 'creator',
    'staged_url', 'expected_size', 'expected_md5', 'file_name'],
  promote_dry_run: ['base_sha', 'asset_id', 'revision_id', 'category', 'display_name', 'destination'],
  promote_confirm: ['base_sha', 'asset_id', 'revision_id', 'category', 'display_name', 'destination', 'accept_warnings']
});
export const REQUIRED = Object.freeze({
  validate: [],
  ingest: ['base_sha', 'asset_id', 'staged_url', 'expected_size', 'expected_md5', 'file_name'],
  promote_dry_run: ['base_sha', 'asset_id', 'revision_id'],
  promote_confirm: ['base_sha', 'asset_id', 'revision_id']
});
const BOOLEAN_INPUTS = new Set(['accept_warnings', 'recheck', 'strict']);

export const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const BASE_SHA = /^[0-9a-f]{40}$/;
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
export const MAX_TEXT = Object.freeze({ display_name: 120, note: 2000, source: 500, creator: 120 });
// Same control-character rule as the runner (tab and newline allowed; carriage return is not).
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;
export const STAGED_URL_PREFIX = 'https://storage.googleapis.com/';
export const MAX_STAGED_URL_LENGTH = 8192;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_DESTINATION_LENGTH = 300;

export function invalid(message, details) {
  return new ApiError(400, 'invalid_request', message, details);
}

export function fileExtension(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

// Python's len() counts code points, not UTF-16 units.
function codePoints(value) {
  return [...value].length;
}

export function checkText(name, value) {
  if (value === undefined || value === null || value === '') return undefined;
  const limit = MAX_TEXT[name];
  if (typeof value !== 'string' || codePoints(value) > limit || CONTROL_CHARS.test(value)) {
    throw invalid(`${name} must be at most ${limit} printable characters.`);
  }
  return value;
}

export function checkDestination(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid('destination must be a plain repository path under assets/.');
  const parts = value.split('/');
  // The runner strips surrounding whitespace; refusing it here keeps the dispatched value exactly what was reviewed.
  if (!value.startsWith('assets/') || value.includes('\\') || value.length > MAX_DESTINATION_LENGTH || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw invalid('destination must be a plain repository path under assets/.');
  }
  return value;
}

export function checkFileName(value, supportedExtensions) {
  if (typeof value !== 'string' || !FILE_NAME.test(value) || !supportedExtensions.has(fileExtension(value))) {
    throw invalid('fileName must be a plain file name with an extension the asset pipeline supports.', {
      supportedExtensions: [...supportedExtensions].sort()
    });
  }
  return value;
}

// Builds the exact workflow_dispatch inputs for one job. Throws on any input the runner would refuse as
// unexpected or missing; that is a programming error here, never a user error.
export function buildDispatchInputs(jobId, operation, values) {
  if (!JOB_ID.test(jobId) || !OPERATIONS.includes(operation)) throw new Error(`invalid job ${jobId}/${operation}`);
  const allowed = new Set(ALLOWED[operation]);
  const inputs = { job_id: jobId, operation };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (!allowed.has(name)) throw new Error(`${operation} does not accept ${name}`);
    if (BOOLEAN_INPUTS.has(name)) {
      if (value !== true) throw new Error(`${name} must be a boolean`);
      inputs[name] = 'true';
    } else {
      inputs[name] = String(value);
    }
  }
  const missing = REQUIRED[operation].filter((name) => !(name in inputs));
  if (missing.length) throw new Error(`${operation} requires ${missing.join(', ')}`);
  if (operation === 'validate' && inputs.revision_id && !inputs.asset_id) throw new Error('revision_id requires asset_id');
  if (inputs.staged_url && (!inputs.staged_url.startsWith(STAGED_URL_PREFIX) || inputs.staged_url.length > MAX_STAGED_URL_LENGTH || /\s/.test(inputs.staged_url))) {
    throw new Error('staged_url must be a signed Cloud Storage URL');
  }
  return inputs;
}
