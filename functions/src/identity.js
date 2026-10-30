// Read-only identity lookups over the manifest at the current commit: which asset a name means, and whether exact
// bytes are already recorded. Content similarity (shared textures, mesh, skeleton) needs the files and is judged by
// the pipeline at ingest (tools/asset_pipeline/lineage.py); these lookups never decide identity on their own.
import { invalid } from './runner-contract.js';

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_HASHES = 16;

export function resolveAssetName(manifest, name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw invalid('name must look like an asset ID.');
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const direct = assets.find((asset) => asset?.asset_id === name);
  const aliased = direct ? null : assets.find((asset) => (asset?.identity?.aliases ?? []).includes(name));
  const asset = direct ?? aliased;
  const pending = assets
    .filter((candidate) => (candidate?.identity?.alias_candidates ?? []).some((entry) => entry?.status === 'pending'
      && typeof entry.name === 'string' && entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').startsWith(name)))
    .map((candidate) => candidate.asset_id);
  return {
    name,
    assetId: asset?.asset_id ?? null,
    via: direct ? 'asset_id' : aliased ? 'alias' : null,
    displayName: asset?.display_name ?? null,
    category: asset?.category ?? null,
    // Unconfirmed: a person still has to decide. Never used to route an upload.
    pendingAliasOf: pending
  };
}

export function duplicateMatches(manifest, body) {
  const hashes = body?.sha256;
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > MAX_HASHES || hashes.some((h) => typeof h !== 'string' || !SHA256.test(h))) {
    throw invalid(`sha256 must list 1-${MAX_HASHES} lowercase SHA-256 hex digests.`);
  }
  const wanted = new Set(hashes);
  const matches = [];
  for (const asset of manifest?.assets ?? []) {
    for (const revision of asset?.revisions ?? []) {
      for (const file of revision?.files ?? []) {
        if (wanted.has(file?.sha256)) {
          matches.push({ sha256: file.sha256, assetId: asset.asset_id, revisionId: revision.revision_id, path: file.path,
            state: revision.canonical_state ?? null, lifecycle: revision.lifecycle?.status ?? 'active' });
        }
      }
    }
  }
  return matches;
}
