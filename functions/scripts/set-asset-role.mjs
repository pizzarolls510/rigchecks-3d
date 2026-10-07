#!/usr/bin/env node
// Grants, changes or removes the Asset Library role claim on a Firebase Authentication user.
// Runs locally with Application Default Credentials (`gcloud auth application-default login`); no key files.
// Without --apply it only prints the current claims and the change it would make.
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const PROJECT_ID = 'rigcheck-cfbe3';
const ROLES = ['reader', 'writer', 'none'];

const usage = `Usage:
  node scripts/set-asset-role.mjs (--uid <uid> | --email <email>) --role <reader|writer|none> [--apply]

  --role none removes the claim. Other custom claims are preserved.
  The user must sign out and back in (or the app must force-refresh the ID token)
  before a changed claim takes effect in the browser.`;

const { values } = parseArgs({
  options: {
    uid: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
    apply: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
});

if (values.help || Boolean(values.uid) === Boolean(values.email) || !ROLES.includes(values.role)) {
  console.log(usage);
  process.exit(values.help ? 0 : 2);
}

initializeApp({ projectId: PROJECT_ID });
const auth = getAuth();
const user = values.uid ? await auth.getUser(values.uid) : await auth.getUserByEmail(values.email);
const current = user.customClaims ?? {};
const next = { ...current };
if (values.role === 'none') delete next.assetLibraryRole;
else next.assetLibraryRole = values.role;

console.log(JSON.stringify({
  project: PROJECT_ID,
  uid: user.uid,
  email: user.email ?? null,
  currentClaims: current,
  nextClaims: next,
  apply: values.apply
}, null, 2));

if (JSON.stringify(current) === JSON.stringify(next)) {
  console.log('No change needed.');
} else if (!values.apply) {
  console.log('Dry run only. Re-run with --apply to write the claim.');
} else {
  await auth.setCustomUserClaims(user.uid, next);
  console.log('Claim updated. Sign out and back in on each device for it to take effect.');
}
