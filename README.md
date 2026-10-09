# RigCheck 3D

A mobile-first GLB inspector for checking rigs, poses and animation clips on a phone.
The whole application is a static PWA in `dist/` — there is no build step.

Models can be opened two ways:

- **Local** — file picker or drag-and-drop. The file never leaves the device.
- **Cloud Library** — signed-in users upload GLBs to Firebase and re-open them
  from any device.

---

## Layout

Everything ships from `dist/`. `index.html` loads scripts in this order, and the
order matters — `app.js` defines the viewer, and everything after it patches or
extends that viewer through the DOM rather than by importing it.

| File | Role |
| --- | --- |
| `app.js` (module) | Viewer core: three.js scene, `GLTFLoader`, clips, `handleFiles()` |
| `patch-v02.js` | Static-pose behaviour + upload-overlay fix |
| `firebase-auth.js` | Google sign-in, exposes auth state to the cloud library |
| `cloud-library.js` (module) | Upload / list / open / delete against Firebase |
| `asset-library.js` (module) | INVASION Asset Library overlay: browse and open revisions through `#fileInput`; writers can upload candidates, promote and re-validate |
| `update-manager.js` | Service-worker update handoff for iOS Home Screen apps |
| `refresh.html` | Standalone one-time cache-recovery page, opened directly |
| `vendor/three/` | Pinned three.js, incl. `GLTFLoader` and `DRACOLoader` |

`DRACOLoader` is vendored and precached, so Draco-compressed GLBs load fine.
That matters on cellular — geometry usually dominates these files, and Draco
typically cuts a 20 MB rig to single digits.

---

## Firebase

Config lives in `firebase-auth.js` and `cloud-library.js` (duplicated in both).
Firebase web config is not secret — it identifies the project; access is
controlled by security rules, not by hiding these values.

- Project: `rigcheck-cfbe3`
- Storage bucket: `rigcheck-cfbe3.firebasestorage.app`
- SDK: `firebasejs/12.18.0`, loaded from `gstatic.com`
- Auth: **Google only**, via `signInWithPopup`
- Browser downloads use Firebase Storage `getBlob()`. The bucket CORS policy must
  allow `GET` requests from `https://pizzarolls510.github.io`; Firebase security
  rules still enforce that the signed-in UID owns the requested model.

Any domain serving the app must be listed under **Firebase Console → Auth →
Settings → Authorized domains**, or sign-in fails with `auth/unauthorized-domain`
(the code surfaces this as a distinct message).

### Where a model lives

Uploading writes **two** things. A file in Storage alone will not appear in the
library — the list is read from Firestore, so the document is what makes a model
exist:

```
Storage    users/{uid}/models/{modelId}/{fileName}
Storage    users/{uid}/thumbnails/{modelId}.webp     (optional; quality 0.78)
Firestore  users/{uid}/models/{modelId}
```

`modelId` is a `crypto.randomUUID()`. The Firestore document is:

| Field | Notes |
| --- | --- |
| `id` | same as `modelId` |
| `name` / `originalName` | display name / filename as uploaded |
| `storagePath` | full Storage path above |
| `thumbnailPath` | `null` if the thumbnail capture failed |
| `sizeBytes`, `contentType` | `contentType` defaults to `model/gltf-binary` |
| `triangles`, `meshes`, `bones`, `clips` | captured from the viewer after load |
| `schemaVersion`, `sha256` | schema version and optional exact-file digest for CLI duplicate detection |
| `favorite` | boolean |
| `uploadedAt`, `updatedAt`, `lastOpenedAt` | `serverTimestamp()` |

Anything writing to the library out-of-band (a script, the Admin SDK) has to
create the Firestore document too, or the upload is invisible.

### Limits

- `.glb` only, and it must be self-contained — `.gltf` with sidecar files is
  rejected at the upload step.
- 200 MB per file (`MAX_GLB_BYTES`).

### Expected security rules

Everything is namespaced under `users/{uid}/`, and the code handles
`permission-denied` / `storage/unauthorized`, so rules are assumed to be
owner-only. Verify against what is actually deployed:

```
// Firestore
match /users/{uid}/models/{modelId} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}

// Storage
match /users/{uid}/{allPaths=**} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}
```

---

## Service worker — read before deploying

`sw.js` precaches an explicit `APP_SHELL` list under a versioned cache key
(currently `rigcheck-v0.4.10`). Two rules follow from that:

1. **Adding a file to `dist/` is not enough.** If it is part of the shell it must
   be added to `APP_SHELL`, or installed clients never fetch it.
2. **Bump `CACHE` on every shell change.** The old cache is only dropped when the
   version string changes. Skip this and Home Screen installs keep serving stale
   code, which looks exactly like a change that silently did nothing.

`update-manager.js` handles the update handoff and guards against reload loops
(5 s floor via `sessionStorage`). `refresh.html` is the manual escape hatch when
an install is truly wedged.

---

## Deployment

GitHub Actions publishes `dist/` to Pages via `.github/workflows/pages.yml`
(**Settings → Pages → Source: GitHub Actions**). Live at
<https://pizzarolls510.github.io/rigchecks-3d/>.

The narrow-iPhone rule that keeps **Cloud** and **Library** visible lives in the
`max-width: 430px` block of `cloud-library.css`. It exists to undo
`.top-actions .ghost { display: none }` from `styles.css`, which otherwise hides
both buttons. Keep it in mind before touching either rule.

---

## INVASION Asset Library

The **Assets** button opens INVASION's authoritative asset manifest
(`docs/ASSET_MANIFEST.yaml` on `invasion-godot` `3d-migration`). The browser never talks to
GitHub. It calls the `assetLibraryApi` Cloud Function (`functions/`), which:

- requires a Firebase ID token whose user has the custom claim `assetLibraryRole`
  (`reader` or `writer`), set with `functions/scripts/set-asset-role.mjs`;
- reads the manifest live at the branch head and returns it with that commit SHA, plus the
  asset pipeline's vocabulary (IDs, categories, roles, file types) read from the same commit;
- for a file, accepts only a path listed in that revision's `files[]`, copies the Git or
  Git LFS bytes into the private, content-addressed `asset-library-cache/` in Storage, and
  returns a 10-minute signed download URL. Bytes never pass through the Function's response.

Writers can also change the manifest, but only through INVASION's own asset pipeline, run as an
**Asset Library job** (the `asset-library-job.yml` workflow on `invasion-godot` `main`):

- **Upload candidate**: `POST /api/uploads` reserves a job and a path in
  `asset-library-staging/{uid}/{jobId}/` (Storage rules: writer only, own folder, supported type,
  ≤200 MB, deleted after 2 days); the browser uploads there; `POST /api/jobs/ingest` dispatches the
  runner with a 30-minute signed URL plus the size and MD5 Cloud Storage recorded.
- **Promote**: clicking **Promote…** immediately starts the mandatory dry run
  (`POST /api/jobs/promote` with `dryRun: true`) with the asset's recorded name and category. **Change
  options** reruns it with a different destination, name or category, and **Run dry run again** repeats it at
  the current commit. The review shows every blocker, the warnings, production compliance and the exact file
  and manifest changes. **Confirm promotion** is never automatic. The confirm names only that dry run and
  inherits all of its parameters and base commit; it must come from the same user, and must accept warnings
  explicitly whenever the dry run reported any. A blocked dry run offers no confirm.
- **Re-validate**: `POST /api/jobs/validate` (read-only).
- `GET /api/jobs/:id` maps the GitHub run to `queued | running | done | error`, reads the
  `asset-job-result` artifact, and caches the final result in Firestore (`assetLibraryJobs`).

**Production compliance** (budgets for triangles, materials, textures and skinning per asset type) is
evaluated only by the INVASION asset pipeline, from RigCheck's measurements. It is recorded on new candidates
and canonical revisions, and is part of every dry run and asset re-validation. The UI shows those results:
Pass, Warning, Fail or Not verified per check, with actual and target values and what is outstanding before
promotion. Over-budget models are still accepted as candidates. Visual quality, device performance and
Godot/gameplay integration are always listed as **not verified**: no check here covers them.

Every request is checked against the runner's input contract before dispatch. Mutations (ingest,
promote confirm) also require the reviewed base commit to equal the live branch head, take a
Firestore lock (`409 mutation_in_progress` while another runs; it expires after 20 minutes), and
count against a per-user limit of 20 jobs and 20 uploads per hour (`429`). The runner re-checks the
base commit before running and before its non-force push.

Pure mapping and client helpers live in `dist/lib/asset-library-model.js`,
`dist/lib/asset-library-api.js` and `dist/lib/asset-library-jobs.js`. Backend tests:
`cd functions && npm test` (unit, with GitHub, Actions, Storage and Firestore faked) and
`npm run test:emulator` (Storage and Firestore emulators: rules, transactions; needs Java 21).
Deployment steps, each changing shared infrastructure, are in
[infra/asset-library/DEPLOY.md](infra/asset-library/DEPLOY.md).

---

## RigCheck CLI

The repository includes a small Node.js 22+ CLI for safe agent and Debian uploads:

```bash
npm ci
npm link
rigcheck doctor
rigcheck check ./model.glb
rigcheck upload ./model.glb --dry-run
rigcheck upload ./model.glb
rigcheck list --json
```

All commands accept `--json`. Only `upload` accepts `--dry-run`; the other three commands are already read-only.

`check` reports glTF validity plus active-scene statistics (`triangles`, `meshes`, `bones`, `skins`, `clips`).
Its `metrics` object adds measurement-only values: materials declared and used, mesh and skinned-mesh nodes,
draw calls, vertices, every embedded image's decoded width and height (`null` when it cannot be decoded), the
largest texture dimension, animation names and the extensions used. RigCheck applies no content budgets;
callers such as the INVASION pipeline compare these values with their own policy.

### Configure the owner

In **Firebase Console → Authentication → Users**, copy the UID of the Google account that owns the RigCheck library. Then create the ignored local configuration:

```bash
cp rigcheck.config.example.json rigcheck.config.json
```

Set the UID without changing the project ID:

```json
{
  "projectId": "rigcheck-cfbe3",
  "ownerUid": "your-firebase-authentication-uid"
}
```

The CLI refuses cloud operations if the file is missing, `ownerUid` is empty, or the project ID differs from `rigcheck-cfbe3`.

### Authenticate Application Default Credentials

Install the Google Cloud CLI on the trusted Debian machine, then run:

```bash
gcloud auth application-default login --no-launch-browser
gcloud auth application-default set-quota-project rigcheck-cfbe3
rigcheck doctor
```

The signed-in Google account must have permission to read and write the project's Firestore database and Cloud Storage bucket. ADC is separate from `firebase login`; the latter authenticates the Firebase CLI but is not used as the website owner's Firebase Authentication identity.

See [docs/architecture.md](docs/architecture.md) for the schema and rollback behavior. Never commit ADC or service-account credentials.
