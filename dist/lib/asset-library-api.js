// RigCheck Asset Library — browser API client helpers. No DOM and no Firebase imports, so they are unit-tested in Node.

export const PRODUCTION_API_BASE = 'https://us-west1-rigcheck-cfbe3.cloudfunctions.net/assetLibraryApi';
export const API_BASE_OVERRIDE_KEY = 'rigcheck.assetLibraryApiBase';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const LOCAL_API_BASE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[^?#]*$/;

// One production code path. A local emulator URL may be used only when the app itself is served from localhost.
export function resolveApiBase(location, storage) {
  if (LOCAL_HOSTS.has(location?.hostname)) {
    let override = null;
    try {
      override = storage?.getItem(API_BASE_OVERRIDE_KEY) ?? null;
    } catch {
      override = null;
    }
    if (override && LOCAL_API_BASE.test(override)) return override.replace(/\/+$/, '');
  }
  return PRODUCTION_API_BASE;
}

const MESSAGES = {
  unauthenticated: 'Sign in to use the Asset Library.',
  not_authorized: 'This account is signed in but is not authorized for the INVASION Asset Library.',
  writer_required: 'This action requires Asset Library write access.',
  origin_not_allowed: 'This copy of RigCheck is not allowed to reach the Asset Library API.',
  invalid_request: 'RigCheck sent an invalid Asset Library request.',
  not_registered: 'That file is not listed for this revision in the manifest.',
  not_published: 'Not yet available from the authoritative repository.',
  asset_too_large: 'This file is larger than the Asset Library can deliver.',
  integrity_mismatch: 'The repository bytes did not match their recorded identity, so nothing was delivered.',
  manifest_unavailable: 'The asset manifest is not available on the authoritative branch.',
  manifest_invalid: 'The asset manifest on the authoritative branch could not be read.',
  upstream_error: 'The authoritative repository could not be reached. Try again shortly.',
  stale_base: 'The branch changed since you loaded it — refresh and review again.',
  mutation_in_progress: 'Another asset change is already running. Wait for it to finish.',
  rate_limited: 'Too many Asset Library requests. Wait a little and try again.',
  network: 'Could not reach the Asset Library. Check your connection and try again.',
  internal: 'The Asset Library hit an unexpected error.'
};

export function describeApiError(code) {
  return MESSAGES[code] ?? MESSAGES.internal;
}

export class AssetApiError extends Error {
  constructor(code, status, message) {
    super(message ?? describeApiError(code));
    this.name = 'AssetApiError';
    this.code = code;
    this.status = status;
  }
}

export async function apiGet({ base, path, params, getIdToken, fetchImpl = globalThis.fetch }) {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  const token = await getIdToken();
  let response;
  try {
    response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    throw new AssetApiError('network', 0);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = body?.error?.code ?? (response.status === 429 ? 'rate_limited' : 'internal');
    throw new AssetApiError(code, response.status, describeApiError(code));
  }
  return body;
}

export function shortSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : null;
}
