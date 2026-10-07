// Cloud Functions entry point. CORS is handled inside the Express app (see access.js) so it is unit-tested;
// the platform `cors` option is intentionally not used to avoid two competing policies.
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { createApp } from './app.js';
import { createBucketStore } from './bucket-store.js';
import { GITHUB_OWNER, GITHUB_REPO, REGION, RUNTIME_SERVICE_ACCOUNT, STORAGE_BUCKET } from './config.js';
import { createGitHubClient } from './github.js';

const GITHUB_TOKEN = defineSecret('GITHUB_TOKEN');

initializeApp();

let app = null;
function assetLibraryApp() {
  // Secrets are only readable at request time, so the app is built lazily per instance.
  app ??= createApp({
    verifyIdToken: (token) => getAuth().verifyIdToken(token, true),
    github: createGitHubClient({ token: GITHUB_TOKEN.value(), owner: GITHUB_OWNER, repo: GITHUB_REPO }),
    store: createBucketStore(getStorage().bucket(STORAGE_BUCKET))
  });
  return app;
}

export const assetLibraryApi = onRequest(
  {
    region: REGION,
    serviceAccount: RUNTIME_SERVICE_ACCOUNT,
    secrets: [GITHUB_TOKEN],
    timeoutSeconds: 300,
    memory: '1GiB',
    maxInstances: 3,
    concurrency: 20,
    // Reachable from browsers; every /api route still requires a verified Firebase ID token and role claim.
    invoker: 'public'
  },
  (req, res) => assetLibraryApp()(req, res)
);
