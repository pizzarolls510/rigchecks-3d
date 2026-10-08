// Fixed deployment facts for the Asset Library API. Nothing here is secret; the GitHub token is a Secret Manager param.

export const PROJECT_ID = 'rigcheck-cfbe3';
export const REGION = 'us-west1'; // Same region as the Storage bucket, so cache fills never cross regions.
export const STORAGE_BUCKET = 'rigcheck-cfbe3.firebasestorage.app';
// Dedicated least-privilege runtime identity (see infra/asset-library/DEPLOY.md), not the default compute account.
export const RUNTIME_SERVICE_ACCOUNT = 'asset-library-api@rigcheck-cfbe3.iam.gserviceaccount.com';

export const GITHUB_OWNER = 'pizzarolls510';
export const GITHUB_REPO = 'invasion-godot';
export const MANIFEST_BRANCH = '3d-migration';
export const MANIFEST_PATH = 'docs/ASSET_MANIFEST.yaml';

export const ALLOWED_ORIGINS = Object.freeze(['https://pizzarolls510.github.io']);
// Local development only (static server or emulator UI). An ID token is still required.
export const DEV_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export const ASSET_LIBRARY_ROLES = Object.freeze(['reader', 'writer']);

// Derived, disposable copies of GitHub bytes. Content-addressed, so they can never disagree with GitHub.
export const CACHE_PREFIX = 'asset-library-cache/';
export const CACHE_TMP_PREFIX = 'asset-library-cache/tmp/';

export const SIGNED_URL_TTL_MS = 10 * 60 * 1000;
export const HEAD_CACHE_TTL_MS = 20 * 1000;
export const LFS_POINTER_MAX_BYTES = 1024;
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;

// Phase 4 jobs. The runner is .github/asset-library/run_job.py on invasion-godot `main`, dispatched with ref `main`;
// it checks out, runs against and pushes to MANIFEST_BRANCH. The pipeline vocabulary is read from VOCABULARY_PATH.
export const WORKFLOW_FILE = 'asset-library-job.yml';
export const WORKFLOW_REF = 'main';
export const RESULT_ARTIFACT = 'asset-job-result';
export const VOCABULARY_PATH = 'tools/asset_pipeline/common.py';

// Staged uploads: asset-library-staging/{uid}/{jobId}/{fileName}, removed by a 2-day bucket lifecycle rule.
export const STAGING_PREFIX = 'asset-library-staging/';
export const UPLOAD_RESERVATION_TTL_MS = 2 * 24 * 60 * 60 * 1000;
export const STAGED_URL_TTL_MS = 30 * 60 * 1000;
// Static copy of the pipeline's SUPPORTED set for storage.rules, which cannot read the repository. The API and the
// runner both re-check against the live pipeline vocabulary; a test keeps storage.rules in step with this list.
export const STAGING_EXTENSIONS = Object.freeze([
  '.blend', '.glb', '.fbx', '.psd', '.tga', '.exr', '.tif', '.tiff', '.ktx2',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.hdr', '.wav', '.ogg', '.mp3', '.flac', '.ttf', '.otf'
]);

// Firestore holds derived job metadata only, never manifest data.
export const JOBS_COLLECTION = 'assetLibraryJobs';
export const LOCK_DOC = 'assetLibraryLocks/mutation';
export const RATE_COLLECTION = 'assetLibraryRate';
export const MUTATION_LOCK_TTL_MS = 20 * 60 * 1000;
export const RATE_WINDOW_MS = 60 * 60 * 1000;
export const RATE_LIMITS = Object.freeze({ dispatch: 20, upload: 20 });

// Polling: GitHub is consulted at most this often per job; a run that never appears or never reports is an error.
export const JOB_POLL_MIN_INTERVAL_MS = 3 * 1000;
export const RUN_DISCOVERY_TIMEOUT_MS = 15 * 60 * 1000;
export const ARTIFACT_GRACE_MS = 90 * 1000;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_CACHED_RESULT_CHARS = 800 * 1024;

export const DEFAULT_CONFIG = Object.freeze({
  githubOwner: GITHUB_OWNER,
  githubRepo: GITHUB_REPO,
  manifestBranch: MANIFEST_BRANCH,
  manifestPath: MANIFEST_PATH,
  allowedOrigins: ALLOWED_ORIGINS,
  allowDevOrigins: true,
  signedUrlTtlMs: SIGNED_URL_TTL_MS,
  headCacheTtlMs: HEAD_CACHE_TTL_MS,
  maxAssetBytes: MAX_ASSET_BYTES,
  workflowFile: WORKFLOW_FILE,
  workflowRef: WORKFLOW_REF,
  resultArtifact: RESULT_ARTIFACT,
  vocabularyPath: VOCABULARY_PATH,
  stagingPrefix: STAGING_PREFIX,
  uploadReservationTtlMs: UPLOAD_RESERVATION_TTL_MS,
  stagedUrlTtlMs: STAGED_URL_TTL_MS,
  mutationLockTtlMs: MUTATION_LOCK_TTL_MS,
  rateWindowMs: RATE_WINDOW_MS,
  rateLimits: RATE_LIMITS,
  jobPollMinIntervalMs: JOB_POLL_MIN_INTERVAL_MS,
  runDiscoveryTimeoutMs: RUN_DISCOVERY_TIMEOUT_MS,
  artifactGraceMs: ARTIFACT_GRACE_MS,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
  maxCachedResultChars: MAX_CACHED_RESULT_CHARS,
  jobsCollection: JOBS_COLLECTION,
  lockDoc: LOCK_DOC,
  rateCollection: RATE_COLLECTION
});
