// Firestore persistence for job metadata, the mutation lock and per-user rate limits.
// Everything here is derived job state (never manifest data) and is written only by the Admin SDK.
// The business rules run inside `runTransaction`, so the same code is exercised against an in-memory store in
// unit tests and against the Firestore emulator in the emulator suite.
import { ApiError } from './errors.js';

export const TERMINAL_STATUSES = Object.freeze(['done', 'error']);

export function createFirestoreDb(firestore) {
  const doc = (path) => firestore.doc(path);
  const data = (snapshot) => (snapshot.exists ? snapshot.data() : null);
  return {
    async get(path) {
      return data(await doc(path).get());
    },
    async update(path, fields) {
      await doc(path).update(fields);
    },
    runTransaction(fn) {
      return firestore.runTransaction((transaction) => fn({
        get: async (path) => data(await transaction.get(doc(path))),
        set: (path, value) => { transaction.set(doc(path), value); },
        update: (path, fields) => { transaction.update(doc(path), fields); },
        delete: (path) => { transaction.delete(doc(path)); }
      }));
    }
  };
}

// A fixed one-hour window per user and kind, started by the first request in it.
export function consumeRate(current, kind, { now, limit, windowMs }) {
  const bucket = current?.[kind];
  const fresh = !bucket || now - bucket.windowStart >= windowMs || now < bucket.windowStart;
  const count = fresh ? 0 : bucket.count;
  if (count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000));
    throw new ApiError(429, 'rate_limited', `Too many Asset Library ${kind === 'upload' ? 'uploads' : 'jobs'}; try again later.`, { retryAfterSeconds });
  }
  return { ...(current ?? {}), [kind]: { windowStart: fresh ? now : bucket.windowStart, count: count + 1 }, updatedAt: now };
}

// The lock is held while it is unexpired and the job holding it has not finished.
export function lockIsHeld(lock, holder, now) {
  return Boolean(lock && lock.expiresAt > now && holder && !TERMINAL_STATUSES.includes(holder.status));
}
