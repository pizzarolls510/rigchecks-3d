// Verification of agent service-account ID tokens (Google-signed OIDC tokens). google-auth-library checks the RS256
// signature against Google's published keys, the issuer, expiry and audience; this adds a verified email and a
// lifetime cap, so only short-lived tokens are ever accepted.
import { OAuth2Client } from 'google-auth-library';

export const MAX_TOKEN_LIFETIME_SECONDS = 3600 + 300;

export function createAgentTokenVerifier({ audience, client = new OAuth2Client() }) {
  if (typeof audience !== 'string' || !audience.startsWith('https://')) throw new Error('An https audience is required');
  return async function verifyAgentToken(token) {
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload() ?? {};
    if (typeof payload.email !== 'string' || payload.email_verified !== true) throw new Error('The token has no verified email');
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) {
      throw new Error('The token lifetime is too long');
    }
    return { email: payload.email.toLowerCase(), sub: String(payload.sub ?? ''), iat: payload.iat, exp: payload.exp };
  };
}
