import { ASSET_LIBRARY_ROLES, DEV_ORIGIN_PATTERN } from './config.js';
import { sendError } from './errors.js';

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

export function authMiddleware({ verifyIdToken }) {
  return async (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (!match) return sendError(res, 401, 'unauthenticated', 'Sign in to use the Asset Library.');
    let decoded;
    try {
      decoded = await verifyIdToken(match[1]);
    } catch {
      return sendError(res, 401, 'unauthenticated', 'Your sign-in is invalid or has expired. Sign in again.');
    }
    const role = decoded?.assetLibraryRole;
    if (!ASSET_LIBRARY_ROLES.includes(role)) {
      return sendError(res, 403, 'not_authorized', 'This account is not authorized for the Asset Library.');
    }
    req.assetUser = { uid: decoded.uid, role };
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
