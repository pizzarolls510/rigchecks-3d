import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTriangleGlb } from '../test-support/make-glb.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'scripts', 'rigcheck.mjs');

test('CLI help exits successfully and exposes only the first-release commands', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /rigcheck doctor/);
  assert.match(result.stdout, /rigcheck check/);
  assert.match(result.stdout, /rigcheck upload/);
  assert.match(result.stdout, /rigcheck list/);
  assert.doesNotMatch(result.stdout, /rigcheck deploy/);
});

test('CLI check emits deterministic JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rigcheck-cli-'));
  const filePath = path.join(directory, 'triangle.glb');
  await writeFile(filePath, makeTriangleGlb());
  const result = run(['check', filePath, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'check');
  assert.equal(payload.result.valid, true);
  assert.equal(payload.result.triangles, 1);
  assert.equal(payload.result.meshes, 1);
});

test('CLI doctor reports missing configuration as structured JSON', () => {
  const result = run(['doctor', '--json'], {
    RIGCHECK_CONFIG: path.join(os.tmpdir(), 'rigcheck-config-that-does-not-exist.json')
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DOCTOR_FAILED');
  assert.equal(payload.error.details.projectId, 'rigcheck-cfbe3');
  assert.equal(payload.error.details.ownerUid, null);
});

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8'
  });
}
