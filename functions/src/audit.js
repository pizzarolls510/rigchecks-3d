// Append-only request audit (Firestore, written by the Admin SDK only; rules deny all client access). Every agent
// request is recorded, allowed or denied, and every human request that is not a plain read. Mutations are also
// recorded on their job document and, once committed, as provenance and history in the manifest itself.
import { randomUUID } from 'node:crypto';

const ASSET_ID = /^[a-z][a-z0-9_]{0,63}$/;
const REVISION_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const SAFE_ID = /^[A-Za-z0-9_.@-]{1,160}$/;

function clean(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export function createAuditLog({ db, config, now, logger, makeId = randomUUID }) {
  const pending = new Set();

  function write(entry) {
    const id = `${new Date(entry.at).toISOString().replace(/[:.]/g, '-')}-${makeId()}`;
    const promise = db.runTransaction(async (tx) => { tx.set(`${config.auditCollection}/${id}`, entry); })
      .catch((error) => logger.error('Asset Library audit write failed', { message: error?.message, action: entry.path }))
      .finally(() => pending.delete(promise));
    pending.add(promise);
    return promise;
  }

  function middleware(req, res, next) {
    res.on('finish', () => {
      const principal = req.principal ? { kind: req.principal.kind, id: req.principal.id } : res.locals.attemptedPrincipal ?? null;
      const agent = principal?.kind === 'agent' || res.locals.agentAttempt === true;
      if (!agent && (req.method === 'GET' || req.method === 'OPTIONS')) return;
      if (!agent && !principal) return; // Anonymous probes are not worth a write each.
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const status = res.statusCode;
      write({
        at: now(),
        principal: principal ? { kind: principal.kind, id: clean(principal.id, SAFE_ID) } : { kind: 'agent', id: null },
        method: req.method,
        path: req.path.slice(0, 120),
        status,
        outcome: status < 400 ? 'allowed' : status === 401 || status === 403 ? 'denied' : 'error',
        code: res.locals.errorCode ?? null,
        jobId: res.locals.jobId ?? null,
        target: {
          assetId: clean(body.assetId ?? req.query?.asset ?? req.query?.name, ASSET_ID),
          revisionId: clean(body.revisionId ?? body.targetRevisionId ?? req.query?.revision, REVISION_ID)
        }
      });
    });
    next();
  }

  return { middleware, write, flush: () => Promise.all([...pending]) };
}
