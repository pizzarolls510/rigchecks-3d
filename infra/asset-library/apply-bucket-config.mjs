#!/usr/bin/env node
// Shows, and with --apply sets, the Storage bucket CORS and lifecycle configuration the Asset Library needs.
// Uses Application Default Credentials. Run from the repository root: node infra/asset-library/apply-bucket-config.mjs
// Setting CORS or lifecycle replaces the whole list, so the files in this directory must contain every rule
// the bucket should keep (storage-cors.json keeps the Cloud Library's existing GitHub Pages GET rule).
import { readFileSync } from 'node:fs';
import { Storage } from '@google-cloud/storage';

const PROJECT_ID = 'rigcheck-cfbe3';
const BUCKET = 'rigcheck-cfbe3.firebasestorage.app';
const apply = process.argv.includes('--apply');

const desiredCors = JSON.parse(readFileSync(new URL('./storage-cors.json', import.meta.url), 'utf8'));
const desiredLifecycle = JSON.parse(readFileSync(new URL('./storage-lifecycle.json', import.meta.url), 'utf8'));

const bucket = new Storage({ projectId: PROJECT_ID }).bucket(BUCKET);
const [metadata] = await bucket.getMetadata();
console.log(JSON.stringify({
  bucket: BUCKET,
  current: { cors: metadata.cors ?? [], lifecycle: metadata.lifecycle ?? null },
  desired: { cors: desiredCors, lifecycle: desiredLifecycle },
  apply
}, null, 2));

if (!apply) {
  console.log('Dry run only. Re-run with --apply to replace the bucket CORS and lifecycle configuration.');
} else {
  await bucket.setMetadata({ cors: desiredCors, lifecycle: desiredLifecycle });
  const [after] = await bucket.getMetadata();
  console.log('Applied.', JSON.stringify({ cors: after.cors, lifecycle: after.lifecycle }, null, 2));
}
