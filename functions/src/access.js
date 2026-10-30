import { ASSET_LIBRARY_ROLES, DEV_ORIGIN_PATTERN } from './config.js';
import { ApiError, sendError } from './errors.js';
import { agentPermissions, humanPermissions } from './permissions.js';

// Browsers must come from an allowed origin. Requests without an Origin header (CLI, agents) are not
// browser cross-origin requests; they are still fully subject to ID-token authorization below.
export function corsMiddleware({ allowedOrigins, allowDevOrigins }) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      const allowed = allowedOrigins.includes(origin) || (allowDevOrigins && DEV_ORIGIN_PATTERN.test(origin));
      if (!allowed) return sendError(res, 403, 'origin_not_allowed', 'This origin may not call the Asset Library API.');
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Max-Age', '3600');
      return res.status(204).end();
    }
    return next();
  };
}

export const GOOGLE_ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);
const AGENT_ID = /^[a-z][a-z0-9-]{1,47}$/;

// The unverified issuer claim, used only to choose which verifier checks the token's signature.
export function tokenIssuer(token) {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof payload?.iss === 'string' ? payload.iss : null;
  } catch {
    return null;
  }
}

// Agents are service accounts: a Google-signed ID token (at most an hour) whose audience is this API, for an email
// registered in assetLibraryAgents. The registry document is read on every request, so disabling an agent, the global
// kill switch or an expiry takes effect immediately.
export function createAgentResolver({ db, config, now }) {
  const deny = (code, message) => new ApiError(403, code, message);
  return async function resolveAgent(claims) {
    const control = await db.get(config.agentControlDoc);
    if (control?.agentsDisabled === true) throw deny('agents_disabled', 'Agent access to the Asset Library is switched off.');
    const matches = await db.findEqual(config.agentsCollection, 'serviceAccountEmail', claims.email, 2);
    if (matches.length !== 1 || !AGENT_ID.test(matches[0]?.agentId ?? '')) {
      throw deny('agent_not_registered', 'This service account is not a registered Asset Library agent.');
    }
    const agent = matches[0];
    if (agent.disabled === true) throw deny('agent_disabled', 'This agent is disabled.');
    if (!Number.isFinite(agent.expiresAt) || agent.expiresAt <= now()) throw deny('agent_expired', 'This agent registration has expired and must be reviewed.');
    if (agent.serviceAccountId && agent.serviceAccountId !== claims.sub) {
      throw deny('agent_identity_mismatch', 'The token belongs to a different service account than the one registered.');
    }
    return agent;
  };
}

export function authMiddleware({ verifyIdToken, verifyAgentToken = null, resolveAgent = null }) {
  return async (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (!match) return sendError(res, 401, 'unauthenticated', 'Sign in to use the Asset Library.');
    const token = match[1];
    if (GOOGLE_ISSUERS.includes(tokenIssuer(token))) {
      res.locals.agentAttempt = true;
      if (!verifyAgentToken || !resolveAgent) return sendError(res, 401, 'unauthenticated', 'Agent tokens are not accepted here.');
      let claims;
      try {
        claims = await verifyAgentToken(token);
      } catch {
        return sendError(res, 401, 'unauthenticated', 'The agent token is invalid, expired or for another audience.');
      }
      res.locals.attemptedPrincipal = { kind: 'agent', id: claims.email };
      let agent;
      try {
        agent = await resolveAgent(claims);
      } catch (error) {
        if (error instanceof ApiError) return sendError(res, error.status, error.code, error.message);
        return next(error);
      }
      const { permissions, ignored } = agentPermissions(agent.permissions);
      req.principal = {
        kind: 'agent', id: agent.agentId, uid: `agent_${agent.agentId}`, role: 'agent', permissions,
        ignoredPermissions: ignored, tokenExpiresAt: claims.exp * 1000, rateLimits: agent.rateLimits ?? null
      };
    } else {
      let decoded;
      try {
        decoded = await verifyIdToken(token);
      } catch {
        return sendError(res, 401, 'unauthenticated', 'Your sign-in is invalid or has expired. Sign in again.');
      }
      const role = decoded?.assetLibraryRole;
      if (!ASSET_LIBRARY_ROLES.includes(role)) {
        res.locals.attemptedPrincipal = { kind: 'human', id: decoded?.uid ?? null };
        return sendError(res, 403, 'not_authorized', 'This account is not authorized for the Asset Library.');
      }
      req.principal = { kind: 'human', id: decoded.uid, uid: decoded.uid, role, permissions: humanPermissions(role), rateLimits: null };
    }
    // The job service's long-standing name for the caller.
    req.assetUser = req.principal;
    return next();
  };
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.principal?.permissions?.has(permission)) {
      // People keep the code the website already explains; agents get the precise permission.
      if (req.principal?.kind !== 'agent') return sendError(res, 403, 'writer_required', 'This action requires Asset Library write access.');
      return sendError(res, 403, 'permission_denied', `This agent may not ${permission.replace(/[:_]/g, ' ')}.`, { permission });
    }
    return next();
  };
}

// For mutation routes (Phase 4). Readers can never reach a writer route.
export function requireWriter(req, res, next) {
  if (req.assetUser?.role !== 'writer') {
    return sendError(res, 403, 'writer_required', 'This action requires Asset Library write access.');
  }
  return next();
}
