import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeDryRun, summarizeIngest, summarizeValidation } from '../dist/lib/asset-library-jobs.js';
import { mapProduction, mapRevision, productionStatusLabel } from '../dist/lib/asset-library-model.js';

// Shape of the pipeline's recorded production evaluation (synthetic values).
const overBudget = {
  status: 'fail',
  profile: 'hero',
  profile_label: 'Hero character',
  profile_source: 'category_default',
  policy_version: 1,
  checks: [
    { id: 'triangles', label: 'LOD0 triangles', status: 'fail', measured: 120000, target: '20,000–40,000', enforcement: 'warning', message: '120,000 triangles exceed the limit.', fix: 'Reduce LOD0 to at most 40,000 triangles.' },
    { id: 'materials', label: 'Materials', status: 'pass', measured: 1, target: '1', message: '1 material(s).' },
    { id: 'textures', label: 'Texture size', status: 'fail', measured: 2048, target: '≤ 1,024 px', enforcement: 'warning', message: 'Largest texture is 2,048 px.', fix: 'Downscale textures to 1,024 px.' },
    { id: 'animations', label: 'Animation clips', status: 'info', measured: 1, target: 'Idle, Walk', message: 'Clips: Walk.' }
  ],
  outstanding: ['Reduce LOD0 to at most 40,000 triangles.', 'Downscale textures to 1,024 px.'],
  not_verified: ['Real mobile-device performance (FPS, thermals, memory)', 'Godot import, generated LODs, shadow settings and gameplay integration']
};

test('production records are labelled as recorded; unknown states never read as a pass', () => {
  const mapped = mapProduction(overBudget);
  assert.equal(mapped.status, 'fail');
  assert.equal(mapped.statusLabel, 'Fail');
  assert.equal(mapped.profileLabel, 'Hero character');
  assert.deepEqual(mapped.checks.map((check) => [check.label, check.measured, check.target, check.statusLabel]), [
    ['LOD0 triangles', '120,000', '20,000–40,000', 'Fail'],
    ['Materials', '1', '1', 'Pass'],
    ['Texture size', '2,048 px', '≤ 1,024 px', 'Fail'],
    ['Animation clips', '1', 'Idle, Walk', 'Info']
  ]);
  assert.deepEqual(mapped.outstanding, overBudget.outstanding);
  assert.equal(mapped.notVerified.length, 2);

  assert.equal(mapProduction(null), null);
  assert.equal(mapProduction({ status: 'excellent', checks: [{ id: 'x', status: 'great' }] }).status, 'not_verified');
  assert.equal(mapProduction({ status: 'pass', checks: [{ id: 'x', status: 'great' }] }).checks[0].status, 'not_verified');
  assert.equal(mapProduction({ status: 'pass', checks: [{ id: 'x', status: 'pass', measured: null }] }).checks[0].measured, 'Not available');
  assert.equal(productionStatusLabel('not_applicable'), 'Not applicable');
  assert.equal(productionStatusLabel('not_evaluated'), 'Not evaluated');
  const core = mapProduction({ status: 'not_evaluated', profile_source: 'asset_assignment', checks: [{ id: 'triangles', label: 'LOD0 triangles', status: 'not_evaluated', measured: 90000, target: 'Not yet defined', enforcement: 'none' }] });
  assert.deepEqual([core.status, core.statusLabel, core.checks[0].statusLabel, core.checks[0].measured, core.checks[0].enforcement], ['not_evaluated', 'Not evaluated', 'Not evaluated', '90,000', 'none'],
    'a measured value with no budget is "not evaluated", never a pass');
  const accepted = mapProduction({ ...overBudget, warnings_accepted_at_promotion: true });
  assert.equal(accepted.status, 'fail', 'accepting warnings never changes the status');
  assert.equal(accepted.warningsAccepted, true);
  assert.equal(mapProduction(overBudget).warningsAccepted, false);
  assert.equal(productionStatusLabel(undefined), 'Not verified');
});

test('revisions expose recorded production and whether they carry a 3D model', () => {
  const asset = { asset_id: 'sample_hero', canonical_revision: null };
  const withRecord = mapRevision({ revision_id: 'r_a', canonical_state: 'candidate', files: [{ path: 'assets/_workbench/x/hero.glb', role: 'runtime' }], production: overBudget }, asset);
  assert.equal(withRecord.hasModel, true);
  assert.equal(withRecord.production.status, 'fail');
  const legacy = mapRevision({ revision_id: 'r_b', canonical_state: 'candidate', files: [{ path: 'assets/x/hero.glb', role: 'runtime' }] }, asset);
  assert.equal(legacy.hasModel, true);
  assert.equal(legacy.production, null, 'older revisions show "not evaluated" rather than an invented result');
  const sprite = mapRevision({ revision_id: 'r_c', canonical_state: 'canonical', files: [{ path: 'assets/x/sheet.png', role: 'runtime' }] }, asset);
  assert.equal(sprite.hasModel, false);
});

test('ingest, dry-run and validation summaries carry the pipeline production results', () => {
  const ingest = summarizeIngest({ params: { asset_id: 'sample_hero' }, result: { pipeline: { ok: true, result: { revision_id: 'r_a', files: [], warnings: [], production: overBudget } } } });
  assert.equal(ingest.production.status, 'fail');

  const dryRun = summarizeDryRun({ jobId: 'job-1-abcdef', baseSha: 'a'.repeat(40), result: { pipeline: { ok: true, result: { revision_id: 'r_a', warnings: [{ code: 'PRODUCTION_TRIANGLES', message: 'Hero character: 120,000 triangles exceed the limit.' }], files: [], production: overBudget } } } });
  assert.equal(dryRun.blocked, false);
  assert.deepEqual(dryRun.blockers, []);
  assert.equal(dryRun.requiresAcceptance, true, 'production warnings need explicit acceptance like any other warning');
  assert.equal(dryRun.production.checks[0].status, 'fail');

  const blocked = summarizeDryRun({ status: 'error', result: { pipeline: {
    ok: false,
    error: 'Unresolved promotion blocker: PROVENANCE_MISSING; Promotion requires an explicit display name and category',
    blockers: [{ code: 'RECORDED_BLOCKER', message: 'Unresolved promotion blocker: PROVENANCE_MISSING' }, { code: 'PROMOTION_METADATA', message: 'Promotion requires an explicit display name and category' }],
    result: { revision_id: 'r_a', warnings: [], files: [], production: { ...overBudget, status: 'pass', checks: [], outstanding: [] } }
  } } });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.available, true);
  assert.deepEqual(blocked.blockers, ['RECORDED_BLOCKER — Unresolved promotion blocker: PROVENANCE_MISSING', 'PROMOTION_METADATA — Promotion requires an explicit display name and category']);
  assert.equal(blocked.production.status, 'pass');

  const legacyBlocked = summarizeDryRun({ status: 'error', result: { pipeline: { ok: false, error: 'Unresolved promotion blocker: X' } } });
  assert.equal(legacyBlocked.available, false, 'an older pipeline error without a plan has nothing to review');

  const validation = summarizeValidation({ result: { pipeline: { ok: true, result: { findings: [], fresh_inspections: [{}], production: [
    { revision_id: 'r_a', canonical_state: 'canonical', ...overBudget },
    { revision_id: 'r_b', canonical_state: 'candidate', status: 'not_applicable', checks: [], reason: 'No production profile applies to this category.' }
  ] } } } });
  assert.deepEqual(validation.production.map((entry) => [entry.revisionId, entry.canonicalState, entry.production.status]), [
    ['r_a', 'canonical', 'fail'],
    ['r_b', 'candidate', 'not_applicable']
  ]);
});
