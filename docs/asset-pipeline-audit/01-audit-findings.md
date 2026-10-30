# 01 · Audit findings

_Part of the [RigCheck Asset Pipeline Audit](README.md). Exported verbatim from the Grok Bot Page "RigCheck Asset Pipeline Audit" on Oct 30, 2026. Docs only; nothing here has been implemented._

## Executive summary

> **Verdict: improve the existing system. No re-architecture needed.**
>
> The manifest-plus-pipeline design (one Python pipeline, a JSON-YAML manifest, a Cloud Function that dispatches GitHub Actions jobs, and Firebase roles) is sound, well guarded and already supports multi-component assets. The gaps are in the data model and missing operations, not the architecture: there's no parent/variant lineage, no reject/archive/restore commands, no binding of animations to skeleton revisions, no cross-asset duplicate check, and no agent identity.

- **Working well**: A stable asset_id with per-component revisions, content-hash revision IDs, candidate-only ingest, dry-run-gated promotion, supersede links, immutable candidate copies, no overwrites of production paths, and the Firestore lock, rate limits and stale-base checks.
- **Biggest gaps**: Rollback is impossible with the current tools. Duplicate detection only covers the same asset. Ingesting under a new asset_id silently creates a new character. Model promotions don't check animation compatibility.
- **Repair/weld candidate (verified Oct 30)**: futuristic_suit/r_a86fda1a3ac3475a is the repair/weld animation set. Grok Bot submitted it through the website on Antonio's request to upload completed animations as candidates. It is correctly recorded as `animation_collection`. Only its file name and blank metadata are misleading. See the Part A section.

## Findings by question

| Question | Status | Evidence | Responsible components |
| --- | --- | --- | --- |
| 1. Character organization | PARTIAL | Each logical asset has a stable `asset_id` and owns independently versioned components (common.py: COMPONENTS, component_of, canonical_of; `component_canonicals`). But identity is just the ID string. There are no aliases, no character-vs-variant concept, and ingest auto-creates a new asset for any unknown ID (core.py ingest_asset, the `if not asset:` branch). | tools/asset_pipeline/common.py, core.py; dist/lib/asset-components.js suggestParent |
| 2. Version management | PARTIAL | Revision IDs come from the content hash (`r_` plus the first 16 hex characters of the SHA-256). An identical file set within the same asset is rejected (core.py: 'Identical revision content already recorded'). Nothing checks hashes across assets on ingest, and there's no name-similarity check. The website suggests a parent asset by skeleton match (asset-components.js:44-62) and hides Cloud Library files whose hash is already in the manifest (manifestHashes), but those are UI suggestions only. The API and CLI accept any valid ID. | core.py ingest_asset; jobs.js startIngest (L284); asset-components.js |
| 3. Revision lineage | MISSING | The revision schema (core.py make_revision) has only `supersedes` and `superseded_by`, both set at promotion. There's no parent_revision, variant_of, change_kind (skeleton upgrade, animation revision, variant), or derived_from field for models. Baked collections do record bake provenance through `animation.derived` (motion.derived_record). | core.py make_revision; motion.py; ASSET_MANIFEST.schema.json |
| 4. Archiving and rollback | PARTIAL | Promotion supersedes the previous canonical with reciprocal links, keeps the immutable `files[].candidate_path` copies, and never overwrites production paths (DESTINATION_EXISTS blocker). There's no restore. promote_asset refuses anything that isn't a candidate ('Promotion requires an existing candidate revision'), so a superseded revision can't be re-promoted, and the CLI, API and workflow have no restore or rollback operation. Old files are kept: nothing in the pipeline deletes them. | core.py promote_asset; cli.py; asset-library-job.yml operation list |
| 5. Dependency tracking | PARTIAL | At ingest, clips are classified against each model revision of the asset (compatible, requires_retarget, incompatible, unknown), and bake jobs require a model revision target (jobs.js L398-401). Bind checks that the collection belongs to the asset and that the clip exists (jobs.js L447-450), but not that it matches the canonical skeleton. Promoting an incompatible model only produced a warning: r_f45648 (63 bones) replaced the 23-bone WalkCodex with a 'requires retarget' warning. | motion.py classify_for_asset; jobs.js startAnimate/startBind; core.py promote_asset |
| 6. Candidate management | MISSING | The only states are canonical, candidate and superseded (common.py STATES). A failed ingest stays in ignored staging/uploads with report.json and never reaches the manifest. A duplicate is rejected at ingest. There's no rejected, archived or abandoned state, and no reject/archive/cleanup command. Candidates stay in assets/_workbench indefinitely. The only automatic cleanup is the Storage lifecycle rule (staging files after 2 days, cache after 7). | common.py STATES; cli.py; infra/asset-library/storage-lifecycle.json |
| 7. Cloud automation | PARTIAL | The REST API is fully usable without the UI: GET /api/manifest, /api/file and /api/jobs(/:id), plus POST /api/uploads, /uploads/library and /jobs/{ingest,promote,validate,animate,bind} (app.js L74-172). Requests without an Origin header are allowed (access.js). It requires a Firebase ID token whose custom claim `assetLibraryRole` is reader or writer, and every mutation requires writer. Roles are granted with functions/scripts/set-asset-role.mjs. No agent or service identity exists yet: Google sign-in only, and the token must be minted for a human user. workflow_dispatch works (it's live-verified by the ingest and promote commits), but it needs a GitHub token on the Function side. | functions/src/app.js, access.js, jobs.js, github.js, config.js; .github/workflows/asset-library-job.yml (main) |
| 8. Current library | PROBLEMS | 17 logical assets: 15 baseline assets, 2 test probes (one of them canonical), and 5 futuristic_suit revisions. See the next sections. | docs/ASSET_MANIFEST.yaml |

## Implemented, partial, missing

### Implemented and working

1. Single authoritative manifest with deterministic JSON-YAML, a duplicate-key guard, atomic save and an OS file lock (common.py load/save, core.py transaction).
2. Six components per asset, each with its own canonical (component_canonicals).
3. Content-hash revision IDs, with identical content rejected within an asset.
4. Candidates go only to assets/_workbench (hidden from Godot by .gdignore).
5. Promotion: mandatory dry run, all blockers collected in one pass, explicit --accept-warnings, supersede links, immutable candidate copies, and no overwrite of existing production paths.
6. Cloud jobs: upload reservation, signed URLs, MD5/size check, Firestore mutation lock (50 min), 20 jobs/hour, stale-base check, non-force push, confirm limited to the same user who ran the dry run.
7. Offline Blender bake producing animation_collection candidates with provenance, and gameplay slot bindings.
8. Personal Cloud Library CLI upload detects exact-hash duplicates (lib/firebase-cloud.mjs L100-113).

### Partial

1. Parent-asset suggestion by skeleton exists only in the website. The CLI and API take any asset_id.
2. Rig classification is recorded, but it doesn't block an incompatible model promotion or bind.
3. Supersede happens, but there's no restore path.
4. API automation works, but only for Google-authenticated humans with a role claim.
5. The requirements.rig_compatibility flag exists, but the docs say the current RigCheck cannot satisfy it.

### Missing

1. Lineage fields: parent revision, variant_of, change kind, aliases.
2. Reject, archive and restore/rollback operations (CLI, API, workflow, UI).
3. Lifecycle states beyond canonical/candidate/superseded.
4. Cross-asset hash duplicate check and a warning when a new asset_id is created.
5. Animation-to-skeleton-revision dependency graph and compatibility gating on promotion.
6. Agent or service-account credentials for the API.
7. Stable-path integration: each later promotion needs a new destination directory, so production folders pile up.
8. Archive (soft delete) in the personal Cloud Library. deleteModel removes the files permanently (dist/cloud-library.js L524-530).

## Current library

| Asset | Kind | Revisions | Canonical | Notes |
| --- | --- | --- | --- | --- |
| futuristic_suit | operators | 5 | r_f45648e7e0cfac98 | The only multi-revision asset (details below) |
| asset_library_probe | other (test) | 1 | none (candidate r_cac0b13f3836a6aa) | Synthetic test. STATUS says never promote it. |
| asset_library_workflow_probe | other (test) | 1 | r_a232c2cc45ae6873 | Synthetic test that was promoted to canonical (1ee9f42) |
| chitter_benchmark | enemy 3D | 1 | none (candidate) | Benchmark only |
| gameplay_hud, start_menu | ui | 1 each | none (reference-only candidates) | Reclassified in 4fd83c2 |
| basic_tower, heavy_tower, flame_tower, drill, command_center | structures (2D) | 1 each | baseline | Legacy in place |
| carapace_brute, leaper, molten_beetle_tank, skitterling, voidspider | enemies (2D) | 1 each | baseline | Legacy in place |
| terrain_2d | environment | 1 | baseline | Legacy in place |

### futuristic_suit revisions

| Revision | State | Component | Content | Bones / clips |
| --- | --- | --- | --- | --- |
| baseline_b2a17261163551c0 | superseded | model | WalkCodex (futuristic_suit_walk_codex.glb). Still the file Operator3D.gd:14 loads. | 23 / 1 walk |
| baseline_be0ffd971f4dd7a3 | candidate | model | futuristic_suit_heavy_gunner_walk.glb | 23 / small walk set |
| baseline_b674ad0be199e9f5 | candidate | model | futuristic_suit_rigged.glb (rigged, no gameplay reference) | 23 / 0 |
| r_f45648e7e0cfac98 | canonical (b4233f6) | model | bigguy_smooth_walks_swing_fixed_8clips.glb, at assets/operators/futuristic_suit/runtime/ | 63 / 8 |
| r_a86fda1a3ac3475a | candidate (1f1b2a4) | animation_collection | repair_weld_collection.glb (same SHA-256 and size). Stored as runtime/futuristic_suit.glb. | 63 / 3 (Grip_R_Pistol, Repair_Weld, Repair_Weld_Upper) |

### Personal Cloud Library (separate from the manifest)

Earlier this week the parent session saw 34 models: many bigguy_*, futuristic_suit_*, suit4_walks v1–v5, combat_suit and duplicate scifi_suit entries. I couldn't re-list them in this read-only pass because that needs the signed-in Firebase session. None of the Big Guy files except r_f45648 are in the manifest.

## Library problems

| Problem | Severity | Detail |
| --- | --- | --- |
| Test probe is canonical | High | asset_library_workflow_probe is canonical in the production manifest. asset_library_probe also lingers. Both should be archived, not deleted. |
| Game still runs the superseded model | High | Operator3D.gd:14 loads futuristic_suit_walk_codex.glb (the superseded revision), so the manifest and runtime disagree. |
| Misleading file name on the repair clip | Medium | Ingest always names files {asset_id}{ext} (core.py), so the r_a86fda1a animation collection is stored as futuristic_suit.glb. Its manifest component is correct (animation_collection). |
| 'Heavy Gunner' is a walk variant, not a character | Medium | baseline_be0ffd97 (heavy_gunner_walk) sits in futuristic_suit as a model candidate. If Heavy Gunner, Combat Engineer and Recon are separate operators, they currently have no assets. Without variant fields, this ambiguity can't be expressed. |
| Two stale 23-bone candidates | Medium | be0ffd97 and b674ad0b are obsolete against the 63-bone canonical, but there's no state to mark them archived. |
| Redundant skeletons | Medium | The asset holds 23-bone and 63-bone SuitRig variants side by side. Any future clip bake must target the 63-bone revision. |
| Untracked texture copies | Low | assets/characters/operator holds three identical copies of each texture JPG (walk_codex, heavy_gunner_walk and rigged sets). Their manifest roles are not verified. |
| Cloud Library clutter | Low | Many bigguy and suit iterations with no lineage. Delete there is permanent. |

## Prioritized recommendations

| Priority | Change | Type |
| --- | --- | --- |
| P0 | Add a restore operation: re-point canonical to a superseded revision using its kept candidate_path copy, with a dry run and confirm. Expose it in cli.py, the runner, jobs.js and the UI. | Incremental |
| P0 | Add lifecycle states `rejected` and `archived` (with reason, actor, timestamp), plus reject/archive operations that only change the manifest and never touch referenced files. | Incremental (schema bump) |
| P0 | Ingest guard: refuse to create a new asset_id unless explicitly requested (--new-asset), and check content hashes across all assets. | Incremental |
| P0 | Archive the two probe assets once archive ops exist. Keep r_a86fda1a as it is (no re-ingest). | Data cleanup through the pipeline |
| P1 | Lineage fields: parent_revision, change_kind (skeleton_upgrade, animation_revision, variant, optimization, new), variant_of, aliases. Set them at ingest from the suggestion logic. | Incremental (schema) |
| P1 | Dependencies: record skeleton_revision on animation collections and bindings, and make promotion block (not warn) when canonical bindings would become incompatible, unless overridden. | Incremental |
| P1 | Agent identity: a Firebase custom-token or service-account path with a scoped `agent` role (ingest, validate and dry-run only, no confirm). | Incremental (backend + auth) |
| P1 | Stable-path integration operation so the game follows the canonical revision (resolve the Operator3D.gd hard-coded path). | Incremental |
| P2 | Cleanup report: list _workbench candidates that are older than N days, not canonical and not referenced, and propose archiving them (never deleting). | Incremental |
| P2 | Cloud Library: soft delete/archive plus a link from each cloud model to its manifest revision. | Incremental |
| P2 | Character registry (operators: futuristic_suit plus planned heavy_gunner, combat_engineer, recon) with shared-rig declarations. | Incremental |

## Verdict

Improve, don't rebuild. Every gap fits the existing shape: add fields to the manifest schema, operations to tools/asset_pipeline (exposed through cli.py), and matching runner operations, API routes and UI buttons. The safety layer (dry runs, locks, stale-base checks, non-force pushes, no overwrites) is already the hard part, and it's done.

## Design note: toward an autonomous pipeline

1. Recognize: an agent always resolves the asset by (1) exact hash anywhere in the manifest, (2) a declared alias, (3) a skeleton and naming match, and only then proposes a new asset. Creating a new asset needs explicit approval.
2. Classify: each ingest records parent_revision and change_kind. A skeleton change automatically flags dependent collections and bindings as needing a retarget.
3. Validate: validate, then a promotion dry run, with dependency gates. Agents may run everything up to the dry run, and a human confirms.
4. Archive: promotion sets the old canonical to superseded (as it does today), and a separate archive op hides stale candidates. Files remain in Git/LFS and in candidate_path, nothing referenced is ever deleted, and deletion stays out of scope.
5. Rollback: a restore op re-points canonical to any superseded or archived revision, with the same dry run and confirm.
6. Avoid clutter: the UI defaults to canonical plus active candidates, with archived items behind a filter. A scheduled cleanup report proposes archiving and never deletes.
