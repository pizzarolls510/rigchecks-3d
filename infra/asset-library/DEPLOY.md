# Asset Library — Phase 2 deployment runbook

Every step below changes shared infrastructure and needs explicit approval at the time it is run.
Run them in this order; each step is safe to re-run.

| # | Step | Command | Reversible by |
|---|------|---------|---------------|
| 1 | Create a fine-grained GitHub PAT | GitHub → Settings → Developer settings → Fine-grained tokens. Repository access: **only** `pizzarolls510/invasion-godot`. Permissions: Contents **read**, Metadata **read**. (Actions read & write is added in Phase 4, not now.) | Revoke the token on GitHub |
| 2 | Store it in Secret Manager | `firebase functions:secrets:set GITHUB_TOKEN --project rigcheck-cfbe3` (paste when prompted; never on the command line) | `firebase functions:secrets:destroy GITHUB_TOKEN` |
| 3 | Runtime identity and URL signing | Create the dedicated `asset-library-api` service account with its three minimum roles (see below) | Remove the bindings, then delete the service account |
| 4 | Deploy the Function | `firebase deploy --only functions:asset-library --project rigcheck-cfbe3` | `firebase functions:delete assetLibraryApi --region us-west1` |
| 5 | Deploy Storage rules | `firebase deploy --only storage --project rigcheck-cfbe3` | Redeploy the previous `storage.rules` |
| 6 | Bucket CORS + lifecycle | `node infra/asset-library/apply-bucket-config.mjs` (dry run), then `… --apply` | Re-apply the previous CORS (a single GitHub Pages `GET` rule) and remove the lifecycle |
| 7 | Grant your account the writer role | `cd functions && node scripts/set-asset-role.mjs --uid <ownerUid> --role writer` (dry run), then `… --apply` | `--role none --apply` |
| 8 | Publish the UI | Push the approved `rigchecks-3d` commit to `main` (GitHub Pages deploys `dist/`) | Revert the commit |

### Step 3: dedicated runtime service account

The Function does not run as the default compute service account. That account is only the build identity (see
"Build identity hardening" below). It runs as `asset-library-api` instead
(`RUNTIME_SERVICE_ACCOUNT` in `functions/src/config.js`), with only:

| Resource | Role | Why |
|---|---|---|
| itself | `roles/iam.serviceAccountTokenCreator` | V4 signed download URLs (`signBlob`) |
| bucket `rigcheck-cfbe3.firebasestorage.app` | `roles/storage.objectAdmin` | Fill, copy, delete and read cache objects |
| project `rigcheck-cfbe3` | `roles/firebaseauth.viewer` | `verifyIdToken(…, checkRevoked)` reads the user record |

Secret access (`roles/secretmanager.secretAccessor` on `GITHUB_TOKEN` only) is granted by `firebase deploy` in step 4.
The account has no user-managed keys.

```bash
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com --project rigcheck-cfbe3
gcloud iam service-accounts create asset-library-api --display-name "RigCheck Asset Library API" --project rigcheck-cfbe3
SA=asset-library-api@rigcheck-cfbe3.iam.gserviceaccount.com
gcloud iam service-accounts add-iam-policy-binding "$SA" --member="serviceAccount:$SA" --role=roles/iam.serviceAccountTokenCreator --project rigcheck-cfbe3
gcloud storage buckets add-iam-policy-binding gs://rigcheck-cfbe3.firebasestorage.app --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
gcloud projects add-iam-policy-binding rigcheck-cfbe3 --member="serviceAccount:$SA" --role=roles/firebaseauth.viewer --condition=None
```

`gcloud` must be logged in (`gcloud auth login`) for step 3. Steps 6–7 use Application Default Credentials,
and steps 2, 4 and 5 use the Firebase CLI login.

### Build identity hardening

The Firebase CLI cannot select a build service account. 2nd-gen builds therefore run as the default compute
service account `384535133161-compute@developer.gserviceaccount.com`, which enabling the Cloud Functions/Run APIs
auto-created with project-wide `roles/editor`. Compute Engine itself remains disabled.

Editor was replaced with Google's documented minimum for a build service account, scoped to the exact resources the
build uses:

| Resource | Role | Why |
|---|---|---|
| project `rigcheck-cfbe3` | `roles/logging.logWriter` | Build logs (`CLOUD_LOGGING_ONLY`); log writing cannot be scoped below project |
| bucket `gcf-v2-sources-384535133161-us-west1` | `roles/storage.objectViewer` | The build fetches the function source here |
| bucket `gcf-v2-uploads-384535133161.us-west1.cloudfunctions.appspot.com` | `roles/storage.objectViewer` | Uploaded source (documented requirement) |
| AR repository `us-west1/gcf-artifacts` | `roles/artifactregistry.writer` | Function image and buildpack cache |

```bash
SA=384535133161-compute@developer.gserviceaccount.com
gcloud projects add-iam-policy-binding rigcheck-cfbe3 --member="serviceAccount:$SA" --role=roles/logging.logWriter --condition=None
gcloud storage buckets add-iam-policy-binding gs://gcf-v2-sources-384535133161-us-west1 --member="serviceAccount:$SA" --role=roles/storage.objectViewer
gcloud storage buckets add-iam-policy-binding gs://gcf-v2-uploads-384535133161.us-west1.cloudfunctions.appspot.com --member="serviceAccount:$SA" --role=roles/storage.objectViewer
gcloud artifacts repositories add-iam-policy-binding gcf-artifacts --location=us-west1 --member="serviceAccount:$SA" --role=roles/artifactregistry.writer --project rigcheck-cfbe3
gcloud projects remove-iam-policy-binding rigcheck-cfbe3 --member="serviceAccount:$SA" --role=roles/editor
```

Deploying to a new region adds a new `gcf-v2-sources-…-<region>` bucket, `gcf-v2-uploads-…` bucket and
`gcf-artifacts` repository. Grant the same roles on those before the first build there.

The unused App Engine default account `rigcheck-cfbe3@appspot.gserviceaccount.com` had project-wide `roles/editor`
removed. It remains enabled and was not deleted. Rollback for either account is re-adding `roles/editor`.
The Google-managed service agent `384535133161@cloudservices.gserviceaccount.com` keeps its `roles/editor`;
Google manages that binding, and it must not be removed.

## Deployment log

- 2026-10-06: steps 3 (applied through the same REST APIs with ADC), 5, 6 and 7 completed. Steps 1–2 done by the
  project owner in their own terminal; secret version 1 (a mistaken entry) was disabled, not destroyed.
- 2026-10-06: step 4 deployed; the function runs as `asset-library-api` and is pinned to `GITHUB_TOKEN` version 2.
  Artifact Registry cleanup policy set for `us-west1/gcf-artifacts` (images older than 1 day).
- Builds run as the auto-created default compute service account, because the Firebase CLI cannot select a build
  service account.
- 2026-10-07: acceptance verified against production from the locally served UI: manifest at `4fd83c2`; plain-Git
  2D sprite sheet; a 19 MB plain-Git GLB (cache fill 4.6 s, reuse 0.6 s); a 19 MB LFS-backed candidate GLB (fill
  4.5 s, reuse 0.7 s), all byte-verified against the manifest; no temp leftovers or errors. Asset-specific details
  are in the private plan (`invasion-godot` `docs/ASSET_LIBRARY_PLAN.md`).
  Authenticated load on the live GitHub Pages site confirmed in production logs.
- 2026-10-07: build identity hardened (see "Build identity hardening"). Editor was replaced at 03:50 UTC. A harmless
  `firebase deploy --only functions:asset-library` ran after about 8 minutes of IAM propagation: build `0d46430e…`
  ran as the compute account and succeeded, producing revision `assetlibraryapi-00002-rey`, with no build or
  function errors.
- 2026-10-07: App Engine default account Editor removed. No App Engine app, gen-1 function, Eventarc trigger or
  Extension exists. Scheduler, Tasks, Dataflow and Compute APIs are disabled, the account has no keys and nobody can
  impersonate it. The whole-policy diff showed only that one binding changed. Its last authentication time was not
  checked; that needs the Policy Analyzer API, which was deliberately not enabled. Live API and site smoke checks
  passed afterwards.

## What gets deployed

- Function `assetLibraryApi` (2nd gen, `us-west1`, Node 22, 1 GiB, 300 s timeout, max 3 instances,
  public invoker with Firebase ID-token + `assetLibraryRole` claim checks on every `/api` route).
  URL: `https://us-west1-rigcheck-cfbe3.cloudfunctions.net/assetLibraryApi`.
- Storage rule: `asset-library-cache/**` is closed to every client (Cloud Library rules unchanged).
- Bucket CORS: the existing Pages `GET` rule plus `HEAD` and `Content-Disposition`, and localhost:8000 for development.
- Bucket lifecycle: delete `asset-library-cache/` objects after 7 days and `asset-library-cache/tmp/` after 1 day.
  The bucket's existing 7-day soft-delete policy still applies to deleted objects.

Firestore rules are unchanged in Phase 2 (no Asset Library collections exist until Phase 4).

## Verify after deploying (Phase 2 acceptance)

1. Sign in on RigCheck, open **Assets**: 15 assets, 17 revisions, 2 needing review, header shows the current `3d-migration` SHA.
2. Open an LFS-backed candidate GLB in the viewer.
3. The first open fills `asset-library-cache/lfs/<oid>`; a second open reports a cache hit (response field `cacheHit`).
4. A signed-in account without the claim sees "Not authorized for the Asset Library".
5. Any manifest-listed file missing on the branch shows "Not yet available from the authoritative repository".
