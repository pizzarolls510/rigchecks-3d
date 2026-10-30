// What each principal may do. Humans get a fixed set from their role claim; each agent gets the permissions recorded
// in its registry document, intersected with AGENT_GRANTABLE, so a promotion, restore, asset creation or binding can
// never be granted to an agent by editing Firestore. Every check happens server-side, per request.

export const PERMISSIONS = Object.freeze({
  libraryRead: 'library:read',
  jobsRead: 'jobs:read',
  identityCheck: 'identity:check',
  uploadCandidate: 'upload:candidate',
  ingestCandidate: 'ingest:candidate',
  validate: 'validate',
  promoteDryRun: 'promote:dry_run',
  restoreDryRun: 'restore:dry_run',
  animateCandidate: 'animate:candidate',
  annotate: 'annotate',
  archiveCandidate: 'archive:candidate',
  // Human only.
  assetCreate: 'asset:create',
  identityOverride: 'identity:override',
  promoteConfirm: 'promote:confirm',
  restoreConfirm: 'restore:confirm',
  archive: 'archive',
  bind: 'bind',
  libraryImport: 'library:import'
});

const ALL = Object.freeze(Object.values(PERMISSIONS));

export const AGENT_GRANTABLE = Object.freeze([
  PERMISSIONS.libraryRead, PERMISSIONS.jobsRead, PERMISSIONS.identityCheck, PERMISSIONS.uploadCandidate,
  PERMISSIONS.ingestCandidate, PERMISSIONS.validate, PERMISSIONS.promoteDryRun, PERMISSIONS.restoreDryRun,
  PERMISSIONS.animateCandidate, PERMISSIONS.annotate, PERMISSIONS.archiveCandidate
]);

// What register-agent.mjs grants when no list is given: an upload agent that can never change a canonical.
export const DEFAULT_AGENT_PERMISSIONS = Object.freeze([
  PERMISSIONS.libraryRead, PERMISSIONS.jobsRead, PERMISSIONS.identityCheck, PERMISSIONS.uploadCandidate,
  PERMISSIONS.ingestCandidate, PERMISSIONS.validate, PERMISSIONS.promoteDryRun
]);

export const ROLE_PERMISSIONS = Object.freeze({
  reader: Object.freeze([PERMISSIONS.libraryRead, PERMISSIONS.jobsRead, PERMISSIONS.identityCheck]),
  writer: ALL
});

// The agent's effective permissions plus anything it was granted but can never hold (reported, never applied).
export function agentPermissions(granted) {
  const list = Array.isArray(granted) ? granted.filter((p) => typeof p === 'string') : [];
  return {
    permissions: new Set(list.filter((p) => AGENT_GRANTABLE.includes(p))),
    ignored: list.filter((p) => !AGENT_GRANTABLE.includes(p)).sort()
  };
}

export function humanPermissions(role) {
  return new Set(ROLE_PERMISSIONS[role] ?? []);
}
