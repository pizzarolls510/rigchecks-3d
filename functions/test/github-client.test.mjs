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
