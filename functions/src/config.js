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

export const DEFAULT_CONFIG = Object.freeze({
  githubOwner: GITHUB_OWNER,
  githubRepo: GITHUB_REPO,
  manifestBranch: MANIFEST_BRANCH,
  manifestPath: MANIFEST_PATH,
  allowedOrigins: ALLOWED_ORIGINS,
  allowDevOrigins: true,
  signedUrlTtlMs: SIGNED_URL_TTL_MS,
  headCacheTtlMs: HEAD_CACHE_TTL_MS,
  maxAssetBytes: MAX_ASSET_BYTES
});
