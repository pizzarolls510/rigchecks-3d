# 02 · Provenance, Plan v1 and lineage

_Part of the [RigCheck Asset Pipeline Audit](README.md). Exported verbatim from the Grok Bot Page "RigCheck Asset Pipeline Audit" on Oct 30, 2026. Docs only; nothing here has been implemented._

## Part A: provenance of r_a86fda1a3ac3475a

> **Verdict: it is the repair/weld collection, submitted by Grok Bot, and correctly classified. Keep it; don't upload again.** _(info)_
>
> Antonio asked for completed animations to be uploaded as candidates. Grok Bot did that through the website, signed in as Antonio. The manifest records `component: animation_collection`, not `model`. The only defects are cosmetic: a misleading file name and empty source, creator and note fields.

- **Commit**: 1f1b2a4 by github-actions[bot], 12:09 AM PT Oct 30. Adds one LFS file and a 1,265-line manifest record.
- **Workflow run**: 41018342222, 'asset-job cb939793-2dd1-47f8-b005-0ffc98077f1f', workflow_dispatch, success, started 12:09 AM PT. Actor pizzarolls510, which is the account behind the Function's GitHub token for every job, so it doesn't identify the person. Job inputs aren't printed in the log.
- **Submitter**: The Grok Bot teammate (agent 8837ec49) recorded a browser task that opened Assets, added repair_weld_collection.glb, accepted the Futuristic Suit plus animation_collection suggestion, and reported r_a86fda1a with 3 clips. It also withheld the two bigguy files because there was no bigguy asset. The Firebase uid would be Antonio's, because the session was his.
- **Manifest record**: `canonical_state: candidate`, `pipeline_status: animated`, `component: animation_collection`; `source`, `creator`, `note` and `created_at` are all null; `supersedes`/`superseded_by` are null. RigCheck: valid, 63 bones, 1 skin, 3 clips, 1 warning (NODE_SKINNED_MESH_NON_ROOT). Technical check: pass.
- **Clips**: Grip_R_Pistol (2.8 s, 15 channels, 2 keys), Repair_Weld (2.8 s, 22 channels, 85 keys), Repair_Weld_Upper (2.8 s, 13 channels, 85 keys). Skeleton SuitRig, 63 joints, signature 8f90068d…847760.
- **Local comparison**: /workspace/invasion_repair_anim/repair_weld_collection.glb: sha256 a86fda1a3ac3475a03e76fdd2ce276d0e04594d416c0fded6e24195d0e0ca9e8, 81,724 bytes, the same 3 clip names, 63 joints. An exact match.
- **Misleading parts**: The path …/r_a86fda1a3ac3475a/runtime/futuristic_suit.glb (core.py names every file {asset_id}{ext}). The record also carries a generic `model` inspection block (1 triangle, a 3-vertex placeholder mesh) that reads like a model. The `component` field is what the tools use.
- **Can it be fixed in place?**: No supported way exists. There's no metadata-edit op in the CLI, run_job or API. Re-ingesting the same file into the same asset is refused ('Identical revision content already recorded'). Each upload's ingest fields are only accepted at ingest (jobs.js L286). The classification doesn't need fixing anyway.
- **Recommendation**: Keep r_a86fda1a as the valid candidate and upload nothing again. Add notes and source later with the new `annotate` op (plan item 1). A re-ingest isn't needed: Git LFS would dedupe the blob, but it would still add a second manifest revision. Bind it to the repair slot only after review.

## Plan v1 (superseded)

> _(info)_
>
> Kept for history. The Final implementation plan below replaces this table, the v1 rollout, and the v1 open decisions, which Antonio answered on Oct 30.

Every item extends the current stack: `docs/ASSET_MANIFEST.yaml` (plus its schema), `tools/asset_pipeline` (common, core, manifest, cli), `.github/asset-library/run_job.py` with the workflow, the `assetLibraryApi` Function (app.js, jobs.js, access.js, config.js), and the website (`dist/asset-library.js`, `dist/lib/asset-components.js`). Manifest changes ship as one versioned migration (`schema_version` bump plus `tools/asset_pipeline/migrate.py`, run as its own reviewed commit).

| Item | Files to change | Schema / migration | API and UI | Tests | Risks | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Asset identity | common.py (IDs, registry load), core.py ingest_asset (guard), new docs/ASSET_REGISTRY or a registry block in the manifest, cli.py (--new-asset, alias, annotate), run_job.py, jobs.js startIngest | Per asset: `aliases[]`, `character` (e.g. operator), `kind` (character / variant / prop), `status`. Migration seeds the aliases bigguy, suit4, combat_suit → futuristic_suit (to be confirmed). | Ingest gains `createAsset: true`; an unknown ID without it gets 409 `unknown_asset` with alias suggestions. New `POST /api/jobs/annotate` (note, source, creator). UI: an alias-aware picker, with 'Create new asset' as an explicit second step. | Unknown ID refused; alias resolves; annotate leaves files untouched; migration round-trips. | Bad alias seeds misfile assets. Mitigation: the user approves the seed list. | M |
| 2. Revision lineage | core.py make_revision, ingest_asset and promote_asset; motion.py (skeleton signature); manifest schema; jobs.js; asset-components.js | Per revision: `parent_revision`, `change_kind` (new_asset, skeleton_upgrade, animation_revision, variant, optimization), `variant_of`, `skeleton_ref` (signature plus model revision). Migration back-fills futuristic_suit: r_f45648 has parent b2a17261 and is a skeleton_upgrade; r_a86fda1a has skeleton_ref r_f45648; be0ffd97 is a variant. | Ingest accepts `parentRevision` and `changeKind` (suggested by the server, overridable). UI: a lineage tree on the asset page. | A skeleton signature change forces skeleton_upgrade; parent must exist and belong to the same asset. | Back-filling guesses wrong. Mitigation: unknown stays null. | M |
| 3. Duplicate detection | New tools/asset_pipeline/similarity.py; core.py ingest_asset; jobs.js (pre-check at upload reservation); asset-components.js (same logic, displayed) | Per revision: `signature` {bone set hash, skeleton signature, sorted clip names, tri count, mesh count}. Migration computes it for existing GLBs from LFS. | An exact cross-asset sha256 match is blocked (409 with the existing revision). A near match returns `suggestion: upgrade_of X` with its score. New `GET /api/similar?sha=…`. UI: 'This looks like an upgrade of X' banner. | Fixture pairs: identical file, same rig with new clips, a different character. | False positives on shared rigs. Mitigation: suggestion only, never a block, except an exact hash. | M |
| 4. Candidate archiving | common.py STATES; core.py (new reject_revision, archive_revision); cli.py; run_job.py; workflow operation enum; jobs.js and app.js; asset-library.js | States: rejected, archived, abandoned, plus `state_history[]` {state, at, actor, reason}. No migration of states needed; probes are archived afterwards through the op. | `POST /api/jobs/archive` and `/reject` (dry run, then confirm). UI: an Archive button with a required reason; archived items hidden behind a filter. Files are never moved or deleted; refused while referenced by a canonical, a binding or a game path. | Archiving a referenced revision is refused; files are untouched; history is appended. | Reference scan misses Godot paths. Mitigation: grep res:// paths across the repo in the dry run. | S–M |
| 5. Rollback | core.py promote_asset (allow superseded or archived sources from the kept candidate_path, into a new destination or the old one if free); cli.py `restore`; run_job.py; jobs.js; UI | Records `restored_from`, plus `supersedes` links in both directions. No migration. | `POST /api/jobs/restore` reuses the promote dry-run/confirm pair (same user, one confirm). UI: 'Restore as canonical' on superseded revisions. | Restore b2a17261 in a fixture; blocked when bindings conflict; idempotent. | Stale bindings after rollback. Mitigation: the item 2 dependency gate. | S |
| 6. Agent authentication | access.js (agent role), config.js roles, set-asset-role.mjs (`agent`), new functions/scripts/mint-agent-token or a dedicated Firebase user, jobs.js (operation allow-list per role), audit collection | Manifest: `provenance` {actor_uid, actor_kind human\|agent, agent_id, job_id} written at ingest (fills today's gap where the uid lives only in Firestore). | Role `agent` may: read, upload, ingest candidates, validate, run dry runs, archive and reject. It may not promote_confirm or restore confirm; those need a writer, after a human reviews. Every call writes `auditLog/{id}`. The token is a short-lived ID token minted from a custom token whose key stays in Secret Manager. Agents receive only the ID token through the vault and never the key. | Role matrix tests: agent denied confirm; audit entry written; expired token rejected. | A leaked token can mint uploads. Mitigation: 1 h expiry, rate limits, and revoke via the role 'none'. | M |

## Plan v1: phased rollout (superseded)

| Phase | Ships | The agent can do on its own |
| --- | --- | --- |
| Phase 1: safety and identity | Item 1 (registry, aliases, unknown-ID guard, annotate), item 3 exact cross-asset hash block, item 6 agent role plus audit log and manifest provenance | Read, upload, validate, ingest candidates into existing assets only, and annotate. No new assets, no archive, no promote. |
| Phase 2: lineage and lifecycle | Item 2 lineage plus skeleton refs and the migration, item 3 near-duplicate suggestions, item 4 archive and reject | Also: set parent_revision and change_kind from suggestions, run promote dry runs, archive unreferenced stale candidates, and propose (not apply) archiving of probes and old 23-bone candidates. |
| Phase 3: rollback and gating | Item 5 restore, the dependency gate that blocks incompatible promotions, a scheduled cleanup report, and stable game paths | Also: prepare promotion and restore dry runs for review. A human writer confirms. Weekly cleanup report proposals. |

## Plan v1: open decisions (answered Oct 30)

1. Should bigguy, suit4 and combat_suit be aliases of futuristic_suit, or separate characters?
2. Are Heavy Gunner, Combat Engineer and Recon separate operators (their own assets) or variants of futuristic_suit?
3. Registry location: a block inside ASSET_MANIFEST.yaml, or a separate docs/ASSET_REGISTRY.yaml?
4. Agent identity: a dedicated Firebase user with the role `agent`, or a custom-token service path?
5. May an agent archive on its own (unreferenced candidates only), or should it only propose?
6. Archive the two probes now (through the new op), and treat 23-bone be0ffd97 and b674ad0b as archived?
7. Should the game load the canonical through a stable path (Operator3D.gd), and when should r_f45648 replace WalkCodex in play?

## Lineage investigation results

Method: the GLBs on the box were parsed directly (glTF JSON, skins, nodes, accessors, embedded images). Each embedded texture's git blob SHA-1 was computed and compared with the blob SHAs of the textures committed in invasion-godot at assets/characters/operator (1f1b2a4). Rest poses were compared per bone by name: translation within 1 mm and rotation within 0.5°. Nothing was ingested or changed.

| Item | Evidence | Conclusion | Confidence |
| --- | --- | --- | --- |
| bigguy_smooth_walks_swing_fixed_8clips.glb | sha256 f45648e7…, which is the current canonical r_f45648. 473,566 tris, 258,011 verts, 63 bones (SuitRig), 8 clips. Embedded images are named futuristic_armored_suit_3d_model_{basecolor,normal,rm}. | This already is futuristic_suit. bigguy is a working name (alias), not a separate identity. | Certain (hash) |
| Textures: bigguy vs committed futuristic_suit | Git blob SHA-1 of bigguy's embedded textures: basecolor 1e44eaf6…, normal 06edfafb…, rm 406a26c4…. These are byte-identical to the JPGs committed beside futuristic_suit_walk_codex.glb (same blob SHAs, 332,917 / 223,680 / 185,661 bytes). | Same source asset. The 63-bone bigguy rig is a skeleton_upgrade of the 23-bone futuristic_suit (WalkCodex). The tri count also matches (473,566, from the manifest). | High. A vertex-level mesh comparison against the 23-bone file wasn't done. |
| bigguy …_hands_walks.glb and …_hands_walks_strutmixamo.glb | sha256 50ddda72… and c577e980… (the same files as the agent attachments). Same tris, textures and 63 bone names. +41 verts (258,052). The rest pose is identical bone-by-bone; only the joint order in the skin differs. The same 8 clip names; strutmixamo differs only in clip data. | Child revisions of r_f45648: model fix (hands, change_kind model_fix) and an animation_revision. They are not new characters. | High |
| operator_repair_weld.glb → r_a86fda1a | Same mesh, bones, textures and joint order as hands_walks, plus the 3 repair clips. repair_weld_collection.glb (r_a86fda1a) has the same 63 bone names and rest pose. | r_a86fda1a is correctly an animation_collection for futuristic_suit. Its skeleton_ref is SuitRig 63 (r_f45648 family). It is compatible by bone name. Skin joint index order differs from r_f45648, which matters only for skin rebinding, not for name-targeted animation. | High |
| suit4_walks v1–v5 (Cloud Library) | From earlier card data only: 65 bones, 4 clips, about 19 MB. The files aren't on the box. | Probably an earlier re-rig of the same mesh (19 MB is close to the 19.85 MB walk_codex). Treat it as a candidate alias, not merged, until the procedure below is run. | Medium-low |
| combat_suit_rigged (Cloud Library) | 65 bones, 0 clips (card data). | Likely the rigged base of the suit4 line. Pending. | Medium-low |
| scifi_suit (Cloud Library) | 53 bones, 485,446 tris (+2.5% vs 473,566). | Likely a different model. Don't alias it. If it's kept, register it as its own character only after a texture check. | Low-medium |
| Unrelated attachments | 06f6d7e0…: 472,982 tris, unrigged, different textures. 1f7d8c31…: 30-bone insect rig (abdomen, thorax, horn, mandible). | Not futuristic_suit. 06f6d7e0 may be a raw Tripo source of another suit; unconfirmed. | Medium |

### Identity procedure and thresholds (for the duplicate-check endpoint)

1. Identical sha256 means the same revision. Reject the upload and link to the existing revision.
2. Texture match: every embedded texture's sha256 equals an existing character's textures. This is strong same-source evidence.
3. Mesh match: the triangle count is equal (or within 0.5%), the vertex count is within 0.5%, and the POSITION accessor bounding box is within 1%. Optionally, a hash of positions quantized to 1e-4, sorted, is equal.
4. Skeleton: the bone-name set is equal (Jaccard 1.0), and the rest pose per bone is within 1 mm and 0.5°. That's the same skeleton. Jaccard ≥ 0.8 or a changed rest pose is a skeleton revision. Jaccard < 0.5 is a different rig.
5. Decision. Texture and mesh match with a different skeleton is skeleton_upgrade of that character. The same skeleton with different clips is animation_revision. The same skeleton with a small vertex change is model_fix. A >2% tri difference with no shared textures is a different character. Variant or role status always needs a human decision.
6. Confidence: high when the hash or texture+mesh match; medium for a mesh-only or texture-only match; low for name or bone-count heuristics only. The API never auto-merges. It returns a suggested parent and confidence, and an alias or merge needs approval.

> _(warning)_
>
> No merge has been done. The backfill (section 4) records bigguy as an alias of futuristic_suit (high confidence). suit4 and combat_suit are recorded only as pending alias candidates until their files are checked with this procedure.
