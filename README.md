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
(currently `rigcheck-v0.4.3`). Two rules follow from that:

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
