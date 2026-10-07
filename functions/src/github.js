// Minimal GitHub + Git LFS client for reading the authoritative INVASION repository.
// The token is only ever sent to api.github.com and the repository's LFS batch endpoint; LFS download
// hrefs are fetched with the headers GitHub's batch response provides, never with the token, and are
// never returned to callers outside this Function.
import { UpstreamError } from './errors.js';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'rigcheck-asset-library';
const LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json';

function encodeRepoPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function createGitHubClient({ token, owner, repo, fetchImpl = globalThis.fetch }) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  function apiFetch(path, { accept = 'application/vnd.github+json' } = {}) {
    return fetchImpl(`${API_ROOT}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT
      }
    });
  }

  async function expectOk(response, what) {
    if (!response.ok) throw new UpstreamError(response.status, `GitHub ${what} returned ${response.status}`);
    return response;
  }

  return {
    async branchHead(branch) {
      const response = await expectOk(await apiFetch(`${repoPath}/git/ref/heads/${encodeRepoPath(branch)}`), 'branch ref');
      const body = await response.json();
      if (body?.object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(body.object.sha)) {
        throw new UpstreamError(502, 'GitHub branch ref did not resolve to a commit');
      }
      return body.object.sha;
    },

    // Raw file text at an exact commit; null when the path does not exist at that commit.
    async fileText(commitSha, path) {
      const response = await apiFetch(`${repoPath}/contents/${encodeRepoPath(path)}?ref=${commitSha}`, { accept: 'application/vnd.github.raw' });
      if (response.status === 404) return null;
      await expectOk(response, 'file contents');
      return response.text();
    },

    // Directory entries (name, blob sha, size) without file content; null when the directory is absent.
    async listDirectory(commitSha, directory) {
      const suffix = directory ? `/${encodeRepoPath(directory)}` : '';
      const response = await apiFetch(`${repoPath}/contents${suffix}?ref=${commitSha}`);
      if (response.status === 404) return null;
      await expectOk(response, 'directory listing');
      const body = await response.json();
      if (!Array.isArray(body)) return null;
      return body.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type, sha: entry.sha, size: entry.size }));
    },

    async blobText(blobSha) {
      const response = await expectOk(await apiFetch(`${repoPath}/git/blobs/${blobSha}`, { accept: 'application/vnd.github.raw' }), 'blob');
      return response.text();
    },

    async blobStream(blobSha) {
      const response = await expectOk(await apiFetch(`${repoPath}/git/blobs/${blobSha}`, { accept: 'application/vnd.github.raw' }), 'blob');
      return response.body;
    },

    async lfsDownloadStream({ oid, size }) {
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      const batch = await fetchImpl(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/info/lfs/objects/batch`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: LFS_MEDIA_TYPE,
          'Content-Type': LFS_MEDIA_TYPE,
          'User-Agent': USER_AGENT
        },
        body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size }] })
      });
      await expectOk(batch, 'LFS batch');
      const body = await batch.json();
      const object = body?.objects?.find((candidate) => candidate.oid === oid);
      if (!object || object.error) {
        const status = object?.error?.code ?? 502;
        throw new UpstreamError(status, `LFS object ${oid} unavailable (${status})`);
      }
      const action = object.actions?.download;
      if (!action?.href) throw new UpstreamError(502, `LFS object ${oid} has no download action`);
      const download = await expectOk(await fetchImpl(action.href, { headers: { ...(action.header ?? {}) } }), 'LFS download');
      return download.body;
    }
  };
}
