import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CATEGORY_ORDER,
  NOT_AVAILABLE,
  UNKNOWN,
  collectKnownIssues,
  deriveManualReview,
  displayValue,
  formatBytes,
  formatDate,
  groupManifest,
  mapAsset,
  mapRevision,
  shortNote
} from '../dist/lib/asset-library-model.js';

// Synthetic manifest with exactly the same schema, shape and test cases as a real INVASION manifest snapshot, but no
// real asset names, paths, revision IDs, hashes, dates, provenance or notes (rigchecks-3d is public).
const fixtureManifest = JSON.parse(readFileSync(new URL('./fixtures/invasion-asset-manifest.json', import.meta.url), 'utf8'));

function findAsset(grouped, assetId) {
  return grouped.categories.flatMap((category) => category.assets).find((asset) => asset.assetId === assetId);
}

function revision(overrides = {}) {
  return {
    revision_id: 'rev_a',
    canonical_state: 'candidate',
    pipeline_status: null,
    source_path: null,
    runtime_path: null,
    files: [],
    created_at: null,
    ingested_at: null,
    recorded_at: null,
    promoted_at: null,
    git_reference: null,
    source: null,
    creator: null,
    note: null,
    model: { triangles: null, polygons: null, meshes: null, materials: null, textures: null, skeletons: null, animations: null },
    rig: { status: 'unknown', reason: 'not_applicable', issues: [] },
    technical: { status: 'pass', issues: [] },
    technical_issues: [],
    supersedes: null,
    superseded_by: null,
    legacy_in_place: false,
    ...overrides
  };
}

function asset(overrides = {}) {
  return {
    asset_id: 'thing',
    display_name: 'Thing',
    category: 'enemies',
    canonical_revision: 'rev_canon',
    requirements: { source: false, runtime: true, rig_compatibility: false },
    revisions: [],
    ...overrides
  };
}

test('fixture manifest groups every asset and revision by category in pipeline order', () => {
  const grouped = groupManifest(fixtureManifest);
  assert.equal(grouped.schemaVersion, 1);
  assert.equal(grouped.schemaSupported, true);
  assert.equal(grouped.assetCount, 15);
  assert.equal(grouped.revisionCount, 17);
  assert.deepEqual(
    grouped.categories.map((category) => [category.category, category.assets.length]),
    [['operators', 1], ['enemies', 6], ['structures', 5], ['environments', 1], ['ui', 2]]
  );
  const order = grouped.categories.map((category) => CATEGORY_ORDER.indexOf(category.category));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(grouped.categories.find((category) => category.category === 'ui').label, 'UI / 2D');
});

test('fixture manifest: operator canonical comes from canonical_revision with candidates grouped separately', () => {
  const suit = findAsset(groupManifest(fixtureManifest), 'operator_alpha');
  assert.equal(suit.canonicalRevisionId, 'rev_operator_alpha_current');
  assert.equal(suit.canonical.revisionId, 'rev_operator_alpha_current');
  assert.equal(suit.canonical.isCanonical, true);
  assert.deepEqual(suit.canonicalIssues, []);
  assert.equal(suit.revisionCount, 3);
  assert.deepEqual(suit.stateCounts, { canonical: 1, candidate: 2, superseded: 0, other: 0 });
  assert.deepEqual(suit.groups.candidate.map((r) => r.revisionId).sort(), ['rev_operator_alpha_candidate_runtime', 'rev_operator_alpha_candidate_source']);
  assert.ok(suit.groups.candidate.every((r) => r.isCanonical === false));
});

test('fixture manifest: manual review surfaces the benchmark enemy and the operator, and nothing else', () => {
  const grouped = groupManifest(fixtureManifest);
  assert.deepEqual([...grouped.manualReviewAssetIds].sort(), ['enemy_benchmark', 'operator_alpha']);

  const benchmark = findAsset(grouped, 'enemy_benchmark');
  const benchmarkRevision = benchmark.groups.candidate[0];
  assert.equal(benchmark.canonical, null, 'the benchmark-only enemy has no canonical revision in the manifest');
  assert.ok(benchmark.canonicalIssues.length > 0);
  assert.equal(benchmarkRevision.manualReview.required, true);
  assert.ok(benchmarkRevision.manualReview.reasons.some((r) => r.code === 'PROVENANCE_MISSING' && r.severity === 'error'));

  const suit = findAsset(grouped, 'operator_alpha');
  for (const candidate of suit.groups.candidate) {
    assert.equal(candidate.manualReview.required, true, candidate.revisionId);
    assert.ok(candidate.manualReview.reasons.some((r) => r.code === 'TRIANGLE_BUDGET_PENDING'));
    assert.ok(candidate.manualReview.reasons.some((r) => r.code === 'RIG_WARNING'));
  }

  // DEEP_INSPECTION_UNAVAILABLE technical warnings and not_applicable rig status are not review triggers.
  const structure = findAsset(grouped, 'structure_alpha');
  assert.equal(structure.needsManualReview, false);
  assert.equal(structure.canonical.technical.status, 'warning');
  assert.equal(structure.canonical.rigCheck.status, 'unknown');
});

test('fixture manifest: Open in RigCheck targets only GLBs listed in files[]; 2D assets get an image preview', () => {
  const grouped = groupManifest(fixtureManifest);
  const suit = findAsset(grouped, 'operator_alpha');
  const runtimeCandidate = suit.groups.candidate.find((r) => r.revisionId === 'rev_operator_alpha_candidate_runtime');
  const sourceCandidate = suit.groups.candidate.find((r) => r.revisionId === 'rev_operator_alpha_candidate_source');
  assert.equal(runtimeCandidate.openInRigCheckPath, 'assets/operators/operator_alpha/operator_alpha_runtime_1.glb');
  assert.equal(runtimeCandidate.previewImagePath, null);
  assert.equal(sourceCandidate.runtimePath, null);
  assert.equal(sourceCandidate.openInRigCheckPath, 'assets/operators/operator_alpha/operator_alpha_source_1.glb', 'source-only GLB is still openable');
  assert.equal(runtimeCandidate.model.triangles, 3000);
  assert.equal(runtimeCandidate.rigCheck.valid, true);
  assert.equal(runtimeCandidate.rigCheck.warningCount, 2);
  assert.ok(runtimeCandidate.knownIssues.some((issue) => issue.source === 'rig' && issue.severity === 'warning'));

  const uiAsset = findAsset(grouped, 'ui_alpha');
  assert.equal(uiAsset.canonical.openInRigCheckPath, null);
  assert.equal(uiAsset.canonical.previewImagePath, 'assets/ui/ui_alpha/ui_alpha_runtime_1.jpg');

  for (const mapped of grouped.categories.flatMap((c) => c.assets).flatMap((a) => Object.values(a.groups).flat())) {
    const listed = new Set(mapped.files.map((file) => file.path));
    if (mapped.openInRigCheckPath) assert.ok(listed.has(mapped.openInRigCheckPath), mapped.revisionId);
    if (mapped.previewImagePath) assert.ok(listed.has(mapped.previewImagePath), mapped.revisionId);
  }
});

test('newest revision is never assumed canonical', () => {
  const mapped = mapAsset(asset({
    canonical_revision: 'rev_old',
    revisions: [
      revision({ revision_id: 'rev_old', canonical_state: 'canonical', recorded_at: '2026-01-01T00:00:00Z' }),
      revision({ revision_id: 'rev_new', canonical_state: 'candidate', recorded_at: '2026-09-01T00:00:00Z' })
    ]
  }));
  assert.equal(mapped.canonical.revisionId, 'rev_old');
  assert.equal(mapped.groups.candidate[0].revisionId, 'rev_new');
  assert.equal(mapped.groups.candidate[0].isCanonical, false);
  assert.equal(mapped.latestDate, '2026-09-01T00:00:00Z');
});

test('superseded and unrecognized states are grouped without dropping data', () => {
  const mapped = mapAsset(asset({
    canonical_revision: 'rev_canon',
    revisions: [
      revision({ revision_id: 'rev_canon', canonical_state: 'canonical' }),
      revision({ revision_id: 'rev_old', canonical_state: 'superseded', superseded_by: 'rev_canon' }),
      revision({ revision_id: 'rev_odd', canonical_state: 'archived' })
    ]
  }));
  assert.deepEqual(mapped.stateCounts, { canonical: 1, candidate: 0, superseded: 1, other: 1 });
  assert.equal(mapped.groups.superseded[0].supersededBy, 'rev_canon');
  assert.equal(mapped.groups.other[0].revisionId, 'rev_odd');
});

test('canonical inconsistencies are reported, not resolved', () => {
  const missing = mapAsset(asset({ canonical_revision: 'rev_gone', revisions: [revision({ revision_id: 'rev_a', canonical_state: 'canonical' })] }));
  assert.equal(missing.canonical, null);
  assert.equal(missing.canonicalIssues.length, 2);

  const wrongState = mapAsset(asset({ canonical_revision: 'rev_a', revisions: [revision({ revision_id: 'rev_a', canonical_state: 'candidate' })] }));
  assert.equal(wrongState.canonical.revisionId, 'rev_a');
  assert.match(wrongState.canonicalIssues[0], /has state "candidate"/);

  const none = mapAsset(asset({ canonical_revision: null, revisions: [] }));
  assert.deepEqual(none.canonicalIssues, ['No canonical revision is recorded.']);
});

test('manual review: rig_compatibility requirement and applicable unknown rig status are triggers', () => {
  const required = asset({ requirements: { source: false, runtime: true, rig_compatibility: true } });
  const unmet = deriveManualReview(revision({ rig: { status: 'pass', compatible: false, issues: [] } }), required);
  assert.equal(unmet.required, true);
  assert.deepEqual(unmet.reasons.map((r) => r.code), ['RIG_COMPATIBILITY_UNMET']);

  const met = deriveManualReview(revision({ rig: { status: 'pass', compatible: true, issues: [] } }), required);
  assert.deepEqual(met, { required: false, reasons: [] });

  const unchecked = deriveManualReview(revision({ rig: { status: 'unknown', reason: null, issues: [] } }));
  assert.deepEqual(unchecked.reasons.map((r) => r.code), ['RIG_UNKNOWN']);

  const failed = deriveManualReview(revision({ rig: { status: 'fail', reason: 'bad skin', issues: [] } }));
  assert.deepEqual(failed.reasons.map((r) => [r.code, r.severity, r.message]), [['RIG_FAIL', 'error', 'bad skin']]);

  const infoOnly = deriveManualReview(revision({ technical_issues: [{ code: 'NOTE', severity: 'info', message: 'fyi' }] }));
  assert.equal(infoOnly.required, false);
});

test('known issues normalize technical_issues, technical.issues and numeric validator severities', () => {
  const issues = collectKnownIssues(revision({
    technical_issues: [{ code: 'A', severity: 'warning', message: 'a' }],
    technical: { status: 'warning', issues: [{ code: 'B', severity: 'warning' }] },
    rig: { status: 'warning', issues: [{ code: 'C', severity: 0, message: 'c', pointer: '/nodes/1' }] }
  }));
  assert.deepEqual(issues, [
    { source: 'technical_issues', severity: 'warning', code: 'A', message: 'a', location: null },
    { source: 'technical', severity: 'warning', code: 'B', message: null, location: null },
    { source: 'rig', severity: 'error', code: 'C', message: 'c', location: '/nodes/1' }
  ]);
});

test('missing data stays null in views and renders as Unknown / Not available', () => {
  const mapped = mapRevision(revision({ model: null, rig: null, technical: null, files: null }), asset());
  assert.equal(mapped.model.triangles, null);
  assert.equal(mapped.model.materials, null);
  assert.equal(mapped.rigCheck.status, null);
  assert.equal(mapped.technical.status, null);
  assert.deepEqual(mapped.files, []);
  assert.equal(mapped.openInRigCheckPath, null);
  assert.equal(mapped.latestDate, null);

  assert.equal(displayValue(null), UNKNOWN);
  assert.equal(displayValue(undefined), UNKNOWN);
  assert.equal(displayValue('  '), UNKNOWN);
  assert.equal(displayValue([]), UNKNOWN);
  assert.equal(displayValue(null, NOT_AVAILABLE), NOT_AVAILABLE);
  assert.equal(displayValue({ nested: true }), UNKNOWN);
  assert.equal(displayValue(123456), '123,456');
  assert.equal(displayValue(0), '0');
  assert.equal(displayValue(false), 'No');
  assert.equal(displayValue(['a', null]), `a, ${UNKNOWN}`);
  assert.equal(formatDate(null), UNKNOWN);
  assert.equal(formatDate('2026-01-05T10:07:42Z'), '2026-01-05 10:07 UTC');
  assert.equal(formatDate('sometime in spring'), 'sometime in spring');
  assert.equal(formatBytes(null), UNKNOWN);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(19800000), '18.9 MB');
  assert.equal(shortNote(null), null);
  assert.equal(shortNote('First sentence. Second one.'), 'First sentence.');
  assert.equal(shortNote('x'.repeat(200)).length, 160);
});

test('mapping is pure: the manifest is not mutated and invalid input is rejected', () => {
  const before = structuredClone(fixtureManifest);
  groupManifest(fixtureManifest);
  assert.deepEqual(fixtureManifest, before);
  assert.throws(() => groupManifest(null), TypeError);
  assert.throws(() => groupManifest({ schema_version: 1 }), TypeError);
  assert.equal(groupManifest({ schema_version: 2, assets: [] }).schemaSupported, false);
});

test('unrecognized categories are kept after the known ones', () => {
  const grouped = groupManifest({
    schema_version: 1,
    assets: [asset({ asset_id: 'z', category: 'vehicles' }), asset({ asset_id: 'a', category: 'operators' })]
  });
  assert.deepEqual(grouped.categories.map((c) => c.category), ['operators', 'vehicles']);
});
