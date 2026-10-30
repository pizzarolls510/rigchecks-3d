#!/usr/bin/env node
// Registers, changes, disables or lists Asset Library agents (service accounts), and flips the global agent kill switch.
// Runs locally with the owner's Application Default Credentials; no key files. Without --apply it only prints the
// current document and the change it would make. Permissions outside AGENT_GRANTABLE are refused here and ignored by
// the API even if written some other way.
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { AGENT_CONTROL_DOC, AGENTS_COLLECTION, AGENT_RATE_LIMITS, PROJECT_ID } from '../src/config.js';
import { AGENT_GRANTABLE, DEFAULT_AGENT_PERMISSIONS } from '../src/permissions.js';

const usage = `Usage:
  node scripts/register-agent.mjs --agent <id> --email <service-account-email> [--sa-id <unique-id>]
       [--permissions <p1,p2|default>] [--expires-days <1-365>] [--rate-dispatch <n>] [--rate-upload <n>]
       [--disable | --enable] [--note <text>] [--apply]
  node scripts/register-agent.mjs --kill-switch <on|off> [--apply]
  node scripts/register-agent.mjs --list

  <id> is lowercase letters, digits and hyphens (e.g. asset-curator). --sa-id is the service account's unique ID
  (gcloud iam service-accounts describe <email> --format='value(uniqueId)'); with it, a re-created account with the
  same email is refused. Registrations expire (default 90 days) and must be renewed after review.
  Grantable permissions: ${AGENT_GRANTABLE.join(', ')}.
  Default: ${DEFAULT_AGENT_PERMISSIONS.join(', ')}.`;

const { values } = parseArgs({
  options: {
    agent: { type: 'string' }, email: { type: 'string' }, 'sa-id': { type: 'string' }, permissions: { type: 'string' },
    'expires-days': { type: 'string' }, 'rate-dispatch': { type: 'string' }, 'rate-upload': { type: 'string' },
    disable: { type: 'boolean', default: false }, enable: { type: 'boolean', default: false }, note: { type: 'string' },
    'kill-switch': { type: 'string' }, list: { type: 'boolean', default: false }, apply: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
});

function fail(message) {
  console.error(message);
  console.error(usage);
  process.exit(2);
}

if (values.help) {
  console.log(usage);
  process.exit(0);
}

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

if (values.list) {
  const snapshot = await db.collection(AGENTS_COLLECTION).get();
  const control = await db.doc(AGENT_CONTROL_DOC).get();
  console.log(JSON.stringify({ killSwitch: control.exists ? control.data() : null,
    agents: snapshot.docs.map((d) => ({ ...d.data(), expiresAt: new Date(d.data().expiresAt).toISOString() })) }, null, 2));
  process.exit(0);
}

if (values['kill-switch']) {
  if (!['on', 'off'].includes(values['kill-switch'])) fail('--kill-switch must be on or off');
  const next = { agentsDisabled: values['kill-switch'] === 'on', updatedAt: Date.now() };
  console.log(JSON.stringify({ project: PROJECT_ID, doc: AGENT_CONTROL_DOC, next, apply: values.apply }, null, 2));
  if (values.apply) await db.doc(AGENT_CONTROL_DOC).set(next);
  console.log(values.apply ? 'Kill switch written; it applies to the next agent request.' : 'Dry run only. Re-run with --apply.');
  process.exit(0);
}

if (!/^[a-z][a-z0-9-]{1,47}$/.test(values.agent ?? '')) fail('--agent is required: lowercase letters, digits and hyphens');
if (values.disable && values.enable) fail('Use only one of --disable and --enable');
const ref = db.doc(`${AGENTS_COLLECTION}/${values.agent}`);
const current = (await ref.get()).data() ?? null;
const email = (values.email ?? current?.serviceAccountEmail ?? '').toLowerCase();
if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email)) fail('--email must be a service account email (…@<project>.iam.gserviceaccount.com)');
const requested = values.permissions === undefined || values.permissions === 'default'
  ? (current?.permissions ?? [...DEFAULT_AGENT_PERMISSIONS])
  : values.permissions.split(',').map((p) => p.trim()).filter(Boolean);
const refused = requested.filter((p) => !AGENT_GRANTABLE.includes(p));
if (refused.length) fail(`Not grantable to agents: ${refused.join(', ')}`);
const days = values['expires-days'] === undefined ? 90 : Number(values['expires-days']);
if (!Number.isInteger(days) || days < 1 || days > 365) fail('--expires-days must be 1-365');
const rateLimits = { ...(current?.rateLimits ?? {}) };
for (const kind of ['dispatch', 'upload']) {
  const raw = values[`rate-${kind}`];
  if (raw === undefined) continue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > AGENT_RATE_LIMITS[kind]) fail(`--rate-${kind} must be 0-${AGENT_RATE_LIMITS[kind]} (the agent ceiling)`);
  rateLimits[kind] = n;
}
const next = {
  agentId: values.agent,
  serviceAccountEmail: email,
  serviceAccountId: values['sa-id'] ?? current?.serviceAccountId ?? null,
  permissions: [...new Set(requested)].sort(),
  rateLimits,
  disabled: values.disable ? true : values.enable ? false : current?.disabled ?? false,
  expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
  note: values.note ?? current?.note ?? null,
  createdAt: current?.createdAt ?? Date.now(),
  updatedAt: Date.now()
};
console.log(JSON.stringify({ project: PROJECT_ID, doc: ref.path, current, next: { ...next, expiresAt: new Date(next.expiresAt).toISOString() }, apply: values.apply }, null, 2));
if (!next.serviceAccountId) console.log('Warning: without --sa-id, a deleted and re-created account with the same email would be accepted.');
if (!values.apply) {
  console.log('Dry run only. Re-run with --apply to write the registration.');
} else {
  await ref.set(next);
  console.log('Registration written; it applies to the agent\'s next request.');
}
