#!/usr/bin/env node
// Run on an agent's host to prove its Asset Library credentials end to end: which Application Default Credentials
// source is available, whether it can mint a Google-signed ID token for the API audience, and who the API takes the
// agent to be (GET /api/whoami). Prints no token, key or secret.
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json node scripts/agent-check.mjs [--api <url>]
//
// Service-account key files, workload identity federation configs, service-account impersonation (gcloud) and the
// Google Cloud metadata server all work. A person's own login (authorized_user) is refused before any token is
// requested: its ID tokens are for gcloud's client, not this API, and agents must never act as a person.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GoogleAuth } from 'google-auth-library';
import { AGENT_TOKEN_AUDIENCE } from '../src/config.js';

const { values } = parseArgs({ options: { api: { type: 'string' }, audience: { type: 'string' } } });
const api = values.api ?? AGENT_TOKEN_AUDIENCE;
const audience = values.audience ?? AGENT_TOKEN_AUDIENCE;
const report = { api, audience, credentialSource: null, credentialType: null, idToken: null, whoami: null };

const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (path) {
  report.credentialSource = 'GOOGLE_APPLICATION_CREDENTIALS';
  try {
    report.credentialType = JSON.parse(readFileSync(path, 'utf8')).type ?? 'unknown';
  } catch {
    report.credentialType = 'unreadable';
  }
} else {
  report.credentialSource = 'default (gcloud application-default or metadata server)';
}

try {
  const auth = new GoogleAuth();
  const base = await auth.getClient();  // Reads the credential configuration only; no token is requested yet.
  report.clientType = base?.constructor?.name ?? null;
  if (report.credentialType === 'authorized_user' || report.clientType === 'UserRefreshClient') {
    report.idToken = { ok: false, error: 'These are a person\'s credentials. Configure a service account for this agent; no token was requested.' };
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const client = await auth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const authorization = headers.get ? headers.get('authorization') : headers.Authorization ?? headers.authorization;
  if (!authorization) throw new Error('No ID token was produced');
  const payload = JSON.parse(Buffer.from(authorization.split(' ')[1].split('.')[1], 'base64url').toString('utf8'));
  report.idToken = { ok: payload.aud === audience, email: payload.email ?? null, audienceMatches: payload.aud === audience,
    expiresInSeconds: payload.exp - Math.floor(Date.now() / 1000) };
  if (payload.aud !== audience) throw new Error('The ID token is for a different audience; the API would refuse it');
  const response = await fetch(`${api.replace(/\/$/, '')}/api/whoami`, { headers: { Authorization: authorization } });
  report.whoami = { status: response.status, body: await response.json().catch(() => null) };
} catch (error) {
  report.idToken = report.idToken ?? { ok: false, error: error?.message?.slice(0, 300) ?? String(error) };
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.whoami?.status === 200 ? 0 : 1);
