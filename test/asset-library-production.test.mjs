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

test('validation reports expose every re-inspected file with RigCheck measurements and validator messages', async () => {
  const { summarizeInspections, operationLabel } = await import('../dist/lib/asset-library-jobs.js');
  const job = { result: { pipeline: { ok: true, result: {
    findings: [{ severity: 'warning', code: 'PRODUCTION_BUDGET', message: 'Hero: too many triangles' }, { severity: 'error', code: 'X', message: 'broken' }],
    fresh_inspections: [
      { path: 'assets/x/hero.glb', inspection: { format: 'glb', size_bytes: 2048, sha256: 'a'.repeat(64), technical: { status: 'pass', issues: [] },
        model: { materials: [{ index: 0 }], animations: [{ index: 0, name: 'Walk' }] },
        rig: { status: 'warning', result: { valid: true, triangles: 120000, meshes: 1, bones: 23, skins: 1, clips: 1,
          metrics: { materials: { declared: 2, used: 1, primitivesWithoutMaterial: 0 }, skinnedMeshNodes: 1, drawCalls: 1, vertices: 60000,
            images: [{ index: 0, mimeType: 'image/png', width: 2048, height: 1024 }, { index: 1, mimeType: 'image/ktx2', width: null, height: null }],
            maxImageDimension: 2048, unmeasuredImages: 1, animations: ['Walk'], extensionsUsed: [] },
          validation: { errorCount: 0, warningCount: 1, infoCount: 0, hintCount: 0, truncated: false, messages: [{ severity: 1, code: 'NODE_SKINNED_MESH_NON_ROOT', message: 'Skinned node is not root', pointer: '/nodes/0' }] } } } } },
      { path: 'assets/x/hero_basecolor.jpg', inspection: { format: 'jpg', size_bytes: 300, technical: { status: 'warning', issues: [{ code: 'DEEP_INSPECTION_UNAVAILABLE', severity: 'warning' }] }, rig: { status: 'unknown', result: null } } },
      { path: 'assets/x/legacy.glb', inspection: { format: 'glb', size_bytes: 10, technical: { status: 'pass', issues: [] }, model: { materials: [{}, {}, {}], animations: [] },
        rig: { status: 'pass', result: { valid: true, triangles: 10, meshes: 1, bones: 0, skins: 0, clips: 0, validation: { errorCount: 0, warningCount: 0, infoCount: 0, hintCount: 0, messages: [] } } } } }
    ],
    production: []
  } } } };
  const [hero, texture, legacy] = summarizeInspections(job);
  assert.equal(hero.fileName, 'hero.glb');
  assert.deepEqual([hero.model.triangles, hero.model.materialsUsed, hero.model.materialsDeclared, hero.model.skinnedMeshes, hero.model.bones, hero.model.maxTexture], [120000, 1, 2, 1, 23, 2048]);
  assert.deepEqual(hero.model.textures, [{ width: 2048, height: 1024, mimeType: 'image/png' }, { width: null, height: null, mimeType: 'image/ktx2' }]);
  assert.deepEqual(hero.model.validator.messages, [{ severity: 'warning', code: 'NODE_SKINNED_MESH_NON_ROOT', message: 'Skinned node is not root', pointer: '/nodes/0' }]);
  assert.equal(texture.model, null, 'texture files have no model section');
  assert.match(texture.technicalIssues[0].text, /content is not inspected/);
  assert.equal(legacy.model.textures, null, 'an older RigCheck result has no texture data rather than an empty list');
  assert.equal(legacy.model.materialsDeclared, 3, 'falls back to the declared materials the pipeline extracted');
  assert.equal(legacy.model.materialsUsed, null);
  assert.deepEqual(summarizeValidation(job).allFindings.map((f) => f.severity), ['warning', 'error']);
  assert.equal(operationLabel('validate'), 'Re-validation');
  assert.equal(operationLabel('nope'), 'Job');
  assert.deepEqual(summarizeInspections({}), []);
});
