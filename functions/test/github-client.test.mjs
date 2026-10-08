import assert from 'node:assert/strict';
import test from 'node:test';
import { UpstreamError } from '../src/errors.js';
import { createGitHubClient } from '../src/github.js';

const TOKEN = 'github_pat_TESTTOKEN';
const SHA = 'c'.repeat(40);

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes.find(([match]) => (typeof match === 'string' ? url === match : match.test(url)));
    if (!route) return new Response('not found', { status: 404 });
    const [, status, body, headers = {}] = route;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return { impl, calls };
}

test('reads the branch head, raw files and directory listings with the token and GitHub API headers', async () => {
  const { impl, calls } = fakeFetch([
    ['https://api.github.com/repos/pizzarolls510/invasion-godot/git/ref/heads/3d-migration', 200, { object: { type: 'commit', sha: SHA } }],
    [`https://api.github.com/repos/pizzarolls510/invasion-godot/contents/docs/ASSET_MANIFEST.yaml?ref=${SHA}`, 200, '{"assets":[]}'],
    [`https://api.github.com/repos/pizzarolls510/invasion-godot/contents/assets/ui/gameplay%20hud?ref=${SHA}`, 200, [
      { name: 'a.png', path: 'assets/ui/gameplay hud/a.png', type: 'file', sha: 'd'.repeat(40), size: 12, content: 'ignored' }
    ]]
  ]);
  const github = createGitHubClient({ token: TOKEN, owner: 'pizzarolls510', repo: 'invasion-godot', fetchImpl: impl });

  assert.equal(await github.branchHead('3d-migration'), SHA);
  assert.equal(await github.fileText(SHA, 'docs/ASSET_MANIFEST.yaml'), '{"assets":[]}');
  assert.deepEqual(await github.listDirectory(SHA, 'assets/ui/gameplay hud'), [
    { name: 'a.png', path: 'assets/ui/gameplay hud/a.png', type: 'file', sha: 'd'.repeat(40), size: 12 }
  ]);
  assert.equal(await github.fileText(SHA, 'missing.json'), null);
  assert.equal(await github.listDirectory(SHA, 'nope'), null);

  for (const { url, init } of calls) {
    assert.ok(url.startsWith('https://api.github.com/'), url);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
  }
  assert.equal(calls[1].init.headers.Accept, 'application/vnd.github.raw');
});

test('upstream failures raise UpstreamError instead of leaking response bodies', async () => {
  const { impl } = fakeFetch([[/git\/ref\/heads/, 401, { message: 'Bad credentials' }]]);
  const github = createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetchImpl: impl });
  await assert.rejects(github.branchHead('3d-migration'), (error) => error instanceof UpstreamError && error.status === 401);
});

test('LFS downloads use the batch API with the token, then fetch the href with only the batch-provided headers', async () => {
  const oid = 'e'.repeat(64);
  const { impl, calls } = fakeFetch([
    ['https://github.com/pizzarolls510/invasion-godot.git/info/lfs/objects/batch', 200, {
      objects: [{ oid, size: 5, actions: { download: { href: 'https://lfs-objects.example/obj?sig=1', header: { 'X-Signed': 'yes' } } } }]
    }],
    ['https://lfs-objects.example/obj?sig=1', 200, 'hello']
  ]);
  const github = createGitHubClient({ token: TOKEN, owner: 'pizzarolls510', repo: 'invasion-godot', fetchImpl: impl });
  const stream = await github.lfsDownloadStream({ oid, size: 5 });
  assert.equal(await new Response(stream).text(), 'hello');

  const [batch, download] = calls;
  assert.equal(batch.init.method, 'POST');
  assert.equal(batch.init.headers.Accept, 'application/vnd.git-lfs+json');
  assert.equal(batch.init.headers.Authorization, `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
  assert.deepEqual(JSON.parse(batch.init.body), { operation: 'download', transfers: ['basic'], objects: [{ oid, size: 5 }] });
  assert.deepEqual(download.init.headers, { 'X-Signed': 'yes' }, 'the GitHub token is never sent to the LFS object host');
});

test('LFS object errors are reported as upstream errors', async () => {
  const oid = 'f'.repeat(64);
  const { impl } = fakeFetch([[/lfs\/objects\/batch/, 200, { objects: [{ oid, size: 5, error: { code: 404, message: 'Object does not exist' } }] }]]);
  const github = createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetchImpl: impl });
  await assert.rejects(github.lfsDownloadStream({ oid, size: 5 }), (error) => error instanceof UpstreamError && error.status === 404);
});

test('workflow dispatch posts ref, inputs and return_run_details, and reads the run id from a 200 response', async () => {
  const { impl, calls } = fakeFetch([
    ['https://api.github.com/repos/pizzarolls510/invasion-godot/actions/workflows/asset-library-job.yml/dispatches', 200, {
      workflow_run_id: 4242, run_url: 'https://api.github.com/repos/pizzarolls510/invasion-godot/actions/runs/4242', html_url: 'https://github.com/pizzarolls510/invasion-godot/actions/runs/4242'
    }]
  ]);
  const github = createGitHubClient({ token: TOKEN, owner: 'pizzarolls510', repo: 'invasion-godot', fetchImpl: impl });
  const inputs = { job_id: 'job-0001-test', operation: 'validate' };
  assert.deepEqual(await github.dispatchWorkflow({ workflow: 'asset-library-job.yml', ref: 'main', inputs }), {
    runId: 4242, htmlUrl: 'https://github.com/pizzarolls510/invasion-godot/actions/runs/4242'
  });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main', inputs, return_run_details: true });
});

test('a 204 dispatch has no run id; a rejected dispatch is an UpstreamError carrying the status', async () => {
  const noContent = createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.deepEqual(await noContent.dispatchWorkflow({ workflow: 'w.yml', ref: 'main', inputs: {} }), { runId: null, htmlUrl: null });
  const forbidden = createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetchImpl: async () => new Response('{"message":"Resource not accessible"}', { status: 403 }) });
  await assert.rejects(forbidden.dispatchWorkflow({ workflow: 'w.yml', ref: 'main', inputs: {} }), (error) => error instanceof UpstreamError && error.status === 403);
});

test('run discovery filters workflow_dispatch runs on the branch by creation time and run-name', async () => {
  const { impl, calls } = fakeFetch([
    [/\/actions\/workflows\/asset-library-job\.yml\/runs\?/, 200, { workflow_runs: [
      { id: 1, display_title: 'asset-job job-0002-test', status: 'queued' },
      { id: 2, display_title: 'asset-job job-0001-test', status: 'in_progress', conclusion: null, html_url: 'https://github.com/x/2', run_attempt: 1, created_at: '2027-01-15T08:00:00Z', updated_at: '2027-01-15T08:00:05Z' }
    ] }]
  ]);
  const github = createGitHubClient({ token: TOKEN, owner: 'pizzarolls510', repo: 'invasion-godot', fetchImpl: impl });
  const run = await github.findDispatchedRun({ workflow: 'asset-library-job.yml', branch: 'main', createdAfter: Date.UTC(2027, 0, 15, 7, 58, 0, 123), displayTitle: 'asset-job job-0001-test' });
  assert.deepEqual(run, {
    id: 2, status: 'in_progress', conclusion: null, displayTitle: 'asset-job job-0001-test', htmlUrl: 'https://github.com/x/2',
    runAttempt: 1, createdAt: '2027-01-15T08:00:00Z', updatedAt: '2027-01-15T08:00:05Z'
  });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('event'), 'workflow_dispatch');
  assert.equal(url.searchParams.get('branch'), 'main');
  assert.equal(url.searchParams.get('created'), '>=2027-01-15T07:58:00Z');
  assert.equal(await github.findDispatchedRun({ workflow: 'asset-library-job.yml', branch: 'main', createdAfter: 0, displayTitle: 'asset-job none' }), null);
});

test('result artifacts are found by name and downloaded through the redirect without sending the token there', async () => {
  const { impl, calls } = fakeFetch([
    ['https://api.github.com/repos/o/r/actions/runs/7/artifacts?name=asset-job-result&per_page=10', 200, { artifacts: [
      { id: 70, name: 'asset-job-result', expired: true, size_in_bytes: 10 },
      { id: 71, name: 'asset-job-result', expired: false, size_in_bytes: 12 }
    ] }],
    ['https://api.github.com/repos/o/r/actions/artifacts/71/zip', 302, '', { Location: 'https://blob.example/zip?sig=1' }],
    ['https://blob.example/zip?sig=1', 200, 'zip-bytes']
  ]);
  const github = createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetchImpl: impl });
  assert.deepEqual(await github.findArtifact(7, 'asset-job-result'), { id: 71, sizeInBytes: 12 });
  const bytes = await github.downloadArtifact(71, { maxBytes: 100 });
  assert.equal(Buffer.from(bytes).toString(), 'zip-bytes');
  assert.equal(calls[1].init.redirect, 'manual');
  assert.equal(calls[2].init.headers.Authorization, undefined, 'the token never reaches the artifact host');
  await assert.rejects(github.downloadArtifact(71, { maxBytes: 4 }), (error) => error instanceof UpstreamError && /size limit/.test(error.message));

  const noRedirect = createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetchImpl: async () => new Response('gone', { status: 410 }) });
  await assert.rejects(noRedirect.downloadArtifact(71, { maxBytes: 100 }), (error) => error instanceof UpstreamError && error.status === 410);
});
