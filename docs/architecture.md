# RigCheck architecture

## Website

The static PWA is served from `dist/`. GitHub Actions publishes that directory to GitHub Pages. The browser viewer uses Firebase Authentication as the signed-in end user, so the deployed Firestore and Storage rules restrict it to `users/{uid}/...`.

## CLI

The Node.js CLI is exposed as `rigcheck` by `scripts/rigcheck.mjs`. It has four commands:

- `doctor`: read-only configuration, ADC, Firestore, and Storage readiness checks.
- `check <file>`: local GLB validation and inspection.
- `upload <file>`: validation, duplicate detection, Storage upload, then Firestore creation.
- `list`: read-only listing of the configured owner's Firestore model collection.

The CLI runs in a trusted environment with Google Application Default Credentials. The Firestore and Cloud Storage server clients use IAM rather than the website's Firebase Security Rules and do not represent a Firebase Authentication end user, so `rigcheck.config.json` must explicitly name the owner UID whose library is targeted. The project ID is fixed to `rigcheck-cfbe3`; any mismatch fails before a cloud operation.

## Canonical model schema

`dist/lib/model-schema.js` is shared by the browser uploader and the CLI. It defines the project, bucket, file limit, path convention, filename normalization, and Firestore document shape. Keeping it under `dist/` lets the browser import it without introducing a frontend build step.

New CLI documents add:

- `schemaVersion: 1`
- `sha256`: lowercase SHA-256 of the exact GLB bytes

CLI thumbnails are currently represented by `thumbnailPath: null`.

## Upload transaction

1. Validate the extension, size, GLB container, and glTF contents.
2. Compute SHA-256 and inspect the default scene.
3. Read the owner's existing model documents.
4. Return the existing model without writing if an exact SHA-256 already exists.
5. Warn about legacy models with the same original filename and byte size.
6. Upload the GLB to `users/{uid}/models/{modelId}/{safeFileName}`.
7. Create `users/{uid}/models/{modelId}` in Firestore.
8. If Firestore creation fails, delete the newly uploaded Storage object.

`--dry-run` performs validation and cloud reads for duplicate detection, but does not create or modify Storage or Firestore data.
