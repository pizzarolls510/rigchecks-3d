// Minimal GitHub + Git LFS client for the authoritative INVASION repository: reads (Phase 2) plus job dispatch,
// run status and result artifacts (Phase 4).
// The token is only ever sent to api.github.com and the repository's LFS batch endpoint; LFS download
// hrefs and artifact download redirects are fetched without the token, and are never returned to callers
// outside this Function.
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

  function apiFetch(path, { accept = 'application/vnd.github+json', method = 'GET', body, redirect } = {}) {
    return fetchImpl(`${API_ROOT}${path}`, {
      method,
      ...(redirect ? { redirect } : {}),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }

  function mapRun(run) {
    if (!run || !Number.isSafeInteger(run.id)) throw new UpstreamError(502, 'GitHub returned a malformed workflow run');
    return {
      id: run.id,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      displayTitle: run.display_title ?? null,
      htmlUrl: run.html_url ?? null,
      runAttempt: run.run_attempt ?? null,
      createdAt: run.created_at ?? null,
      updatedAt: run.updated_at ?? null
    };
  }

  async function readCapped(response, maxBytes) {
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maxBytes) throw new UpstreamError(502, 'Result artifact exceeds the size limit');
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
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
    },

    // workflow_dispatch. With return_run_details GitHub answers 200 with the new run's id; an older API answers
    // 204 and the run is found later by its run-name (see findDispatchedRun).
    async dispatchWorkflow({ workflow, ref, inputs }) {
      const response = await apiFetch(`${repoPath}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: 'POST',
        body: { ref, inputs, return_run_details: true }
      });
      if (response.status === 204) return { runId: null, htmlUrl: null };
      await expectOk(response, 'workflow dispatch');
      const body = await response.json().catch(() => null);
      const runId = Number.isSafeInteger(body?.workflow_run_id) ? body.workflow_run_id : null;
      return { runId, htmlUrl: runId && typeof body.html_url === 'string' ? body.html_url : null };
    },

    async findDispatchedRun({ workflow, branch, createdAfter, displayTitle }) {
      const created = encodeURIComponent(`>=${new Date(createdAfter).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
      const query = `event=workflow_dispatch&branch=${encodeURIComponent(branch)}&created=${created}&per_page=100`;
      const response = await expectOk(await apiFetch(`${repoPath}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`), 'workflow runs');
      const body = await response.json();
      const run = (body?.workflow_runs ?? []).find((candidate) => candidate?.display_title === displayTitle);
      return run ? mapRun(run) : null;
    },

    async getRun(runId) {
      const response = await expectOk(await apiFetch(`${repoPath}/actions/runs/${runId}`), 'workflow run');
      return mapRun(await response.json());
    },

    async findArtifact(runId, name) {
      const response = await expectOk(await apiFetch(`${repoPath}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=10`), 'run artifacts');
      const body = await response.json();
      const artifact = (body?.artifacts ?? []).find((candidate) => candidate?.name === name && !candidate.expired);
      return artifact ? { id: artifact.id, sizeInBytes: artifact.size_in_bytes ?? null } : null;
    },

    // The zip endpoint redirects to short-lived blob storage. The redirect is followed by hand so the token is
    // never sent to that host.
    async downloadArtifact(artifactId, { maxBytes }) {
      const redirect = await apiFetch(`${repoPath}/actions/artifacts/${artifactId}/zip`, { redirect: 'manual' });
      const location = redirect.headers.get('location');
      if (redirect.status < 300 || redirect.status >= 400 || !location?.startsWith('https://')) {
        throw new UpstreamError(redirect.status, `GitHub artifact download returned ${redirect.status}`);
      }
      const download = await expectOk(await fetchImpl(location, { headers: { 'User-Agent': USER_AGENT } }), 'artifact download');
      return readCapped(download, maxBytes);
    }
  };
}
