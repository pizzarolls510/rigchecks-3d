import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { STAGING_EXTENSIONS } from '../src/config.js';
import { consumeRate, lockIsHeld } from '../src/job-store.js';
import { buildDispatchInputs, checkDestination, checkText } from '../src/runner-contract.js';
import { parsePipelineVocabulary, publicVocabulary } from '../src/vocabulary.js';
import { PIPELINE_COMMON } from './support/fakes.mjs';

test('buildDispatchInputs sends only allowed, non-empty inputs as strings and refuses contract violations', () => {
  assert.deepEqual(buildDispatchInputs('job-0001-test', 'validate', { asset_id: 'a', revision_id: undefined, recheck: true, strict: false }), {
    job_id: 'job-0001-test', operation: 'validate', asset_id: 'a', recheck: 'true'
  });
  assert.deepEqual(buildDispatchInputs('job-0001-test', 'promote_dry_run', { base_sha: 'a'.repeat(40), asset_id: 'a', revision_id: 'r', destination: '' }), {
    job_id: 'job-0001-test', operation: 'promote_dry_run', base_sha: 'a'.repeat(40), asset_id: 'a', revision_id: 'r'
  });
  assert.throws(() => buildDispatchInputs('job-0001-test', 'promote_dry_run', { base_sha: 'a'.repeat(40), asset_id: 'a', revision_id: 'r', accept_warnings: true }), /does not accept accept_warnings/);
  assert.throws(() => buildDispatchInputs('job-0001-test', 'ingest', { base_sha: 'a'.repeat(40), asset_id: 'a', recheck: true }), /does not accept recheck/);
  assert.throws(() => buildDispatchInputs('job-0001-test', 'promote_confirm', { base_sha: 'a'.repeat(40), asset_id: 'a' }), /requires revision_id/);
  assert.throws(() => buildDispatchInputs('job-0001-test', 'selftest', {}), /invalid job/);
  assert.throws(() => buildDispatchInputs('short', 'validate', {}), /invalid job/);
  assert.throws(() => buildDispatchInputs('job-0001-test', 'validate', { revision_id: 'r' }), /requires asset_id/);
  assert.throws(() => buildDispatchInputs('job-0001-test', 'ingest', {
    base_sha: 'a'.repeat(40), asset_id: 'a', staged_url: 'https://evil.example/x', expected_size: '1', expected_md5: 'x', file_name: 'a.glb'
  }), /signed Cloud Storage URL/);
});

test('text and destination checks match the runner (code points, control characters, plain assets/ paths)', () => {
  assert.equal(checkText('creator', 'é'.repeat(120)), 'é'.repeat(120));
  assert.throws(() => checkText('creator', 'é'.repeat(121)), /at most 120/);
  assert.throws(() => checkText('note', 'a\u0000b'), /printable/);
  assert.throws(() => checkText('note', 42), /printable/);
  assert.equal(checkText('note', ''), undefined);
  assert.equal(checkDestination('assets/operators/sample asset'), 'assets/operators/sample asset');
  for (const bad of ['assets', 'assets/', 'assets/./x', 'assets/x/', '/assets/x', 'assets/x ', 'assets/a\tb']) {
    assert.throws(() => checkDestination(bad), /plain repository path/, bad);
  }
});

test('the pipeline vocabulary is read from common.py literals', () => {
  const vocabulary = parsePipelineVocabulary(PIPELINE_COMMON);
  assert.deepEqual(publicVocabulary(vocabulary), {
    assetIdPattern: '^[a-z][a-z0-9_]{0,63}$',
    revisionIdPattern: '^[a-z0-9][a-z0-9_-]{0,95}$',
    categories: ['audio', 'effects', 'enemies', 'environments', 'operators', 'other', 'structures', 'ui', 'weapons'],
    roles: ['reference', 'runtime', 'source', 'textures'],
    supportedExtensions: [...STAGING_EXTENSIONS].sort()
  });
  assert.ok(vocabulary.assetId.test('sample_asset'));
  assert.ok(!vocabulary.assetId.test('Sample'));
  assert.ok(vocabulary.revisionId.test('r_0123-abc'));
});

test('anything outside the understood literal forms fails closed with vocabulary_unavailable', () => {
  for (const [label, source] of [
    ['missing name', PIPELINE_COMMON.replace(/^ROLES = .*$/m, '')],
    ['computed set', PIPELINE_COMMON.replace('ROLES = {', 'ROLES = set({')],
    ['non-literal member', PIPELINE_COMMON.replace('"runtime"', 'RUNTIME')],
    ['escaped string', PIPELINE_COMMON.replace('"runtime"', '"run\\time"')],
    ['unknown union term', PIPELINE_COMMON.replace('LFS_EXTENSIONS |', 'OTHER |')],
    ['regex flags', PIPELINE_COMMON.replace('ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")', 'ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$", re.I)')],
    ['unanchored regex', PIPELINE_COMMON.replace('r"^[a-z][a-z0-9_]{0,63}$"', 'r"[a-z]+"')],
    ['regex escapes', PIPELINE_COMMON.replace('r"^[a-z][a-z0-9_]{0,63}$"', 'r"^\\w+$"')],
    ['odd extension', PIPELINE_COMMON.replace('".otf"', '"otf"')],
    ['empty', '']
  ]) {
    assert.throws(() => parsePipelineVocabulary(source), (error) => error.code === 'vocabulary_unavailable' && error.status === 503, label);
  }
});

test('storage.rules allows exactly the staging extensions the API and pipeline support', () => {
  const rules = readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8');
  const listed = /\[\.\]\(([a-z0-9|]+)\)\$/.exec(rules)?.[1]?.split('|').map((extension) => `.${extension}`);
  assert.deepEqual(listed?.sort(), [...STAGING_EXTENSIONS].sort());
});

test('rate windows reset after an hour and report when to retry; the lock is held only while live and unexpired', () => {
  const options = { now: 1000, limit: 2, windowMs: 3600_000 };
  let rate = consumeRate(null, 'dispatch', options);
  rate = consumeRate(rate, 'dispatch', { ...options, now: 2000 });
  assert.deepEqual(rate.dispatch, { windowStart: 1000, count: 2 });
  assert.throws(() => consumeRate(rate, 'dispatch', { ...options, now: 1801_000 }), (error) => error.status === 429 && error.details.retryAfterSeconds === 1800);
  assert.equal(consumeRate(rate, 'upload', options).upload.count, 1, 'kinds are counted separately');
  assert.deepEqual(consumeRate(rate, 'dispatch', { ...options, now: 3601_000 }).dispatch, { windowStart: 3601_000, count: 1 });

  const lock = { jobId: 'j', expiresAt: 5000 };
  assert.equal(lockIsHeld(lock, { status: 'running' }, 4999), true);
  assert.equal(lockIsHeld(lock, { status: 'running' }, 5000), false);
  assert.equal(lockIsHeld(lock, { status: 'done' }, 1000), false);
  assert.equal(lockIsHeld(lock, null, 1000), false);
  assert.equal(lockIsHeld(null, null, 1000), false);
});
