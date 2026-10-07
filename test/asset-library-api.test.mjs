import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_BASE_OVERRIDE_KEY,
  AssetApiError,
  PRODUCTION_API_BASE,
  apiGet,
  describeApiError,
  resolveApiBase,
  shortSha
} from '../dist/lib/asset-library-api.js';

const storageWith = (value) => ({ getItem: (key) => (key === API_BASE_OVERRIDE_KEY ? value : null) });

test('the production API base is the only path for the deployed site', () => {
  assert.equal(PRODUCTION_API_BASE, 'https://us-west1-rigcheck-cfbe3.cloudfunctions.net/assetLibraryApi');
  const pages = { hostname: 'pizzarolls510.github.io' };
  assert.equal(resolveApiBase(pages, storageWith('http://127.0.0.1:5001/demo/us-west1/assetLibraryApi')), PRODUCTION_API_BASE);
  assert.equal(resolveApiBase(pages, null), PRODUCTION_API_BASE);
});

test('a localhost-served app may target a local emulator, but never a remote override', () => {
  const local = { hostname: '127.0.0.1' };
  assert.equal(
    resolveApiBase(local, storageWith('http://127.0.0.1:5001/rigcheck-cfbe3/us-west1/assetLibraryApi/')),
    'http://127.0.0.1:5001/rigcheck-cfbe3/us-west1/assetLibraryApi'
  );
  assert.equal(resolveApiBase(local, storageWith('https://evil.example/api')), PRODUCTION_API_BASE);
  assert.equal(resolveApiBase(local, storageWith('http://localhost.evil.example/api')), PRODUCTION_API_BASE);
  assert.equal(resolveApiBase(local, { getItem() { throw new Error('blocked'); } }), PRODUCTION_API_BASE);
});

test('apiGet sends the ID token, encodes parameters and maps API errors to clear messages', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/file')) {
      return new Response(JSON.stringify({ error: { code: 'not_published', message: 'x' } }), { status: 404 });
    }
    return new Response(JSON.stringify({ commitSha: 'abc' }), { status: 200 });
  };
  const getIdToken = async () => 'id-token-1';
  assert.deepEqual(await apiGet({ base: 'https://api.example/fn', path: '/api/manifest', getIdToken, fetchImpl }), { commitSha: 'abc' });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer id-token-1');
  assert.equal(calls[0].init.cache, 'no-store');

  await assert.rejects(
    apiGet({ base: 'https://api.example/fn', path: '/api/file', params: { asset: 'a', revision: 'r', path: 'assets/x y.glb' }, getIdToken, fetchImpl }),
    (error) => error instanceof AssetApiError && error.code === 'not_published' && error.status === 404
      && error.message === 'Not yet available from the authoritative repository.'
  );
  assert.equal(calls[1].url, 'https://api.example/fn/api/file?asset=a&revision=r&path=assets%2Fx+y.glb');
});

test('network failures, non-JSON errors and 429s get stable codes', async () => {
  const getIdToken = async () => 't';
  await assert.rejects(apiGet({ base: 'https://a', path: '/api/manifest', getIdToken, fetchImpl: async () => { throw new TypeError('offline'); } }), { code: 'network' });
  await assert.rejects(apiGet({ base: 'https://a', path: '/api/manifest', getIdToken, fetchImpl: async () => new Response('<html>', { status: 500 }) }), { code: 'internal' });
  await assert.rejects(apiGet({ base: 'https://a', path: '/api/manifest', getIdToken, fetchImpl: async () => new Response('', { status: 429 }) }), { code: 'rate_limited' });
  assert.equal(describeApiError('stale_base'), 'The branch changed since you loaded it — refresh and review again.');
  assert.equal(describeApiError('something_new'), describeApiError('internal'));
  assert.equal(shortSha('bd19f958c74213b93085486b755b0ee846fc895f'), 'bd19f95');
  assert.equal(shortSha('nope'), null);
});
