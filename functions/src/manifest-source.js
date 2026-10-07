// Reads docs/ASSET_MANIFEST.yaml at the current branch head. The pipeline writes it with json.dump, so it is
// parsed as JSON; nothing here interprets asset semantics beyond locating listed files.
// Everything cached here is disposable: the head SHA for a few seconds, everything else keyed by an
// immutable commit SHA.
import { ApiError } from './errors.js';

const MAX_CACHED_COMMITS = 4;
const MAX_CACHED_DIRECTORIES = 256;

function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
  return value;
}

export function createManifestSource({ github, branch, manifestPath, headCacheTtlMs, now = Date.now }) {
  let head = null;
  const manifests = new Map();
  const directories = new Map();

  async function currentSha() {
    if (head && now() - head.at < headCacheTtlMs) return head.sha;
    const sha = await github.branchHead(branch);
    head = { sha, at: now() };
    return sha;
  }

  async function manifestAt(sha) {
    if (manifests.has(sha)) return manifests.get(sha);
    const text = await github.fileText(sha, manifestPath);
    if (text === null) {
      throw new ApiError(503, 'manifest_unavailable', `${manifestPath} does not exist on ${branch} at ${sha.slice(0, 12)}.`);
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new ApiError(502, 'manifest_invalid', `${manifestPath} at ${sha.slice(0, 12)} is not valid manifest JSON.`);
    }
    if (!manifest || !Array.isArray(manifest.assets)) {
      throw new ApiError(502, 'manifest_invalid', `${manifestPath} at ${sha.slice(0, 12)} has no assets array.`);
    }
    return remember(manifests, sha, manifest, MAX_CACHED_COMMITS);
  }

  async function treeEntry(sha, path) {
    const slash = path.lastIndexOf('/');
    const directory = slash === -1 ? '' : path.slice(0, slash);
    const name = path.slice(slash + 1);
    const key = `${sha}:${directory}`;
    const listing = directories.has(key)
      ? directories.get(key)
      : remember(directories, key, await github.listDirectory(sha, directory), MAX_CACHED_DIRECTORIES);
    return listing?.find((entry) => entry.name === name && entry.type === 'file') ?? null;
  }

  return {
    async current() {
      const sha = await currentSha();
      return { sha, manifest: await manifestAt(sha) };
    },
    treeEntry
  };
}

export function findListedFile(manifest, assetId, revisionId, path) {
  const asset = manifest.assets.find((candidate) => candidate?.asset_id === assetId);
  const revision = asset?.revisions?.find((candidate) => candidate?.revision_id === revisionId);
  const file = revision?.files?.find((candidate) => candidate?.path === path);
  return file ? { asset, revision, file } : null;
}
